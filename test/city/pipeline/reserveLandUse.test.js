import { describe, it, expect } from 'vitest';
import { Grid2D } from '../../../src/core/Grid2D.js';
import { reserveLandUse, RESERVATION } from '../../../src/city/pipeline/reserveLandUse.js';
import { ARCHETYPES } from '../../../src/city/archetypes.js';

function makeTestMap() {
  const width = 60, height = 60, cellSize = 5;
  const opts = { cellSize, originX: 0, originZ: 0 };
  const map = {
    width, height, cellSize, originX: 0, originZ: 0,
    _layers: new Map(),
    getLayer(name) { return this._layers.get(name); },
    hasLayer(name) { return this._layers.has(name); },
    setLayer(name, grid) { this._layers.set(name, grid); },
    nuclei: [{ gx: 30, gz: 30, type: 'market' }],
    developmentZones: [],
  };

  map.setLayer('zoneGrid', new Grid2D(width, height, { ...opts, type: 'uint8' }));

  // Spatial layers with realistic gradients
  const centrality = new Grid2D(width, height, opts);
  const edgeness = new Grid2D(width, height, opts);
  const downwindness = new Grid2D(width, height, opts);
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      const dx = gx - 30, dz = gz - 30;
      const c = Math.max(0, 1 - Math.sqrt(dx * dx + dz * dz) / 30);
      centrality.set(gx, gz, c);
      edgeness.set(gx, gz, 1 - c);
      downwindness.set(gx, gz, gx / 60);
    }
  }
  map.setLayer('centrality', centrality);
  map.setLayer('edgeness', edgeness);
  map.setLayer('downwindness', downwindness);
  map.setLayer('waterfrontness', new Grid2D(width, height, opts));
  map.setLayer('roadFrontage', new Grid2D(width, height, opts));

  // Development zone: 40x40 block in the centre
  const zoneCells = [];
  const zoneGrid = map.getLayer('zoneGrid');
  for (let gz = 10; gz < 50; gz++) {
    for (let gx = 10; gx < 50; gx++) {
      zoneCells.push({ gx, gz });
      zoneGrid.set(gx, gz, 1);
    }
  }
  map.developmentZones = [{ id: 1, cells: zoneCells, nucleusIdx: 0 }];

  return map;
}

describe('reserveLandUse', () => {
  it('sets reservationGrid layer', () => {
    const map = makeTestMap();
    reserveLandUse(map, null);
    expect(map.hasLayer('reservationGrid')).toBe(true);
  });

  it('returns map for chaining', () => {
    const map = makeTestMap();
    expect(reserveLandUse(map, null)).toBe(map);
  });

  it('produces empty grid when no archetype given', () => {
    const map = makeTestMap();
    reserveLandUse(map, null);
    const grid = map.getLayer('reservationGrid');
    let nonZero = 0;
    for (let gz = 0; gz < 60; gz++)
      for (let gx = 0; gx < 60; gx++)
        if (grid.get(gx, gz) > 0) nonZero++;
    expect(nonZero).toBe(0);
  });
});

describe('reserveLandUse with archetype', () => {
  it('reserves cells for each use type', () => {
    const map = makeTestMap();
    reserveLandUse(map, ARCHETYPES.marketTown);
    const grid = map.getLayer('reservationGrid');

    const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
    for (let gz = 0; gz < 60; gz++)
      for (let gx = 0; gx < 60; gx++) {
        const v = grid.get(gx, gz);
        if (v > 0) counts[v]++;
      }

    expect(counts[RESERVATION.COMMERCIAL]).toBeGreaterThan(0);
    expect(counts[RESERVATION.INDUSTRIAL]).toBeGreaterThan(0);
    expect(counts[RESERVATION.CIVIC]).toBeGreaterThan(0);
    expect(counts[RESERVATION.OPEN_SPACE]).toBeGreaterThan(0);
  });

  it('civic reserves are near the centre (market town)', () => {
    const map = makeTestMap();
    reserveLandUse(map, ARCHETYPES.marketTown);
    const grid = map.getLayer('reservationGrid');

    let cx = 0, cz = 0, count = 0;
    for (let gz = 0; gz < 60; gz++)
      for (let gx = 0; gx < 60; gx++)
        if (grid.get(gx, gz) === RESERVATION.CIVIC) { cx += gx; cz += gz; count++; }

    if (count > 0) {
      cx /= count; cz /= count;
      const dist = Math.sqrt((cx - 30) ** 2 + (cz - 30) ** 2);
      expect(dist).toBeLessThan(15);
    }
  });

  it('industrial reserves are away from centre (market town)', () => {
    const map = makeTestMap();
    reserveLandUse(map, ARCHETYPES.marketTown);
    const grid = map.getLayer('reservationGrid');

    let cx = 0, cz = 0, count = 0;
    for (let gz = 0; gz < 60; gz++)
      for (let gx = 0; gx < 60; gx++)
        if (grid.get(gx, gz) === RESERVATION.INDUSTRIAL) { cx += gx; cz += gz; count++; }

    if (count > 0) {
      cx /= count; cz /= count;
      const dist = Math.sqrt((cx - 30) ** 2 + (cz - 30) ** 2);
      expect(dist).toBeGreaterThan(5);
    }
  });

  it('reserved cell count approximately matches share budget', () => {
    const map = makeTestMap();
    const arch = ARCHETYPES.marketTown;
    reserveLandUse(map, arch);
    const grid = map.getLayer('reservationGrid');

    const totalZoneCells = map.developmentZones.reduce((sum, z) => sum + z.cells.length, 0);
    let civicCount = 0;
    for (let gz = 0; gz < 60; gz++)
      for (let gx = 0; gx < 60; gx++)
        if (grid.get(gx, gz) === RESERVATION.CIVIC) civicCount++;

    const expectedCivic = Math.round(totalZoneCells * arch.shares.civic);
    expect(civicCount).toBeGreaterThan(expectedCivic * 0.5);
    expect(civicCount).toBeLessThan(expectedCivic * 1.5);
  });

  it('reserved zones are contiguous', () => {
    const map = makeTestMap();
    reserveLandUse(map, ARCHETYPES.marketTown);
    const grid = map.getLayer('reservationGrid');

    const civicCells = [];
    for (let gz = 0; gz < 60; gz++)
      for (let gx = 0; gx < 60; gx++)
        if (grid.get(gx, gz) === RESERVATION.CIVIC) civicCells.push({ gx, gz });

    if (civicCells.length > 0) {
      const visited = new Set();
      const queue = [civicCells[0]];
      visited.add(`${civicCells[0].gx},${civicCells[0].gz}`);
      while (queue.length > 0) {
        const { gx, gz } = queue.shift();
        for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const nx = gx + dx, nz = gz + dz;
          const key = `${nx},${nz}`;
          if (!visited.has(key) && grid.get(nx, nz) === RESERVATION.CIVIC) {
            visited.add(key);
            queue.push({ gx: nx, gz: nz });
          }
        }
      }
      expect(visited.size).toBe(civicCells.length);
    }
  });

  it('stores reservationZones on map', () => {
    const map = makeTestMap();
    reserveLandUse(map, ARCHETYPES.marketTown);
    expect(map.reservationZones).toBeDefined();
    expect(map.reservationZones.length).toBe(4);
  });

  it('works with all 5 archetypes', () => {
    for (const arch of Object.values(ARCHETYPES)) {
      const map = makeTestMap();
      reserveLandUse(map, arch);
      const grid = map.getLayer('reservationGrid');
      let reserved = 0;
      for (let gz = 0; gz < 60; gz++)
        for (let gx = 0; gx < 60; gx++)
          if (grid.get(gx, gz) > 0) reserved++;
      expect(reserved).toBeGreaterThan(0);
    }
  });
});
