/**
 * GPU influence layer computation.
 *
 * GPUInfluenceSession replicates the CPU boxBlur + normalization approach from
 * influenceLayers.js but runs on the GPU. For each named influence layer and for
 * developmentProximity:
 *
 *   1. Build a binary mask on CPU (which cells match the reservation type).
 *   2. Upload mask to srcBuffer[i].
 *   3. Horizontal box-blur pass:  srcBuffer[i] → tmpBuffer[i].
 *   4. Vertical box-blur pass:    tmpBuffer[i] → dstBuffer[i].
 *   5. Copy dstBuffer[i] → readbackBuffer[i], submit ONE command encoder for
 *      all N layers, then await all N mapAsync in parallel.
 *   6. Normalize each result to [0, 1] on CPU (find max, divide).
 *
 * H and V passes are split into two separate compute passes inside the same
 * command encoder, creating an implicit memory barrier between them.
 *
 * The blur radius and grid dimensions are fixed per archetype and baked into
 * per-layer uniform buffers at session creation time — no per-tick updates.
 *
 * Spec: specs/v5/gpu-plan.md § Step 3
 */

import { createStorageBuffer, createOutputBuffer, createReadbackBuffer, createUniformBuffer } from '../../core/gpu/GPUBuffer.js';
import { RESERVATION } from './growthAgents.js';

// ── WGSL blur shader ──────────────────────────────────────────────────────────
//
//  H pass: accumulate row sum (no per-window normalization, matches CPU).
//  V pass: accumulate column sum.
//  Final normalization to [0, 1] happens on CPU via global max divide.
//
const BLUR_SHADER_CODE = /* wgsl */`
struct BlurUniforms {
  width  : u32,
  height : u32,
  radius : u32,
  pad    : u32,
}

@group(0) @binding(0) var<storage, read>       src : array<f32>;
@group(0) @binding(1) var<uniform>             u   : BlurUniforms;
@group(0) @binding(2) var<storage, read_write> dst : array<f32>;

// Horizontal pass: each thread sums src[gz][gx-r .. gx+r] → dst[gz][gx]
@compute @workgroup_size(256)
fn blurH(@builtin(global_invocation_id) id : vec3<u32>) {
  let i  = id.x;
  let gz = i / u.width;
  let gx = i % u.width;
  if (gz >= u.height) { return; }

  let r  = u.radius;
  let lo = select(0u, gx - r, gx >= r);
  let hi = min(gx + r, u.width - 1u);
  var sum = 0.0;
  for (var x = lo; x <= hi; x++) {
    sum += src[gz * u.width + x];
  }
  dst[i] = sum;
}

// Vertical pass: each thread sums src[gz-r .. gz+r][gx] → dst[gz][gx]
@compute @workgroup_size(256)
fn blurV(@builtin(global_invocation_id) id : vec3<u32>) {
  let i  = id.x;
  let gz = i / u.width;
  let gx = i % u.width;
  if (gz >= u.height) { return; }

  let r  = u.radius;
  let lo = select(0u, gz - r, gz >= r);
  let hi = min(gz + r, u.height - 1u);
  var sum = 0.0;
  for (var z = lo; z <= hi; z++) {
    sum += src[z * u.width + gx];
  }
  dst[i] = sum;
}
`;

// ── GPUInfluenceSession ────────────────────────────────────────────────────────

export class GPUInfluenceSession {
  /**
   * @param {GPUDevice} device
   * @param {object}    map       — FeatureMap (for dimensions)
   * @param {object}    archetype
   */
  constructor(device, map, archetype) {
    this._device = device;
    const w = map.width;
    const h = map.height;
    const n = w * h;
    this._w = w;
    this._h = h;
    this._n = n;

    const influenceRadii = archetype.growth?.influenceRadii ?? {};

    // Compute devProximity radius = max(20, max of all named radii)
    let devRadius = 20;
    for (const cfg of Object.values(influenceRadii)) {
      if (cfg.radius > devRadius) devRadius = cfg.radius;
    }

    // Build ordered list of layers to compute
    // Index 0 = developmentProximity; the rest are named influence layers.
    this._layers = [
      { name: 'developmentProximity', radius: devRadius, isDevProximity: true },
      ...Object.entries(influenceRadii).map(([name, cfg]) => ({
        name,
        radius: cfg.radius,
        types: cfg.types,
        isDevProximity: false,
      })),
    ];

    const N = this._layers.length;

    // Per-layer GPU buffers
    this._srcBuffers     = [];
    this._tmpBuffers     = [];
    this._dstBuffers     = [];
    this._readbackBufs   = [];
    this._uniformBuffers = [];

    for (let i = 0; i < N; i++) {
      this._srcBuffers.push(createStorageBuffer(device, n * 4));
      this._tmpBuffers.push(createStorageBuffer(device, n * 4, GPUBufferUsage.COPY_SRC));
      this._dstBuffers.push(createOutputBuffer(device, n * 4));
      this._readbackBufs.push(createReadbackBuffer(device, n * 4));

      // Bake blur uniform (fixed per archetype, never updated per tick)
      const uniformData = new Uint32Array([w, h, this._layers[i].radius, 0]);
      this._uniformBuffers.push(createUniformBuffer(device, uniformData.buffer));
    }

    // Compile shader (one module, two entry points)
    const blurModule = device.createShaderModule({ code: BLUR_SHADER_CODE });
    this._hPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: blurModule, entryPoint: 'blurH' },
    });
    this._vPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: blurModule, entryPoint: 'blurV' },
    });

    // Each pipeline gets its own bind group layout object — with layout:'auto'
    // the spec does not consider two implicit layouts equal even if structurally
    // identical, so we must use each pipeline's own layout when creating its
    // bind groups.
    const hbgl = this._hPipeline.getBindGroupLayout(0);
    const vbgl = this._vPipeline.getBindGroupLayout(0);

    // H bind groups: src[i] → tmp[i] (with uniform[i])
    this._hBindGroups = this._srcBuffers.map((src, i) =>
      device.createBindGroup({
        layout: hbgl,
        entries: [
          { binding: 0, resource: { buffer: src } },
          { binding: 1, resource: { buffer: this._uniformBuffers[i] } },
          { binding: 2, resource: { buffer: this._tmpBuffers[i] } },
        ],
      }),
    );

    // V bind groups: tmp[i] → dst[i] (with uniform[i])
    this._vBindGroups = this._tmpBuffers.map((tmp, i) =>
      device.createBindGroup({
        layout: vbgl,
        entries: [
          { binding: 0, resource: { buffer: tmp } },
          { binding: 1, resource: { buffer: this._uniformBuffers[i] } },
          { binding: 2, resource: { buffer: this._dstBuffers[i] } },
        ],
      }),
    );

    this._influenceRadii = influenceRadii;
  }

  // ── Static factory ──────────────────────────────────────────────────────────

  /**
   * Create a session, or return null if the archetype has no influenceRadii.
   * @param {GPUDevice} device
   * @param {object}    map
   * @param {object}    archetype
   * @returns {GPUInfluenceSession|null}
   */
  static create(device, map, archetype) {
    const radii = archetype.growth?.influenceRadii;
    if (!radii || Object.keys(radii).length === 0) return null;
    return new GPUInfluenceSession(device, map, archetype);
  }

  // ── Compute ───────────────────────────────────────────────────────────────

  /**
   * Compute all influence layers on the GPU.
   *
   * @param {Grid2D}  resGrid        — reservation grid (read-only)
   * @param {number}  w
   * @param {number}  h
   * @param {object}  influenceRadii — archetype config (for type sets)
   * @param {Array}   [nuclei=[]]    — nucleus cells for devProximity seeding
   * @returns {Promise<object>}      — { layerName: Float32Array }, values in [0,1]
   */
  async compute(resGrid, w, h, influenceRadii, nuclei = []) {
    const n = w * h;
    const N = this._layers.length;
    const device = this._device;

    // ── 1. Build binary masks on CPU ─────────────────────────────────────────
    const masks = [];
    for (const layer of this._layers) {
      const mask = new Float32Array(n);

      if (layer.isDevProximity) {
        // devMask: all non-NONE, non-AGRICULTURE cells + nuclei
        for (let j = 0; j < n; j++) {
          const v = resGrid.data[j];
          if (v !== RESERVATION.NONE && v !== RESERVATION.AGRICULTURE) {
            mask[j] = 1.0;
          }
        }
        for (const { gx, gz } of nuclei) {
          if (gx >= 0 && gx < w && gz >= 0 && gz < h) {
            mask[gz * w + gx] = 1.0;
          }
        }
      } else {
        // Named influence layer: cells matching the reservation types
        const typeSet = new Set(layer.types);
        for (let j = 0; j < n; j++) {
          if (typeSet.has(resGrid.data[j])) mask[j] = 1.0;
        }
      }

      masks.push(mask);
    }

    // ── 2. Upload all masks ────────────────────────────────────────────────
    for (let i = 0; i < N; i++) {
      device.queue.writeBuffer(this._srcBuffers[i], 0, masks[i]);
    }

    // ── 3. Encode: Pass 1 (H blurs) → Pass 2 (V blurs) → copies ──────────
    const workgroups = Math.ceil(n / 256);
    const encoder = device.createCommandEncoder();

    // Pass 1: all horizontal blurs (barrier at pass boundary before V)
    {
      const pass = encoder.beginComputePass();
      pass.setPipeline(this._hPipeline);
      for (let i = 0; i < N; i++) {
        pass.setBindGroup(0, this._hBindGroups[i]);
        pass.dispatchWorkgroups(workgroups);
      }
      pass.end();
    }

    // Pass 2: all vertical blurs (reads from tmpBuffers, which H pass finished writing)
    {
      const pass = encoder.beginComputePass();
      pass.setPipeline(this._vPipeline);
      for (let i = 0; i < N; i++) {
        pass.setBindGroup(0, this._vBindGroups[i]);
        pass.dispatchWorkgroups(workgroups);
      }
      pass.end();
    }

    // Copy all dst buffers → readback buffers
    for (let i = 0; i < N; i++) {
      encoder.copyBufferToBuffer(this._dstBuffers[i], 0, this._readbackBufs[i], 0, n * 4);
    }

    device.queue.submit([encoder.finish()]);

    // ── 4. Read back all in parallel ────────────────────────────────────────
    await Promise.all(this._readbackBufs.map(buf => buf.mapAsync(GPUMapMode.READ)));

    const result = {};
    for (let i = 0; i < N; i++) {
      const raw = new Float32Array(this._readbackBufs[i].getMappedRange().slice(0));
      this._readbackBufs[i].unmap();

      // Normalize to [0, 1] (matches CPU boxBlur normalization)
      let max = 0;
      for (let j = 0; j < n; j++) if (raw[j] > max) max = raw[j];
      if (max > 0) for (let j = 0; j < n; j++) raw[j] /= max;

      result[this._layers[i].name] = raw;
    }

    return result;
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  destroy() {
    for (let i = 0; i < this._layers.length; i++) {
      this._srcBuffers[i].destroy();
      this._tmpBuffers[i].destroy();
      this._dstBuffers[i].destroy();
      this._readbackBufs[i].destroy();
      this._uniformBuffers[i].destroy();
    }
  }
}
