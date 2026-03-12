import { describe, it, expect } from 'vitest';
import { setupCity } from '../../src/city/setup.js';
import { generateRegion } from '../../src/regional/pipeline.js';
import { SeededRandom } from '../../src/core/rng.js';

function makeRegion(seed = 42) {
  const rng = new SeededRandom(seed);
  const coastEdge = ['north', 'south', 'east', 'west', null][rng.int(0, 4)];
  const layers = generateRegion({
    width: 128, height: 128, cellSize: 50, seaLevel: 0, coastEdge,
  }, rng);
  return { layers, rng };
}

describe('setupCity', { timeout: 30000 }, () => {
  it('creates a FeatureMap from regional data', () => {
    const { layers, rng } = makeRegion();
    const settlements = layers.getData('settlements');
    if (!settlements || settlements.length === 0) return; // skip if no settlements

    const settlement = settlements[0];
    const map = setupCity(layers, settlement, rng.fork('city'));

    expect(map).toBeDefined();
    expect(map.width).toBeGreaterThan(0);
    expect(map.height).toBeGreaterThan(0);
    expect(map.elevation).not.toBeNull();
    expect(map.slope).not.toBeNull();
  });

  it('has buildability computed', () => {
    const { layers, rng } = makeRegion();
    const settlements = layers.getData('settlements');
    if (!settlements || settlements.length === 0) return;

    const settlement = settlements[0];
    const map = setupCity(layers, settlement, rng.fork('city'));

    // Should have some buildable cells
    let buildable = 0;
    for (let gz = 0; gz < map.height; gz++) {
      for (let gx = 0; gx < map.width; gx++) {
        if (map.buildability.get(gx, gz) > 0.3) buildable++;
      }
    }
    expect(buildable).toBeGreaterThan(0);
  });

  it('computes land value with non-zero values', () => {
    const { layers, rng } = makeRegion();
    const settlements = layers.getData('settlements');
    if (!settlements || settlements.length === 0) return;

    const settlement = settlements[0];
    const map = setupCity(layers, settlement, rng.fork('city'));

    // Should have some cells with positive land value
    let valued = 0;
    for (let gz = 0; gz < map.height; gz++) {
      for (let gx = 0; gx < map.width; gx++) {
        if (map.landValue.get(gx, gz) > 0.1) valued++;
      }
    }
    expect(valued).toBeGreaterThan(0);

    // Town center area should have high value
    const params = layers.getData('params');
    const cx = Math.round((settlement.gx * params.cellSize - map.originX) / map.cellSize);
    const cz = Math.round((settlement.gz * params.cellSize - map.originZ) / map.cellSize);
    if (cx >= 0 && cx < map.width && cz >= 0 && cz < map.height) {
      expect(map.landValue.get(cx, cz)).toBeGreaterThan(0.15);
    }
  });

  it('places nuclei during setup', () => {
    const { layers, rng } = makeRegion();
    const settlements = layers.getData('settlements');
    if (!settlements || settlements.length === 0) return;

    const settlement = settlements[0];
    const map = setupCity(layers, settlement, rng.fork('city'));

    expect(map.nuclei.length).toBeGreaterThan(0);
    expect(map.nuclei[0]).toHaveProperty('gx');
    expect(map.nuclei[0]).toHaveProperty('gz');
    expect(map.nuclei[0]).toHaveProperty('type');
    expect(map.nuclei[0]).toHaveProperty('tier');
  });

  it('imports rivers from regional data', () => {
    const { layers, rng } = makeRegion();
    const settlements = layers.getData('settlements');
    if (!settlements || settlements.length === 0) return;

    const settlement = settlements[0];
    const map = setupCity(layers, settlement, rng.fork('city'));

    // Rivers may or may not be present depending on settlement location
    // Just check no crash
    expect(map.rivers).toBeDefined();
  });
});

describe('placeNuclei with regional settlements', { timeout: 30000 }, () => {
  it('seeds nuclei at regional settlement positions', () => {
    const { layers, rng } = makeRegion(152);
    const settlements = layers.getData('settlements');
    if (!settlements || settlements.length < 2) return;
    const settlement = settlements[0];
    const map = setupCity(layers, settlement, rng.fork('city'));
    const otherSettlements = map.regionalSettlements.filter(s =>
      s.gx !== settlement.gx || s.gz !== settlement.gz
    );
    for (const rs of otherSettlements) {
      const match = map.nuclei.find(n =>
        Math.abs(n.gx - rs.cityGx) < 15 && Math.abs(n.gz - rs.cityGz) < 15
      );
      expect(match).toBeDefined();
    }
  });

  it('regional settlement nuclei keep their regional tier', () => {
    const { layers, rng } = makeRegion(152);
    const settlements = layers.getData('settlements');
    if (!settlements || settlements.length < 2) return;
    const settlement = settlements[0];
    const map = setupCity(layers, settlement, rng.fork('city'));
    const otherSettlements = map.regionalSettlements.filter(s =>
      s.gx !== settlement.gx || s.gz !== settlement.gz
    );
    for (const rs of otherSettlements) {
      const match = map.nuclei.find(n =>
        Math.abs(n.gx - rs.cityGx) < 15 && Math.abs(n.gz - rs.cityGz) < 15
      );
      if (match) expect(match.tier).toBe(rs.tier);
    }
  });

  it('land-value nuclei have lower priority than regional settlements', () => {
    const { layers, rng } = makeRegion(152);
    const settlements = layers.getData('settlements');
    if (!settlements || settlements.length < 2) return;
    const settlement = settlements[0];
    const map = setupCity(layers, settlement, rng.fork('city'));
    const regionalTiers = map.regionalSettlements.map(s => s.tier);
    const maxRegionalTier = Math.max(...regionalTiers, 1);
    const otherSettlements = map.regionalSettlements.filter(s =>
      s.gx !== settlement.gx || s.gz !== settlement.gz
    );
    const regionalPositions = new Set();
    for (const rs of otherSettlements) {
      const match = map.nuclei.find(n =>
        Math.abs(n.gx - rs.cityGx) < 15 && Math.abs(n.gz - rs.cityGz) < 15
      );
      if (match) regionalPositions.add(match.index);
    }
    for (const n of map.nuclei) {
      if (n.index === 0) continue;
      if (regionalPositions.has(n.index)) continue;
      expect(n.tier).toBeGreaterThan(maxRegionalTier);
    }
  });

  it('regional settlement nuclei are not placed on water', () => {
    const { layers, rng } = makeRegion(152);
    const settlements = layers.getData('settlements');
    if (!settlements || settlements.length < 2) return;
    const settlement = settlements[0];
    const map = setupCity(layers, settlement, rng.fork('city'));
    for (const n of map.nuclei) {
      expect(map.waterMask.get(n.gx, n.gz)).toBe(0);
    }
  });
});
