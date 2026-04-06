import { describe, it, expect } from 'vitest';
import { Grid2D } from '../../../src/core/Grid2D.js';
import { RESERVATION } from '../../../src/city/pipeline/growthAgents.js';
import { Parcel } from '../../../src/city/Parcel.js';
import { Plot } from '../../../src/city/Plot.js';
import { subdividePlots } from '../../../src/city/pipeline/subdividePlots.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal test map with two parallel ribbon streets and a residential zone.
 *
 * Grid: 40x40, cellSize 5, origin (0,0).
 * Zone covers cells (2..37, 2..37) = 180m x 180m.
 * Two parallel streets at z=50 and z=100 (world coords), running from x=10 to x=190.
 * Spacing = 50m (distance between the two streets).
 */
function makeTestMap() {
  const width = 40, height = 40, cellSize = 5;
  const opts = { cellSize, originX: 0, originZ: 0, type: 'uint8' };

  const map = {
    width, height, cellSize, originX: 0, originZ: 0,
    _layers: new Map(),
    getLayer(name) { return this._layers.get(name); },
    hasLayer(name) { return this._layers.has(name); },
    setLayer(name, grid) { this._layers.set(name, grid); },
    developmentZones: [],
    parcels: [],
    plots: [],
  };

  // Road grid — empty (ribbon streets are not stamped here)
  map.setLayer('roadGrid', new Grid2D(width, height, opts));

  // Water mask — empty
  map.setLayer('waterMask', new Grid2D(width, height, opts));

  // Zone grid
  const zoneGrid = new Grid2D(width, height, opts);
  const zoneCells = [];
  for (let gz = 2; gz < 38; gz++) {
    for (let gx = 2; gx < 38; gx++) {
      zoneGrid.set(gx, gz, 1);
      zoneCells.push({ gx, gz });
    }
  }
  map.setLayer('zoneGrid', zoneGrid);

  // Reservation grid — residential everywhere
  const resGrid = new Grid2D(width, height, opts);
  for (const c of zoneCells) {
    resGrid.set(c.gx, c.gz, RESERVATION.RESIDENTIAL_FINE);
  }
  map.setLayer('reservationGrid', resGrid);

  // Two parallel street polylines (world coords)
  // Street 1: z=50, from x=10 to x=190
  // Street 2: z=100, from x=10 to x=190
  const street1 = [
    { x: 10, z: 50 },
    { x: 190, z: 50 },
  ];
  const street2 = [
    { x: 10, z: 100 },
    { x: 190, z: 100 },
  ];

  // Create a parcel covering the zone
  const parcel = new Parcel({
    id: 1,
    zoneId: 1,
    reservationType: RESERVATION.RESIDENTIAL_FINE,
    cells: zoneCells,
    polygon: [
      { x: 10, z: 10 },
      { x: 190, z: 10 },
      { x: 190, z: 190 },
      { x: 10, z: 190 },
    ],
    edges: [],
    area: zoneCells.length * cellSize * cellSize,
    frontageLength: 0,
  });

  // Development zone
  map.developmentZones = [{
    id: 1,
    cells: zoneCells,
    centroidGx: 20,
    centroidGz: 20,
    _streets: [street1, street2],
    _spacing: 50, // 50m between streets
    parcels: [parcel],
  }];

  map.parcels = [parcel];

  return map;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('subdividePlots', () => {
  it('returns empty when no zones exist', () => {
    const map = makeTestMap();
    map.developmentZones = [];
    const result = subdividePlots(map);
    expect(result.plotCount).toBe(0);
    expect(map.plots).toEqual([]);
  });

  it('returns empty when zones have no _streets', () => {
    const map = makeTestMap();
    delete map.developmentZones[0]._streets;
    const result = subdividePlots(map);
    expect(result.plotCount).toBe(0);
  });

  it('creates plots from two parallel streets', () => {
    const map = makeTestMap();
    const result = subdividePlots(map);

    expect(result.plotCount).toBeGreaterThan(0);
    expect(map.plots.length).toBe(result.plotCount);
  });

  it('creates Plot instances with correct properties', () => {
    const map = makeTestMap();
    subdividePlots(map);

    const plot = map.plots[0];
    expect(plot).toBeInstanceOf(Plot);
    expect(plot.id).toBe(1);
    expect(plot.zoneId).toBe(1);
    expect(plot.polygon).toHaveLength(4);
    expect(plot.frontageEdge).toBeDefined();
    expect(plot.frontageEdge.segment).toHaveLength(2);
    expect(plot.width).toBeGreaterThan(0);
    expect(plot.depth).toBeGreaterThan(0);
    expect(plot.area).toBeCloseTo(plot.width * plot.depth, 0);
    expect(plot.usage).toBe('residential');
    expect(plot.buildingId).toBeNull();
  });

  it('each plot has road frontage (frontageEdge)', () => {
    const map = makeTestMap();
    subdividePlots(map);

    for (const plot of map.plots) {
      const seg = plot.frontageEdge.segment;
      expect(seg).toHaveLength(2);
      // The frontage edge should have non-zero length
      const dx = seg[1].x - seg[0].x;
      const dz = seg[1].z - seg[0].z;
      const len = Math.sqrt(dx * dx + dz * dz);
      expect(len).toBeGreaterThan(0);
    }
  });

  it('plot polygons have 4 corners in world coords', () => {
    const map = makeTestMap();
    subdividePlots(map);

    for (const plot of map.plots) {
      expect(plot.polygon).toHaveLength(4);
      for (const corner of plot.polygon) {
        expect(typeof corner.x).toBe('number');
        expect(typeof corner.z).toBe('number');
        expect(Number.isFinite(corner.x)).toBe(true);
        expect(Number.isFinite(corner.z)).toBe(true);
      }
    }
  });

  it('plots do not overlap (axis-aligned check on centers)', () => {
    const map = makeTestMap();
    subdividePlots(map);

    // Quick overlap check: no two plot centers should be within half a plot-width of each other
    const centers = map.plots.map(p => ({
      x: (p.polygon[0].x + p.polygon[2].x) / 2,
      z: (p.polygon[0].z + p.polygon[2].z) / 2,
    }));

    for (let i = 0; i < centers.length; i++) {
      for (let j = i + 1; j < centers.length; j++) {
        const dx = Math.abs(centers[i].x - centers[j].x);
        const dz = Math.abs(centers[i].z - centers[j].z);
        const dist = Math.sqrt(dx * dx + dz * dz);
        // Minimum separation: plots should not be closer than ~3m
        // (they are ~7m wide and placed at 7m intervals)
        expect(dist).toBeGreaterThan(2);
      }
    }
  });

  it('stores plots on parcel.plots', () => {
    const map = makeTestMap();
    subdividePlots(map);

    const parcel = map.parcels[0];
    expect(parcel.plots).toBeDefined();
    expect(parcel.plots.length).toBeGreaterThan(0);
    // Every plot on the parcel should also be in map.plots
    for (const plot of parcel.plots) {
      expect(map.plots).toContain(plot);
    }
  });

  it('stores all plots on map.plots', () => {
    const map = makeTestMap();
    subdividePlots(map);

    // map.plots should contain every plot from every parcel
    let totalFromParcels = 0;
    for (const parcel of map.parcels) {
      if (parcel.plots) totalFromParcels += parcel.plots.length;
    }
    expect(map.plots.length).toBeGreaterThanOrEqual(totalFromParcels);
  });

  it('avoids placing plots on water cells', () => {
    const map = makeTestMap();
    // Place water across the middle of the map
    const waterMask = map.getLayer('waterMask');
    for (let gx = 0; gx < map.width; gx++) {
      // Water at z cells 10-12 (world z = 50-60), which overlaps street 1
      for (let gz = 10; gz <= 12; gz++) {
        waterMask.set(gx, gz, 1);
      }
    }

    subdividePlots(map);

    // Plots near the water should have been rejected
    for (const plot of map.plots) {
      const cx = (plot.polygon[0].x + plot.polygon[2].x) / 2;
      const cz = (plot.polygon[0].z + plot.polygon[2].z) / 2;
      const gx = Math.round(cx / map.cellSize);
      const gz = Math.round(cz / map.cellSize);
      if (gx >= 0 && gz >= 0 && gx < map.width && gz < map.height) {
        expect(waterMask.get(gx, gz)).toBe(0);
      }
    }
  });

  it('avoids placing plots on road-grid cells', () => {
    const map = makeTestMap();
    // Stamp a road across the middle
    const roadGrid = map.getLayer('roadGrid');
    for (let gx = 0; gx < map.width; gx++) {
      roadGrid.set(gx, 15, 1); // world z=75
    }

    subdividePlots(map);

    for (const plot of map.plots) {
      const cx = (plot.polygon[0].x + plot.polygon[2].x) / 2;
      const cz = (plot.polygon[0].z + plot.polygon[2].z) / 2;
      const gx = Math.round(cx / map.cellSize);
      const gz = Math.round(cz / map.cellSize);
      if (gx >= 0 && gz >= 0 && gx < map.width && gz < map.height) {
        expect(roadGrid.get(gx, gz)).toBe(0);
      }
    }
  });

  it('places plots on both sides of each street', () => {
    const map = makeTestMap();
    // Use a single street for clarity
    map.developmentZones[0]._streets = [
      [{ x: 20, z: 100 }, { x: 180, z: 100 }],
    ];
    subdividePlots(map);

    // With plots on both sides, some should be above z=100 and some below
    const above = map.plots.filter(p => {
      const cz = (p.polygon[0].z + p.polygon[2].z) / 2;
      return cz > 100;
    });
    const below = map.plots.filter(p => {
      const cz = (p.polygon[0].z + p.polygon[2].z) / 2;
      return cz < 100;
    });

    expect(above.length).toBeGreaterThan(0);
    expect(below.length).toBeGreaterThan(0);
  });

  it('handles multi-segment streets', () => {
    const map = makeTestMap();
    // Replace with a multi-segment street (L-shape)
    map.developmentZones[0]._streets = [
      [
        { x: 20, z: 50 },
        { x: 100, z: 50 },
        { x: 100, z: 150 },
      ],
    ];
    subdividePlots(map);

    expect(map.plots.length).toBeGreaterThan(0);
  });

  it('skips very short streets', () => {
    const map = makeTestMap();
    // Street shorter than MIN_STREET_LENGTH (10m)
    map.developmentZones[0]._streets = [
      [{ x: 50, z: 50 }, { x: 55, z: 50 }], // 5m
    ];
    subdividePlots(map);

    expect(map.plots.length).toBe(0);
  });

  it('assigns unique IDs to all plots', () => {
    const map = makeTestMap();
    subdividePlots(map);

    const ids = map.plots.map(p => p.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});
