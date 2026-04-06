#!/usr/bin/env bun
/**
 * test-ribbons.js — Test ribbon algorithm with synthetic cross streets.
 *
 * Creates known cross street configurations, runs layRibbons, and
 * renders the results so we can see exactly what's happening.
 */

import { layRibbons } from '../src/city/incremental/ribbons.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const outDir = process.argv[2] || '/tmp/test-ribbons';
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

// === Test configurations ===

const tests = [
  {
    name: 'parallel-equal',
    desc: 'Two parallel vertical lines, same length, 90m apart',
    crossStreets: [
      makeCS([{ x: 0, z: 0 }, { x: 0, z: 300 }], -45),
      makeCS([{ x: 90, z: 0 }, { x: 90, z: 300 }], 45),
    ],
  },
  {
    name: 'parallel-offset',
    desc: 'Two parallel vertical lines, right one starts 50m higher',
    crossStreets: [
      makeCS([{ x: 0, z: 0 }, { x: 0, z: 300 }], -45),
      makeCS([{ x: 90, z: 50 }, { x: 90, z: 350 }], 45),
    ],
  },
  {
    name: 'parallel-short-right',
    desc: 'Right line is much shorter (150m vs 300m)',
    crossStreets: [
      makeCS([{ x: 0, z: 0 }, { x: 0, z: 300 }], -45),
      makeCS([{ x: 90, z: 75 }, { x: 90, z: 225 }], 45),
    ],
  },
  {
    name: 'angled',
    desc: 'Two lines at 45°, same length, 90m apart along contour',
    crossStreets: [
      makeCS([{ x: 0, z: 0 }, { x: 150, z: 150 }], -45),
      makeCS([{ x: 90, z: 0 }, { x: 240, z: 150 }], 45),
    ],
  },
  {
    name: 'three-parallel',
    desc: 'Three parallel vertical lines, 90m spacing',
    crossStreets: [
      makeCS([{ x: 0, z: 0 }, { x: 0, z: 300 }], -90),
      makeCS([{ x: 90, z: 0 }, { x: 90, z: 300 }], 0),
      makeCS([{ x: 180, z: 0 }, { x: 180, z: 300 }], 90),
    ],
  },
  {
    name: 'converging',
    desc: 'Two lines that converge (narrowing corridor)',
    crossStreets: [
      makeCS([{ x: 0, z: 0 }, { x: 0, z: 300 }], -45),
      makeCS([{ x: 120, z: 0 }, { x: 60, z: 300 }], 45),
    ],
  },
  {
    name: 'realistic-scan',
    desc: 'Many-point scan lines at slight angle, 90m contour spacing',
    crossStreets: [
      // Gradient (0.95, -0.31). Contour direction ≈ (0.31, 0.95).
      // 90m apart along contour = 90*(0.31, 0.95) = (28, 85.5) offset between streets
      makeScanCS(0, 0, 300, 0.95, -0.31, 2.5, -45),
      makeScanCS(28, 85, 385, 0.95, -0.31, 2.5, 0),
      makeScanCS(56, 171, 471, 0.95, -0.31, 2.5, 45),
    ],
  },
  {
    name: 'realistic-diverging',
    desc: 'Scan lines that diverge slightly (different gradient angles)',
    crossStreets: [
      makeScanCS(0, 0, 300, 0.95, -0.31, 2.5, -45),
      makeScanCS(90, 0, 300, 0.97, -0.24, 2.5, 45),   // slightly different angle
    ],
  },
];

function makeCS(points, ctOff) {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i].x - points[i-1].x, points[i].z - points[i-1].z);
  }
  return { points, ctOff, length: len };
}

/** Create a many-point cross street like the real gradient scan produces. */
function makeScanCS(startX, startZ, endZ, gradX, gradZ, stepSize, ctOff) {
  const points = [];
  const totalDist = (endZ - startZ) / gradZ; // distance along gradient
  const numSteps = Math.abs(Math.round(totalDist / stepSize));
  for (let i = 0; i <= numSteps; i++) {
    const t = i * stepSize;
    points.push({
      x: startX + gradX * t,
      z: startZ + gradZ * t,
    });
  }
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i].x - points[i-1].x, points[i].z - points[i-1].z);
  }
  return { points, ctOff, length: len };
}

// === Mock map and zone ===

function makeMockMap(crossStreets) {
  // Find bounding box of all cross streets
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const cs of crossStreets) {
    for (const p of cs.points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
  }

  const pad = 50;
  const cellSize = 5;
  const originX = minX - pad;
  const originZ = minZ - pad;
  const width = Math.ceil((maxX - minX + 2 * pad) / cellSize);
  const height = Math.ceil((maxZ - minZ + 2 * pad) / cellSize);

  // Build zone cells covering the entire area
  const cells = [];
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      cells.push({ gx, gz });
    }
  }

  return {
    map: {
      cellSize,
      width,
      height,
      originX,
      originZ,
      hasLayer: (name) => name === 'waterMask' ? false : false,
      getLayer: () => null,
      roadNetwork: {
        roads: [],
        add: (polyline, attrs) => {
          const road = { id: Math.random(), polyline, ...attrs };
          return road;
        },
        remove: () => {},
      },
    },
    zone: {
      cells,
      centroidGx: width / 2,
      centroidGz: height / 2,
    },
    renderInfo: { minX: originX, minZ: originZ, width, height, cellSize },
  };
}

// === Run tests ===

for (const test of tests) {
  console.log(`\n=== ${test.name}: ${test.desc} ===`);

  const { map, zone, renderInfo } = makeMockMap(test.crossStreets);

  const { ribbons, parcels, angleRejects } = layRibbons(test.crossStreets, zone, map);

  console.log(`  Cross streets: ${test.crossStreets.length}`);
  console.log(`  Ribbons: ${ribbons.length}`);
  console.log(`  Parcels: ${parcels.length}`);
  console.log(`  Angle rejects: ${angleRejects}`);

  for (let i = 0; i < ribbons.length; i++) {
    const r = ribbons[i];
    const p0 = r.points[0], p1 = r.points[r.points.length - 1];
    console.log(`    ribbon ${i}: (${p0.x.toFixed(0)},${p0.z.toFixed(0)}) → (${p1.x.toFixed(0)},${p1.z.toFixed(0)}) len=${r.length.toFixed(0)}m`);
  }

  // Render
  const { minX, minZ, width: W, height: H, cellSize: cs } = renderInfo;
  const pixels = new Uint8Array(W * H * 3);

  // Background (dark grey)
  for (let i = 0; i < pixels.length; i += 3) {
    pixels[i] = 50; pixels[i+1] = 50; pixels[i+2] = 50;
  }

  // Cross streets (magenta)
  for (const street of test.crossStreets) {
    for (let i = 1; i < street.points.length; i++) {
      bres(pixels, W, H,
        Math.round((street.points[i-1].x - minX) / cs),
        Math.round((street.points[i-1].z - minZ) / cs),
        Math.round((street.points[i].x - minX) / cs),
        Math.round((street.points[i].z - minZ) / cs),
        255, 0, 255);
    }
  }

  // Ribbons (cyan)
  for (const ribbon of ribbons) {
    for (let i = 1; i < ribbon.points.length; i++) {
      bres(pixels, W, H,
        Math.round((ribbon.points[i-1].x - minX) / cs),
        Math.round((ribbon.points[i-1].z - minZ) / cs),
        Math.round((ribbon.points[i].x - minX) / cs),
        Math.round((ribbon.points[i].z - minZ) / cs),
        0, 255, 255);
    }
    // Endpoint dots (orange)
    for (const pt of [ribbon.points[0], ribbon.points[ribbon.points.length-1]]) {
      const px = Math.round((pt.x - minX) / cs);
      const pz = Math.round((pt.z - minZ) / cs);
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++)
          if (px+dx >= 0 && px+dx < W && pz+dz >= 0 && pz+dz < H) {
            const idx = ((pz+dz) * W + (px+dx)) * 3;
            pixels[idx] = 255; pixels[idx+1] = 165; pixels[idx+2] = 0;
          }
    }
  }

  const header = `P6\n${W} ${H}\n255\n`;
  const basePath = `${outDir}/${test.name}`;
  writeFileSync(`${basePath}.ppm`, Buffer.concat([Buffer.from(header), Buffer.from(pixels)]));
  try { execSync(`convert "${basePath}.ppm" "${basePath}.png" 2>/dev/null`); } catch {}
  console.log(`  Written to ${basePath}.png (${W}x${H})`);
}

function bres(pixels, w, h, x0, y0, x1, y1, r, g, b) {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, x = x0, y = y0;
  for (let i = 0; i < dx + dy + 2; i++) {
    if (x >= 0 && x < w && y >= 0 && y < h) {
      const idx = (y * w + x) * 3;
      pixels[idx] = r; pixels[idx + 1] = g; pixels[idx + 2] = b;
    }
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}
