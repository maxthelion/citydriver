/**
 * Compute inset polygons for all zones.
 *
 * Per-edge inset distance is based on boundary type:
 * - Road edge: road.width / 2 + 2m (half road width + sidewalk)
 * - Water edge: 5m (bank buffer)
 * - Map boundary edge: cellSize (margin)
 * - Other (adjacent zone, shared boundary): 0
 *
 * Adds zone.insetPolygon to each zone.
 *
 * Reads: map.developmentZones, map.graph, map.cellSize
 * Writes: zone.insetPolygon for each zone
 */

import { insetPolygon } from '../../core/polygonInset.js';

// Inset constants
const SIDEWALK_BUFFER = 2;    // metres — setback from road edge
const WATER_BUFFER = 5;       // metres — bank buffer from water
const BOUNDARY_SCALE = 1;     // multiplier of cellSize for map-edge margin

/**
 * Minimum distance from a point to a polyline (array of {x, z}).
 */
function pointToPolylineDist(pt, polyline) {
  let minDist = Infinity;
  for (let i = 0; i < polyline.length - 1; i++) {
    const d = pointToSegmentDist(pt, polyline[i], polyline[i + 1]);
    if (d < minDist) minDist = d;
  }
  return minDist;
}

/**
 * Distance from point p to line segment a-b.
 */
function pointToSegmentDist(p, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lenSq = dx * dx + dz * dz;
  if (lenSq === 0) {
    const ex = p.x - a.x;
    const ez = p.z - a.z;
    return Math.sqrt(ex * ex + ez * ez);
  }
  let t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = a.x + t * dx;
  const projZ = a.z + t * dz;
  const ex = p.x - projX;
  const ez = p.z - projZ;
  return Math.sqrt(ex * ex + ez * ez);
}

/**
 * Classify a polygon edge by matching it to the zone's bounding graph edges.
 *
 * @param {{x: number, z: number}} a - Edge start
 * @param {{x: number, z: number}} b - Edge end
 * @param {Map<number, {polyline: Array, edge: object}>} edgeCache - Pre-built edge polylines
 * @param {number} tolerance - Maximum distance for a match
 * @returns {{ type: 'road'|'water'|'boundary'|'none', width: number }}
 */
function classifyEdge(a, b, edgeCache, tolerance) {
  const midX = (a.x + b.x) / 2;
  const midZ = (a.z + b.z) / 2;
  const mid = { x: midX, z: midZ };

  let bestDist = Infinity;
  let bestEdge = null;

  for (const [, entry] of edgeCache) {
    const dist = pointToPolylineDist(mid, entry.polyline);
    if (dist < bestDist) {
      bestDist = dist;
      bestEdge = entry;
    }
  }

  if (!bestEdge || bestDist > tolerance) {
    return { type: 'none', width: 0 };
  }

  const edge = bestEdge.edge;

  // Check edge type from attrs
  if (edge.attrs && edge.attrs.type === 'water') {
    return { type: 'water', width: 0 };
  }
  if (edge.attrs && edge.attrs.type === 'boundary') {
    return { type: 'boundary', width: 0 };
  }

  // Default: it's a road edge — use its width and hierarchy
  return { type: 'road', width: edge.width || 6 };
}

/**
 * Pre-build edge polylines for a zone's bounding edges.
 *
 * @param {number[]} boundingEdgeIds
 * @param {import('../../core/PlanarGraph.js').PlanarGraph} graph
 * @returns {Map<number, {polyline: Array, edge: object}>}
 */
function buildEdgeCache(boundingEdgeIds, graph) {
  const cache = new Map();
  for (const edgeId of boundingEdgeIds) {
    const edge = graph.edges.get(edgeId);
    if (!edge) continue;
    const fromNode = graph.nodes.get(edge.from);
    const toNode = graph.nodes.get(edge.to);
    if (!fromNode || !toNode) continue;
    const polyline = [
      { x: fromNode.x, z: fromNode.z },
      ...edge.points,
      { x: toNode.x, z: toNode.z },
    ];
    cache.set(edgeId, { polyline, edge });
  }
  return cache;
}

/**
 * Compute inset polygons for all development zones on the map.
 *
 * @param {import('../../core/FeatureMap.js').FeatureMap} map
 */
export function computeInsetPolygons(map) {
  const zones = map.developmentZones;
  if (!zones || zones.length === 0) return;

  const graph = map.graph;
  const cellSize = map.cellSize;
  const tolerance = cellSize * 3;

  for (const zone of zones) {
    if (!zone.polygon || zone.polygon.length < 3) {
      zone.insetPolygon = [];
      continue;
    }

    const boundingEdgeIds = zone.boundingEdgeIds || [];

    // Build edge cache for this zone's bounding edges
    const edgeCache = graph ? buildEdgeCache(boundingEdgeIds, graph) : new Map();

    // Compute per-edge inset distances
    const n = zone.polygon.length;
    const distances = new Array(n);

    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = zone.polygon[i];
      const b = zone.polygon[j];

      if (edgeCache.size > 0) {
        const classification = classifyEdge(a, b, edgeCache, tolerance);

        switch (classification.type) {
          case 'road':
            distances[i] = classification.width / 2 + SIDEWALK_BUFFER;
            break;
          case 'water':
            distances[i] = WATER_BUFFER;
            break;
          case 'boundary':
            distances[i] = cellSize * BOUNDARY_SCALE;
            break;
          default:
            distances[i] = 0;
        }
      } else {
        distances[i] = 0;
      }
    }

    zone.insetPolygon = insetPolygon(zone.polygon, distances);
  }
}
