/**
 * GPUBuffer utilities — typed array ↔ GPUBuffer helpers.
 */

/**
 * Upload a TypedArray to a new GPU storage buffer (STORAGE | COPY_DST).
 * @param {GPUDevice} device
 * @param {TypedArray} data
 * @param {number} [extraUsage=0]
 * @returns {GPUBuffer}
 */
export function uploadBuffer(device, data, extraUsage = 0) {
  const buffer = device.createBuffer({
    size: Math.max(data.byteLength, 4),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | extraUsage,
    mappedAtCreation: true,
  });
  new Uint8Array(buffer.getMappedRange()).set(
    new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
  );
  buffer.unmap();
  return buffer;
}

/**
 * Create a GPU storage buffer sized for `byteLength` bytes (STORAGE | COPY_DST).
 * Data can be written later via device.queue.writeBuffer().
 * @param {GPUDevice} device
 * @param {number} byteLength
 * @param {number} [extraUsage=0]
 * @returns {GPUBuffer}
 */
export function createStorageBuffer(device, byteLength, extraUsage = 0) {
  return device.createBuffer({
    size: Math.max(byteLength, 4),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | extraUsage,
  });
}

/**
 * Create a GPU output buffer (STORAGE | COPY_SRC) — for compute shader output.
 * @param {GPUDevice} device
 * @param {number} byteLength
 * @returns {GPUBuffer}
 */
export function createOutputBuffer(device, byteLength) {
  return device.createBuffer({
    size: Math.max(byteLength, 4),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
}

/**
 * Create a GPU readback buffer (MAP_READ | COPY_DST).
 * @param {GPUDevice} device
 * @param {number} byteLength
 * @returns {GPUBuffer}
 */
export function createReadbackBuffer(device, byteLength) {
  return device.createBuffer({
    size: Math.max(byteLength, 4),
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
}

/**
 * Upload a small struct to a new GPU uniform buffer.
 * @param {GPUDevice} device
 * @param {ArrayBuffer} data  — raw bytes of the uniform struct
 * @returns {GPUBuffer}
 */
export function createUniformBuffer(device, data) {
  const size = Math.ceil(data.byteLength / 16) * 16; // align to 16 bytes
  const buffer = device.createBuffer({
    size,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  });
  new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data));
  buffer.unmap();
  return buffer;
}

/**
 * Download a GPU buffer into a new Float32Array.
 * Copies via a temporary MAP_READ buffer, then destroys it.
 * @param {GPUDevice} device
 * @param {GPUBuffer} src  — must have COPY_SRC usage
 * @param {number} numFloats
 * @returns {Promise<Float32Array>}
 */
export async function downloadFloat32(device, src, numFloats) {
  const byteLength = numFloats * 4;
  const readback = createReadbackBuffer(device, byteLength);
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(src, 0, readback, 0, byteLength);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(GPUMapMode.READ);
  const result = new Float32Array(readback.getMappedRange().slice(0));
  readback.unmap();
  readback.destroy();
  return result;
}

/**
 * Convert a typed array (Uint8Array, Int32Array, …) to Float32Array.
 * If it is already a Float32Array, returns it directly (no copy).
 * Also accepts a Grid2D-like object with a .data property.
 * @param {TypedArray|{data: TypedArray}|null} src
 * @param {number} n  — expected length
 * @returns {Float32Array}
 */
export function toFloat32(src, n) {
  if (src == null) return new Float32Array(n);
  const arr = src.data ?? src;
  if (arr instanceof Float32Array) return arr;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = arr[i];
  return out;
}
