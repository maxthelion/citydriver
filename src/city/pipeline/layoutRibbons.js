/**
 * Pipeline step: lay out ribbon streets within development zones.
 * Reads: developmentZones, terrainSuitability, waterMask, roadGrid, nuclei, elevation, slope
 * Writes: roads (features), updates roadGrid layer
 */

import {
  computeRibbonOrientation, layoutRibbonStreets, adjustStreetToContour,
  CONTOUR_SLOPE_THRESHOLD,
} from '../ribbonLayout.js';
import { segmentZoneIntoFaces } from './segmentTerrainFaces.js';

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
    // Step 5: Terrain face segmentation.
    // Split the zone into terrain faces (consistent slope direction/steepness) and
    // lay out ribbons per face. Falls back to [zone] if elevation is unavailable.
    const faces = segmentZoneIntoFaces(zone, map);

    const allClippedParallel = [];
    const allClippedCross = [];

    for (const face of faces) {
    const nucleus = map.nuclei[face.nucleusIdx ?? zone.nucleusIdx];
    const direction = computeRibbonOrientation(face, nucleus, map.cellSize);

    const streets = layoutRibbonStreets(
      face, direction, map.cellSize, map.originX, map.originZ
    );

    // Contour adjustment for sloped faces
    if (face.avgSlope > CONTOUR_SLOPE_THRESHOLD) {
      const elevation = map.hasLayer ? map.getLayer('elevation') : map.elevation;
      for (let i = 0; i < streets.parallel.length; i++) {
        streets.parallel[i] = adjustStreetToContour(
          streets.parallel[i], elevation, face.slopeDir,
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

    // Add parallel streets and track their way IDs for T-junction stitching.
    const parallelWayIds = [];
    for (const st of clippedParallel) {
      if (st.length < 2) continue;
      const way = _addRoad(map, st, 'local', 6);
      if (way) parallelWayIds.push(way.id);
    }
    const crossWayIds = [];

    for (const st of clippedCross) {
      if (st.length < 2) continue;
      const way = _addRoad(map, st, 'local', 6);
      if (way) crossWayIds.push(way.id);
    }

    // Step 4a: T-junction splitting (scoped to this face's parallel edges).
    _splitTJunctions(map, clippedCross, crossWayIds, parallelWayIds);

    // Store the first face's spine on the zone for connectToNetwork
    if (!zone._spine && streets.spine) zone._spine = streets.spine;
    allClippedParallel.push(...clippedParallel);
    allClippedCross.push(...clippedCross);
    } // end for face

    // Store on zone for building placement and connection phase
    zone._streets = allClippedParallel;
    zone._crossStreets = allClippedCross;
    zone._spacing = null; // spacing varies per face
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
 * T-junction fix: for each cross street endpoint, connect the cross-street way
 * to any nearby parallel way through RoadNetwork's shared-node model. This
 * replaces the old graph-only edge split path.
 *
 * @param {object} map
 * @param {Array} crossStreets
 * @param {number[]} crossWayIds - way IDs for this face's cross streets
 * @param {number[]} parallelWayIds - way IDs for this face's parallel streets
 */
function _splitTJunctions(map, crossStreets, crossWayIds = [], parallelWayIds = []) {
  if (!map.roadNetwork || parallelWayIds.length === 0 || crossWayIds.length === 0 || crossStreets.length === 0) return;

  const snapDistSq = (map.cellSize * 5) ** 2; // 25m²
  const crossCount = Math.min(crossStreets.length, crossWayIds.length);

  map.roadNetwork.mutate(() => {
    for (let crossIdx = 0; crossIdx < crossCount; crossIdx++) {
      const cs = crossStreets[crossIdx];
      if (cs.length < 2) continue;
      const crossWayId = crossWayIds[crossIdx];
      const endpoints = [cs[0], cs[cs.length - 1]];

      for (const pt of endpoints) {
        for (const parallelWayId of parallelWayIds) {
          const parallelWay = map.roadNetwork.getWay(parallelWayId);
          if (!parallelWay) continue;
          const poly = parallelWay.polyline;
          let best = null;

          for (let i = 0; i < poly.length - 1; i++) {
            const from = poly[i];
            const to = poly[i + 1];
            const dx = to.x - from.x;
            const dz = to.z - from.z;
            const lenSq = dx * dx + dz * dz;
            if (lenSq < 1) continue;

            const t = ((pt.x - from.x) * dx + (pt.z - from.z) * dz) / lenSq;
            if (t <= 0.1 || t >= 0.9) continue;

            const projX = from.x + t * dx;
            const projZ = from.z + t * dz;
            const distSq = (pt.x - projX) ** 2 + (pt.z - projZ) ** 2;
            if (!best || distSq < best.distSq) {
              best = { x: projX, z: projZ, distSq };
            }
          }

          if (best && best.distSq < snapDistSq) {
            map.roadNetwork.connectWaysAtPoint(crossWayId, parallelWayId, pt.x, pt.z);
            break;
          }
        }
      }
    }
  });
}

function _addRoad(map, polyline, hierarchy, width) {
  return map.roadNetwork.add(polyline, {
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
  const roadHalf = 6; // metres — buffer around existing roads; ceil(6/5)=2 cells

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
