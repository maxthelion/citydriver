/**
 * Bitmap logger for pipeline observability.
 *
 * Captures snapshots of Grid2D layers at each pipeline step.
 * Writes PPM images to a trace directory for offline inspection.
 *
 * Usage:
 *   const logger = new BitmapLogger('output/traces/seed-42-marketTown');
 *   logger.log('setup', 'elevation', elevationGrid, 'terrain');
 *   logger.log('setup', 'waterMask', waterMaskGrid, 'mask');
 *   // ... pipeline runs ...
 *   logger.log('tick-5', 'reservationGrid', resGrid, 'reservation');
 *   await logger.flush();
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';

// Colour palettes for different layer types
const PALETTES = {
  // Continuous float layers (0-1): blue → green → yellow → red
  heat: (v) => {
    const r = Math.round(v < 0.5 ? 0 : (v - 0.5) * 2 * 255);
    const g = Math.round(v < 0.5 ? v * 2 * 255 : (1 - v) * 2 * 255);
    const b = Math.round(v < 0.5 ? (1 - v * 2) * 255 : 0);
    return [r, g, b];
  },

  // Continuous float: grayscale
  gray: (v) => {
    const c = Math.round(v * 255);
    return [c, c, c];
  },

  // Elevation: green-brown gradient
  terrain: (v) => [
    Math.round(80 + v * 140),
    Math.round(120 + v * 80),
    Math.round(40 + v * 40),
  ],

  // Binary mask: blue/tan
  mask: (v) => v > 0 ? [34, 102, 204] : [221, 238, 221],

  // Reservation grid: categorical colours
  reservation: (v) => {
    const colors = {
      0: [26, 26, 46],
      1: [255, 165, 0],     // commercial
      2: [128, 128, 128],   // industrial
      3: [0, 100, 255],     // civic
      4: [0, 200, 0],       // open space
      5: [180, 140, 60],    // agriculture
      6: [200, 160, 80],    // residential fine
      7: [180, 80, 80],     // residential estate
      8: [160, 100, 200],   // residential quality
    };
    return colors[v] || [26, 26, 46];
  },

  // Zone grid: golden hue by zone ID
  zone: (v) => {
    if (v === 0) return [26, 26, 46];
    const hue = (v * 137.508) % 360;
    // Simple HSL→RGB for s=0.7, l=0.5
    const c = 0.7;
    const x = c * (1 - Math.abs((hue / 60) % 2 - 1));
    let r1, g1, b1;
    if (hue < 60) [r1, g1, b1] = [c, x, 0];
    else if (hue < 120) [r1, g1, b1] = [x, c, 0];
    else if (hue < 180) [r1, g1, b1] = [0, c, x];
    else if (hue < 240) [r1, g1, b1] = [0, x, c];
    else if (hue < 300) [r1, g1, b1] = [x, 0, c];
    else [r1, g1, b1] = [c, 0, x];
    return [Math.round((r1 + 0.3) * 255), Math.round((g1 + 0.3) * 255), Math.round((b1 + 0.3) * 255)];
  },
};

export class BitmapLogger {
  /**
   * @param {string} traceDir - output directory for this trace
   */
  constructor(traceDir) {
    this.traceDir = traceDir;
    this._seq = 0;
    this._entries = [];

    if (!existsSync(traceDir)) {
      mkdirSync(traceDir, { recursive: true });
    }
  }

  /**
   * Log a grid snapshot.
   * @param {string} step - pipeline step name (e.g. 'setup', 'tick-5')
   * @param {string} layerName - layer name (e.g. 'elevation', 'reservationGrid')
   * @param {Grid2D|{width,height,get}} grid - the grid to snapshot
   * @param {string} [palette='heat'] - colour palette name
   * @param {string} [description] - optional description
   */
  log(step, layerName, grid, palette = 'heat', description) {
    this._seq++;
    const padded = String(this._seq).padStart(3, '0');
    const filename = `${padded}-${step}-${layerName}.ppm`;
    const filepath = `${this.traceDir}/${filename}`;

    const w = grid.width;
    const h = grid.height;
    const colorFn = PALETTES[palette] || PALETTES.heat;

    // For continuous palettes, normalise to 0-1
    let min = Infinity, max = -Infinity;
    const needsNorm = palette === 'heat' || palette === 'gray' || palette === 'terrain';
    if (needsNorm) {
      for (let z = 0; z < h; z++) {
        for (let x = 0; x < w; x++) {
          const v = grid.get(x, z);
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
    }
    const range = max - min || 1;

    const header = `P6\n${w} ${h}\n255\n`;
    const pixels = new Uint8Array(w * h * 3);

    for (let z = 0; z < h; z++) {
      for (let x = 0; x < w; x++) {
        let v = grid.get(x, z);
        if (needsNorm) v = (v - min) / range;
        const [r, g, b] = colorFn(v);
        const idx = (z * w + x) * 3;
        pixels[idx] = Math.min(255, Math.max(0, r));
        pixels[idx + 1] = Math.min(255, Math.max(0, g));
        pixels[idx + 2] = Math.min(255, Math.max(0, b));
      }
    }

    writeFileSync(filepath, Buffer.concat([Buffer.from(header), Buffer.from(pixels)]));

    const desc = description || `${step}: ${layerName}`;
    this._entries.push({ seq: this._seq, step, layerName, filename, palette, description: desc });

    console.log(`[trace] ${filename} (${w}×${h}, ${palette})`);
  }

  /**
   * Log all named layers on a map at once.
   * @param {string} step - pipeline step name
   * @param {object} map - FeatureMap with hasLayer/getLayer
   * @param {Array<[string, string]>} layerSpecs - [[layerName, palette], ...]
   */
  logLayers(step, map, layerSpecs) {
    for (const [name, palette] of layerSpecs) {
      if (map.hasLayer(name)) {
        this.log(step, name, map.getLayer(name), palette);
      }
    }
  }

  /**
   * Write an index file listing all captured snapshots.
   */
  writeIndex() {
    const lines = ['# Pipeline Trace', ''];
    for (const e of this._entries) {
      lines.push(`- **${e.seq}.** \`${e.filename}\` — ${e.description}`);
    }
    writeFileSync(`${this.traceDir}/index.md`, lines.join('\n'));
    console.log(`[trace] Index written: ${this._entries.length} snapshots`);
  }
}

/**
 * No-op logger for when tracing is disabled.
 */
export class NullLogger {
  log() {}
  logLayers() {}
  writeIndex() {}
}
