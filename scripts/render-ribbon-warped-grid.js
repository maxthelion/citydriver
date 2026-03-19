#!/usr/bin/env bun
/**
 * Experiment 007s: Warped grid between two non-parallel anchor roads.
 *
 * Builds on 007r's angled-road zone finder but uses bilinear interpolation
 * to warp the grid through the zone. Finds the road intersection point,
 * computes perpendicular construction lines to an apex, then generates
 * a (u,v) grid via bilinear interpolation between the two road edges.
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
const outDir = process.argv[5] || 'experiments/007s-output';
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

    if (normalised > 10 && normalised < 80) {
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

// === Find where the two anchor road LINES intersect ===
// Extend the road edge directions to find their intersection point
const zoneSet = new Set(zone.cells.map(c => c.gz * W + c.gx));

const A0_orig = edges[0].points[0];
const A1_orig = edges[0].points[edges[0].points.length - 1];
const B0_orig = edges[1].points[0];
const B1_orig = edges[1].points[edges[1].points.length - 1];

// Road A line: A0 + t * dirA, Road B line: B0 + s * dirB
const dA = edges[0].dir, dB = edges[1].dir;
const det = dA.x * (-dB.z) - dA.z * (-dB.x);
let roadIntersection;

if (Math.abs(det) > 0.001) {
  const dmx = B0_orig.x - A0_orig.x, dmz = B0_orig.z - A0_orig.z;
  const t = (dmx * (-dB.z) - dmz * (-dB.x)) / det;
  roadIntersection = { x: A0_orig.x + t * dA.x, z: A0_orig.z + t * dA.z };
  console.log(`  Road lines intersect at (${roadIntersection.x.toFixed(0)}, ${roadIntersection.z.toFixed(0)})`);
} else {
  roadIntersection = { x: centX, z: centZ };
  console.log(`  Roads are parallel — using centroid`);
}

// === Find the point on each edge FURTHEST from the road intersection ===
function furthestFromPoint(edgePts, px, pz) {
  let maxDist = 0, best = edgePts[0];
  for (const p of edgePts) {
    const d = Math.sqrt((p.x - px) ** 2 + (p.z - pz) ** 2);
    if (d > maxDist) { maxDist = d; best = p; }
  }
  return { point: best, dist: maxDist };
}

const farA = furthestFromPoint(edges[0].points, roadIntersection.x, roadIntersection.z);
const farB = furthestFromPoint(edges[1].points, roadIntersection.x, roadIntersection.z);

console.log(`  Furthest on A: dist=${farA.dist.toFixed(0)}m`);
console.log(`  Furthest on B: dist=${farB.dist.toFixed(0)}m`);

// === Draw perpendicular lines from these furthest points into the zone ===
// perpA from farA.point into the zone along edges[0].perp
// perpB from farB.point into the zone along edges[1].perp

// Find where these two perpendicular lines intersect — that's the apex
const pA = edges[0].perp, pB = edges[1].perp;
const detPerp = pA.x * (-pB.z) - pA.z * (-pB.x);
let apex;

if (Math.abs(detPerp) > 0.001) {
  const dmx = farB.point.x - farA.point.x, dmz = farB.point.z - farA.point.z;
  const t = (dmx * (-pB.z) - dmz * (-pB.x)) / detPerp;
  apex = { x: farA.point.x + t * pA.x, z: farA.point.z + t * pA.z };
} else {
  apex = { x: centX, z: centZ };
}

// Truncate both perp lines to the apex distance
const perpLenA = Math.sqrt((apex.x - farA.point.x) ** 2 + (apex.z - farA.point.z) ** 2);
const perpLenB = Math.sqrt((apex.x - farB.point.x) ** 2 + (apex.z - farB.point.z) ** 2);
console.log(`  Apex at (${apex.x.toFixed(0)}, ${apex.z.toFixed(0)}), perpA=${perpLenA.toFixed(0)}m, perpB=${perpLenB.toFixed(0)}m`);

// === Build the quadrilateral ===
// Four corners: start of edge A, end of edge A, apex (from A side), apex (from B side)
// Actually: the quad is edge A on one side, edge B on the other, with two "side edges"
// connecting them through or near the apex.
//
// Side edge 1: from start of edge A to start of edge B (or through apex)
// Side edge 2: from end of edge A to end of edge B (or through apex)
//
// Simpler model: treat it as a quad with:
//   Top: edge A (road A)
//   Bottom: edge B (road B)
//   Left: line from edgeA[0] to edgeB[0]
//   Right: line from edgeA[last] to edgeB[last]
// But push the interior toward the apex.
//
// Even simpler: bilinear interpolation.
// The quad corners are: A_start, A_end, B_start, B_end
// For any (u, v) in [0,1]x[0,1]:
//   point = (1-v)*lerp(A_start, A_end, u) + v*lerp(B_start, B_end, u)
// But warp v to push through apex.

// The quad: edge A (road A) on one side, edge B (road B) on the other,
// connected by two side edges through/near the apex.
// We use the full road edges (A0-A1, B0-B1) as opposite sides of the quad.
const A0 = edges[0].points[0];
const A1 = edges[0].points[edges[0].points.length - 1];
const B0 = edges[1].points[0];
const B1 = edges[1].points[edges[1].points.length - 1];

// Subdivide edges and connect
const CROSS_SPACING = 60;
const PARALLEL_SPACING = 35;
const NUM_U = Math.max(3, Math.round(Math.max(edges[0].length, edges[1].length) / CROSS_SPACING));

// Cross street length (A to B direction)
const avgCrossLen = (
  Math.sqrt((B0.x-A0.x)**2 + (B0.z-A0.z)**2) +
  Math.sqrt((B1.x-A1.x)**2 + (B1.z-A1.z)**2)
) / 2;
const NUM_V = Math.max(3, Math.round(avgCrossLen / PARALLEL_SPACING));

console.log(`  Grid: ${NUM_U} x ${NUM_V}`);

// Generate grid points via bilinear interpolation
// u goes along edges (0=start, 1=end), v goes between edges (0=A, 1=B)
function gridPoint(u, v) {
  // Point on edge A at fraction u
  const ax = A0.x + (A1.x - A0.x) * u;
  const az = A0.z + (A1.z - A0.z) * u;
  // Point on edge B at fraction u
  const bx = B0.x + (B1.x - B0.x) * u;
  const bz = B0.z + (B1.z - B0.z) * u;
  // Interpolate between A and B
  return {
    x: ax + (bx - ax) * v,
    z: az + (bz - az) * v,
  };
}

// Cross streets: lines at constant u (connecting A to B)
const crossStreets = [];
for (let ui = 0; ui <= NUM_U; ui++) {
  const u = ui / NUM_U;
  const pts = [];
  for (let vi = 0; vi <= NUM_V; vi++) {
    pts.push(gridPoint(u, vi / NUM_V));
  }
  crossStreets.push(pts);
}

// Parallel streets: lines at constant v (following along edges)
const parallelStreets = [];
for (let vi = 0; vi <= NUM_V; vi++) {
  const v = vi / NUM_V;
  const pts = [];
  for (let ui = 0; ui <= NUM_U; ui++) {
    pts.push(gridPoint(ui / NUM_U, v));
  }
  parallelStreets.push(pts);
}

console.log(`  ${crossStreets.length} cross streets, ${parallelStreets.length} parallel streets`);

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

// Perpendicular construction lines (green, 1px)
bres(pixels, cropW, cropH,
  Math.round((farA.point.x - ox) / cs) - minGx, Math.round((farA.point.z - oz) / cs) - minGz,
  Math.round((apex.x - ox) / cs) - minGx, Math.round((apex.z - oz) / cs) - minGz,
  0, 200, 0);
bres(pixels, cropW, cropH,
  Math.round((farB.point.x - ox) / cs) - minGx, Math.round((farB.point.z - oz) / cs) - minGz,
  Math.round((apex.x - ox) / cs) - minGx, Math.round((apex.z - oz) / cs) - minGz,
  0, 200, 0);

// Apex (bright green dot)
{
  const ax = Math.round((apex.x - ox) / cs) - minGx;
  const az = Math.round((apex.z - oz) / cs) - minGz;
  for (let dz = -2; dz <= 2; dz++)
    for (let dx = -2; dx <= 2; dx++)
      if (ax+dx >= 0 && ax+dx < cropW && az+dz >= 0 && az+dz < cropH) {
        const idx = ((az+dz) * cropW + (ax+dx)) * 3;
        pixels[idx] = 0; pixels[idx+1] = 255; pixels[idx+2] = 0;
      }
}

// Cross streets (magenta, 1px) — polylines
for (const pts of crossStreets) {
  for (let i = 0; i < pts.length - 1; i++) {
    bres(pixels, cropW, cropH,
      Math.round((pts[i].x - ox) / cs) - minGx, Math.round((pts[i].z - oz) / cs) - minGz,
      Math.round((pts[i+1].x - ox) / cs) - minGx, Math.round((pts[i+1].z - oz) / cs) - minGz,
      255, 0, 255);
  }
}

// Parallel streets (cyan, 1px) — polylines
for (const pts of parallelStreets) {
  for (let i = 0; i < pts.length - 1; i++) {
    bres(pixels, cropW, cropH,
      Math.round((pts[i].x - ox) / cs) - minGx, Math.round((pts[i].z - oz) / cs) - minGz,
      Math.round((pts[i+1].x - ox) / cs) - minGx, Math.round((pts[i+1].z - oz) / cs) - minGz,
      0, 220, 220);
  }
}

// Furthest points on edges (white dots)
for (const p of [farA.point, farB.point]) {
  const x = Math.round((p.x - ox) / cs) - minGx;
  const z = Math.round((p.z - oz) / cs) - minGz;
  for (let dz = -2; dz <= 2; dz++)
    for (let dx = -2; dx <= 2; dx++)
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
