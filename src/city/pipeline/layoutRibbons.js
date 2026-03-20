/**
 * Pipeline step: lay out ribbon streets within development zones.
 * Reads: developmentZones, terrainSuitability, waterMask, roadGrid, nuclei, elevation, slope
 * Writes: roads (features), updates roadGrid layer
 */

import {
  computeRibbonOrientation, layoutRibbonStreets, adjustStreetToContour,
  CONTOUR_SLOPE_THRESHOLD,
} from '../ribbonLayout.js';

const MIN_CLIP_SEGMENT = 20; // meters
const CLIP_SAMPLE_STEP = 2;  // meters

/**
 * @param {object} map - FeatureMap
 * @returns {object} map (for chaining)
 */
export function layoutRibbons(map) {
  const zones = map.developmentZones;
  if (!zones || zones.length === 0) return map;

  for (const zone of zones) {
    const nucleus = map.nuclei[zone.nucleusIdx];
    const direction = computeRibbonOrientation(zone, nucleus, map.cellSize);

    const streets = layoutRibbonStreets(
      zone, direction, map.cellSize, map.originX, map.originZ
    );

    // Contour adjustment for sloped zones
    if (zone.avgSlope > CONTOUR_SLOPE_THRESHOLD) {
      const elevation = map.hasLayer ? map.getLayer('elevation') : map.elevation;
      for (let i = 0; i < streets.parallel.length; i++) {
        streets.parallel[i] = adjustStreetToContour(
          streets.parallel[i], elevation, zone.slopeDir,
          map.cellSize, map.originX, map.originZ
        );
      }
    }

    // Clip ribbon streets against existing roads and water
    const clippedParallel = [];
    for (const st of streets.parallel) {
      const segments = _clipStreetToGrid(st, map);
      clippedParallel.push(...segments);
    }
    const clippedCross = [];
    for (const st of streets.cross) {
      const segments = _clipStreetToGrid(st, map);
      clippedCross.push(...segments);
    }

    // Add parallel streets and track their graph edge IDs for T-junction splitting.
    // Only the parallel streets of THIS zone need to be split at cross endpoints.
    const parallelEdgesBeforeAdd = new Set(map.graph ? [...map.graph.edges.keys()] : []);
    for (const st of clippedParallel) {
      if (st.length < 2) continue;
      _addRoad(map, st, 'local', 6);
    }
    const parallelEdgeIds = map.graph
      ? [...map.graph.edges.keys()].filter(id => !parallelEdgesBeforeAdd.has(id))
      : [];

    for (const st of clippedCross) {
      if (st.length < 2) continue;
      _addRoad(map, st, 'local', 6);
    }

    // Store on zone for building placement and connection phase
    zone._spine = streets.spine;
    zone._streets = clippedParallel;
    zone._crossStreets = clippedCross;
    zone._spacing = streets.spacing;

    // Step 4a: T-junction splitting.
    // Cross street endpoints land in the middle of parallel street edges,
    // but the graph only has nodes at endpoints — no junction exists.
    // Only scan the parallel edges from THIS zone (not the full graph),
    // since cross streets can only T into the parallels they were generated from.
    _splitTJunctions(map, clippedCross, parallelEdgeIds);
  }

  return map;
}

/**
 * T-junction fix: for each cross street endpoint, find any graph edge that it
 * lies on (within snapDist of the edge line, t ∈ (0.1, 0.9)) and split it.
 *
 * This creates a proper topological junction so routing can traverse from a
 * parallel street onto a cross street.
 *
 * @param {object} map
 * @param {Array<Array<{x:number,z:number}>>} crossStreets - clipped cross street polylines
 */
/**
 * T-junction fix: for each cross street endpoint, split any parallel edge that
 * the endpoint lies on. Only scans the `parallelEdgeIds` list (edges added for
 * this zone's parallel streets) — not the full graph — keeping the scan O(parallels)
 * rather than O(all_graph_edges).
 *
 * @param {object} map
 * @param {Array} crossStreets
 * @param {number[]} parallelEdgeIds - graph edge IDs for this zone's parallel streets
 */
function _splitTJunctions(map, crossStreets, parallelEdgeIds = []) {
  const graph = map.graph;
  if (!graph || parallelEdgeIds.length === 0 || crossStreets.length === 0) return;

  const snapDistSq = (map.cellSize * 5) ** 2; // 25m²

  // parallelEdgeIds is already a snapshot (collected before adding cross streets).
  // No need to re-snapshot — these IDs won't be iterated back to us.
  const edgeSnapshot = parallelEdgeIds;

  for (const cs of crossStreets) {
    if (cs.length < 2) continue;
    const endpoints = [cs[0], cs[cs.length - 1]];

    for (const pt of endpoints) {
      // Scan the snapshot to find an edge that this endpoint lies on
      for (const edgeId of edgeSnapshot) {
        const edge = graph.edges.get(edgeId);
        if (!edge) continue; // already split in an earlier pass

        const from = graph.nodes.get(edge.from);
        const to   = graph.nodes.get(edge.to);
        if (!from || !to) continue;

        const dx = to.x - from.x;
        const dz = to.z - from.z;
        const lenSq = dx * dx + dz * dz;
        if (lenSq < 1) continue;

        // Project pt onto the edge segment
        const t = ((pt.x - from.x) * dx + (pt.z - from.z) * dz) / lenSq;
        if (t <= 0.1 || t >= 0.9) continue; // too close to endpoint nodes

        const projX = from.x + t * dx;
        const projZ = from.z + t * dz;

        const distSq = (pt.x - projX) ** 2 + (pt.z - projZ) ** 2;
        if (distSq < snapDistSq) {
          // Split this edge at the projection point to create a T-junction node
          graph.splitEdge(edgeId, projX, projZ);
          break; // one split per endpoint is enough
        }
      }
    }
  }
}

function _addRoad(map, polyline, hierarchy, width) {
  map.roadNetwork.add(polyline, {
    width,
    hierarchy,
    importance: hierarchy === 'collector' ? 0.5 : 0.2,
    source: 'land-first',
  });
}

/**
 * Clip a street polyline against the map's roadGrid and waterMask.
 */
function _clipStreetToGrid(street, map) {
  if (street.length < 2) return [];

  const roadGrid = map.getLayer('roadGrid');
  const railwayGrid = map.railwayGrid || null;
  const waterMask = map.getLayer('waterMask');
  const cs = map.cellSize;
  const ox = map.originX, oz = map.originZ;
  const roadHalf = 3;

  // Densify into evenly spaced samples
  const samples = [];
  for (let i = 0; i < street.length - 1; i++) {
    const ax = street[i].x, az = street[i].z;
    const bx = street[i + 1].x, bz = street[i + 1].z;
    const dx = bx - ax, dz = bz - az;
    const segLen = Math.sqrt(dx * dx + dz * dz);
    const steps = Math.max(1, Math.ceil(segLen / CLIP_SAMPLE_STEP));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      samples.push({ x: ax + dx * t, z: az + dz * t });
    }
  }
  samples.push(street[street.length - 1]);

  // Classify each sample as clear or blocked
  const RAILWAY_BUFFER = 2; // cells beyond stamped track
  const WATER_BANK_BUFFER = 1; // cells beyond water edge
  const clear = samples.map(p => {
    const gx = Math.round((p.x - ox) / cs);
    const gz = Math.round((p.z - oz) / cs);
    if (gx < 0 || gz < 0 || gx >= map.width || gz >= map.height) return false;

    // Water + bank buffer
    if (waterMask) {
      for (let dz = -WATER_BANK_BUFFER; dz <= WATER_BANK_BUFFER; dz++) {
        for (let dx = -WATER_BANK_BUFFER; dx <= WATER_BANK_BUFFER; dx++) {
          const nx = gx + dx, nz = gz + dz;
          if (nx >= 0 && nz >= 0 && nx < map.width && nz < map.height) {
            if (waterMask.get(nx, nz) > 0) return false;
          }
        }
      }
    }

    // Road buffer
    const r = Math.ceil(roadHalf / cs);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const nx = gx + dx, nz = gz + dz;
        if (nx < 0 || nz < 0 || nx >= map.width || nz >= map.height) continue;
        if (roadGrid && roadGrid.get(nx, nz) > 0) return false;
      }
    }

    // Railway buffer (wider than roads)
    if (railwayGrid) {
      for (let dz = -RAILWAY_BUFFER; dz <= RAILWAY_BUFFER; dz++) {
        for (let dx = -RAILWAY_BUFFER; dx <= RAILWAY_BUFFER; dx++) {
          const nx = gx + dx, nz = gz + dz;
          if (nx >= 0 && nz >= 0 && nx < map.width && nz < map.height) {
            if (railwayGrid.get(nx, nz) > 0) return false;
          }
        }
      }
    }

    return true;
  });

  // Split into contiguous clear segments
  const segments = [];
  let current = null;
  for (let i = 0; i < samples.length; i++) {
    if (clear[i]) {
      if (!current) current = [];
      current.push(samples[i]);
    } else {
      if (current && current.length >= 2) segments.push(current);
      current = null;
    }
  }
  if (current && current.length >= 2) segments.push(current);

  // Discard short fragments
  return segments.filter(seg => {
    let len = 0;
    for (let i = 1; i < seg.length; i++) {
      const dx = seg[i].x - seg[i - 1].x;
      const dz = seg[i].z - seg[i - 1].z;
      len += Math.sqrt(dx * dx + dz * dz);
    }
    return len >= MIN_CLIP_SEGMENT;
  });
}
