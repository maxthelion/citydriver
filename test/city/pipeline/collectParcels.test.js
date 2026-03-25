import { describe, it, expect } from 'vitest';
import { Grid2D } from '../../../src/core/Grid2D.js';
import { RESERVATION } from '../../../src/city/pipeline/growthAgents.js';
import { collectParcels, floodFillComponents } from '../../../src/city/pipeline/collectParcels.js';
import { Parcel, EDGE_TYPE } from '../../../src/city/Parcel.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a minimal test map with the layer-bag API expected by collectParcels.
 * 20x20 grid, cellSize 5, one zone covering cells (2..17, 2..17).
 */
function makeTestMap() {
  const width = 20, height = 20, cellSize = 5;
  const opts = { cellSize, originX: 0, originZ: 0, type: 'uint8' };

  const map = {
    width, height, cellSize, originX: 0, originZ: 0,
    _layers: new Map(),
    getLayer(name) { return this._layers.get(name); },
    hasLayer(name) { return this._layers.has(name); },
    setLayer(name, grid) { this._layers.set(name, grid); },
    developmentZones: [],
    parcels: [],
  };

  // Reservation grid — starts empty
  map.setLayer('reservationGrid', new Grid2D(width, height, opts));

  // Zone grid — zone 1 covers 2..17 in both axes
  const zoneGrid = new Grid2D(width, height, opts);
  const zoneCells = [];
  for (let gz = 2; gz < 18; gz++) {
    for (let gx = 2; gx < 18; gx++) {
      zoneGrid.set(gx, gz, 1);
      zoneCells.push({ gx, gz });
    }
  }
  map.setLayer('zoneGrid', zoneGrid);

  // Road grid — a road along row gz=5
  const roadGrid = new Grid2D(width, height, opts);
  for (let gx = 2; gx < 18; gx++) {
    roadGrid.set(gx, 5, 1);
  }
  map.setLayer('roadGrid', roadGrid);

  // Water mask — water along column gx=15
  const waterMask = new Grid2D(width, height, opts);
  for (let gz = 2; gz < 18; gz++) {
    waterMask.set(15, gz, 1);
  }
  map.setLayer('waterMask', waterMask);

  // Development zone — one zone using the cells (excluding road and water cells)
  const devZoneCells = zoneCells.filter(c => {
    if (roadGrid.get(c.gx, c.gz) > 0) return false;
    if (waterMask.get(c.gx, c.gz) > 0) return false;
    return true;
  });

  map.developmentZones = [{
    id: 1,
    cells: devZoneCells,
    centroidGx: 10,
    centroidGz: 10,
  }];

  return map;
}

/**
 * Stamp a rectangular block of reservation cells.
 */
function stampReservation(map, gxMin, gxMax, gzMin, gzMax, resType) {
  const resGrid = map.getLayer('reservationGrid');
  const roadGrid = map.getLayer('roadGrid');
  const waterMask = map.getLayer('waterMask');
  for (let gz = gzMin; gz <= gzMax; gz++) {
    for (let gx = gxMin; gx <= gxMax; gx++) {
      // Don't stamp on road or water
      if (roadGrid.get(gx, gz) > 0) continue;
      if (waterMask.get(gx, gz) > 0) continue;
      resGrid.set(gx, gz, resType);
    }
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('floodFillComponents', () => {
  it('finds connected components from a cell list', () => {
    // Two separate 2x2 blocks
    const cells = [
      { gx: 0, gz: 0 }, { gx: 1, gz: 0 }, { gx: 0, gz: 1 }, { gx: 1, gz: 1 },
      { gx: 5, gz: 5 }, { gx: 6, gz: 5 }, { gx: 5, gz: 6 }, { gx: 6, gz: 6 },
    ];
    const components = floodFillComponents(cells, () => true);
    expect(components).toHaveLength(2);
    expect(components[0]).toHaveLength(4);
    expect(components[1]).toHaveLength(4);
  });

  it('respects predicate filter', () => {
    const cells = [
      { gx: 0, gz: 0 }, { gx: 1, gz: 0 }, { gx: 2, gz: 0 },
    ];
    // Only include first and last — they are not contiguous
    const components = floodFillComponents(cells, c => c.gx !== 1);
    expect(components).toHaveLength(2);
    expect(components[0]).toHaveLength(1);
    expect(components[1]).toHaveLength(1);
  });

  it('returns empty array for no matching cells', () => {
    const cells = [{ gx: 0, gz: 0 }];
    const components = floodFillComponents(cells, () => false);
    expect(components).toHaveLength(0);
  });
});

describe('collectParcels', () => {
  it('returns empty when no zones exist', () => {
    const map = makeTestMap();
    map.developmentZones = [];
    const result = collectParcels(map);
    expect(result.parcelCount).toBe(0);
    expect(map.parcels).toEqual([]);
  });

  it('returns empty when no reservations are stamped', () => {
    const map = makeTestMap();
    const result = collectParcels(map);
    expect(result.parcelCount).toBe(0);
    expect(map.parcels).toEqual([]);
  });

  it('creates parcels from stamped reservations', () => {
    const map = makeTestMap();
    // Stamp commercial block above the road (gz 2-4)
    stampReservation(map, 3, 8, 2, 4, RESERVATION.COMMERCIAL);
    // Stamp residential block below the road (gz 6-10)
    stampReservation(map, 3, 8, 6, 10, RESERVATION.RESIDENTIAL_FINE);

    const result = collectParcels(map);

    expect(result.parcelCount).toBe(2);
    expect(result.byType[RESERVATION.COMMERCIAL]).toBe(1);
    expect(result.byType[RESERVATION.RESIDENTIAL_FINE]).toBe(1);
    expect(map.parcels).toHaveLength(2);
  });

  it('creates Parcel instances with correct properties', () => {
    const map = makeTestMap();
    stampReservation(map, 3, 8, 6, 10, RESERVATION.COMMERCIAL);

    collectParcels(map);

    const parcel = map.parcels[0];
    expect(parcel).toBeInstanceOf(Parcel);
    expect(parcel.id).toBe(1);
    expect(parcel.zoneId).toBe(1);
    expect(parcel.reservationType).toBe(RESERVATION.COMMERCIAL);
    expect(parcel.cells.length).toBeGreaterThan(0);
    expect(parcel.polygon.length).toBeGreaterThan(0);
    expect(parcel.edges.length).toBeGreaterThan(0);
    expect(parcel.area).toBeGreaterThan(0);
  });

  it('traces boundary polygon in world coordinates', () => {
    const map = makeTestMap();
    stampReservation(map, 3, 8, 6, 10, RESERVATION.COMMERCIAL);

    collectParcels(map);
    const parcel = map.parcels[0];

    // Polygon should be in world coords (cellSize=5, origin=0)
    for (const p of parcel.polygon) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.z).toBeGreaterThanOrEqual(0);
      expect(typeof p.x).toBe('number');
      expect(typeof p.z).toBe('number');
    }
  });

  it('computes area correctly', () => {
    const map = makeTestMap();
    // 6 cols (3..8) x 5 rows (6..10) = 30 cells, each 5x5 = 750 m²
    stampReservation(map, 3, 8, 6, 10, RESERVATION.COMMERCIAL);

    collectParcels(map);
    const parcel = map.parcels[0];

    expect(parcel.area).toBe(30 * 25); // 30 cells * 5*5
  });

  it('classifies road edges correctly', () => {
    const map = makeTestMap();
    // Block just below the road at gz=5 — row 6 should border road
    stampReservation(map, 3, 8, 6, 10, RESERVATION.COMMERCIAL);

    collectParcels(map);
    const parcel = map.parcels[0];

    const roadEdges = parcel.edges.filter(e => e.type === EDGE_TYPE.ROAD);
    expect(roadEdges.length).toBeGreaterThan(0);
    expect(parcel.frontageLength).toBeGreaterThan(0);
  });

  it('classifies water edges correctly', () => {
    const map = makeTestMap();
    // Block next to water column at gx=15 — cells at gx=14 should border water
    stampReservation(map, 12, 14, 6, 10, RESERVATION.INDUSTRIAL);

    collectParcels(map);
    const parcel = map.parcels[0];

    const waterEdges = parcel.edges.filter(e => e.type === EDGE_TYPE.WATER);
    expect(waterEdges.length).toBeGreaterThan(0);
  });

  it('classifies zone-edge types for cells at zone boundary', () => {
    const map = makeTestMap();
    // Block touching the zone boundary (zone goes from 2..17, so gx=2 borders zone-edge)
    stampReservation(map, 2, 4, 6, 10, RESERVATION.CIVIC);

    collectParcels(map);
    const parcel = map.parcels[0];

    const zoneEdges = parcel.edges.filter(e => e.type === EDGE_TYPE.ZONE_EDGE);
    expect(zoneEdges.length).toBeGreaterThan(0);
  });

  it('classifies parcel-back edges between different reservation types', () => {
    const map = makeTestMap();
    // Two adjacent blocks with different types
    stampReservation(map, 3, 8, 6, 8, RESERVATION.COMMERCIAL);
    stampReservation(map, 3, 8, 9, 12, RESERVATION.RESIDENTIAL_FINE);

    collectParcels(map);

    expect(map.parcels).toHaveLength(2);

    // The commercial parcel's south edge should border residential (parcel-back)
    const commercial = map.parcels.find(p => p.reservationType === RESERVATION.COMMERCIAL);
    const backEdges = commercial.edges.filter(e => e.type === EDGE_TYPE.PARCEL_BACK);
    expect(backEdges.length).toBeGreaterThan(0);
  });

  it('splits non-contiguous regions into separate parcels', () => {
    const map = makeTestMap();
    // Two separated commercial blocks (road at gz=5 splits them)
    stampReservation(map, 3, 8, 2, 4, RESERVATION.COMMERCIAL);
    stampReservation(map, 3, 8, 6, 8, RESERVATION.COMMERCIAL);

    collectParcels(map);

    const commercial = map.parcels.filter(p => p.reservationType === RESERVATION.COMMERCIAL);
    expect(commercial).toHaveLength(2);
  });

  it('stores parcels on zones', () => {
    const map = makeTestMap();
    stampReservation(map, 3, 8, 6, 10, RESERVATION.COMMERCIAL);

    collectParcels(map);

    const zone = map.developmentZones[0];
    expect(zone.parcels).toHaveLength(1);
    expect(zone.parcels[0]).toBe(map.parcels[0]);
  });

  it('handles frontageLength = 0 when no road borders', () => {
    const map = makeTestMap();
    // Block far from the road (gz 12-14), not near water (gx < 15)
    stampReservation(map, 3, 8, 12, 14, RESERVATION.OPEN_SPACE);

    collectParcels(map);
    const parcel = map.parcels[0];

    expect(parcel.frontageLength).toBe(0);
  });
});
