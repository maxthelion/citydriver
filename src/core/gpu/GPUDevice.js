/**
 * GPUDevice — WebGPU singleton with lazy init and CPU fallback.
 *
 * Usage:
 *   const gpu = await GPUDevice.get();
 *   if (gpu.available) {
 *     const { device } = gpu;
 *     // use device
 *   }
 *
 * isDefinitelyUnavailable() is a fast synchronous check — returns true when WebGPU
 * is definitely not present (Node.js, old browsers). Use this to avoid starting an
 * async init that would immediately fail.
 */

export class GPUDevice {
  static _instance = null;
  static _initPromise = null;

  /**
   * Fast synchronous check: true when WebGPU is definitely absent.
   * In Node.js (no navigator.gpu, no globalThis.gpu) this returns true immediately,
   * allowing callers to skip the async init entirely and keep step functions sync.
   */
  static isDefinitelyUnavailable() {
    const gpuEntry =
      (typeof navigator !== 'undefined' && navigator.gpu) ||
      (typeof globalThis !== 'undefined' && globalThis.gpu);
    return !gpuEntry;
  }

  /**
   * Get the singleton GPU device. Initialises on first call.
   * Returns { available: false } if WebGPU is not supported.
   * @returns {Promise<{ available: boolean, device?: GPUDevice }>}
   */
  static async get() {
    if (this._instance) return this._instance;
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._init().then(result => {
      this._instance = result;
      return result;
    });
    return this._initPromise;
  }

  static async _init() {
    try {
      const gpuEntry =
        (typeof navigator !== 'undefined' && navigator.gpu) ||
        (typeof globalThis !== 'undefined' && globalThis.gpu);
      if (!gpuEntry) return { available: false };

      const adapter = await gpuEntry.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) return { available: false };

      const device = await adapter.requestDevice();

      // Handle device loss — reset singleton so next get() re-initialises.
      device.lost.then((info) => {
        console.warn(`[GPUDevice] Device lost: ${info.message}`);
        GPUDevice._instance = null;
        GPUDevice._initPromise = null;
      });

      console.log('[GPUDevice] WebGPU device acquired');
      return { available: true, device };
    } catch (e) {
      console.warn('[GPUDevice] WebGPU init failed:', e?.message ?? e);
      return { available: false };
    }
  }

  /** Reset singleton (for testing or after device loss). */
  static reset() {
    this._instance = null;
    this._initPromise = null;
  }
}
