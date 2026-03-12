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

  it('street plot positions have adequate buildability', () => {
    const { map } = getShared();
    const zones = map.developmentZones;
    const cs = map.cellSize;

    let lowBuild = 0;
    let totalPlots = 0;

    for (const zone of zones) {
      if (!zone._streets) continue;
      const spacing = zone._spacing || 30;

      for (const street of zone._streets) {
        if (street.length < 2) continue;

        // Sample midpoints along street — front of plot on each side
        let streetLen = 0;
        for (let i = 1; i < street.length; i++) {
          const dx = street[i].x - street[i - 1].x;
          const dz = street[i].z - street[i - 1].z;
          streetLen += Math.sqrt(dx * dx + dz * dz);
        }

        const plotWidth = 5;
        const numPlots = Math.floor(streetLen / plotWidth);
        if (numPlots === 0) continue;

        // Check front-of-plot positions
        for (let h = 0; h < numPlots; h++) {
          const dist = (h + 0.5) * plotWidth;
          // Find position on street
          let segIdx = 0, segStart = 0;
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

          for (const side of [-1, 1]) {
            const perpX = (-sdz / segLen) * side;
            const perpZ = (sdx / segLen) * side;
            const frontX = px + perpX * 4.5; // road half + sidewalk
            const frontZ = pz + perpZ * 4.5;
            const gx = (frontX - map.originX) / cs;
            const gz = (frontZ - map.originZ) / cs;
            if (gx < 1 || gz < 1 || gx >= map.width - 1 || gz >= map.height - 1) continue;
            totalPlots++;
            if (map.buildability.sample(gx, gz) < 0.2) lowBuild++;
            if (map.waterMask.get(Math.floor(gx), Math.floor(gz)) > 0) lowBuild++;
          }
        }
      }
    }

    // Most plots should be on buildable land
    const ratio = totalPlots > 0 ? lowBuild / totalPlots : 0;
    expect(ratio).toBeLessThan(0.1);
  });
});
