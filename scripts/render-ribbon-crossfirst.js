#!/usr/bin/env bun
/**
 * Experiment 007d: Cross-street-first ribbon layout.
 * Lays cross streets first (perpendicular to ribbon direction), marks measured
 * points along each cross street, then connects corresponding points between
 * adjacent cross streets to form parallel streets.
 *
 * This prevents parallel streets from bunching because they are derived from
 * evenly-spaced points on the cross streets rather than swept independently.
 */

import { generateRegionFromSeed } from '../src/ui/regionHelper.js';
import { setupCity } from '../src/city/setup.js';
import { LandFirstDevelopment } from '../src/city/strategies/landFirstDevelopment.js';
import { ARCHETYPES } from '../src/city/archetypes.js';
import { SeededRandom } from '../src/core/rng.js';
import { createZoneBoundaryRoads } from '../src/city/pipeline/zoneBoundaryRoads.js';
import { subdivideLargeZones } from '../src/city/pipeline/subdivideZones.js';
import { extractZones } from '../src/city/pipeline/extractZones.js';
import { computeRibbonOrientation, adjustStreetToContour, CONTOUR_SLOPE_THRESHOLD } from '../src/city/ribbonLayout.js';
import { ribbonSpacingForPressure } from '../src/city/developmentPressure.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const seed = parseInt(process.argv[2]) || 884469;
const gx = parseInt(process.argv[3]) || 27;
const gz = parseInt(process.argv[4]) || 95;
const outDir = process.argv[5] || 'experiments/007d-output';

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

console.log(`Cross-first ribbon: seed=${seed} gx=${gx} gz=${gz}`);
const t0 = performance.now();

const { layers, settlement } = generateRegionFromSeed(seed, gx, gz);
if (!settlement) { console.error('No settlement'); process.exit(1); }

const rng = new SeededRandom(seed);
const map = setupCity(layers, settlement, rng.fork('city'));
const strategy = new LandFirstDevelopment(map, { archetype: ARCHETYPES.marketTown });

// Run through tick 4 (spatial layers)
for (let i = 0; i < 4; i++) strategy.tick();

// Add zone boundary roads + subdivide
createZoneBoundaryRoads(map);
subdivideLargeZones(map);

// Re-extract zones
extractZones(map);

const zones = map.developmentZones;
const w = map.width, h = map.height;
const cs = map.cellSize;

console.log(`${zones.length} zones after subdivision`);

// Print zone stats
const sizes = zones.map(z => z.cells.length).sort((a, b) => b - a);
console.log(`Sizes: ${sizes.slice(0, 10).join(', ')}...`);
console.log(`Zones with boundary: ${zones.filter(z => z.boundary && z.boundary.length >= 3).length}`);
console.log(`Zones with slope data: ${zones.filter(z => z.avgSlope !== undefined).length}`);

// Pick a medium-large zone that has proper metadata
const candidates = zones.filter(z =>
  z.cells.length > 2000 &&
  z.cells.length < 50000 &&
  z.boundary && z.boundary.length >= 4 &&
  z.avgSlope !== undefined
);

if (candidates.length === 0) {
  console.error('No suitable zone found');
  process.exit(1);
}

// Pick one near the centre
candidates.sort((a, b) => {
  const aDist = Math.abs(a.centroidGx - w/2) + Math.abs(a.centroidGz - h/2);
  const bDist = Math.abs(b.centroidGx - w/2) + Math.abs(b.centroidGz - h/2);
  return aDist - bDist;
});
const zone = candidates[0];

console.log(`\nSelected zone: ${zone.cells.length} cells, centroid (${zone.centroidGx}, ${zone.centroidGz})`);
console.log(`  boundary: ${zone.boundary.length} vertices`);
console.log(`  avgSlope: ${zone.avgSlope.toFixed(3)}`);
console.log(`  slopeDir: (${zone.slopeDir.x.toFixed(2)}, ${zone.slopeDir.z.toFixed(2)})`);
console.log(`  nucleusIdx: ${zone.nucleusIdx}`);

// Run ribbon orientation
const nucleus = map.nuclei[zone.nucleusIdx];
const direction = computeRibbonOrientation(zone, nucleus, cs);
console.log(`  ribbon direction: (${direction.dx.toFixed(2)}, ${direction.dz.toFixed(2)})`);

const spacing = ribbonSpacingForPressure(zone.pressure ?? 0.5);
console.log(`  spacing: ${spacing}m`);

// Cross-street-first layout
const { crossStreets, parallelStreets } = layoutCrossFirst(zone, direction, cs, map.originX, map.originZ, spacing);
console.log(`  cross streets: ${crossStreets.length}`);
console.log(`  parallel streets: ${parallelStreets.length}`);

// Apply contour adjustment to parallel streets on sloped terrain
let adjustedParallels = parallelStreets;
if (zone.avgSlope > CONTOUR_SLOPE_THRESHOLD) {
  const elevation = map.hasLayer('elevation') ? map.getLayer('elevation') : null;
  if (elevation) {
    adjustedParallels = parallelStreets.map(seg =>
      adjustStreetToContour(seg, elevation, zone.slopeDir, cs, map.originX, map.originZ)
    );
  }
}

// --- Render ---
const pixels = new Uint8Array(w * h * 3);

// Terrain base
const elev = map.hasLayer('elevation') ? map.getLayer('elevation') : null;
const waterMask = map.hasLayer('waterMask') ? map.getLayer('waterMask') : null;
if (elev) {
  const bounds = elev.bounds();
  const range = bounds.max - bounds.min || 1;
  for (let z = 0; z < h; z++)
    for (let x = 0; x < w; x++) {
      const v = (elev.get(x, z) - bounds.min) / range;
      const idx = (z * w + x) * 3;
      pixels[idx] = Math.round(30 + v * 40);
      pixels[idx + 1] = Math.round(40 + v * 30);
      pixels[idx + 2] = Math.round(20 + v * 20);
    }
}
if (waterMask) {
  for (let z = 0; z < h; z++)
    for (let x = 0; x < w; x++)
      if (waterMask.get(x, z) > 0) {
        const idx = (z * w + x) * 3;
        pixels[idx] = 15; pixels[idx + 1] = 30; pixels[idx + 2] = 60;
      }
}

// All zones faint
for (const z of zones) {
  for (const c of z.cells) {
    const idx = (c.gz * w + c.gx) * 3;
    pixels[idx] = Math.min(255, pixels[idx] + 20);
    pixels[idx + 1] = Math.min(255, pixels[idx + 1] + 15);
    pixels[idx + 2] = Math.min(255, pixels[idx + 2] + 10);
  }
}

// Highlight selected zone
for (const c of zone.cells) {
  const idx = (c.gz * w + c.gx) * 3;
  pixels[idx] = 60; pixels[idx + 1] = 100; pixels[idx + 2] = 60;
}

// Roads (white)
const roadGrid = map.hasLayer('roadGrid') ? map.getLayer('roadGrid') : null;
if (roadGrid) {
  for (let z = 0; z < h; z++)
    for (let x = 0; x < w; x++)
      if (roadGrid.get(x, z) > 0) {
        const idx = (z * w + x) * 3;
        pixels[idx] = 180; pixels[idx + 1] = 180; pixels[idx + 2] = 180;
      }
}

// Zone boundary (yellow)
if (zone.boundary) {
  const b = zone.boundary;
  for (let i = 0; i < b.length; i++) {
    const p1 = b[i], p2 = b[(i + 1) % b.length];
    bresenham(pixels, w, h,
      Math.round((p1.x - map.originX) / cs), Math.round((p1.z - map.originZ) / cs),
      Math.round((p2.x - map.originX) / cs), Math.round((p2.z - map.originZ) / cs),
      255, 255, 0);
  }
}

// Cross streets (magenta, 3px)
for (const st of crossStreets) {
  if (st.length < 2) continue;
  const p1gx = Math.round((st[0].x - map.originX) / cs);
  const p1gz = Math.round((st[0].z - map.originZ) / cs);
  const p2gx = Math.round((st[1].x - map.originX) / cs);
  const p2gz = Math.round((st[1].z - map.originZ) / cs);
  for (let dz = -1; dz <= 1; dz++)
    for (let dx = -1; dx <= 1; dx++)
      bresenham(pixels, w, h, p1gx+dx, p1gz+dz, p2gx+dx, p2gz+dz, 255, 0, 255);
}

// Parallel streets / connections (cyan, 3px)
for (const st of adjustedParallels) {
  if (st.length < 2) continue;
  for (let i = 0; i < st.length - 1; i++) {
    const p1gx = Math.round((st[i].x - map.originX) / cs);
    const p1gz = Math.round((st[i].z - map.originZ) / cs);
    const p2gx = Math.round((st[i+1].x - map.originX) / cs);
    const p2gz = Math.round((st[i+1].z - map.originZ) / cs);
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        bresenham(pixels, w, h, p1gx+dx, p1gz+dz, p2gx+dx, p2gz+dz, 0, 255, 255);
  }
}

// Nucleus (red dot)
if (nucleus) {
  for (let dz = -3; dz <= 3; dz++)
    for (let dx = -3; dx <= 3; dx++) {
      const px = nucleus.gx + dx, pz = nucleus.gz + dz;
      if (px >= 0 && px < w && pz >= 0 && pz < h) {
        const idx = (pz * w + px) * 3;
        pixels[idx] = 255; pixels[idx + 1] = 0; pixels[idx + 2] = 0;
      }
    }
}

const header = `P6\n${w} ${h}\n255\n`;
const basePath = `${outDir}/ribbon-zone-seed${seed}`;
writeFileSync(`${basePath}.ppm`, Buffer.concat([Buffer.from(header), Buffer.from(pixels)]));
try { execSync(`convert "${basePath}.ppm" "${basePath}.png" 2>/dev/null`); } catch {}
console.log(`\nWritten to ${basePath}.png`);
console.log(`Total: ${((performance.now() - t0) / 1000).toFixed(1)}s`);

// --- Cross-street-first layout algorithm ---

/**
 * Clip a line segment to a (possibly concave) polygon.
 * Returns an array of clipped segments. Each segment is [start, end].
 */
function clipLineToPolygon(p1, p2, polygon) {
  const dx = p2.x - p1.x, dz = p2.z - p1.z;
  const n = polygon.length;
  const intersections = [];

  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];
    const edx = b.x - a.x, edz = b.z - a.z;
    const denom = dx * edz - dz * edx;
    if (Math.abs(denom) < 1e-10) continue;

    const t = ((a.x - p1.x) * edz - (a.z - p1.z) * edx) / denom;
    const u = ((a.x - p1.x) * dz - (a.z - p1.z) * dx) / denom;

    if (u >= 0 && u <= 1 && t >= 0 && t <= 1) {
      intersections.push(t);
    }
  }

  if (intersections.length < 2) {
    const mx = (p1.x + p2.x) / 2, mz = (p1.z + p2.z) / 2;
    if (pointInPoly(mx, mz, polygon)) return [[p1, p2]];
    return [];
  }

  intersections.sort((a, b) => a - b);
  const segments = [];
  for (let i = 0; i < intersections.length - 1; i += 2) {
    const t0 = intersections[i];
    const t1 = intersections[i + 1];
    if (t1 - t0 < 1e-6) continue;
    segments.push([
      { x: p1.x + t0 * dx, z: p1.z + t0 * dz },
      { x: p1.x + t1 * dx, z: p1.z + t1 * dz },
    ]);
  }

  return segments;
}

function pointInPoly(x, z, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, zi = polygon[i].z;
    const xj = polygon[j].x, zj = polygon[j].z;
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Cross-street-first ribbon layout.
 *
 * @param {Object} zone - Zone with boundary polygon, centroid, pressure etc.
 * @param {{ dx: number, dz: number }} direction - Parallel street direction (unit vector)
 * @param {number} cellSize
 * @param {number} originX
 * @param {number} originZ
 * @param {number} spacing - Plot depth / parallel street spacing (metres)
 * @returns {{ crossStreets: Array, parallelStreets: Array }}
 */
function layoutCrossFirst(zone, direction, cellSize, originX, originZ, spacing) {
  const CROSS_STREET_INTERVAL = 90; // metres between cross streets
  const MIN_STREET_LENGTH = 20;     // metres — skip streets shorter than this

  const boundary = zone.boundary;
  if (!boundary || boundary.length < 3) return { crossStreets: [], parallelStreets: [] };

  // direction is the parallel street direction (unit vector)
  // crossDx/crossDz is perpendicular to it — the direction cross streets run along
  const { dx, dz } = direction;
  const crossDx = -dz, crossDz = dx;

  // Centroid in world coordinates
  const cx = originX + zone.centroidGx * cellSize;
  const cz = originZ + zone.centroidGz * cellSize;

  // Find zone extent along the parallel (dx,dz) axis — that's where we sweep cross streets
  let minAlong = Infinity, maxAlong = -Infinity;
  // Find zone extent along the cross (crossDx,crossDz) axis — for clipping cross street reach
  let minCross = Infinity, maxCross = -Infinity;

  for (const pt of boundary) {
    const projAlong = (pt.x - cx) * dx + (pt.z - cz) * dz;
    if (projAlong < minAlong) minAlong = projAlong;
    if (projAlong > maxAlong) maxAlong = projAlong;
    const projCross = (pt.x - cx) * crossDx + (pt.z - cz) * crossDz;
    if (projCross < minCross) minCross = projCross;
    if (projCross > maxCross) maxCross = projCross;
  }

  // Step 1: Lay cross streets at fixed intervals along the parallel direction.
  // Each cross street runs along (crossDx, crossDz), swept at positions along (dx, dz).
  const crossStreets = [];
  // Array of arrays: crossStreetPoints[i] = list of measured points along cross street i
  const crossStreetPoints = [];

  // Start from minAlong, place cross streets at CROSS_STREET_INTERVAL spacing
  for (let along = minAlong; along <= maxAlong + CROSS_STREET_INTERVAL; along += CROSS_STREET_INTERVAL) {
    // Centre point of this cross street on the parallel axis
    const lineCx = cx + dx * along;
    const lineCz = cz + dz * along;

    // Build a long line along the cross direction, extending well past boundary
    const reach = (maxCross - minCross) / 2 + 50;
    const p1 = { x: lineCx + crossDx * (minCross - 50), z: lineCz + crossDz * (minCross - 50) };
    const p2 = { x: lineCx + crossDx * (maxCross + 50), z: lineCz + crossDz * (maxCross + 50) };

    const segments = clipLineToPolygon(p1, p2, boundary);
    for (const seg of segments) {
      const segLen = Math.sqrt((seg[1].x - seg[0].x) ** 2 + (seg[1].z - seg[0].z) ** 2);
      if (segLen < MIN_STREET_LENGTH) continue;

      crossStreets.push(seg);

      // Step 2: Mark measured points along this cross street at `spacing` intervals.
      // Points are anchored at 0 along the cross axis (relative to centroid projection)
      // so corresponding points on adjacent cross streets align.
      const segStart = (seg[0].x - cx) * crossDx + (seg[0].z - cz) * crossDz;
      const segEnd   = (seg[1].x - cx) * crossDx + (seg[1].z - cz) * crossDz;
      const segMin = Math.min(segStart, segEnd);
      const segMax = Math.max(segStart, segEnd);

      // Anchor first point to a multiple of spacing — so all cross streets share
      // the same "grid" of offsets and corresponding points truly correspond.
      const firstOffset = Math.ceil(segMin / spacing) * spacing;

      const points = [];
      for (let offset = firstOffset; offset <= segMax; offset += spacing) {
        // t in [0,1] along the segment
        const t = (offset - segStart) / (segEnd - segStart);
        if (t < 0 || t > 1) continue;
        points.push({
          x: seg[0].x + t * (seg[1].x - seg[0].x),
          z: seg[0].z + t * (seg[1].z - seg[0].z),
          offset, // the cross-axis offset for matching
        });
      }
      crossStreetPoints.push({ along, points, seg });
    }
  }

  // Step 3: Connect corresponding points between adjacent cross streets.
  // Sort cross street point sets by their `along` position.
  crossStreetPoints.sort((a, b) => a.along - b.along);

  const parallelStreets = [];

  for (let k = 0; k < crossStreetPoints.length - 1; k++) {
    const csA = crossStreetPoints[k];
    const csB = crossStreetPoints[k + 1];

    // Build lookup maps: offset -> point
    const mapA = new Map(csA.points.map(p => [p.offset, p]));
    const mapB = new Map(csB.points.map(p => [p.offset, p]));

    // Find offsets present in both
    for (const [offset, pA] of mapA) {
      const pB = mapB.get(offset);
      if (!pB) continue;

      const segLen = Math.sqrt((pB.x - pA.x) ** 2 + (pB.z - pA.z) ** 2);
      if (segLen < MIN_STREET_LENGTH) continue;

      parallelStreets.push([
        { x: pA.x, z: pA.z },
        { x: pB.x, z: pB.z },
      ]);
    }
  }

  return { crossStreets, parallelStreets };
}

// --- Bresenham line draw ---
function bresenham(pixels, w, h, x0, y0, x1, y1, r, g, b) {
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
