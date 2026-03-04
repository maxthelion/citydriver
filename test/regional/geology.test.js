import { describe, it, expect } from 'vitest';
import { SeededRandom } from '../../src/core/rng.js';
import { generateGeology, ROCK_TYPES, ROCK_PROPERTIES } from '../../src/regional/geology.js';

const SEED = 42;
const GRID_SIZE = 64;

function makeGeology(overrides = {}) {
  const rng = new SeededRandom(SEED);
  return generateGeology({
    gridSize: GRID_SIZE,
    geologyComplexity: 3,
    igneousIntrusionCount: 1,
    ...overrides,
  }, rng);
}

describe('Geology Generation', () => {

  it('1. rockTypes has correct dimensions', () => {
    const geo = makeGeology();
    expect(geo.rockTypes.length).toBe(GRID_SIZE * GRID_SIZE);
    expect(geo.rockTypes).toBeInstanceOf(Uint8Array);
  });

  it('2. all rock type values are in valid range [0,4]', () => {
    const geo = makeGeology();
    for (let i = 0; i < geo.rockTypes.length; i++) {
      expect(geo.rockTypes[i]).toBeGreaterThanOrEqual(0);
      expect(geo.rockTypes[i]).toBeLessThanOrEqual(4);
    }
  });

  it('3. sedimentary bands create varied rock types across the grid', () => {
    const geo = makeGeology();
    const typeCounts = new Array(5).fill(0);
    for (let i = 0; i < geo.rockTypes.length; i++) {
      typeCounts[geo.rockTypes[i]]++;
    }

    // At least 2 distinct sedimentary types present
    const sedCount = [ROCK_TYPES.HARD_SED, ROCK_TYPES.SOFT_SED, ROCK_TYPES.CHALK]
      .filter(t => typeCounts[t] > 0).length;
    expect(sedCount).toBeGreaterThanOrEqual(2);
  });

  it('4. igneous intrusions create IGNEOUS cells', () => {
    const geo = makeGeology({ igneousIntrusionCount: 2 });
    const typeCounts = new Array(5).fill(0);
    for (let i = 0; i < geo.rockTypes.length; i++) {
      typeCounts[geo.rockTypes[i]]++;
    }
    expect(typeCounts[ROCK_TYPES.IGNEOUS]).toBeGreaterThan(0);
    expect(geo.intrusions.length).toBe(2);

    // Intrusions have valid center and radius
    for (const intr of geo.intrusions) {
      expect(intr.cx).toBeGreaterThan(0);
      expect(intr.cz).toBeGreaterThan(0);
      expect(intr.radius).toBeGreaterThan(0);
    }
  });

  it('5. spring line marks boundaries between different rock resistances', () => {
    const geo = makeGeology();
    expect(geo.springLine).toBeInstanceOf(Uint8Array);
    expect(geo.springLine.length).toBe(GRID_SIZE * GRID_SIZE);

    // Spring line cells should exist where different rock types meet
    let springCount = 0;
    for (let i = 0; i < geo.springLine.length; i++) {
      if (geo.springLine[i]) springCount++;
    }
    expect(springCount).toBeGreaterThan(0);

    // Verify a spring line cell actually has a neighbor with different resistance
    for (let gz = 1; gz < GRID_SIZE - 1; gz++) {
      for (let gx = 1; gx < GRID_SIZE - 1; gx++) {
        const idx = gz * GRID_SIZE + gx;
        if (!geo.springLine[idx]) continue;

        const myRes = ROCK_PROPERTIES[geo.rockTypes[idx]].erosionResistance;
        let hasDiffNeighbor = false;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dz === 0) continue;
            const nIdx = (gz + dz) * GRID_SIZE + (gx + dx);
            const nRes = ROCK_PROPERTIES[geo.rockTypes[nIdx]].erosionResistance;
            if (Math.abs(myRes - nRes) >= 0.3) hasDiffNeighbor = true;
          }
        }
        expect(hasDiffNeighbor).toBe(true);
        return; // Only need to check one
      }
    }
  });

  it('6. deterministic: same seed produces identical geology', () => {
    const geoA = makeGeology();
    const geoB = makeGeology();

    expect(geoA.bandDirection).toBe(geoB.bandDirection);
    expect(geoA.intrusions.length).toBe(geoB.intrusions.length);
    for (let i = 0; i < geoA.rockTypes.length; i++) {
      expect(geoA.rockTypes[i]).toBe(geoB.rockTypes[i]);
    }
    for (let i = 0; i < geoA.springLine.length; i++) {
      expect(geoA.springLine[i]).toBe(geoB.springLine[i]);
    }
  });

  it('7. zero intrusions produces no igneous cells', () => {
    const geo = makeGeology({ igneousIntrusionCount: 0 });
    expect(geo.intrusions.length).toBe(0);

    let igneousCount = 0;
    for (let i = 0; i < geo.rockTypes.length; i++) {
      if (geo.rockTypes[i] === ROCK_TYPES.IGNEOUS) igneousCount++;
    }
    expect(igneousCount).toBe(0);
  });

  it('8. no alluvial deposits present (deferred to drainage phase)', () => {
    const geo = makeGeology();
    let alluvialCount = 0;
    for (let i = 0; i < geo.rockTypes.length; i++) {
      if (geo.rockTypes[i] === ROCK_TYPES.ALLUVIAL) alluvialCount++;
    }
    expect(alluvialCount).toBe(0);
  });

});
