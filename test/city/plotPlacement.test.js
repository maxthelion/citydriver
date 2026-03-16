import { describe, it, expect } from 'vitest';
import { setupCity } from '../../src/city/setup.js';
import { generateRegionFromSeed } from '../../src/ui/regionHelper.js';
import { SeededRandom } from '../../src/core/rng.js';
import { LandFirstDevelopment } from '../../src/city/strategies/landFirstDevelopment.js';
import { computePlotPlacements } from '../../src/city/placeBuildings.js';
import { Grid2D } from '../../src/core/Grid2D.js';
import { plotWidthForPressure } from '../../src/city/developmentPressure.js';

// Shared completed map
let shared;
function getShared() {
  if (!shared) {
    const seed = 42;
    const { layers, settlement } = generateRegionFromSeed(seed);
    const rng = new SeededRandom(seed);
    const map = setupCity(layers, settlement, rng.fork('city'));
    const strategy = new LandFirstDevelopment(map);
    while (strategy.tick()) {}
    shared = { map };
  }
  return shared;
}

/** Point-in-convex-quad — works for both CW and CCW winding. */
function pointInQuad(px, pz, corners) {
  let pos = 0, neg = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const cross = (b.x - a.x) * (pz - a.z) - (b.z - a.z) * (px - a.x);
    if (cross > 0) pos++;
    else if (cross < 0) neg++;
  }
  return pos === 0 || neg === 0;
}

/** Rasterise a rotated rectangle onto a bitmap. */
function stampQuad(corners, bitmap, cs, ox, oz) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const c of corners) {
    if (c.x < minX) minX = c.x;
    if (c.x > maxX) maxX = c.x;
    if (c.z < minZ) minZ = c.z;
    if (c.z > maxZ) maxZ = c.z;
  }
  const gx0 = Math.max(0, Math.floor((minX - ox) / cs));
  const gx1 = Math.min(bitmap.width - 1, Math.ceil((maxX - ox) / cs));
  const gz0 = Math.max(0, Math.floor((minZ - oz) / cs));
  const gz1 = Math.min(bitmap.height - 1, Math.ceil((maxZ - oz) / cs));
  for (let gz = gz0; gz <= gz1; gz++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const wx = ox + gx * cs;
      const wz = oz + gz * cs;
      if (pointInQuad(wx, wz, corners)) {
        bitmap.set(gx, gz, 1);
      }
    }
  }
}

/** Build a road bitmap from filtered roads. */
function buildFilteredRoadBitmap(map, filterFn) {
  const { width, height, cellSize: cs, originX: ox, originZ: oz } = map;
  const bitmap = new Grid2D(width, height, { type: 'uint8' });
  for (const road of map.roads) {
    if (!filterFn(road)) continue;
    const polyline = road.polyline;
    if (!polyline || polyline.length < 2) continue;
    const halfW = (road.width || 6) / 2;
    for (let i = 0; i < polyline.length - 1; i++) {
      const ax = polyline[i].x, az = polyline[i].z;
      const bx = polyline[i + 1].x, bz = polyline[i + 1].z;
      const dx = bx - ax, dz = bz - az;
      const segLen = Math.sqrt(dx * dx + dz * dz);
      if (segLen < 0.01) continue;
      const steps = Math.ceil(segLen / (cs * 0.5));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const px = ax + dx * t, pz = az + dz * t;
        const cellR = Math.ceil(halfW / cs);
        const cgx = Math.round((px - ox) / cs);
        const cgz = Math.round((pz - oz) / cs);
        for (let ddz = -cellR; ddz <= cellR; ddz++) {
          for (let ddx = -cellR; ddx <= cellR; ddx++) {
            const gx = cgx + ddx, gz = cgz + ddz;
            if (gx < 0 || gx >= width || gz < 0 || gz >= height) continue;
            const cellX = ox + gx * cs, cellZ = oz + gz * cs;
            if ((cellX - px) ** 2 + (cellZ - pz) ** 2 <= halfW * halfW) {
              bitmap.set(gx, gz, 1);
            }
          }
        }
      }
    }
  }
  return bitmap;
}

function buildRoadBitmap(map) {
  return buildFilteredRoadBitmap(map, () => true);
}

/** Build a plot bitmap by stamping every placed plot's full footprint. */
function buildPlotBitmap(map, plots) {
  const bitmap = new Grid2D(map.width, map.height, { type: 'uint8' });
  for (const plot of plots) {
    stampQuad(plot.corners, bitmap, map.cellSize, map.originX, map.originZ);
  }
  return bitmap;
}

/** AND two bitmaps — count overlapping cells. */
function bitmapIntersection(a, b) {
  let count = 0;
  for (let gz = 0; gz < a.height; gz++) {
    for (let gx = 0; gx < a.width; gx++) {
      if (a.get(gx, gz) > 0 && b.get(gx, gz) > 0) count++;
    }
  }
  return count;
}

describe('plot placement bitmap verification', { timeout: 120000 }, () => {
  it('zones do not contain water cells', () => {
    const { map } = getShared();
    let waterCells = 0;
    for (const zone of map.developmentZones) {
      for (const c of zone.cells) {
        if (map.waterMask.get(c.gx, c.gz) > 0) waterCells++;
      }
    }
    expect(waterCells).toBe(0);
  });

  it('zones do not overlap with skeleton roads', () => {
    // Zone extraction runs after skeleton but before ribbon layout.
    // The shared map has all roads (skeleton + ribbon + connector).
    // Check that zone cells don't overlap with skeleton-source roads
    // by rebuilding just the skeleton road bitmap.
    const { map } = getShared();
    const skeletonRoads = map.roads.filter(r => r.source === 'skeleton' || r.source === 'bridge');
    const skeletonBitmap = new Grid2D(map.width, map.height, { type: 'uint8', cellSize: map.cellSize });
    for (const road of skeletonRoads) {
      if (!road.polyline || road.polyline.length < 2) continue;
      Grid2D.stampPolyline(skeletonBitmap, road.polyline, (road.width || 6) / 2, 1);
    }

    let overlap = 0;
    for (const zone of map.developmentZones) {
      for (const c of zone.cells) {
        if (skeletonBitmap.get(c.gx, c.gz) > 0) overlap++;
      }
    }
    // Some minor overlap is possible at boundaries, but should be minimal
    const totalZoneCells = map.developmentZones.reduce((s, z) => s + z.cells.length, 0);
    const overlapFraction = totalZoneCells > 0 ? overlap / totalZoneCells : 0;
    expect(overlapFraction).toBeLessThan(0.05); // less than 5% overlap
  });

  it('ribbon street bitmap does not intersect skeleton road bitmap', () => {
    const { map } = getShared();
    const skeletonBitmap = buildFilteredRoadBitmap(map, r => r.source !== 'land-first');
    const ribbonBitmap = buildFilteredRoadBitmap(map, r => r.source === 'land-first' && r.hierarchy === 'local');

    const overlap = bitmapIntersection(ribbonBitmap, skeletonBitmap);

    let skeletonCells = 0, ribbonCells = 0;
    for (let gz = 0; gz < map.height; gz++) {
      for (let gx = 0; gx < map.width; gx++) {
        if (skeletonBitmap.get(gx, gz) > 0) skeletonCells++;
        if (ribbonBitmap.get(gx, gz) > 0) ribbonCells++;
      }
    }
    console.log(`  Skeleton cells: ${skeletonCells}, Ribbon cells: ${ribbonCells}, Overlap: ${overlap}`);
    expect(overlap).toBe(0);
  });

  it('plot bitmap does not intersect road bitmap', () => {
    const { map } = getShared();
    const { plots } = computePlotPlacements(map);
    expect(plots.length).toBeGreaterThan(0);

    const roadBitmap = buildRoadBitmap(map);
    const plotBitmap = buildPlotBitmap(map, plots);
    const overlap = bitmapIntersection(plotBitmap, roadBitmap);

    // Count totals for context
    let roadCells = 0, plotCells = 0;
    for (let gz = 0; gz < map.height; gz++) {
      for (let gx = 0; gx < map.width; gx++) {
        if (roadBitmap.get(gx, gz) > 0) roadCells++;
        if (plotBitmap.get(gx, gz) > 0) plotCells++;
      }
    }

    console.log(`  Road cells: ${roadCells}, Plot cells: ${plotCells}, Overlap: ${overlap}`);
    expect(overlap).toBe(0);
  });

  it('plot bitmap does not intersect water bitmap', () => {
    const { map } = getShared();
    const { plots } = computePlotPlacements(map);

    const plotBitmap = buildPlotBitmap(map, plots);
    const overlap = bitmapIntersection(plotBitmap, map.waterMask);

    console.log(`  Water-plot overlap cells: ${overlap}`);
    expect(overlap).toBe(0);
  });

  it('no two plots share any cells', () => {
    const { map } = getShared();
    const { plots } = computePlotPlacements(map);
    const cs = map.cellSize;
    const ox = map.originX, oz = map.originZ;

    // Use uint16 to track which plot owns each cell
    const owner = new Grid2D(map.width, map.height, { type: 'uint16' });
    let overlapCells = 0;

    for (let pi = 0; pi < plots.length; pi++) {
      const plot = plots[pi];
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const c of plot.corners) {
        if (c.x < minX) minX = c.x;
        if (c.x > maxX) maxX = c.x;
        if (c.z < minZ) minZ = c.z;
        if (c.z > maxZ) maxZ = c.z;
      }
      const gx0 = Math.max(0, Math.floor((minX - ox) / cs));
      const gx1 = Math.min(map.width - 1, Math.ceil((maxX - ox) / cs));
      const gz0 = Math.max(0, Math.floor((minZ - oz) / cs));
      const gz1 = Math.min(map.height - 1, Math.ceil((maxZ - oz) / cs));

      for (let gz = gz0; gz <= gz1; gz++) {
        for (let gx = gx0; gx <= gx1; gx++) {
          const wx = ox + gx * cs, wz = oz + gz * cs;
          if (!pointInQuad(wx, wz, plot.corners)) continue;
          if (owner.get(gx, gz) > 0) overlapCells++;
          owner.set(gx, gz, pi + 1);
        }
      }
    }

    console.log(`  Plot-plot overlap cells: ${overlapCells}`);
    expect(overlapCells).toBe(0);
  });
});

describe('pressure-based plot placement', () => {
  it('high-pressure zones produce narrower plots than low-pressure zones', () => {
    const highW = plotWidthForPressure(0.9, 0.5);
    const lowW = plotWidthForPressure(0.2, 0.5);
    expect(highW).toBeLessThan(7);
    expect(lowW).toBeGreaterThan(10);
  });
});
