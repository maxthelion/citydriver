#!/usr/bin/env bun
/**
 * render-sector-cross-streets.js — Cross streets per sector (zone x face).
 *
 * Runs layCrossStreets on sectors (zone x face intersections) instead of
 * whole zones, so each sector gets its own local gradient direction.
 *
 * Usage: bun scripts/render-sector-cross-streets.js <seed> <gx> <gz> [outDir]
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { layCrossStreets } from '../src/city/incremental/crossStreets.js';
import { segmentTerrainV2 } from '../src/city/incremental/ridgeSegmentationV2.js';
import { loadMapForStep } from './fixture-bootstrap.js';

// === CLI ===
const cliArgs = process.argv.slice(2);
const getArg = (name, def = null) => {
  const idx = cliArgs.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < cliArgs.length ? cliArgs[idx + 1] : def;
};
const fixturePath = getArg('fixture', null);
const seed = fixturePath ? NaN : (parseInt(process.argv[2]) || 42);
const gx = fixturePath ? NaN : (parseInt(process.argv[3]) || 27);
const gz = fixturePath ? NaN : (parseInt(process.argv[4]) || 95);
const outDir = fixturePath ? (getArg('out', 'experiments/021-output')) : (process.argv[5] || 'experiments/021-output');
const outputPrefix = getArg('output-prefix', '');
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

// === Pipeline setup ===
const t0 = performance.now();
const { map, runSeed, fixtureMeta } = await loadMapForStep({
  fixturePath,
  seed,
  gx,
  gz,
  step: 'spatial',
  archetype: 'marketTown',
});
if (fixturePath) {
  console.log(`Loaded fixture: ${fixturePath}`);
  console.log(`Fixture step: ${fixtureMeta?.afterStep ?? 'unknown'}`);
}

const zones = map.developmentZones;
const W = map.width, H = map.height;
const cs = map.cellSize;
const ox = map.originX, oz = map.originZ;
const elev = map.getLayer('elevation');
const roadGrid = map.getLayer('roadGrid');
const waterMask = map.getLayer('waterMask');
const eBounds = elev.bounds();
const eRange = eBounds.max - eBounds.min || 1;

// === Segment terrain into faces (once for whole map) ===
console.log('Segmenting terrain...');
const { faces } = segmentTerrainV2(map, {
  dirTolerance: Math.PI / 6,
  elevTolerance: 100,
  slopeBands: [0.3, 0.8],
});
console.log(`Terrain faces: ${faces.length}`);

// Build cellToFace lookup
const cellToFace = new Map();
for (let fi = 0; fi < faces.length; fi++) {
  for (const c of faces[fi].cells) {
    cellToFace.set(c.gz * W + c.gx, fi);
  }
}

// === Zone selection (same as render-cross-streets.js) ===
const candidates = zones.filter(z =>
  z.cells.length > 500 &&
  z.boundary && z.boundary.length >= 4 && z.avgSlope !== undefined
);
candidates.sort((a, b) => {
  const ad = Math.abs(a.centroidGx - W / 2) + Math.abs(a.centroidGz - H / 2);
  const bd = Math.abs(b.centroidGx - W / 2) + Math.abs(b.centroidGz - H / 2);
  return ad - bd;
});
const selectedZones = candidates.slice(0, 3);

if (selectedZones.length === 0) {
  console.error('No suitable zones found');
  process.exit(1);
}

console.log(`Found ${candidates.length} candidate zones, rendering ${selectedZones.length}`);

// === HSL to RGB ===
function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

// === Process each zone ===
for (let zi = 0; zi < selectedZones.length; zi++) {
  const zone = selectedZones[zi];
  console.log(`\n=== Zone ${zi} ===`);
  console.log(`  ${zone.cells.length} cells, avgSlope=${zone.avgSlope.toFixed(3)}`);

  // Zone bounding box for cropped render
  let minGx = W, maxGx = 0, minGz = H, maxGz = 0;
  for (const c of zone.cells) {
    if (c.gx < minGx) minGx = c.gx;
    if (c.gx > maxGx) maxGx = c.gx;
    if (c.gz < minGz) minGz = c.gz;
    if (c.gz > maxGz) maxGz = c.gz;
  }
  const pad = 20;
  minGx = Math.max(0, minGx - pad);
  maxGx = Math.min(W - 1, maxGx + pad);
  minGz = Math.max(0, minGz - pad);
  maxGz = Math.min(H - 1, maxGz + pad);
  const cropW = maxGx - minGx + 1;
  const cropH = maxGz - minGz + 1;
  console.log(`  Crop: ${cropW}x${cropH} at (${minGx},${minGz})`);

  // === Build sectors (zone x face intersections) ===
  const sectorMap = new Map(); // faceIdx -> cells[]
  for (const c of zone.cells) {
    const key = c.gz * W + c.gx;
    const fi = cellToFace.get(key);
    if (fi === undefined) continue;
    if (!sectorMap.has(fi)) sectorMap.set(fi, []);
    sectorMap.get(fi).push(c);
  }

  // Build sector objects, filtering out < 50 cells
  const MIN_SECTOR_CELLS = 50;
  const sectors = [];
  for (const [fi, cells] of sectorMap) {
    if (cells.length < MIN_SECTOR_CELLS) continue;

    // Compute centroid
    let cx = 0, cz = 0;
    for (const c of cells) { cx += c.gx; cz += c.gz; }
    cx /= cells.length;
    cz /= cells.length;

    // Use face's slopeDir and avgSlope
    const face = faces[fi];

    sectors.push({
      cells,
      centroidGx: cx,
      centroidGz: cz,
      avgSlope: face ? face.avgSlope : zone.avgSlope,
      slopeDir: face ? face.slopeDir : zone.slopeDir,
      boundary: zone.boundary, // reuse zone boundary
      faceIdx: fi,
    });
  }

  console.log(`  Sectors: ${sectors.length} (from ${sectorMap.size} face intersections, min ${MIN_SECTOR_CELLS} cells)`);

  // Run cross streets per sector
  const allCrossStreets = [];
  for (let si = 0; si < sectors.length; si++) {
    const sector = sectors[si];
    const { crossStreets, gradDir } = layCrossStreets(sector, map);
    console.log(`    Sector ${si}: ${sector.cells.length} cells, ${crossStreets.length} cross streets, grad=(${gradDir.x.toFixed(3)},${gradDir.z.toFixed(3)})`);
    allCrossStreets.push(...crossStreets);
  }

  console.log(`  Total cross streets: ${allCrossStreets.length}`);

  // === Build sector cell lookup for boundary detection ===
  const cellToSector = new Map();
  for (let si = 0; si < sectors.length; si++) {
    for (const c of sectors[si].cells) {
      cellToSector.set(c.gz * W + c.gx, si);
    }
  }

  // Assign sector colors
  const sectorColors = sectors.map((_, i) => {
    const hue = (i * 137.508) % 360;
    return hslToRgb(hue, 0.6, 0.45);
  });

  // ===== Render =====
  const pixels = new Uint8Array(cropW * cropH * 3);

  // Layer 1: Elevation grayscale base
  for (let z = 0; z < cropH; z++) {
    for (let x = 0; x < cropW; x++) {
      const gx2 = x + minGx, gz2 = z + minGz;
      const v = (elev.get(gx2, gz2) - eBounds.min) / eRange;
      const idx = (z * cropW + x) * 3;
      if (waterMask && waterMask.get(gx2, gz2) > 0) {
        pixels[idx] = 15; pixels[idx + 1] = 30; pixels[idx + 2] = 80;
      } else {
        const grey = Math.round(40 + v * 80);
        pixels[idx] = grey; pixels[idx + 1] = grey; pixels[idx + 2] = grey;
      }
    }
  }

  // Layer 2: Sector fills (semi-transparent)
  const ALPHA = 0.35;
  for (let si = 0; si < sectors.length; si++) {
    const color = sectorColors[si];
    for (const c of sectors[si].cells) {
      const px = c.gx - minGx;
      const pz = c.gz - minGz;
      if (px < 0 || px >= cropW || pz < 0 || pz >= cropH) continue;
      const idx = (pz * cropW + px) * 3;
      pixels[idx]     = Math.round(pixels[idx]     * (1 - ALPHA) + color[0] * ALPHA);
      pixels[idx + 1] = Math.round(pixels[idx + 1] * (1 - ALPHA) + color[1] * ALPHA);
      pixels[idx + 2] = Math.round(pixels[idx + 2] * (1 - ALPHA) + color[2] * ALPHA);
    }
  }

  // Layer 3: Contour lines (dark green, every 5m)
  const contourInterval = 5;
  for (let z = 0; z < cropH; z++) {
    for (let x = 0; x < cropW; x++) {
      const gx2 = x + minGx, gz2 = z + minGz;
      const e = elev.get(gx2, gz2);
      let isContour = false;
      const eBin = Math.floor(e / contourInterval);
      if (gx2 + 1 < W && Math.floor(elev.get(gx2 + 1, gz2) / contourInterval) !== eBin) isContour = true;
      if (gz2 + 1 < H && Math.floor(elev.get(gx2, gz2 + 1) / contourInterval) !== eBin) isContour = true;
      if (isContour) {
        const idx = (z * cropW + x) * 3;
        pixels[idx] = Math.min(255, pixels[idx] + 30);
        pixels[idx + 1] = Math.min(255, pixels[idx + 1] + 50);
        pixels[idx + 2] = Math.min(255, pixels[idx + 2] + 20);
      }
    }
  }

  // Layer 4: Roads (grey)
  if (roadGrid) {
    for (let z = 0; z < cropH; z++)
      for (let x = 0; x < cropW; x++)
        if (roadGrid.get(x + minGx, z + minGz) > 0) {
          const idx = (z * cropW + x) * 3;
          pixels[idx] = 150; pixels[idx + 1] = 150; pixels[idx + 2] = 150;
        }
  }

  // Layer 5: Cross streets per sector (magenta polylines, green start, white end)
  for (const street of allCrossStreets) {
    const pts = street.points;
    for (let i = 1; i < pts.length; i++) {
      bres(pixels, cropW, cropH,
        Math.round((pts[i - 1].x - ox) / cs) - minGx, Math.round((pts[i - 1].z - oz) / cs) - minGz,
        Math.round((pts[i].x - ox) / cs) - minGx, Math.round((pts[i].z - oz) / cs) - minGz,
        255, 0, 255);
    }
    // Start dot (green, 3px)
    const sx = Math.round((pts[0].x - ox) / cs) - minGx;
    const sz = Math.round((pts[0].z - oz) / cs) - minGz;
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        if (sx + dx >= 0 && sx + dx < cropW && sz + dz >= 0 && sz + dz < cropH) {
          const idx = ((sz + dz) * cropW + (sx + dx)) * 3;
          pixels[idx] = 0; pixels[idx + 1] = 255; pixels[idx + 2] = 0;
        }
    // End dot (white, 3px)
    const ex = Math.round((pts[pts.length - 1].x - ox) / cs) - minGx;
    const ez = Math.round((pts[pts.length - 1].z - oz) / cs) - minGz;
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        if (ex + dx >= 0 && ex + dx < cropW && ez + dz >= 0 && ez + dz < cropH) {
          const idx = ((ez + dz) * cropW + (ex + dx)) * 3;
          pixels[idx] = 255; pixels[idx + 1] = 255; pixels[idx + 2] = 255;
        }
  }

  // Layer 6: Sector boundaries (thin white lines between sectors)
  for (let si = 0; si < sectors.length; si++) {
    for (const c of sectors[si].cells) {
      const key = c.gz * W + c.gx;
      for (const [dx, dz] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nk = (c.gz + dz) * W + (c.gx + dx);
        const nsi = cellToSector.get(nk);
        if (nsi !== undefined && nsi !== si) {
          const px = c.gx - minGx;
          const pz = c.gz - minGz;
          if (px >= 0 && px < cropW && pz >= 0 && pz < cropH) {
            const idx = (pz * cropW + px) * 3;
            pixels[idx] = 220; pixels[idx + 1] = 220; pixels[idx + 2] = 220;
          }
          break;
        }
      }
    }
  }

  // Layer 7: Zone boundary (yellow, 2px thick)
  if (zone.boundary) {
    for (let i = 0; i < zone.boundary.length; i++) {
      const p1 = zone.boundary[i], p2 = zone.boundary[(i + 1) % zone.boundary.length];
      const x0 = Math.round((p1.x - ox) / cs) - minGx;
      const y0 = Math.round((p1.z - oz) / cs) - minGz;
      const x1 = Math.round((p2.x - ox) / cs) - minGx;
      const y1 = Math.round((p2.z - oz) / cs) - minGz;
      bres(pixels, cropW, cropH, x0, y0, x1, y1, 255, 255, 0);
      bres(pixels, cropW, cropH, x0 + 1, y0, x1 + 1, y1, 255, 255, 0);
      bres(pixels, cropW, cropH, x0, y0 + 1, x1, y1 + 1, 255, 255, 0);
    }
  }

  // === Write output ===
  const header = `P6\n${cropW} ${cropH}\n255\n`;
  const basePath = `${outDir}/${outputPrefix}cross-streets-zone${zi}-seed${runSeed}`;
  writeFileSync(`${basePath}.ppm`, Buffer.concat([Buffer.from(header), Buffer.from(pixels)]));
  try { execSync(`convert "${basePath}.ppm" "${basePath}.png" 2>/dev/null`); } catch {}
  console.log(`  Written to ${basePath}.png (${cropW}x${cropH})`);
}

console.log(`\nTotal time: ${((performance.now() - t0) / 1000).toFixed(1)}s`);

// === Bresenham line draw ===
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
