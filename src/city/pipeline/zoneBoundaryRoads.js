/**
 * Create secondary roads from zone boundary geometry.
 *
 * Uses the existing road system (_clipStreetToGrid + _addRoad) to properly
 * integrate with the road grid, planar graph, and deduplication.
 *
 * Algorithm:
 * 1. Collect zone boundary polygons (world coordinates)
 * 2. Filter: only zones that touch an arterial road
 * 3. Filter: skip tiny zones
 * 4. Simplify + smooth boundary polylines (pinning junction vertices)
 * 5. Clip against existing roads/water (reuse _clipStreetToGrid)
 * 6. Add as roads via _addRoad (stamps grid, updates graph, snaps nodes)
 */

import { chaikinSmooth } from '../../core/math.js';

const ARTERIAL_SNAP_DIST_M = 25;  // metres — max distance to snap to arterial
const MIN_ZONE_CELLS = 1000;       // skip tiny zones
const MIN_ROAD_LENGTH_M = 40;      // metres — skip very short segments
const CLIP_SAMPLE_STEP = 2;        // metres — densify step for clipping
const ROAD_HALF_WIDTH = 3;         // metres — buffer around existing roads

/**
 * Create secondary roads from zone boundaries.
 *
 * @param {object} map - FeatureMap
 * @returns {{ segmentsAdded: number, cellsAdded: number }}
 */
export function createZoneBoundaryRoads(map) {
  const zones = map.developmentZones;
  if (!zones || zones.length === 0) return { segmentsAdded: 0, cellsAdded: 0 };

  const roadGrid = map.hasLayer('roadGrid') ? map.getLayer('roadGrid') : null;
  const waterMask = map.hasLayer('waterMask') ? map.getLayer('waterMask') : null;
  if (!roadGrid) return { segmentsAdded: 0, cellsAdded: 0 };

  const w = map.width, h = map.height;
  const cs = map.cellSize;
  const snapDist = ARTERIAL_SNAP_DIST_M / cs; // in cells

  // Step 1: Find zone boundaries that touch arterial roads
  const candidateBoundaries = [];

  for (const zone of zones) {
    if (!zone.boundary || zone.boundary.length < 3) continue;
    if (zone.cells.length < MIN_ZONE_CELLS) continue;

    // Check if any boundary vertex is near an existing road
    let touchesRoad = false;
    for (const pt of zone.boundary) {
      const gx = Math.round((pt.x - map.originX) / cs);
      const gz = Math.round((pt.z - map.originZ) / cs);
      for (let dz = -snapDist; dz <= snapDist && !touchesRoad; dz++) {
        for (let dx = -snapDist; dx <= snapDist && !touchesRoad; dx++) {
          const nx = gx + dx, nz = gz + dz;
          if (nx >= 0 && nx < w && nz >= 0 && nz < h && roadGrid.get(nx, nz) > 0) {
            touchesRoad = true;
          }
        }
      }
    }

    if (touchesRoad) {
      candidateBoundaries.push(zone.boundary);
    }
  }

  if (candidateBoundaries.length === 0) return { segmentsAdded: 0, cellsAdded: 0 };

  // Step 2: Simplify + smooth each boundary
  const roadsBefore = map.roads.length;

  for (const boundary of candidateBoundaries) {
    // Convert to world-coordinate polyline (already is — zone.boundary is {x, z})
    let pts = [...boundary];

    // Simplify (Ramer-Douglas-Peucker)
    pts = simplifyPolyline(pts, cs * 2);

    // Identify junction vertices (near existing roads) — pin during smoothing
    const pinned = pts.map(p => {
      const gx = Math.round((p.x - map.originX) / cs);
      const gz = Math.round((p.z - map.originZ) / cs);
      for (let dz = -3; dz <= 3; dz++) {
        for (let dx = -3; dx <= 3; dx++) {
          const nx = gx + dx, nz = gz + dz;
          if (nx >= 0 && nx < w && nz >= 0 && nz < h && roadGrid.get(nx, nz) > 0) return true;
        }
      }
      return false;
    });

    // Chaikin smooth with pinned junctions (2 passes)
    for (let pass = 0; pass < 2; pass++) {
      if (pts.length < 3) break;
      const smoothed = [pts[0]];
      const newPinned = [pinned[0]];
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        if (pinned[i] || pinned[i + 1]) {
          if (!pinned[i]) {
            smoothed.push({ x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 });
            newPinned.push(false);
          }
          if (pinned[i + 1]) {
            smoothed.push(b);
            newPinned.push(true);
          } else {
            smoothed.push({ x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 });
            newPinned.push(false);
          }
        } else {
          smoothed.push({ x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 });
          newPinned.push(false);
          smoothed.push({ x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 });
          newPinned.push(false);
        }
      }
      if (!pinned[pts.length - 1]) {
        smoothed.push(pts[pts.length - 1]);
        newPinned.push(pinned[pts.length - 1]);
      }
      pts = smoothed;
      pinned.length = 0;
      pinned.push(...newPinned);
    }

    // Step 3: Clip against existing roads and water
    const segments = clipStreetToGrid(pts, map);

    // Step 4: Add each surviving segment as a road
    for (const seg of segments) {
      if (seg.length < 2) continue;
      addRoad(map, seg, 'collector', 6);
    }
  }

  const segmentsAdded = map.roads.length - roadsBefore;
  // Count new road cells (approximate)
  let cellsAdded = 0;
  for (let z = 0; z < h; z++)
    for (let x = 0; x < w; x++)
      if (roadGrid.get(x, z) > 0) cellsAdded++;

  console.log(`[zoneBoundaryRoads] ${candidateBoundaries.length} boundaries → ${segmentsAdded} road segments`);
  return { segmentsAdded, cellsAdded };
}

// ── Shared road utilities (same as layoutRibbons.js) ──────────────

function addRoad(map, polyline, hierarchy, width) {
  const roadData = {
    type: 'road',
    polyline,
    width,
    hierarchy,
    importance: hierarchy === 'collector' ? 0.5 : 0.2,
    source: 'zone-boundary',
    id: map.roads ? map.roads.length : 0,
  };

  if (map.addFeature) {
    map.addFeature('road', roadData);
  } else {
    map.roads.push(roadData);
  }

  if (polyline.length >= 2 && map.graph) {
    const snapDist = map.cellSize * 3;
    const startPt = polyline[0];
    const endPt = polyline[polyline.length - 1];
    const startNode = findOrCreateNode(map, startPt.x, startPt.z, snapDist);
    const endNode = findOrCreateNode(map, endPt.x, endPt.z, snapDist);

    if (startNode !== endNode) {
      const points = polyline.slice(1, -1).map(p => ({ x: p.x, z: p.z }));
      map.graph.addEdge(startNode, endNode, { points, width, hierarchy });
    }
  }
}

function findOrCreateNode(map, x, z, snapDist) {
  const graph = map.graph;
  const nearest = graph.nearestNode(x, z);
  if (nearest && nearest.dist < snapDist) return nearest.id;
  return graph.addNode(x, z);
}

function clipStreetToGrid(street, map) {
  if (street.length < 2) return [];

  const roadGrid = map.hasLayer ? map.getLayer('roadGrid') : map.roadGrid;
  const waterMask = map.hasLayer ? map.getLayer('waterMask') : map.waterMask;
  const cs = map.cellSize;
  const ox = map.originX, oz = map.originZ;

  // Densify
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

  // Classify
  const r = Math.ceil(ROAD_HALF_WIDTH / cs);
  const clear = samples.map(p => {
    const gx = Math.round((p.x - ox) / cs);
    const gz = Math.round((p.z - oz) / cs);
    if (gx < 3 || gz < 3 || gx >= map.width - 3 || gz >= map.height - 3) return false;
    if (waterMask) {
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = gx + dx, nz = gz + dz;
          if (nx >= 0 && nz >= 0 && nx < map.width && nz < map.height && waterMask.get(nx, nz) > 0) return false;
        }
    }
    if (roadGrid) {
      for (let dz = -r; dz <= r; dz++)
        for (let dx = -r; dx <= r; dx++) {
          const nx = gx + dx, nz = gz + dz;
          if (nx >= 0 && nz >= 0 && nx < map.width && nz < map.height && roadGrid.get(nx, nz) > 0) return false;
        }
    }
    return true;
  });

  // Split into clear segments
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

  // Filter short
  return segments.filter(seg => {
    let len = 0;
    for (let i = 1; i < seg.length; i++) {
      const dx = seg[i].x - seg[i - 1].x, dz = seg[i].z - seg[i - 1].z;
      len += Math.sqrt(dx * dx + dz * dz);
    }
    return len >= MIN_ROAD_LENGTH_M;
  });
}

// ── Geometry utilities ──────────────────────────────────────────────

function simplifyPolyline(pts, tolerance) {
  if (pts.length < 3) return pts;
  const tolSq = tolerance * tolerance;

  let maxDist = 0, maxIdx = 0;
  const first = pts[0], last = pts[pts.length - 1];
  const dx = last.x - first.x, dz = last.z - first.z;
  const lenSq = dx * dx + dz * dz;

  for (let i = 1; i < pts.length - 1; i++) {
    let dist;
    if (lenSq < 0.001) {
      const ex = pts[i].x - first.x, ez = pts[i].z - first.z;
      dist = ex * ex + ez * ez;
    } else {
      const t = Math.max(0, Math.min(1, ((pts[i].x - first.x) * dx + (pts[i].z - first.z) * dz) / lenSq));
      const px = first.x + t * dx, pz = first.z + t * dz;
      const ex = pts[i].x - px, ez = pts[i].z - pz;
      dist = ex * ex + ez * ez;
    }
    if (dist > maxDist) { maxDist = dist; maxIdx = i; }
  }

  if (maxDist > tolSq) {
    const left = simplifyPolyline(pts.slice(0, maxIdx + 1), tolerance);
    const right = simplifyPolyline(pts.slice(maxIdx), tolerance);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}
