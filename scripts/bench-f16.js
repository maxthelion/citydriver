/**
 * Quick probe: f16 layers vs f32 layers upload time.
 * All layers stored as float16 → half the buffer size → faster uploads.
 */
import { create, globals } from 'webgpu';
Object.assign(globalThis, globals);
const gpu = create([]);
const adapter = await gpu.requestAdapter();
const device = await adapter.requestDevice({ requiredFeatures: ['shader-f16'] });

const nCells = 1200 * 1200, nLayers = 12, nZones = 8;
const weightData = new Float32Array(nZones * nLayers).fill(0.1);
const outSize = nZones * nCells * 4; // output stays f32

// f32 buffer (baseline — 5 dynamic layers)
const lBuf32 = device.createBuffer({
  size: nLayers * nCells * 4,
  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
});
// f16 buffer (new — 5 dynamic layers at half size)
const lBuf16 = device.createBuffer({
  size: nLayers * nCells * 2,
  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
});

const wBuf = device.createBuffer({ size: weightData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
device.queue.writeBuffer(wBuf, 0, weightData);

const oBuf = device.createBuffer({ size: outSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
const rBuf = device.createBuffer({ size: outSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

// Dynamic layer data
const dynF32 = new Float32Array(5 * nCells).fill(0.4);
const dynF16 = new Float16Array(5 * nCells).fill(0.4);

// --- Build both pipelines ---
const shaderF32 = device.createShaderModule({ code: `
  @group(0) @binding(0) var<storage,read>       l:array<f32>;
  @group(0) @binding(1) var<storage,read>       w:array<f32>;
  @group(0) @binding(2) var<storage,read_write> o:array<f32>;
  @compute @workgroup_size(64)
  fn main(@builtin(global_invocation_id) id:vec3u) {
    let c=id.x; if(c>=${nCells}u){return;}
    for(var z=0u;z<${nZones}u;z++){
      var s=0.0;
      for(var li=0u;li<${nLayers}u;li++){s+=w[z*${nLayers}u+li]*l[li*${nCells}u+c];}
      o[z*${nCells}u+c]=clamp(s,0.0,1.0);
    }
  }
`});

const shaderF16 = device.createShaderModule({ code: `
  enable f16;
  @group(0) @binding(0) var<storage,read>       l:array<f16>;
  @group(0) @binding(1) var<storage,read>       w:array<f32>;
  @group(0) @binding(2) var<storage,read_write> o:array<f32>;
  @compute @workgroup_size(64)
  fn main(@builtin(global_invocation_id) id:vec3u) {
    let c=id.x; if(c>=${nCells}u){return;}
    for(var z=0u;z<${nZones}u;z++){
      var s=f32(0);
      for(var li=0u;li<${nLayers}u;li++){s+=w[z*${nLayers}u+li]*f32(l[li*${nCells}u+c]);}
      o[z*${nCells}u+c]=clamp(s,0.0,1.0);
    }
  }
`});

const [pipe32, pipe16] = await Promise.all([
  device.createComputePipelineAsync({ layout: 'auto', compute: { module: shaderF32, entryPoint: 'main' } }),
  device.createComputePipelineAsync({ layout: 'auto', compute: { module: shaderF16, entryPoint: 'main' } }),
]);

const bg32 = device.createBindGroup({ layout: pipe32.getBindGroupLayout(0),
  entries: [{ binding:0,resource:{buffer:lBuf32}},{binding:1,resource:{buffer:wBuf}},{binding:2,resource:{buffer:oBuf}}] });
const bg16 = device.createBindGroup({ layout: pipe16.getBindGroupLayout(0),
  entries: [{ binding:0,resource:{buffer:lBuf16}},{binding:1,resource:{buffer:wBuf}},{binding:2,resource:{buffer:oBuf}}] });

async function runBench(label, pipeline, bg, uploadFn, N = 10) {
  const times = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    uploadFn();
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(nCells / 64)); pass.end();
    enc.copyBufferToBuffer(oBuf, 0, rBuf, 0, outSize);
    device.queue.submit([enc.finish()]);
    await rBuf.mapAsync(GPUMapMode.READ);
    new Float32Array(rBuf.getMappedRange()).slice(0, 1);
    rBuf.unmap();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const mean = times.slice(1, -1).reduce((a, b) => a + b, 0) / (N - 2);
  console.log(`${label}: mean=${mean.toFixed(1)}ms  p50=${times[Math.floor(N * 0.5)].toFixed(1)}ms`);
}

// f32: upload 5 dynamic layers (28.8MB)
await runBench(
  'f32 layers (5 dynamic, 28.8MB)',
  pipe32, bg32,
  () => device.queue.writeBuffer(lBuf32, 0, dynF32, 0, 5 * nCells),
);

// f16: upload 5 dynamic layers (14.4MB)
await runBench(
  'f16 layers (5 dynamic, 14.4MB)',
  pipe16, bg16,
  () => device.queue.writeBuffer(lBuf16, 0, dynF16, 0, 5 * nCells),
);

device.destroy();
