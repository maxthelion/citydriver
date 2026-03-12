import { describe, it, expect } from 'vitest';
import { setupCity } from '../../src/city/setup.js';
import { generateRegionFromSeed } from '../../src/ui/regionHelper.js';
import { SeededRandom } from '../../src/core/rng.js';
import { LandFirstDevelopment } from '../../src/city/strategies/landFirstDevelopment.js';
import { computePlotPlacements } from '../../src/city/placeBuildings.js';

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

// Build a bitmap of skeleton/collector road cells (excludes local ribbon roads)
function buildSkeletonBitmap(map) {
  const cs = map.cellSize;
  const ox = map.originX, oz = map.originZ;
  const Grid2D = map.waterMask.constructor;
  const bitmap = new Grid2D(map.width, map.height, { type: 'uint8' });

  for (const road of map.roads) {
    if (road.source === 'land-first' && road.hierarchy === 'local') continue;
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
            if (gx < 0 || gx >= map.width || gz < 0 || gz >= map.height) continue;
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

describe('plot placement quality', { timeout: 60000 }, () => {
  it('zones do not contain water cells', () => {
    const { map } = getShared();
    const zones = map.developmentZones;
    expect(zones.length).toBeGreaterThan(0);

    let waterCells = 0;
    for (const zone of zones) {
      for (const c of zone.cells) {
        if (map.waterMask.get(c.gx, c.gz) > 0) waterCells++;
      }
    }
    expect(waterCells).toBe(0);
  });

  it('skeleton roads split zones (river-like barriers)', () => {
    const seed = 42;
    const { layers, settlement } = generateRegionFromSeed(seed);
    const rng = new SeededRandom(seed);
    const map = setupCity(layers, settlement, rng.fork('city'));
    const strategy = new LandFirstDevelopment(map);
    strategy.tick(); // skeleton roads
    strategy.tick(); // land value
    strategy.tick(); // zone extraction

    const zones = map.developmentZones;
    let roadCells = 0;
    for (const zone of zones) {
      for (const c of zone.cells) {
        if (map.roadGrid && map.roadGrid.get(c.gx, c.gz) > 0) roadCells++;
      }
    }
    expect(roadCells).toBe(0);
  });

  it('ribbon streets do not cross water', () => {
    const { map } = getShared();
    const zones = map.developmentZones;
    const cs = map.cellSize;

    let waterCrossings = 0;
    let totalSamples = 0;

    for (const zone of zones) {
      if (!zone._streets) continue;
      for (const street of zone._streets) {
        for (const pt of street) {
          const gx = Math.floor((pt.x - map.originX) / cs);
          const gz = Math.floor((pt.z - map.originZ) / cs);
          if (gx < 0 || gz < 0 || gx >= map.width || gz >= map.height) continue;
          totalSamples++;
          if (map.waterMask.get(gx, gz) > 0) waterCrossings++;
        }
      }
    }

    const ratio = totalSamples > 0 ? waterCrossings / totalSamples : 0;
    expect(ratio).toBeLessThan(0.01);
  });

  it('computePlotPlacements returns plots', () => {
    const { map } = getShared();
    const { plots, occupancy } = computePlotPlacements(map);

    expect(plots.length).toBeGreaterThan(0);
    expect(occupancy).not.toBeNull();

    // Every plot should have valid corners
    for (const plot of plots) {
      expect(plot.corners).toHaveLength(4);
      expect(typeof plot.frontX).toBe('number');
      expect(typeof plot.frontZ).toBe('number');
      expect(typeof plot.angle).toBe('number');
    }
  });

  it('no placed plot overlaps a skeleton/collector road', () => {
    const { map } = getShared();
    const { plots } = computePlotPlacements(map);
    const skeletonBitmap = buildSkeletonBitmap(map);
    const cs = map.cellSize;
    const ox = map.originX, oz = map.originZ;

    let collidingPlots = 0;

    for (const plot of plots) {
      // Check every cell in the plot's footprint
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

      let collides = false;
      for (let gz = gz0; gz <= gz1 && !collides; gz++) {
        for (let gx = gx0; gx <= gx1 && !collides; gx++) {
          if (skeletonBitmap.get(gx, gz) === 0) continue;
          // Check if cell center is inside the plot quad
          const wx = ox + gx * cs, wz = oz + gz * cs;
          if (_pointInQuad(wx, wz, plot.corners)) collides = true;
        }
      }
      if (collides) collidingPlots++;
    }

    // Zero collisions with skeleton roads
    expect(collidingPlots).toBe(0);
  });

  it('no placed plot overlaps water', () => {
    const { map } = getShared();
    const { plots } = computePlotPlacements(map);
    const cs = map.cellSize;
    const ox = map.originX, oz = map.originZ;

    let waterPlots = 0;

    for (const plot of plots) {
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
      const gz1 = Math.min(map.height - 1, Math.ceil((maxZ - ox) / cs));

      let onWater = false;
      for (let gz = gz0; gz <= gz1 && !onWater; gz++) {
        for (let gx = gx0; gx <= gx1 && !onWater; gx++) {
          if (map.waterMask.get(gx, gz) === 0) continue;
          const wx = ox + gx * cs, wz = oz + gz * cs;
          if (_pointInQuad(wx, wz, plot.corners)) onWater = true;
        }
      }
      if (onWater) waterPlots++;
    }

    expect(waterPlots).toBe(0);
  });

  it('no two placed plots overlap each other', () => {
    const { map } = getShared();
    const { plots, occupancy } = computePlotPlacements(map);

    // The occupancy grid stamps each plot as it's placed, so if any were
    // placed on an already-occupied cell, the algorithm is broken.
    // Verify by re-running with a fresh occupancy grid.
    const cs = map.cellSize;
    const ox = map.originX, oz = map.originZ;
    const Grid2D = map.waterMask.constructor;
    const check = new Grid2D(map.width, map.height, { type: 'uint16' });

    let overlapPairs = 0;
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

      let thisPlotOverlaps = false;
      for (let gz = gz0; gz <= gz1; gz++) {
        for (let gx = gx0; gx <= gx1; gx++) {
          const wx = ox + gx * cs, wz = oz + gz * cs;
          if (!_pointInQuad(wx, wz, plot.corners)) continue;
          if (check.get(gx, gz) > 0) thisPlotOverlaps = true;
          check.set(gx, gz, pi + 1);
        }
      }
      if (thisPlotOverlaps) overlapPairs++;
    }

    expect(overlapPairs).toBe(0);
  });
});

/** Point-in-convex-quad (same logic as placeBuildings.js) */
function _pointInQuad(px, pz, corners) {
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const cross = (b.x - a.x) * (pz - a.z) - (b.z - a.z) * (px - a.x);
    if (cross < 0) return false;
  }
  return true;
}
