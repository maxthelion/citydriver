/**
 * collectParcels — extract Parcel objects from the reservation grid.
 *
 * For each development zone, groups cells by reservation type, flood-fills
 * contiguous regions, traces boundary polygons, and classifies each boundary
 * edge by what it borders (road, water, parcel-back, zone-edge, map-edge).
 *
 * Reads:  reservationGrid, zoneGrid, roadGrid, waterMask, developmentZones
 * Writes: map.parcels (flat array), zone.parcels (per-zone arrays)
 */

import { Parcel, EDGE_TYPE } from '../Parcel.js';
import { RESERVATION } from './growthAgents.js';
import { extractZoneBoundary } from '../zoneExtraction.js';

/**
 * Flood-fill connected components on cells matching a predicate.
 * Returns array of cell groups (each group is contiguous).
 *
 * @param {Array<{gx: number, gz: number}>} cells - candidate cells
 * @param {function({gx: number, gz: number}): boolean} predicate - cell filter
 * @returns {Array<Array<{gx: number, gz: number}>>} connected components
 */
export function floodFillComponents(cells, predicate) {
  const eligible = cells.filter(predicate);
  if (eligible.length === 0) return [];

  const cellSet = new Set();
  for (const c of eligible) cellSet.add(cellKey(c.gx, c.gz));

  const visited = new Set();
  const components = [];

  for (const c of eligible) {
    const k = cellKey(c.gx, c.gz);
    if (visited.has(k)) continue;

    // BFS flood fill
    const component = [];
    const queue = [c];
    visited.add(k);

    while (queue.length > 0) {
      const cell = queue.shift();
      component.push(cell);

      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cell.gx + dx, nz = cell.gz + dz;
        const nk = cellKey(nx, nz);
        if (visited.has(nk) || !cellSet.has(nk)) continue;
        visited.add(nk);
        queue.push({ gx: nx, gz: nz });
      }
    }

    components.push(component);
  }

  return components;
}

function cellKey(gx, gz) { return gx | (gz << 16); }

/**
 * For a set of boundary cells, find the boundary edges and classify each one
 * by what lies on the outside.
 *
 * Each boundary edge is a cell-edge between an inside cell and an outside cell.
 * We check what occupies the outside cell to determine the edge type.
 *
 * @param {Array<{gx: number, gz: number}>} cells
 * @param {object} map - FeatureMap (for grid lookups)
 * @param {number} resType - the reservation type of this parcel
 * @returns {Array<{inside: {gx,gz}, outside: {gx,gz}, direction: string}>}
 */
function findBoundaryEdgesWithClassification(cells, map, resType) {
  const cellSet = new Set();
  for (const c of cells) cellSet.add(`${c.gx},${c.gz}`);

  const w = map.width, h = map.height;
  const resGrid = map.getLayer('reservationGrid');
  const roadGrid = map.hasLayer('roadGrid') ? map.getLayer('roadGrid') : null;
  const waterMask = map.hasLayer('waterMask') ? map.getLayer('waterMask') : null;
  const zoneGrid = map.hasLayer('zoneGrid') ? map.getLayer('zoneGrid') : null;

  const directions = [
    { dx: 0, dz: -1, dir: 'north' },
    { dx: 0, dz: 1, dir: 'south' },
    { dx: -1, dz: 0, dir: 'west' },
    { dx: 1, dz: 0, dir: 'east' },
  ];

  const classifiedEdges = [];

  for (const c of cells) {
    for (const { dx, dz, dir } of directions) {
      const ox = c.gx + dx, oz = c.gz + dz;
      if (cellSet.has(`${ox},${oz}`)) continue; // interior edge, skip

      // This is a boundary edge: classify the outside cell
      let type;
      if (ox < 0 || ox >= w || oz < 0 || oz >= h) {
        type = EDGE_TYPE.MAP_EDGE;
      } else if (roadGrid && roadGrid.get(ox, oz) > 0) {
        type = EDGE_TYPE.ROAD;
      } else if (waterMask && waterMask.get(ox, oz) > 0) {
        type = EDGE_TYPE.WATER;
      } else if (resGrid && resGrid.get(ox, oz) !== RESERVATION.NONE && resGrid.get(ox, oz) !== resType) {
        type = EDGE_TYPE.PARCEL_BACK;
      } else if (zoneGrid && zoneGrid.get(ox, oz) === 0) {
        type = EDGE_TYPE.ZONE_EDGE;
      } else {
        // Same reservation type but not in our cell set (shouldn't happen often),
        // or unzoned area within the zone — treat as zone-edge.
        type = EDGE_TYPE.ZONE_EDGE;
      }

      classifiedEdges.push({
        inside: { gx: c.gx, gz: c.gz },
        outside: { gx: ox, gz: oz },
        direction: dir,
        type,
      });
    }
  }

  return classifiedEdges;
}

/**
 * Convert classified boundary edge info into world-coordinate segment objects.
 *
 * Each cell-edge becomes a segment: two corners of the cell boundary.
 * The segment coordinates match the convention in extractZoneBoundary.
 *
 * @param {Array<{inside: {gx,gz}, outside: {gx,gz}, direction: string, type: string}>} classifiedEdges
 * @param {number} cellSize
 * @param {number} originX
 * @param {number} originZ
 * @returns {Array<{segment: [{x,z},{x,z}], type: string}>}
 */
function buildEdgeSegments(classifiedEdges, cellSize, originX, originZ) {
  return classifiedEdges.map(({ inside, direction, type }) => {
    const { gx, gz } = inside;
    let x1, z1, x2, z2;

    // Match the vertex convention from extractZoneBoundary
    switch (direction) {
      case 'north': // top edge of cell
        x1 = gx; z1 = gz; x2 = gx + 1; z2 = gz;
        break;
      case 'south': // bottom edge of cell
        x1 = gx + 1; z1 = gz + 1; x2 = gx; z2 = gz + 1;
        break;
      case 'west': // left edge of cell
        x1 = gx; z1 = gz + 1; x2 = gx; z2 = gz;
        break;
      case 'east': // right edge of cell
        x1 = gx + 1; z1 = gz; x2 = gx + 1; z2 = gz + 1;
        break;
    }

    return {
      segment: [
        { x: originX + x1 * cellSize, z: originZ + z1 * cellSize },
        { x: originX + x2 * cellSize, z: originZ + z2 * cellSize },
      ],
      type,
    };
  });
}

/**
 * Compute the length of a segment.
 */
function segmentLength(seg) {
  const dx = seg[1].x - seg[0].x;
  const dz = seg[1].z - seg[0].z;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Collect parcels from the reservation grid.
 *
 * For each development zone, groups cells by reservation type, flood-fills
 * contiguous regions, traces boundaries, classifies edges, and creates Parcel objects.
 *
 * @param {object} map - FeatureMap
 * @returns {{ parcelCount: number, byType: Record<number, number> }}
 */
export function collectParcels(map) {
  const zones = map.developmentZones;
  if (!zones || zones.length === 0) {
    map.parcels = [];
    return { parcelCount: 0, byType: {} };
  }

  const resGrid = map.getLayer('reservationGrid');
  const zoneGrid = map.getLayer('zoneGrid');
  const { cellSize, originX, originZ } = map;

  const allParcels = [];
  const byType = {};
  let nextId = 1;

  for (const zone of zones) {
    const zoneParcels = [];

    // Find which reservation types are present in this zone
    const typesPresent = new Set();
    for (const c of zone.cells) {
      const rv = resGrid.get(c.gx, c.gz);
      if (rv !== RESERVATION.NONE) typesPresent.add(rv);
    }

    // For each reservation type, flood-fill contiguous regions
    for (const resType of typesPresent) {
      const components = floodFillComponents(
        zone.cells,
        (c) => resGrid.get(c.gx, c.gz) === resType,
      );

      for (const cells of components) {
        if (cells.length === 0) continue;

        // Trace boundary polygon (reuse existing extraction)
        const polygon = extractZoneBoundary(cells, cellSize, originX, originZ);

        // Classify boundary edges
        const classifiedEdges = findBoundaryEdgesWithClassification(cells, map, resType);
        const edges = buildEdgeSegments(classifiedEdges, cellSize, originX, originZ);

        // Compute frontage: sum of road-type edge lengths
        let frontageLength = 0;
        for (const edge of edges) {
          if (edge.type === EDGE_TYPE.ROAD) {
            frontageLength += segmentLength(edge.segment);
          }
        }

        // Area: number of cells * cellSize^2
        const area = cells.length * cellSize * cellSize;

        const parcel = new Parcel({
          id: nextId++,
          zoneId: zone.id,
          reservationType: resType,
          cells,
          polygon,
          edges,
          area,
          frontageLength,
        });

        zoneParcels.push(parcel);
        allParcels.push(parcel);
        byType[resType] = (byType[resType] || 0) + 1;
      }
    }

    zone.parcels = zoneParcels;
  }

  map.parcels = allParcels;

  return { parcelCount: allParcels.length, byType };
}
