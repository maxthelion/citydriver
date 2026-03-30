#!/usr/bin/env bun
/**
 * render-sector-ribbons.js — Cross streets + ribbons per sector.
 *
 * Extends render-sector-cross-streets.js with ribbon streets between
 * adjacent cross streets. Ribbons run along the contour, connecting
 * points on adjacent cross streets to form parcels.
 *
 * Usage: bun scripts/render-sector-ribbons.js <seed> <gx> <gz> [outDir]
 */

import { generateRegionFromSeed } from '../src/ui/regionHelper.js';
import { setupCity } from '../src/city/setup.js';
import { LandFirstDevelopment } from '../src/city/strategies/landFirstDevelopment.js';
import { ARCHETYPES } from '../src/city/archetypes.js';
import { SeededRandom } from '../src/core/rng.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { runToStep } from './pipeline-utils.js';
import { layCrossStreets } from '../src/city/incremental/crossStreets.js';
import { layRibbons } from '../src/city/incremental/ribbons.js';
import { segmentTerrainV2 } from '../src/city/incremental/ridgeSegmentationV2.js';
import { tryAddRoad } from '../src/city/incremental/roadTransaction.js';

// === CLI ===
const seed = parseInt(process.argv[2]) || 42;
const gx = parseInt(process.argv[3]) || 27;
const gz = parseInt(process.argv[4]) || 95;
const outDir = process.argv[5] || 'experiments/022-output';
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
  const sectorMap = new Map();
  for (const c of zone.cells) {
    const key = c.gz * W + c.gx;
    const fi = cellToFace.get(key);
    if (fi === undefined) continue;
    if (!sectorMap.has(fi)) sectorMap.set(fi, []);
    sectorMap.get(fi).push(c);
  }

  const MIN_SECTOR_CELLS = 50;
  const sectors = [];
  for (const [fi, cells] of sectorMap) {
    if (cells.length < MIN_SECTOR_CELLS) continue;
    let cx = 0, cz = 0;
    for (const c of cells) { cx += c.gx; cz += c.gz; }
    cx /= cells.length;
    cz /= cells.length;
    const face = faces[fi];
    sectors.push({
      cells,
      centroidGx: cx,
      centroidGz: cz,
      avgSlope: face ? face.avgSlope : zone.avgSlope,
      slopeDir: face ? face.slopeDir : zone.slopeDir,
      boundary: zone.boundary,
      faceIdx: fi,
    });
  }

  console.log(`  Sectors: ${sectors.length} (from ${sectorMap.size} face intersections, min ${MIN_SECTOR_CELLS} cells)`);

  // Run cross streets and ribbons per sector, committing via tryAddRoad
  const allCrossStreets = [];
  const allRibbons = [];
  const allRibbonJunctions = [];
  const allFailedRibbons = [];
  const allSeedAnchors = [];
  let totalParcels = 0;
  let totalCsRejects = 0;
  let totalRibbonRejects = 0;

  for (let si = 0; si < sectors.length; si++) {
    const sector = sectors[si];
    const sectorFailureCounts = {};
    const { crossStreets } = layCrossStreets(sector, map);

    // Commit cross streets via tryAddRoad
    const committedCrossStreets = [];
    let csRejects = 0;
    for (const cs2 of crossStreets) {
      const result = tryAddRoad(map, cs2.points, { hierarchy: 'residential', source: 'cross-street' });
      if (result.accepted) {
        committedCrossStreets.push({
          ...cs2,
          roadId: result.road.id,
        });
      } else {
        csRejects++;
      }
    }
    allCrossStreets.push(...committedCrossStreets);
    totalCsRejects += csRejects;

    // Lay ribbons between committed cross streets
    if (committedCrossStreets.length >= 2) {
      const {
        ribbons,
        parcels,
        angleRejects,
        failedRibbons = [],
        seedAnchors = [],
        failureSummary = { reasons: {} },
      } = layRibbons(committedCrossStreets, sector, map);
      allFailedRibbons.push(...failedRibbons);
      allSeedAnchors.push(...seedAnchors);
      mergeCounts(sectorFailureCounts, failureSummary.reasons || {});

      // Commit ribbons via tryAddRoad
      let ribbonRejects = 0;
      const committedRibbons = [];
      for (const ribbon of ribbons) {
        const result = tryAddRoad(map, ribbon.points, { hierarchy: 'residential', source: 'ribbon' });
        if (result.accepted) {
          const junctions = splitRibbonHitJunctions(map, result.road.id, ribbon, committedCrossStreets);
          allRibbonJunctions.push(...junctions);
          committedRibbons.push({
            ...ribbon,
            roadId: result.road.id,
            junctions,
          });
        } else {
          ribbonRejects++;
          const reason = classifyTransactionFailure(result.violations);
          addCount(sectorFailureCounts, reason);
          allFailedRibbons.push({
            points: ribbon.points,
            reason,
            source: 'transaction',
            corridorIdx: ribbon.corridorIdx,
          });
        }
      }
      allRibbons.push(...committedRibbons);
      totalParcels += parcels.length;
      totalRibbonRejects += ribbonRejects;

      const csStr = csRejects > 0 ? `, ${csRejects} cs rejected` : '';
      const ribStr = ribbonRejects > 0 ? `, ${ribbonRejects} ribbons rejected` : '';
      const angStr = angleRejects > 0 ? `, ${angleRejects} angle rejects` : '';
      const failStr = formatFailureCounts(sectorFailureCounts);
      console.log(`    Sector ${si}: ${committedCrossStreets.length}/${crossStreets.length} cross streets, ${committedRibbons.length}/${ribbons.length} ribbons, ${parcels.length} parcels${csStr}${ribStr}${angStr}${failStr ? `, failures ${failStr}` : ''}`);
    } else {
      const csStr = csRejects > 0 ? ` (${csRejects} rejected)` : '';
      console.log(`    Sector ${si}: ${committedCrossStreets.length} cross streets${csStr} (too few for ribbons)`);
    }
  }

  console.log(`  Total: ${allCrossStreets.length} cross streets (${totalCsRejects} rejected), ${allRibbons.length} ribbons (${totalRibbonRejects} rejected), ${totalParcels} parcels`);

  // === Build sector cell lookup for boundary detection ===
  const cellToSector = new Map();
  for (let si = 0; si < sectors.length; si++) {
    for (const c of sectors[si].cells) {
      cellToSector.set(c.gz * W + c.gx, si);
    }
  }

  const sectorColors = sectors.map((_, i) => {
    const hue = (i * 137.508) % 360;
    return hslToRgb(hue, 0.6, 0.45);
  });

  // ===== Render =====
  const basePixels = new Uint8Array(cropW * cropH * 3);

  // Layer 1: Elevation grayscale base
  for (let z = 0; z < cropH; z++) {
    for (let x = 0; x < cropW; x++) {
      const gx2 = x + minGx, gz2 = z + minGz;
      const v = (elev.get(gx2, gz2) - eBounds.min) / eRange;
      const idx = (z * cropW + x) * 3;
      if (waterMask && waterMask.get(gx2, gz2) > 0) {
        basePixels[idx] = 15; basePixels[idx + 1] = 30; basePixels[idx + 2] = 80;
      } else {
        const grey = Math.round(40 + v * 80);
        basePixels[idx] = grey; basePixels[idx + 1] = grey; basePixels[idx + 2] = grey;
      }
    }
  }

  // Layer 2: Sector fills (semi-transparent)
  const ALPHA = 0.25;
  for (let si = 0; si < sectors.length; si++) {
    const color = sectorColors[si];
    for (const c of sectors[si].cells) {
      const px = c.gx - minGx;
      const pz = c.gz - minGz;
      if (px < 0 || px >= cropW || pz < 0 || pz >= cropH) continue;
      const idx = (pz * cropW + px) * 3;
      basePixels[idx]     = Math.round(basePixels[idx]     * (1 - ALPHA) + color[0] * ALPHA);
      basePixels[idx + 1] = Math.round(basePixels[idx + 1] * (1 - ALPHA) + color[1] * ALPHA);
      basePixels[idx + 2] = Math.round(basePixels[idx + 2] * (1 - ALPHA) + color[2] * ALPHA);
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
        basePixels[idx] = Math.min(255, basePixels[idx] + 30);
        basePixels[idx + 1] = Math.min(255, basePixels[idx + 1] + 50);
        basePixels[idx + 2] = Math.min(255, basePixels[idx + 2] + 20);
      }
    }
  }

  // Layer 4: Roads (grey)
  if (roadGrid) {
    for (let z = 0; z < cropH; z++)
      for (let x = 0; x < cropW; x++)
        if (roadGrid.get(x + minGx, z + minGz) > 0) {
          const idx = (z * cropW + x) * 3;
          basePixels[idx] = 150; basePixels[idx + 1] = 150; basePixels[idx + 2] = 150;
        }
  }

  // Layer 5: Cross streets (magenta polylines)
  for (const street of allCrossStreets) {
    const pts = street.points;
    for (let i = 1; i < pts.length; i++) {
      bres(basePixels, cropW, cropH,
        Math.round((pts[i - 1].x - ox) / cs) - minGx, Math.round((pts[i - 1].z - oz) / cs) - minGz,
        Math.round((pts[i].x - ox) / cs) - minGx, Math.round((pts[i].z - oz) / cs) - minGz,
        255, 0, 255);
    }
  }

  // Layer 6: Sector boundaries (thin white)
  for (let si = 0; si < sectors.length; si++) {
    for (const c of sectors[si].cells) {
      for (const [dx, dz] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nk = (c.gz + dz) * W + (c.gx + dx);
        const nsi = cellToSector.get(nk);
        if (nsi !== undefined && nsi !== si) {
          const px = c.gx - minGx;
          const pz = c.gz - minGz;
          if (px >= 0 && px < cropW && pz >= 0 && pz < cropH) {
            const idx = (pz * cropW + px) * 3;
            basePixels[idx] = 200; basePixels[idx + 1] = 200; basePixels[idx + 2] = 200;
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
      bres(basePixels, cropW, cropH, x0, y0, x1, y1, 255, 255, 0);
      bres(basePixels, cropW, cropH, x0 + 1, y0, x1 + 1, y1, 255, 255, 0);
      bres(basePixels, cropW, cropH, x0, y0 + 1, x1, y1 + 1, 255, 255, 0);
    }
  }

  const pixels = basePixels.slice();
  for (const ribbon of allRibbons) {
    drawRoad(pixels, ribbon.points, cropW, cropH, cs, ox, oz, minGx, minGz, [0, 255, 255]);
    drawEndpointDots(pixels, ribbon.points, cropW, cropH, cs, ox, oz, minGx, minGz, [255, 165, 0]);
    drawStreetHitPoints(pixels, ribbon.streetPoints || [], cropW, cropH, cs, ox, oz, minGx, minGz);
  }
  drawConfirmedJunctions(pixels, allRibbonJunctions, cropW, cropH, cs, ox, oz, minGx, minGz);
  for (const anchor of allSeedAnchors) {
    drawAnchorCircle(pixels, anchor.point, cropW, cropH, cs, ox, oz, minGx, minGz, anchor.accepted);
  }

  const failurePixels = basePixels.slice();
  for (const ribbon of allRibbons) {
    drawRoad(failurePixels, ribbon.points, cropW, cropH, cs, ox, oz, minGx, minGz, [80, 200, 200]);
    drawStreetHitPoints(failurePixels, ribbon.streetPoints || [], cropW, cropH, cs, ox, oz, minGx, minGz);
  }
  drawConfirmedJunctions(failurePixels, allRibbonJunctions, cropW, cropH, cs, ox, oz, minGx, minGz);
  for (const failure of allFailedRibbons) {
    drawRoad(
      failurePixels,
      failure.attemptPath || failure.points,
      cropW,
      cropH,
      cs,
      ox,
      oz,
      minGx,
      minGz,
      failureColor(failure.reason),
    );
  }
  for (const failure of allFailedRibbons) {
    if (failure.guideLine && !samePolyline(failure.guideLine, failure.attemptPath || failure.points)) {
      drawRoad(
        failurePixels,
        failure.guideLine,
        cropW,
        cropH,
        cs,
        ox,
        oz,
        minGx,
        minGz,
        [255, 255, 255],
      );
    }
  }
  for (const failure of allFailedRibbons) {
    if (failure.startPoint) {
      drawMarker(failurePixels, failure.startPoint, cropW, cropH, cs, ox, oz, minGx, minGz, [220, 220, 220], 2);
    }
    if (failure.projectedPoint) {
      drawMarker(failurePixels, failure.projectedPoint, cropW, cropH, cs, ox, oz, minGx, minGz, [120, 255, 255], 2);
    }
    if (failure.stopPoint) {
      drawMarker(failurePixels, failure.stopPoint, cropW, cropH, cs, ox, oz, minGx, minGz, failureColor(failure.reason), 3, [0, 0, 0]);
    }
  }
  for (const anchor of allSeedAnchors) {
    drawAnchorCircle(failurePixels, anchor.point, cropW, cropH, cs, ox, oz, minGx, minGz, anchor.accepted);
  }

  writeRaster(`${outDir}/ribbons-zone${zi}-seed${seed}`, cropW, cropH, pixels);
  console.log(`  Written to ${outDir}/ribbons-zone${zi}-seed${seed}.png (${cropW}x${cropH})`);

  if (allFailedRibbons.length > 0) {
    writeRaster(`${outDir}/ribbon-failures-zone${zi}-seed${seed}`, cropW, cropH, failurePixels);
    console.log(`  Written to ${outDir}/ribbon-failures-zone${zi}-seed${seed}.png (${cropW}x${cropH})`);
  }
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

function drawRoad(pixels, points, cropW, cropH, cs, ox, oz, minGx, minGz, color) {
  for (let i = 1; i < points.length; i++) {
    bres(
      pixels,
      cropW,
      cropH,
      Math.round((points[i - 1].x - ox) / cs) - minGx,
      Math.round((points[i - 1].z - oz) / cs) - minGz,
      Math.round((points[i].x - ox) / cs) - minGx,
      Math.round((points[i].z - oz) / cs) - minGz,
      color[0],
      color[1],
      color[2],
    );
  }
}

function splitRibbonHitJunctions(map, ribbonRoadId, ribbon, crossStreets) {
  if (!map?.roadNetwork || ribbonRoadId === null || ribbonRoadId === undefined) return [];
  const hits = ribbon?.streetPoints || [];
  const junctions = [];
  const seenNodeIds = new Set();
  for (const entry of hits) {
    if (!entry || !entry.pt || !Number.isInteger(entry.streetIdx)) continue;
    const crossStreet = crossStreets[entry.streetIdx];
    if (!crossStreet || crossStreet.roadId === null || crossStreet.roadId === undefined) continue;
    const junctionId = map.roadNetwork.connectRoadsAtPoint(
      ribbonRoadId,
      crossStreet.roadId,
      entry.pt.x,
      entry.pt.z,
      { nodeAttrs: { type: 'ribbon-hit', source: 'ribbon-hit' } },
    );
    if (junctionId === null || junctionId === undefined || seenNodeIds.has(junctionId)) continue;
    const node = map.graph?.getNode ? map.graph.getNode(junctionId) : null;
    if (!node) continue;
    seenNodeIds.add(junctionId);
    junctions.push({
      id: junctionId,
      x: node.x,
      z: node.z,
      streetIdx: entry.streetIdx,
    });
  }
  return junctions;
}

function drawEndpointDots(pixels, points, cropW, cropH, cs, ox, oz, minGx, minGz, color) {
  for (const pt of [points[0], points[points.length - 1]]) {
    const px = Math.round((pt.x - ox) / cs) - minGx;
    const pz = Math.round((pt.z - oz) / cs) - minGz;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (px + dx >= 0 && px + dx < cropW && pz + dz >= 0 && pz + dz < cropH) {
          const idx = ((pz + dz) * cropW + (px + dx)) * 3;
          pixels[idx] = color[0];
          pixels[idx + 1] = color[1];
          pixels[idx + 2] = color[2];
        }
      }
    }
  }
}

function drawAnchorCircle(pixels, point, cropW, cropH, cs, ox, oz, minGx, minGz, accepted) {
  const px = Math.round((point.x - ox) / cs) - minGx;
  const pz = Math.round((point.z - oz) / cs) - minGz;
  const ringColor = accepted ? [255, 215, 0] : [255, 120, 0];

  stampCircle(pixels, cropW, cropH, px, pz, 4, [0, 0, 0]);
  stampCircle(pixels, cropW, cropH, px, pz, 3, ringColor);
}

function drawStreetHitPoints(pixels, streetPoints, cropW, cropH, cs, ox, oz, minGx, minGz) {
  for (const entry of streetPoints) {
    const pt = entry && entry.pt ? entry.pt : entry;
    if (!pt) continue;
    drawMarker(pixels, pt, cropW, cropH, cs, ox, oz, minGx, minGz, [180, 255, 80], 1, [0, 0, 0]);
  }
}

function drawConfirmedJunctions(pixels, junctions, cropW, cropH, cs, ox, oz, minGx, minGz) {
  for (const node of junctions) {
    if (!node) continue;
    drawMarker(pixels, node, cropW, cropH, cs, ox, oz, minGx, minGz, [80, 200, 255], 2, [255, 255, 255]);
  }
}

function drawMarker(pixels, point, cropW, cropH, cs, ox, oz, minGx, minGz, color, radius = 2, outline = null) {
  const px = Math.round((point.x - ox) / cs) - minGx;
  const pz = Math.round((point.z - oz) / cs) - minGz;
  if (outline) stampFilledCircle(pixels, cropW, cropH, px, pz, radius + 1, outline);
  stampFilledCircle(pixels, cropW, cropH, px, pz, radius, color);
}

function stampCircle(pixels, cropW, cropH, cx, cz, radius, color) {
  const rOuterSq = radius * radius;
  const rInnerSq = (radius - 1) * (radius - 1);
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const dSq = dx * dx + dz * dz;
      if (dSq > rOuterSq || dSq < rInnerSq) continue;
      const px = cx + dx;
      const pz = cz + dz;
      if (px < 0 || px >= cropW || pz < 0 || pz >= cropH) continue;
      const idx = (pz * cropW + px) * 3;
      pixels[idx] = color[0];
      pixels[idx + 1] = color[1];
      pixels[idx + 2] = color[2];
    }
  }
}

function stampFilledCircle(pixels, cropW, cropH, cx, cz, radius, color) {
  const rSq = radius * radius;
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const dSq = dx * dx + dz * dz;
      if (dSq > rSq) continue;
      const px = cx + dx;
      const pz = cz + dz;
      if (px < 0 || px >= cropW || pz < 0 || pz >= cropH) continue;
      const idx = (pz * cropW + px) * 3;
      pixels[idx] = color[0];
      pixels[idx + 1] = color[1];
      pixels[idx + 2] = color[2];
    }
  }
}

function writeRaster(basePath, width, height, pixels) {
  const header = `P6\n${width} ${height}\n255\n`;
  writeFileSync(`${basePath}.ppm`, Buffer.concat([Buffer.from(header), Buffer.from(pixels)]));
  try { execSync(`convert "${basePath}.ppm" "${basePath}.png" 2>/dev/null`); } catch {}
}

function classifyTransactionFailure(violations) {
  const first = violations && violations[0] ? violations[0] : '';
  if (first.includes('crosses existing road')) return 'txn-crossing';
  if (first.includes('crosses water')) return 'txn-water';
  if (first.includes('parallel to existing road')) return 'txn-parallel';
  return 'txn-other';
}

function failureColor(reason) {
  if (reason === 'wrong-street') return [255, 120, 0];
  if (reason === 'ray-miss') return [255, 210, 120];
  if (reason === 'guide-direction') return [255, 40, 40];
  if (reason === 'guide-offset') return [255, 120, 120];
  if (reason === 'angle') return [190, 60, 255];
  if (reason === 'too-short') return [255, 170, 0];
  if (reason === 'too-long') return [255, 120, 0];
  if (reason === 'water' || reason === 'txn-water') return [80, 160, 255];
  if (reason === 'out-of-zone') return [255, 255, 90];
  if (reason === 'off-map') return [255, 255, 255];
  if (reason === 'too-close' || reason === 'txn-parallel') return [200, 110, 255];
  if (reason === 'txn-crossing') return [255, 0, 0];
  return [255, 180, 180];
}

function formatFailureCounts(counts) {
  const entries = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);
  if (entries.length === 0) return '';
  return entries.map(([reason, count]) => `${reason}=${count}`).join(', ');
}

function mergeCounts(target, counts) {
  for (const [reason, count] of Object.entries(counts)) {
    target[reason] = (target[reason] || 0) + count;
  }
}

function addCount(target, key) {
  target[key] = (target[key] || 0) + 1;
}

function samePolyline(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i].x - b[i].x) > 0.01 || Math.abs(a[i].z - b[i].z) > 0.01) return false;
  }
  return true;
}
