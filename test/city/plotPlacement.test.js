import { describe, it, expect } from 'vitest';
import { setupCity } from '../../src/city/setup.js';
import { generateRegionFromSeed } from '../../src/ui/regionHelper.js';
import { SeededRandom } from '../../src/core/rng.js';
import { LandFirstDevelopment } from '../../src/city/strategies/landFirstDevelopment.js';

// Shared map — avoid repeated slow setupCity calls
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
    // Run only to tick 3 (zone extraction) to check zones before ribbon roads
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
    let totalCells = 0;
    for (const zone of zones) {
      for (const c of zone.cells) {
        totalCells++;
        if (map.roadGrid && map.roadGrid.get(c.gx, c.gz) > 0) roadCells++;
      }
    }
    // Zones should not contain skeleton road cells
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

    // Allow a tiny fraction for edge cases (boundary simplification)
    const ratio = totalSamples > 0 ? waterCrossings / totalSamples : 0;
    expect(ratio).toBeLessThan(0.01);
  });

  it('placed plots do not overlap skeleton roads', () => {
    const { map } = getShared();
    const cs = map.cellSize;
    const ox = map.originX, oz = map.originZ;

    // Build a bitmap of skeleton/collector road cells (same as placeTerracedRows uses)
    const skeletonBitmap = new (map.waterMask.constructor)(map.width, map.height, { type: 'uint8' });
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
                skeletonBitmap.set(gx, gz, 1);
              }
            }
          }
        }
      }
    }

    // Check plot footprints against skeleton bitmap
    const zones = map.developmentZones;
    let overlaps = 0, total = 0;

    for (const zone of zones) {
      if (!zone._streets) continue;
      const plotWidth = 5;
      const spacing = zone._spacing || 30;
      const plotDepth = Math.min(20, (spacing / 2) - 3 - 1);

      for (const street of zone._streets) {
        if (street.length < 2) continue;
        let streetLen = 0;
        for (let i = 1; i < street.length; i++) {
          const dx = street[i].x - street[i - 1].x;
          const dz = street[i].z - street[i - 1].z;
          streetLen += Math.sqrt(dx * dx + dz * dz);
        }
        if (streetLen < plotWidth * 2) continue;

        const numPlots = Math.floor(streetLen / plotWidth);
        let segIdx = 0, segStart = 0;

        for (let h = 0; h < numPlots; h++) {
          const dist = (h + 0.5) * plotWidth;
          while (segIdx < street.length - 2) {
            const dx = street[segIdx + 1].x - street[segIdx].x;
            const dz = street[segIdx + 1].z - street[segIdx].z;
            const sLen = Math.sqrt(dx * dx + dz * dz);
            if (segStart + sLen >= dist) break;
            segStart += sLen;
            segIdx++;
          }
          if (segIdx >= street.length - 1) break;

          const a = street[segIdx], b = street[segIdx + 1];
          const sdx = b.x - a.x, sdz = b.z - a.z;
          const segLen = Math.sqrt(sdx * sdx + sdz * sdz);
          if (segLen < 0.01) continue;
          const t = (dist - segStart) / segLen;
          const px = a.x + sdx * t, pz = a.z + sdz * t;
          const adx = sdx / segLen, adz = sdz / segLen;

          for (const side of [-1, 1]) {
            const perpX = (-sdz / segLen) * side;
            const perpZ = (sdx / segLen) * side;
            const frontX = px + perpX * 4.5;
            const frontZ = pz + perpZ * 4.5;

            // Sample cells across the plot footprint
            let plotOverlap = false;
            for (let pd = 0; pd <= plotDepth && !plotOverlap; pd += cs) {
              for (let pw = -plotWidth / 2; pw <= plotWidth / 2 && !plotOverlap; pw += cs) {
                const wx = frontX + adx * pw + perpX * pd;
                const wz = frontZ + adz * pw + perpZ * pd;
                const gx = Math.floor((wx - ox) / cs);
                const gz = Math.floor((wz - oz) / cs);
                if (gx < 0 || gz < 0 || gx >= map.width || gz >= map.height) continue;
                if (skeletonBitmap.get(gx, gz) > 0) plotOverlap = true;
              }
            }
            total++;
            if (plotOverlap) overlaps++;
          }
        }
      }
    }

    // Occupancy check should reject plots that overlap skeleton roads
    const ratio = total > 0 ? overlaps / total : 0;
    expect(ratio).toBeLessThan(0.02);
  });
});
