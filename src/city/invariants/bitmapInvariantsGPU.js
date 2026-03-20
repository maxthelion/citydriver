/**
 * GPU bitmap invariant checker.
 *
 * Runs the same five invariant checks as bitmapInvariants.js but on the GPU
 * using a single compute shader with one atomic counter per invariant.
 *
 * On a 1200×1200 grid (1.44 M cells) this should be ~30× faster than the CPU
 * implementation, making it cheap enough to leave wired at every pipeline sub-step.
 *
 * Usage (same interface as CPU version):
 *   const counts = await checkAllBitmapInvariantsGPU(map, device);
 *
 * The function returns the same { noRoadOnWater, noRailOnWater, … } object.
 * If any layer is missing it gracefully falls back to zero for that check.
 */

/* ── WGSL shader ────────────────────────────────────────────────────────────

  Each cell i is checked against five bitmap invariants.
  Layers are packed as Uint32 (1 = set, 0 = clear) — see toUint32 below.
  Violations are accumulated in an atomic counter struct.

─────────────────────────────────────────────────────────────────────────── */
const SHADER_CODE = /* wgsl */`
struct Counts {
  noRoadOnWater     : atomic<u32>,
  noRailOnWater     : atomic<u32>,
  noZoneOnWater     : atomic<u32>,
  noResOutsideZone  : atomic<u32>,
  bridgesOnlyOnWater: atomic<u32>,
}

@group(0) @binding(0) var<storage, read>       waterMask  : array<u32>;
@group(0) @binding(1) var<storage, read>       roadGrid   : array<u32>;
@group(0) @binding(2) var<storage, read>       railGrid   : array<u32>;
@group(0) @binding(3) var<storage, read>       bridgeGrid : array<u32>;
@group(0) @binding(4) var<storage, read>       zoneGrid   : array<u32>;
@group(0) @binding(5) var<storage, read>       resGrid    : array<u32>;
@group(0) @binding(6) var<storage, read_write> counts     : Counts;

@group(1) @binding(0) var<uniform> cellCount : u32;

@compute @workgroup_size(256)
fn checkAll(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= cellCount) { return; }

  let isWater  = waterMask[i]  > 0u;
  let isRoad   = roadGrid[i]   > 0u;
  let isRail   = railGrid[i]   > 0u;
  let isBridge = bridgeGrid[i] > 0u;
  let inZone   = zoneGrid[i]   > 0u;
  let isRes    = resGrid[i]    > 0u;

  if (isWater && isRoad && !isBridge) { atomicAdd(&counts.noRoadOnWater,      1u); }
  if (isWater && isRail)              { atomicAdd(&counts.noRailOnWater,      1u); }
  if (isWater && inZone)              { atomicAdd(&counts.noZoneOnWater,      1u); }
  if (isRes   && !inZone)             { atomicAdd(&counts.noResOutsideZone,   1u); }
  if (isBridge && !isWater)           { atomicAdd(&counts.bridgesOnlyOnWater, 1u); }
}
`;

// ── Persistent pipeline cache ────────────────────────────────────────────────

let _cachedDevice = null;
let _pipeline = null;
let _bgl0 = null;
let _bgl1 = null;

function getOrCreatePipeline(device) {
  if (_cachedDevice === device) return _pipeline;
  _cachedDevice = device;
  const module = device.createShaderModule({ code: SHADER_CODE });
  _pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'checkAll' },
  });
  _bgl0 = _pipeline.getBindGroupLayout(0);
  _bgl1 = _pipeline.getBindGroupLayout(1);
  return _pipeline;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert Grid2D or TypedArray layer to a Uint32Array for upload.
 * Each cell value >0 becomes 1u, 0 stays 0u.
 */
function toUint32(layer, n) {
  if (layer == null) return new Uint32Array(n); // all zeros
  const src = layer.data ?? layer;
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = src[i] > 0 ? 1 : 0;
  return out;
}

function uploadU32(device, data) {
  const buf = device.createBuffer({
    size: Math.max(data.byteLength, 4),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  });
  new Uint32Array(buf.getMappedRange()).set(data);
  buf.unmap();
  return buf;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run all bitmap invariant checks on the GPU.
 *
 * @param {object} map  — FeatureMap
 * @param {GPUDevice} device
 * @returns {Promise<{ noRoadOnWater: number, noRailOnWater: number,
 *                     noZoneOnWater: number, noResOutsideZone: number,
 *                     bridgesOnlyOnWater: number }>}
 */
export async function checkAllBitmapInvariantsGPU(map, device) {
  const n = map.width * map.height;

  const waterLayer  = map.hasLayer('waterMask')      ? map.getLayer('waterMask')      : null;
  const roadLayer   = map.hasLayer('roadGrid')        ? map.getLayer('roadGrid')        : null;
  const railLayer   = map.hasLayer('railwayGrid')     ? map.getLayer('railwayGrid')     : null;
  const bridgeLayer = map.hasLayer('bridgeGrid')      ? map.getLayer('bridgeGrid')      : null;
  const zoneLayer   = map.hasLayer('zoneGrid')        ? map.getLayer('zoneGrid')        : null;
  const resLayer    = map.hasLayer('reservationGrid') ? map.getLayer('reservationGrid') : null;

  const pipeline = getOrCreatePipeline(device);

  // Upload layer data as Uint32 arrays
  const bufWater  = uploadU32(device, toUint32(waterLayer,  n));
  const bufRoad   = uploadU32(device, toUint32(roadLayer,   n));
  const bufRail   = uploadU32(device, toUint32(railLayer,   n));
  const bufBridge = uploadU32(device, toUint32(bridgeLayer, n));
  const bufZone   = uploadU32(device, toUint32(zoneLayer,   n));
  const bufRes    = uploadU32(device, toUint32(resLayer,    n));

  // Counts output buffer (5 × u32 atomics = 20 bytes, rounded to 32)
  const countsBuffer = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    mappedAtCreation: true,
  });
  new Uint32Array(countsBuffer.getMappedRange()).fill(0);
  countsBuffer.unmap();

  // Uniform: cellCount
  const uniformBuf = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  });
  new Uint32Array(uniformBuf.getMappedRange())[0] = n;
  uniformBuf.unmap();

  // Bind groups
  const bg0 = device.createBindGroup({
    layout: _bgl0,
    entries: [
      { binding: 0, resource: { buffer: bufWater  } },
      { binding: 1, resource: { buffer: bufRoad   } },
      { binding: 2, resource: { buffer: bufRail   } },
      { binding: 3, resource: { buffer: bufBridge } },
      { binding: 4, resource: { buffer: bufZone   } },
      { binding: 5, resource: { buffer: bufRes    } },
      { binding: 6, resource: { buffer: countsBuffer } },
    ],
  });
  const bg1 = device.createBindGroup({
    layout: _bgl1,
    entries: [{ binding: 0, resource: { buffer: uniformBuf } }],
  });

  // Dispatch
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bg0);
  pass.setBindGroup(1, bg1);
  pass.dispatchWorkgroups(Math.ceil(n / 256));
  pass.end();

  // Readback
  const readback = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  encoder.copyBufferToBuffer(countsBuffer, 0, readback, 0, 32);
  device.queue.submit([encoder.finish()]);

  await readback.mapAsync(GPUMapMode.READ);
  const result = new Uint32Array(readback.getMappedRange().slice(0));
  readback.unmap();

  // Destroy temporary buffers
  bufWater.destroy(); bufRoad.destroy(); bufRail.destroy();
  bufBridge.destroy(); bufZone.destroy(); bufRes.destroy();
  countsBuffer.destroy(); uniformBuf.destroy(); readback.destroy();

  return {
    noRoadOnWater:      result[0],
    noRailOnWater:      result[1],
    noZoneOnWater:      result[2],
    noResOutsideZone:   result[3],
    bridgesOnlyOnWater: result[4],
  };
}
