/**
 * GPU value layer composition.
 *
 * GPUValueSession composes per-agent value bitmaps on the GPU by taking a
 * weighted sum of named spatial + influence layers.  The computation is
 * embarrassingly parallel: one thread per cell, one dispatch per agent type,
 * all dispatched in a single command encoder.
 *
 * Key design:
 *  • A single packed layers buffer holds ALL named layers back-to-back.
 *    Layer slot i occupies [i * cellCount, (i+1) * cellCount) in float32.
 *  • Static spatial layers (centrality, waterfrontness, …) are uploaded once
 *    after computeSpatialLayers() via uploadStaticLayers().
 *  • Dynamic influence layers (developmentProximity, …) are re-uploaded each
 *    tick in compose().
 *  • Per-agent weight uniforms are baked at session creation time (archetype
 *    weights do not change between ticks).
 *  • All agent dispatches share the same pipeline; each has its own bind group
 *    referencing its own output buffer and weight uniform.
 *
 * Spec: specs/v5/gpu-plan.md § Step 2
 */

import { createStorageBuffer, createOutputBuffer, createReadbackBuffer, toFloat32 } from '../../core/gpu/GPUBuffer.js';

// ── Layer slot registry ────────────────────────────────────────────────────
// Fixed ordered list of layer names → GPU slot index.
// Indices 0–5 are static (uploaded once); 6–15 are dynamic (re-uploaded each tick).
// Unused slots have weight 0 and are silently skipped by the shader.
export const LAYER_SLOTS = [
  /* 0 */ 'centrality',
  /* 1 */ 'waterfrontness',
  /* 2 */ 'edgeness',
  /* 3 */ 'roadFrontage',
  /* 4 */ 'downwindness',
  /* 5 */ 'landValue',
  /* 6 */ 'developmentProximity',
  /* 7 */ 'industrialProximity',
  /* 8 */ 'civicProximity',
  /* 9 */ 'parkProximity',
  /* 10 */ 'residentialProximity',
  /* 11 */ 'roadGrid',
  /* 12 */ '',  // spare
  /* 13 */ '',  // spare
  /* 14 */ '',  // spare
  /* 15 */ '',  // spare
];
export const NUM_LAYER_SLOTS = 16;   // must be multiple of 4 (vec4 alignment)
const STATIC_SLOT_END = 6;           // slots 0–5 are static spatial layers

// ── WGSL shader ──────────────────────────────────────────────────────────────
//
// All layer data is stored in one packed buffer: layers[slot * cellCount + i].
// Per-agent weights are in a uniform; unused slots have weight 0 → skipped.
//
const SHADER_CODE = /* wgsl */`
// Packed layer buffer: slot * cellCount + cellIndex → f32 value.
@group(0) @binding(0) var<storage, read> layers : array<f32>;

struct Uniforms {
  cellCount : u32,
  pad0 : u32,
  pad1 : u32,
  pad2 : u32,
  // 16 weights packed as 4 × vec4 (each vec4 element = one layer slot)
  w0 : vec4<f32>,   // slots  0–3
  w1 : vec4<f32>,   // slots  4–7
  w2 : vec4<f32>,   // slots  8–11
  w3 : vec4<f32>,   // slots 12–15
}
@group(0) @binding(1) var<uniform> u : Uniforms;
@group(0) @binding(2) var<storage, read_write> valueOut : array<f32>;

fn getWeight(slot : u32) -> f32 {
  if (slot < 4u)  { return u.w0[slot]; }
  if (slot < 8u)  { return u.w1[slot - 4u]; }
  if (slot < 12u) { return u.w2[slot - 8u]; }
  return u.w3[slot - 12u];
}

@compute @workgroup_size(256)
fn composeValue(@builtin(global_invocation_id) id : vec3<u32>) {
  let i = id.x;
  if (i >= u.cellCount) { return; }

  var v = 0.0;
  for (var s = 0u; s < ${NUM_LAYER_SLOTS}u; s++) {
    let w = getWeight(s);
    if (w != 0.0) {
      v += w * layers[s * u.cellCount + i];
    }
  }
  valueOut[i] = clamp(v, 0.0, 1.0);
}
`;

// ── GPUValueSession ───────────────────────────────────────────────────────────

export class GPUValueSession {
  /**
   * @param {GPUDevice} device
   * @param {object} map   — FeatureMap (for dimensions)
   * @param {object} archetype
   */
  constructor(device, map, archetype) {
    this._device = device;
    const n = map.width * map.height;
    this._n = n;
    this._w = map.width;
    this._h = map.height;

    const valueComposition = archetype.growth?.valueComposition ?? {};
    this._agentTypes = Object.keys(valueComposition);
    this._valueComposition = valueComposition;

    // Packed layers buffer: NUM_LAYER_SLOTS × cellCount × f32
    this._layersBuffer = createStorageBuffer(device, NUM_LAYER_SLOTS * n * 4);

    // Compile shader pipeline
    const module = device.createShaderModule({ code: SHADER_CODE });
    this._pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'composeValue' },
    });
    const bgl = this._pipeline.getBindGroupLayout(0);

    // Per-agent resources: output buffer, readback buffer, uniform, bind group
    this._perAgent = {};
    for (const agentType of this._agentTypes) {
      const composition = valueComposition[agentType] ?? {};
      const uniformBuf = this._buildWeightUniform(device, n, composition);
      const outputBuf = createOutputBuffer(device, n * 4);
      const readbackBuf = createReadbackBuffer(device, n * 4);
      const bindGroup = device.createBindGroup({
        layout: bgl,
        entries: [
          { binding: 0, resource: { buffer: this._layersBuffer } },
          { binding: 1, resource: { buffer: uniformBuf } },
          { binding: 2, resource: { buffer: outputBuf } },
        ],
      });
      this._perAgent[agentType] = { uniformBuf, outputBuf, readbackBuf, bindGroup };
    }
  }

  // ── Static factory ──────────────────────────────────────────────────────────

  /**
   * Create a session, or return null if the archetype has no value composition.
   * @param {GPUDevice} device
   * @param {object} map
   * @param {object} archetype
   * @returns {GPUValueSession|null}
   */
  static create(device, map, archetype) {
    const comp = archetype.growth?.valueComposition;
    if (!comp || Object.keys(comp).length === 0) return null;
    return new GPUValueSession(device, map, archetype);
  }

  // ── Upload ────────────────────────────────────────────────────────────────

  /**
   * Upload static spatial layers (slots 0–5) to the layers buffer.
   * Call once after computeSpatialLayers() has run; before the first growth tick.
   * @param {object} map
   */
  uploadStaticLayers(map) {
    const n = this._n;
    for (let slot = 0; slot < STATIC_SLOT_END; slot++) {
      const name = LAYER_SLOTS[slot];
      if (!name) continue;
      const layer = map.hasLayer(name) ? map.getLayer(name) : null;
      if (!layer) continue;
      const f32 = toFloat32(layer, n);
      this._device.queue.writeBuffer(this._layersBuffer, slot * n * 4, f32);
    }
  }

  // ── Compose ────────────────────────────────────────────────────────────────

  /**
   * Compose value bitmaps for all agent types.
   * Uploads dynamic influence layers, dispatches all agents in one encoder,
   * then reads back all results in parallel.
   *
   * @param {object} influenceLayers  — { layerName: Float32Array }
   * @returns {Promise<object>}       — { agentType: Float32Array }
   */
  async compose(influenceLayers) {
    const n = this._n;
    const device = this._device;

    // Upload dynamic layers (slots 6–15)
    for (let slot = STATIC_SLOT_END; slot < NUM_LAYER_SLOTS; slot++) {
      const name = LAYER_SLOTS[slot];
      if (!name) continue;
      const data = influenceLayers[name];
      if (!data) continue;
      const f32 = data instanceof Float32Array ? data : new Float32Array(data);
      device.queue.writeBuffer(this._layersBuffer, slot * n * 4, f32);
    }

    // One command encoder: all agent dispatches, then all copies to readback
    const encoder = device.createCommandEncoder();

    {
      const pass = encoder.beginComputePass();
      pass.setPipeline(this._pipeline);
      const workgroups = Math.ceil(n / 256);
      for (const agentType of this._agentTypes) {
        const { bindGroup } = this._perAgent[agentType];
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(workgroups);
      }
      pass.end();
    }

    for (const agentType of this._agentTypes) {
      const { outputBuf, readbackBuf } = this._perAgent[agentType];
      encoder.copyBufferToBuffer(outputBuf, 0, readbackBuf, 0, n * 4);
    }

    device.queue.submit([encoder.finish()]);

    // Read back all in parallel
    await Promise.all(
      this._agentTypes.map(t => this._perAgent[t].readbackBuf.mapAsync(GPUMapMode.READ)),
    );

    const result = {};
    for (const agentType of this._agentTypes) {
      const buf = this._perAgent[agentType].readbackBuf;
      result[agentType] = new Float32Array(buf.getMappedRange().slice(0));
      buf.unmap();
    }

    return result;
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  destroy() {
    this._layersBuffer.destroy();
    for (const { uniformBuf, outputBuf, readbackBuf } of Object.values(this._perAgent)) {
      uniformBuf.destroy();
      outputBuf.destroy();
      readbackBuf.destroy();
    }
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  /**
   * Build a 80-byte uniform buffer containing cellCount and per-slot weights.
   * Layout:
   *   bytes  0–15: u32[cellCount, 0, 0, 0]
   *   bytes 16–31: f32[w[0..3]]   (slots 0–3)
   *   bytes 32–47: f32[w[4..7]]   (slots 4–7)
   *   bytes 48–63: f32[w[8..11]]  (slots 8–11)
   *   bytes 64–79: f32[w[12..15]] (slots 12–15)
   */
  _buildWeightUniform(device, cellCount, composition) {
    const buf = new ArrayBuffer(80);
    const u32 = new Uint32Array(buf);
    const f32 = new Float32Array(buf);
    u32[0] = cellCount;
    // f32 indices 4–19 hold the 16 weights
    for (let slot = 0; slot < NUM_LAYER_SLOTS; slot++) {
      const name = LAYER_SLOTS[slot];
      f32[4 + slot] = (name && composition[name] != null) ? composition[name] : 0;
    }
    const gpuBuf = device.createBuffer({
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Uint8Array(gpuBuf.getMappedRange()).set(new Uint8Array(buf));
    gpuBuf.unmap();
    return gpuBuf;
  }
}
