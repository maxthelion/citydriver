#!/usr/bin/env bun
/**
 * render-incremental-streets.js — Incremental street layout visualiser.
 *
 * Runs the incremental street layout library on selected zones and
 * renders cropped PPM/PNG per zone showing terrain, zone boundary,
 * existing roads, water, construction lines, parallel streets, junctions,
 * and parcels.
 *
 * Usage: bun scripts/render-incremental-streets.js <seed> <gx> <gz> [outDir]
 */

import { generateRegionFromSeed } from '../src/ui/regionHelper.js';
import { setupCity } from '../src/city/setup.js';
import { LandFirstDevelopment } from '../src/city/strategies/landFirstDevelopment.js';
import { ARCHETYPES } from '../src/city/archetypes.js';
import { SeededRandom } from '../src/core/rng.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { runToStep } from './pipeline-utils.js';
import { layoutIncrementalStreets } from '../src/city/incremental/index.js';

// === CLI ===
const seed = parseInt(process.argv[2]) || 42;
const gx = parseInt(process.argv[3]) || 27;
const gz = parseInt(process.argv[4]) || 95;
const outDir = process.argv[5] || 'experiments/incremental-output';
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

// === Pipeline setup ===
const t0 = performance.now();
const { layers, settlement } = generateRegionFromSeed(seed, gx, gz);
if (!settlement) { console.error('No settlement'); process.exit(1); }

const rng = new SeededRandom(seed);
const map = setupCity(layers, settlement, rng.fork('city'));
const strategy = new LandFirstDevelopment(map, { archetype: ARCHETYPES.marketTown });
runToStep(strategy, 'spatial');

const zones = map.developmentZones;
const W = map.width, H = map.height;
const cs = map.cellSize;
const ox = map.originX, oz = map.originZ;
const elev = map.getLayer('elevation');
const roadGrid = map.getLayer('roadGrid');
const waterMask = map.getLayer('waterMask');
const eBounds = elev.bounds();
const eRange = eBounds.max - eBounds.min || 1;

// === Zone selection ===
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

// Summary accumulators
const zoneResults = [];

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

  // ===== Run incremental street layout =====
  const result = layoutIncrementalStreets(zone, map);
  const { constructionLines, streets, parcels, plots, wasteRatio, gradDir, contourDir } = result;

  console.log(`  Gradient: (${gradDir.x.toFixed(3)}, ${gradDir.z.toFixed(3)}), Contour: (${contourDir.x.toFixed(3)}, ${contourDir.z.toFixed(3)})`);
  console.log(`  Phase 1: ${constructionLines.length} construction lines`);
  console.log(`  Phase 2: ${streets.length} parallel streets`);
  console.log(`  Parcels: ${parcels.length}, Plots: ${plots.length}`);
  console.log(`  Waste ratio: ${(wasteRatio * 100).toFixed(1)}%`);

  // Post-hoc diagnostics
  const d = result.diagnostics;
  console.log(`  --- Diagnostics ${d.passed ? 'PASS' : 'FAIL'} ---`);
  if (d.cLineConvergence > 0) console.log(`    ✗ Construction line convergence: ${d.cLineConvergence} violations`);
  if (d.parallelViolations > 0) console.log(`    ✗ Parallel separation (<5m): ${d.parallelViolations} violations`);
  if (d.unresolvedCrossings > 0) console.log(`    ✗ Unresolved crossings: ${d.unresolvedCrossings}`);
  if (d.shortDeadEnds > 0) console.log(`    ✗ Short dead-ends (<15m): ${d.shortDeadEnds}`);
  if (d.duplicateJunctions > 0) console.log(`    ✗ Duplicate junctions (<5m apart): ${d.duplicateJunctions}`);
  if (d.sliverParcels > 0) console.log(`    ✗ Sliver parcels: ${d.sliverParcels}`);
  if (d.wasteRatio >= 0.4) console.log(`    ✗ Waste ratio: ${(d.wasteRatio * 100).toFixed(1)}% (target <40%)`);
  if (d.passed) console.log(`    All checks passed`);

  // Derive junctions from street endpoints
  const allJunctions = [];
  for (const s of streets) {
    allJunctions.push(s.start);
    allJunctions.push(s.end);
  }

  zoneResults.push({
    zi,
    cells: zone.cells.length,
    constructionLines: constructionLines.length,
    streets: streets.length,
    parcels: parcels.length,
    plots: plots.length,
    wasteRatio,
    diagnostics: result.diagnostics,
  });

  // ===== Render =====
  const pixels = new Uint8Array(cropW * cropH * 3);

  // Terrain base (elevation grayscale)
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

  // Parcels (faint tinted fills)
  for (let pi = 0; pi < parcels.length; pi++) {
    const parcel = parcels[pi];
    const pxCorners = parcel.corners.map(c => ({
      x: Math.round((c.x - ox) / cs) - minGx,
      z: Math.round((c.z - oz) / cs) - minGz,
    }));

    let pMinX = cropW, pMaxX = 0, pMinZ = cropH, pMaxZ = 0;
    for (const c of pxCorners) {
      if (c.x < pMinX) pMinX = c.x;
      if (c.x > pMaxX) pMaxX = c.x;
      if (c.z < pMinZ) pMinZ = c.z;
      if (c.z > pMaxZ) pMaxZ = c.z;
    }
    pMinX = Math.max(0, pMinX); pMaxX = Math.min(cropW - 1, pMaxX);
    pMinZ = Math.max(0, pMinZ); pMaxZ = Math.min(cropH - 1, pMaxZ);

    const edges = [];
    for (let i = 0; i < 4; i++) {
      edges.push({
        x: pxCorners[(i + 1) % 4].x - pxCorners[i].x,
        z: pxCorners[(i + 1) % 4].z - pxCorners[i].z,
        ox: pxCorners[i].x,
        oz: pxCorners[i].z,
      });
    }

    const tints = [
      [40, 60, 40], [40, 40, 60], [60, 50, 40], [50, 40, 60],
    ];
    const [tr, tg, tb] = tints[pi % tints.length];

    for (let pz = pMinZ; pz <= pMaxZ; pz++) {
      for (let px = pMinX; px <= pMaxX; px++) {
        let allPos = true, allNeg = true;
        for (const e of edges) {
          const cross = e.x * (pz - e.oz) - e.z * (px - e.ox);
          if (cross < 0) allPos = false;
          if (cross > 0) allNeg = false;
        }
        if (allPos || allNeg) {
          const idx = (pz * cropW + px) * 3;
          pixels[idx] = Math.min(255, Math.round(pixels[idx] * 0.5 + tr));
          pixels[idx + 1] = Math.min(255, Math.round(pixels[idx + 1] * 0.5 + tg));
          pixels[idx + 2] = Math.min(255, Math.round(pixels[idx + 2] * 0.5 + tb));
        }
      }
    }
  }

  // Roads (light grey)
  if (roadGrid) {
    for (let z = 0; z < cropH; z++)
      for (let x = 0; x < cropW; x++)
        if (roadGrid.get(x + minGx, z + minGz) > 0) {
          const idx = (z * cropW + x) * 3;
          pixels[idx] = 150; pixels[idx + 1] = 150; pixels[idx + 2] = 150;
        }
  }

  // Zone boundary (yellow)
  if (zone.boundary) {
    for (let i = 0; i < zone.boundary.length; i++) {
      const p1 = zone.boundary[i], p2 = zone.boundary[(i + 1) % zone.boundary.length];
      bres(pixels, cropW, cropH,
        Math.round((p1.x - ox) / cs) - minGx, Math.round((p1.z - oz) / cs) - minGz,
        Math.round((p2.x - ox) / cs) - minGx, Math.round((p2.z - oz) / cs) - minGz,
        200, 200, 0);
    }
  }

  // Construction lines (magenta) — draw as polylines for curved lines
  for (const cLine of constructionLines) {
    const pts = cLine.points || [cLine.start, cLine.end];
    for (let i = 1; i < pts.length; i++) {
      bres(pixels, cropW, cropH,
        Math.round((pts[i - 1].x - ox) / cs) - minGx, Math.round((pts[i - 1].z - oz) / cs) - minGz,
        Math.round((pts[i].x - ox) / cs) - minGx, Math.round((pts[i].z - oz) / cs) - minGz,
        255, 0, 255);
    }
  }

  // Parallel streets (cyan)
  for (const s of streets) {
    bres(pixels, cropW, cropH,
      Math.round((s.start.x - ox) / cs) - minGx, Math.round((s.start.z - oz) / cs) - minGz,
      Math.round((s.end.x - ox) / cs) - minGx, Math.round((s.end.z - oz) / cs) - minGz,
      0, 220, 220);
  }

  // Junction dots (white, 3px)
  for (const j of allJunctions) {
    const jx = Math.round((j.x - ox) / cs) - minGx;
    const jz = Math.round((j.z - oz) / cs) - minGz;
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        if (jx + dx >= 0 && jx + dx < cropW && jz + dz >= 0 && jz + dz < cropH) {
          const idx = ((jz + dz) * cropW + (jx + dx)) * 3;
          pixels[idx] = 255; pixels[idx + 1] = 255; pixels[idx + 2] = 255;
        }
  }

  // === Write output ===
  const header = `P6\n${cropW} ${cropH}\n255\n`;
  const basePath = `${outDir}/incremental-zone${zi}-seed${seed}`;
  writeFileSync(`${basePath}.ppm`, Buffer.concat([Buffer.from(header), Buffer.from(pixels)]));
  try { execSync(`convert "${basePath}.ppm" "${basePath}.png" 2>/dev/null`); } catch {}
  console.log(`  Written to ${basePath}.png (${cropW}x${cropH})`);
}

// ===== Summary =====
console.log(`\n=== Summary ===`);
console.log(`Total zones rendered: ${zoneResults.length}`);
for (const r of zoneResults) {
  console.log(`  Zone ${r.zi}: cells=${r.cells} construction=${r.constructionLines} streets=${r.streets} parcels=${r.parcels} plots=${r.plots} waste=${(r.wasteRatio * 100).toFixed(1)}%`);
}
console.log(`Total time: ${((performance.now() - t0) / 1000).toFixed(1)}s`);

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
