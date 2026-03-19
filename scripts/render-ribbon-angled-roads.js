#!/usr/bin/env bun
/**
 * Experiment 007r: Grid between two non-parallel anchor roads.
 *
 * Finds a zone bounded by two roads at an angle, then lays a street grid
 * that compromises between being perpendicular to both roads.
 *
 * Approach:
 * - Find the two road edges of the zone
 * - Compute perpendicular direction for each
 * - Subdivide each road edge at regular intervals
 * - Connect corresponding points between the two edges
 *   (these become cross streets that gradually rotate from one road's
 *   perpendicular to the other's)
 * - Fill between adjacent cross streets with parallel streets
 */

import { generateRegionFromSeed } from '../src/ui/regionHelper.js';
import { setupCity } from '../src/city/setup.js';
import { LandFirstDevelopment } from '../src/city/strategies/landFirstDevelopment.js';
import { ARCHETYPES } from '../src/city/archetypes.js';
import { SeededRandom } from '../src/core/rng.js';
import { createZoneBoundaryRoads } from '../src/city/pipeline/zoneBoundaryRoads.js';
import { subdivideLargeZones } from '../src/city/pipeline/subdivideZones.js';
import { extractZones } from '../src/city/pipeline/extractZones.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const seed = parseInt(process.argv[2]) || 884469;
const gx = parseInt(process.argv[3]) || 27;
const gz = parseInt(process.argv[4]) || 95;
const outDir = process.argv[5] || 'experiments/007r-output';
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const t0 = performance.now();
const { layers, settlement } = generateRegionFromSeed(seed, gx, gz);
if (!settlement) { console.error('No settlement'); process.exit(1); }

const rng = new SeededRandom(seed);
const map = setupCity(layers, settlement, rng.fork('city'));
const strategy = new LandFirstDevelopment(map, { archetype: ARCHETYPES.marketTown });
for (let i = 0; i < 4; i++) strategy.tick();
createZoneBoundaryRoads(map);
subdivideLargeZones(map);
extractZones(map);

const zones = map.developmentZones;
const W = map.width, H = map.height, cs = map.cellSize;
const ox = map.originX, oz = map.originZ;
const roadGrid = map.getLayer('roadGrid');
const elev = map.getLayer('elevation');
const waterMask = map.getLayer('waterMask');

// === Find a zone between two angled roads ===

function findAngledZone() {
  for (const zone of zones) {
    if (zone.cells.length < 2000 || zone.cells.length > 30000) continue;
    if (!zone.boundary || zone.boundary.length < 4) continue;

    // Find boundary vertices near roads
    const nearRoad = [];
    for (let i = 0; i < zone.boundary.length; i++) {
      const p = zone.boundary[i];
      const pgx = Math.round((p.x - ox) / cs);
      const pgz = Math.round((p.z - oz) / cs);
      let near = false;
      for (let dz = -3; dz <= 3 && !near; dz++)
        for (let dx = -3; dx <= 3 && !near; dx++) {
          const nx = pgx + dx, nz = pgz + dz;
          if (nx >= 0 && nx < W && nz >= 0 && nz < H && roadGrid.get(nx, nz) > 0) near = true;
        }
      if (near) nearRoad.push({ x: p.x, z: p.z, idx: i });
    }

    if (nearRoad.length < 10) continue;

    // Cluster into groups (separate road edges)
    const groups = [];
    let cur = [nearRoad[0]];
    for (let i = 1; i < nearRoad.length; i++) {
      if (nearRoad[i].idx - nearRoad[i - 1].idx <= 3) {
        cur.push(nearRoad[i]);
      } else {
        if (cur.length >= 3) groups.push(cur);
        cur = [nearRoad[i]];
      }
    }
    if (cur.length >= 3) groups.push(cur);

    if (groups.length < 2) continue;

    // Compute angle of each group
    const edgeInfo = groups.slice(0, 2).map(g => {
      const first = g[0], last = g[g.length - 1];
      const dx = last.x - first.x, dz = last.z - first.z;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;
      return {
        points: g,
        dir: { x: dx / len, z: dz / len },
        perp: { x: -dz / len, z: dx / len }, // perpendicular
        angle: Math.atan2(dz, dx) * 180 / Math.PI,
        length: len,
      };
    });

    const angleDiff = Math.abs(edgeInfo[0].angle - edgeInfo[1].angle);
    const normalised = angleDiff > 90 ? 180 - angleDiff : angleDiff;

    if (normalised > 20 && normalised < 80) {
      return { zone, edges: edgeInfo, angleDiff: normalised };
    }
  }
  return null;
}

const found = findAngledZone();
if (!found) { console.error('No suitable angled zone found'); process.exit(1); }

const { zone, edges, angleDiff } = found;
console.log(`Zone: ${zone.cells.length} cells, angle diff: ${angleDiff.toFixed(0)}°`);
console.log(`  Edge A: ${edges[0].points.length} pts, angle ${edges[0].angle.toFixed(0)}°, length ${edges[0].length.toFixed(0)}m`);
console.log(`  Edge B: ${edges[1].points.length} pts, angle ${edges[1].angle.toFixed(0)}°, length ${edges[1].length.toFixed(0)}m`);

// === Ensure perpendiculars point inward ===
const centX = ox + zone.centroidGx * cs;
const centZ = oz + zone.centroidGz * cs;

for (const edge of edges) {
  const midX = (edge.points[0].x + edge.points[edge.points.length - 1].x) / 2;
  const midZ = (edge.points[0].z + edge.points[edge.points.length - 1].z) / 2;
  const toCentX = centX - midX, toCentZ = centZ - midZ;
  const dot = edge.perp.x * toCentX + edge.perp.z * toCentZ;
  if (dot < 0) {
    edge.perp.x = -edge.perp.x;
    edge.perp.z = -edge.perp.z;
  }
}

// === Subdivide both road edges at regular intervals ===
const CROSS_SPACING = 60; // metres between cross street start points

function subdivideEdge(edge, spacing) {
  const pts = edge.points;
  const result = [{ x: pts[0].x, z: pts[0].z }];
  let accum = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x, dz = pts[i].z - pts[i - 1].z;
    accum += Math.sqrt(dx * dx + dz * dz);
    if (accum >= spacing) {
      result.push({ x: pts[i].x, z: pts[i].z });
      accum = 0;
    }
  }
  // Always include last point
  const last = pts[pts.length - 1];
  if (result.length === 0 || (result[result.length-1].x !== last.x || result[result.length-1].z !== last.z)) {
    result.push({ x: last.x, z: last.z });
  }
  return result;
}

const ptsA = subdivideEdge(edges[0], CROSS_SPACING);
const ptsB = subdivideEdge(edges[1], CROSS_SPACING);

console.log(`  Edge A: ${ptsA.length} subdivided points`);
console.log(`  Edge B: ${ptsB.length} subdivided points`);

// === Connect corresponding points: cross streets ===
// Match by normalised position along each edge (0 to 1)
const count = Math.min(ptsA.length, ptsB.length);
const crossStreets = [];

for (let i = 0; i < count; i++) {
  const tA = ptsA.length === 1 ? 0 : i / (count - 1);
  const tB = ptsB.length === 1 ? 0 : i / (count - 1);
  const idxA = Math.min(ptsA.length - 1, Math.round(tA * (ptsA.length - 1)));
  const idxB = Math.min(ptsB.length - 1, Math.round(tB * (ptsB.length - 1)));
  crossStreets.push([ptsA[idxA], ptsB[idxB]]);
}

console.log(`  ${crossStreets.length} cross streets connecting edges`);

// === Fill parallel streets between adjacent cross streets ===
const PARALLEL_SPACING = 35; // metres
const parallelStreets = [];

for (let i = 0; i < crossStreets.length - 1; i++) {
  const [a1, a2] = crossStreets[i];     // cross street i: from edge A to edge B
  const [b1, b2] = crossStreets[i + 1]; // cross street i+1

  // Length of each cross street
  const lenLeft = Math.sqrt((a2.x - a1.x) ** 2 + (a2.z - a1.z) ** 2);
  const lenRight = Math.sqrt((b2.x - b1.x) ** 2 + (b2.z - b1.z) ** 2);
  const avgLen = (lenLeft + lenRight) / 2;
  const steps = Math.max(1, Math.floor(avgLen / PARALLEL_SPACING));

  for (let s = 1; s < steps; s++) {
    const t = s / steps;
    // Point on cross street i at fraction t
    const lx = a1.x + (a2.x - a1.x) * t;
    const lz = a1.z + (a2.z - a1.z) * t;
    // Point on cross street i+1 at fraction t
    const rx = b1.x + (b2.x - b1.x) * t;
    const rz = b1.z + (b2.z - b1.z) * t;
    parallelStreets.push([{ x: lx, z: lz }, { x: rx, z: rz }]);
  }
}

console.log(`  ${parallelStreets.length} parallel streets`);

// === Render cropped to zone ===
let minGx = W, maxGx = 0, minGz = H, maxGz = 0;
for (const c of zone.cells) {
  if (c.gx < minGx) minGx = c.gx;
  if (c.gx > maxGx) maxGx = c.gx;
  if (c.gz < minGz) minGz = c.gz;
  if (c.gz > maxGz) maxGz = c.gz;
}
const pad = 30;
minGx = Math.max(0, minGx - pad);
maxGx = Math.min(W - 1, maxGx + pad);
minGz = Math.max(0, minGz - pad);
maxGz = Math.min(H - 1, maxGz + pad);
const cropW = maxGx - minGx + 1;
const cropH = maxGz - minGz + 1;

const pixels = new Uint8Array(cropW * cropH * 3);

// Terrain
const eBounds = elev.bounds();
const eRange = eBounds.max - eBounds.min || 1;
for (let z = 0; z < cropH; z++)
  for (let x = 0; x < cropW; x++) {
    const gx2 = x + minGx, gz2 = z + minGz;
    const v = (elev.get(gx2, gz2) - eBounds.min) / eRange;
    const idx = (z * cropW + x) * 3;
    if (waterMask && waterMask.get(gx2, gz2) > 0) {
      pixels[idx] = 15; pixels[idx + 1] = 30; pixels[idx + 2] = 60;
    } else {
      pixels[idx] = Math.round(35 + v * 50);
      pixels[idx + 1] = Math.round(45 + v * 40);
      pixels[idx + 2] = Math.round(25 + v * 25);
    }
  }

// Zone fill
for (const c of zone.cells) {
  const x = c.gx - minGx, z = c.gz - minGz;
  if (x >= 0 && x < cropW && z >= 0 && z < cropH) {
    const idx = (z * cropW + x) * 3;
    pixels[idx] = 55; pixels[idx + 1] = 85; pixels[idx + 2] = 55;
  }
}

// Roads (light gray)
for (let z = 0; z < cropH; z++)
  for (let x = 0; x < cropW; x++)
    if (roadGrid.get(x + minGx, z + minGz) > 0) {
      const idx = (z * cropW + x) * 3;
      pixels[idx] = 150; pixels[idx + 1] = 150; pixels[idx + 2] = 150;
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

// Road edge A (bright red)
for (const p of edges[0].points) {
  const x = Math.round((p.x - ox) / cs) - minGx;
  const z = Math.round((p.z - oz) / cs) - minGz;
  if (x >= 0 && x < cropW && z >= 0 && z < cropH) {
    const idx = (z * cropW + x) * 3;
    pixels[idx] = 255; pixels[idx + 1] = 50; pixels[idx + 2] = 50;
  }
}

// Road edge B (bright blue)
for (const p of edges[1].points) {
  const x = Math.round((p.x - ox) / cs) - minGx;
  const z = Math.round((p.z - oz) / cs) - minGz;
  if (x >= 0 && x < cropW && z >= 0 && z < cropH) {
    const idx = (z * cropW + x) * 3;
    pixels[idx] = 50; pixels[idx + 1] = 50; pixels[idx + 2] = 255;
  }
}

// Cross streets (magenta, 1px)
for (const [a, b] of crossStreets) {
  bres(pixels, cropW, cropH,
    Math.round((a.x - ox) / cs) - minGx, Math.round((a.z - oz) / cs) - minGz,
    Math.round((b.x - ox) / cs) - minGx, Math.round((b.z - oz) / cs) - minGz,
    255, 0, 255);
}

// Parallel streets (cyan, 1px)
for (const [a, b] of parallelStreets) {
  bres(pixels, cropW, cropH,
    Math.round((a.x - ox) / cs) - minGx, Math.round((a.z - oz) / cs) - minGz,
    Math.round((b.x - ox) / cs) - minGx, Math.round((b.z - oz) / cs) - minGz,
    0, 220, 220);
}

// Subdivision points on edges (white dots)
for (const p of ptsA) {
  const x = Math.round((p.x - ox) / cs) - minGx;
  const z = Math.round((p.z - oz) / cs) - minGz;
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++)
      if (x+dx >= 0 && x+dx < cropW && z+dz >= 0 && z+dz < cropH) {
        const idx = ((z+dz) * cropW + (x+dx)) * 3;
        pixels[idx] = 255; pixels[idx+1] = 255; pixels[idx+2] = 255;
      }
}
for (const p of ptsB) {
  const x = Math.round((p.x - ox) / cs) - minGx;
  const z = Math.round((p.z - oz) / cs) - minGz;
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++)
      if (x+dx >= 0 && x+dx < cropW && z+dz >= 0 && z+dz < cropH) {
        const idx = ((z+dz) * cropW + (x+dx)) * 3;
        pixels[idx] = 255; pixels[idx+1] = 255; pixels[idx+2] = 255;
      }
}

const header = `P6\n${cropW} ${cropH}\n255\n`;
const basePath = `${outDir}/ribbon-zone-zoomed-seed${seed}`;
writeFileSync(`${basePath}.ppm`, Buffer.concat([Buffer.from(header), Buffer.from(pixels)]));
try { execSync(`convert "${basePath}.ppm" "${basePath}.png" 2>/dev/null`); } catch {}
console.log(`\nWritten to ${basePath}.png (${cropW}x${cropH})`);
console.log(`Total: ${((performance.now() - t0) / 1000).toFixed(1)}s`);

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
