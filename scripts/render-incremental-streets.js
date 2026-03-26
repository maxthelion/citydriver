#!/usr/bin/env bun
/**
 * render-incremental-streets.js — Incremental street layout skeleton.
 *
 * Implements the incremental street layout algorithm from
 * wiki/pages/incremental-street-layout.md:
 *   Phase 1: Construction lines (cross streets in the gradient direction)
 *   Phase 2: Incremental parallel streets (perpendicular to construction lines)
 *   + simple parcel creation between adjacent parallels
 *
 * Renders a cropped PPM/PNG per zone showing terrain, zone boundary,
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

// === Parameters ===
const CONSTRUCTION_SPACING = 90;  // metres between construction lines
const PARCEL_DEPTH = 35;          // metres between parallel streets
const MIN_STREET_LEN = 20;        // minimum street segment length
const MIN_PARCEL_SHORT_SIDE = 15; // minimum parcel dimension

// === CLI ===
const seed = parseInt(process.argv[2]) || 42;
const gx = parseInt(process.argv[3]) || 27;
const gz = parseInt(process.argv[4]) || 95;
const outDir = process.argv[5] || 'experiments/incremental-output';
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

// === Pipeline setup (same as render-k3-survey) ===
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

// === Zone selection (same as render-k3-survey) ===
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

  // Build zone cell set for fast lookup
  const zoneSet = new Set();
  for (const c of zone.cells) zoneSet.add(c.gz * W + c.gx);

  // ===== Phase 1: Construction Lines =====

  // 1a. Compute average gradient direction for the zone
  let sumDx = 0, sumDz = 0, gradCount = 0;
  for (const c of zone.cells) {
    const eC = elev.get(c.gx, c.gz);
    const eE = zoneSet.has(c.gz * W + (c.gx + 1)) ? elev.get(c.gx + 1, c.gz) : eC;
    const eW_ = zoneSet.has(c.gz * W + (c.gx - 1)) ? elev.get(c.gx - 1, c.gz) : eC;
    const gx_ = (eE - eW_) / (2 * cs);
    const eS = zoneSet.has((c.gz + 1) * W + c.gx) ? elev.get(c.gx, c.gz + 1) : eC;
    const eN = zoneSet.has((c.gz - 1) * W + c.gx) ? elev.get(c.gx, c.gz - 1) : eC;
    const gz_ = (eS - eN) / (2 * cs);
    sumDx += gx_;
    sumDz += gz_;
    gradCount++;
  }

  if (gradCount === 0) {
    console.log('  Skipping — no gradient data');
    continue;
  }

  let gradX = sumDx / gradCount;
  let gradZ = sumDz / gradCount;
  const gradMag = Math.sqrt(gradX * gradX + gradZ * gradZ);

  if (gradMag < 1e-6) {
    if (zone.slopeDir) {
      gradX = zone.slopeDir.x;
      gradZ = zone.slopeDir.z;
    } else {
      // Flat zone — use arbitrary direction
      gradX = 1; gradZ = 0;
    }
  } else {
    gradX /= gradMag;
    gradZ /= gradMag;
  }

  // Contour direction (perpendicular to gradient)
  const ctX = -gradZ, ctZ = gradX;

  console.log(`  Gradient: (${gradX.toFixed(3)}, ${gradZ.toFixed(3)}), Contour: (${ctX.toFixed(3)}, ${ctZ.toFixed(3)})`);

  // 1b. Find zone centroid in world coords
  let cxSum = 0, czSum = 0;
  for (const c of zone.cells) { cxSum += c.gx; czSum += c.gz; }
  const zoneCx = ox + (cxSum / zone.cells.length) * cs;
  const zoneCz = oz + (czSum / zone.cells.length) * cs;

  // 1c. Project zone cells onto gradient and contour axes
  let minCt = Infinity, maxCt = -Infinity;
  let minGr = Infinity, maxGr = -Infinity;
  for (const c of zone.cells) {
    const wx = ox + c.gx * cs;
    const wz = oz + c.gz * cs;
    const projCt = (wx - zoneCx) * ctX + (wz - zoneCz) * ctZ;
    const projGr = (wx - zoneCx) * gradX + (wz - zoneCz) * gradZ;
    if (projCt < minCt) minCt = projCt;
    if (projCt > maxCt) maxCt = projCt;
    if (projGr < minGr) minGr = projGr;
    if (projGr > maxGr) maxGr = projGr;
  }

  // 1d. Sweep construction lines along the contour axis at CONSTRUCTION_SPACING intervals
  // Each construction line runs in the gradient direction, from one side of the zone to the other
  const constructionLines = [];
  const firstCt = Math.ceil(minCt / CONSTRUCTION_SPACING) * CONSTRUCTION_SPACING;

  for (let ctOff = firstCt; ctOff <= maxCt + 1e-6; ctOff += CONSTRUCTION_SPACING) {
    // Origin point on the contour axis
    const lineOx = zoneCx + ctX * ctOff;
    const lineOz = zoneCz + ctZ * ctOff;

    // Walk in the gradient direction, collecting in-zone points
    const step = cs * 0.5;
    const reach = (maxGr - minGr) + cs * 2;
    const nSteps = Math.ceil(reach / step);

    const inZonePoints = [];
    for (let si = -nSteps; si <= nSteps; si++) {
      const grOff = si * step;
      const wx = lineOx + gradX * grOff;
      const wz = lineOz + gradZ * grOff;
      const cgx = Math.round((wx - ox) / cs);
      const cgz = Math.round((wz - oz) / cs);
      if (cgx < 0 || cgx >= W || cgz < 0 || cgz >= H) continue;

      const inZone = zoneSet.has(cgz * W + cgx);
      const isWater = waterMask && waterMask.get(cgx, cgz) > 0;
      const isRoad = roadGrid && roadGrid.get(cgx, cgz) > 0;
      inZonePoints.push({ wx, wz, grOff, inZone, isWater, isRoad, cgx, cgz });
    }

    // Keep the longest contiguous run that is in-zone and not water
    let bestRun = [];
    let curRun = [];
    for (const pt of inZonePoints) {
      if (pt.inZone && !pt.isWater) {
        curRun.push(pt);
      } else {
        if (curRun.length > bestRun.length) bestRun = curRun;
        curRun = [];
      }
    }
    if (curRun.length > bestRun.length) bestRun = curRun;

    if (bestRun.length < 2) continue;

    const segStart = bestRun[0];
    const segEnd = bestRun[bestRun.length - 1];
    const segLen = Math.sqrt(
      (segEnd.wx - segStart.wx) ** 2 + (segEnd.wz - segStart.wz) ** 2
    );
    if (segLen < MIN_STREET_LEN) continue;

    constructionLines.push({
      ctOff,
      start: { x: segStart.wx, z: segStart.wz },
      end: { x: segEnd.wx, z: segEnd.wz },
      profile: bestRun,
    });
  }

  console.log(`  Phase 1: ${constructionLines.length} construction lines`);

  // ===== Phase 2: Incremental Parallel Streets =====
  // Walk along each construction line at PARCEL_DEPTH intervals.
  // At each point, draw a line perpendicular to the construction line
  // (i.e. in the contour direction), clipped to the zone boundary.
  // That line is a parallel street.

  const parallelStreets = [];
  const allJunctions = [];
  const parcels = [];
  let failedParcels = 0;

  // Sort construction lines by contour offset
  constructionLines.sort((a, b) => a.ctOff - b.ctOff);

  // For each construction line, compute junction points at PARCEL_DEPTH intervals
  for (const cLine of constructionLines) {
    const profile = cLine.profile;
    let distAccum = 0;
    cLine.junctions = [];

    for (let si = 0; si < profile.length; si++) {
      if (si > 0) {
        const dx = profile[si].wx - profile[si - 1].wx;
        const dz = profile[si].wz - profile[si - 1].wz;
        distAccum += Math.sqrt(dx * dx + dz * dz);
      }
      if (si === 0 || distAccum >= PARCEL_DEPTH) {
        if (si > 0) distAccum = 0;
        const pt = profile[si];
        cLine.junctions.push({ x: pt.wx, z: pt.wz, cgx: pt.cgx, cgz: pt.cgz });
      }
    }
  }

  // Lay parallel streets between adjacent construction lines
  for (let ci = 0; ci < constructionLines.length - 1; ci++) {
    const cLineA = constructionLines[ci];
    const cLineB = constructionLines[ci + 1];
    const jA = cLineA.junctions;
    const jB = cLineB.junctions;
    const count = Math.min(jA.length, jB.length);

    let prevStreet = null;

    for (let idx = 0; idx < count; idx++) {
      const pA = jA[idx], pB = jB[idx];
      const segLen = Math.sqrt((pB.x - pA.x) ** 2 + (pB.z - pA.z) ** 2);

      // Validate: minimum length
      if (segLen < MIN_STREET_LEN) continue;

      // Validate: check water along the street
      let hitsWater = false;
      if (waterMask) {
        const nCheck = Math.ceil(segLen / (cs * 0.5));
        for (let s = 0; s <= nCheck; s++) {
          const t = s / nCheck;
          const px = pA.x + (pB.x - pA.x) * t;
          const pz = pA.z + (pB.z - pA.z) * t;
          const cgx2 = Math.round((px - ox) / cs);
          const cgz2 = Math.round((pz - oz) / cs);
          if (cgx2 >= 0 && cgx2 < W && cgz2 >= 0 && cgz2 < H && waterMask.get(cgx2, cgz2) > 0) {
            hitsWater = true;
            break;
          }
        }
      }
      if (hitsWater) continue;

      // Validate: check existing road crossings
      let hitsRoad = false;
      if (roadGrid) {
        const nCheck = Math.ceil(segLen / (cs * 0.5));
        for (let s = 0; s <= nCheck; s++) {
          const t = s / nCheck;
          const px = pA.x + (pB.x - pA.x) * t;
          const pz = pA.z + (pB.z - pA.z) * t;
          const cgx2 = Math.round((px - ox) / cs);
          const cgz2 = Math.round((pz - oz) / cs);
          if (cgx2 >= 0 && cgx2 < W && cgz2 >= 0 && cgz2 < H && roadGrid.get(cgx2, cgz2) > 0) {
            hitsRoad = true;
            break;
          }
        }
      }
      if (hitsRoad) continue;

      // Validate: angle within ±30° of perpendicular to construction lines
      // Construction lines run in gradient direction, so perpendicular = contour direction
      const streetAngle = Math.atan2(pB.z - pA.z, pB.x - pA.x);
      const contourAngle = Math.atan2(ctZ, ctX);
      let angleDiff = Math.abs(streetAngle - contourAngle);
      if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
      // Allow ±30° or ±(180-30)° (opposite direction is fine)
      if (angleDiff > Math.PI / 6 && Math.abs(angleDiff - Math.PI) > Math.PI / 6) continue;

      const street = [{ x: pA.x, z: pA.z }, { x: pB.x, z: pB.z }];
      parallelStreets.push(street);
      allJunctions.push({ x: pA.x, z: pA.z });
      allJunctions.push({ x: pB.x, z: pB.z });

      // Create parcel between this street and the previous one (or zone boundary for the first)
      if (prevStreet) {
        const parcel = {
          corners: [
            { x: prevStreet[0].x, z: prevStreet[0].z },
            { x: prevStreet[1].x, z: prevStreet[1].z },
            { x: street[1].x, z: street[1].z },
            { x: street[0].x, z: street[0].z },
          ],
        };

        // Compute parcel dimensions
        const sideA = Math.sqrt(
          (parcel.corners[1].x - parcel.corners[0].x) ** 2 +
          (parcel.corners[1].z - parcel.corners[0].z) ** 2
        );
        const sideB = Math.sqrt(
          (parcel.corners[3].x - parcel.corners[0].x) ** 2 +
          (parcel.corners[3].z - parcel.corners[0].z) ** 2
        );
        const shortSide = Math.min(sideA, sideB);
        const longSide = Math.max(sideA, sideB);
        const ratio = longSide > 0 ? shortSide / longSide : 0;

        parcel.shortSide = shortSide;
        parcel.longSide = longSide;
        parcel.ratio = ratio;

        // Validate parcel
        if (shortSide >= MIN_PARCEL_SHORT_SIDE && ratio > 0.1) {
          parcels.push(parcel);
        } else {
          failedParcels++;
        }
      }

      prevStreet = street;
    }
  }

  console.log(`  Phase 2: ${parallelStreets.length} parallel streets, ${allJunctions.length} junctions`);
  console.log(`  Parcels: ${parcels.length} valid, ${failedParcels} failed viability checks`);

  zoneResults.push({
    zi,
    cells: zone.cells.length,
    constructionLines: constructionLines.length,
    parallelStreets: parallelStreets.length,
    parcels: parcels.length,
    failedParcels,
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
        // Water (dark blue)
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
    // Fill the quad by scanline — convert corners to pixel coords
    const pxCorners = parcel.corners.map(c => ({
      x: Math.round((c.x - ox) / cs) - minGx,
      z: Math.round((c.z - oz) / cs) - minGz,
    }));

    // Simple quad fill: for each row in the bounding box, find intersections
    let pMinX = cropW, pMaxX = 0, pMinZ = cropH, pMaxZ = 0;
    for (const c of pxCorners) {
      if (c.x < pMinX) pMinX = c.x;
      if (c.x > pMaxX) pMaxX = c.x;
      if (c.z < pMinZ) pMinZ = c.z;
      if (c.z > pMaxZ) pMaxZ = c.z;
    }
    pMinX = Math.max(0, pMinX); pMaxX = Math.min(cropW - 1, pMaxX);
    pMinZ = Math.max(0, pMinZ); pMaxZ = Math.min(cropH - 1, pMaxZ);

    // Point-in-quad test using cross products
    const edges = [];
    for (let i = 0; i < 4; i++) {
      edges.push({
        x: pxCorners[(i + 1) % 4].x - pxCorners[i].x,
        z: pxCorners[(i + 1) % 4].z - pxCorners[i].z,
        ox: pxCorners[i].x,
        oz: pxCorners[i].z,
      });
    }

    // Alternate tint colours
    const tints = [
      [40, 60, 40],  // green-ish
      [40, 40, 60],  // blue-ish
      [60, 50, 40],  // brown-ish
      [50, 40, 60],  // purple-ish
    ];
    const [tr, tg, tb] = tints[pi % tints.length];

    for (let pz = pMinZ; pz <= pMaxZ; pz++) {
      for (let px = pMinX; px <= pMaxX; px++) {
        // Point-in-convex-quad: all cross products same sign
        let allPos = true, allNeg = true;
        for (const e of edges) {
          const cross = e.x * (pz - e.oz) - e.z * (px - e.ox);
          if (cross < 0) allPos = false;
          if (cross > 0) allNeg = false;
        }
        if (allPos || allNeg) {
          const idx = (pz * cropW + px) * 3;
          // Blend with existing pixel (faint tint)
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

  // Construction lines (magenta)
  for (const cLine of constructionLines) {
    bres(pixels, cropW, cropH,
      Math.round((cLine.start.x - ox) / cs) - minGx, Math.round((cLine.start.z - oz) / cs) - minGz,
      Math.round((cLine.end.x - ox) / cs) - minGx, Math.round((cLine.end.z - oz) / cs) - minGz,
      255, 0, 255);
  }

  // Parallel streets (cyan)
  for (const seg of parallelStreets) {
    bres(pixels, cropW, cropH,
      Math.round((seg[0].x - ox) / cs) - minGx, Math.round((seg[0].z - oz) / cs) - minGz,
      Math.round((seg[1].x - ox) / cs) - minGx, Math.round((seg[1].z - oz) / cs) - minGz,
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
  console.log(`  Zone ${r.zi}: cells=${r.cells} construction=${r.constructionLines} parallel=${r.parallelStreets} parcels=${r.parcels} failedParcels=${r.failedParcels}`);
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
