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

// No smoothing — RDP simplification only. Chaikin drifts junction vertices.

const ARTERIAL_SNAP_DIST_M = 25;  // metres — max distance to snap to arterial
const MIN_ZONE_CELLS = 1000;       // skip tiny zones
const MIN_ROAD_LENGTH_M = 60;      // metres — skip very short segments
const SNAP_TO_ROAD_DIST_M = 15;   // metres — snap endpoints to nearby roads
const CLIP_SAMPLE_STEP = 2;        // metres — densify step for clipping
const ROAD_HALF_WIDTH = 8;         // metres — buffer around existing roads (wide to prevent parallel duplicates)

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

  // Capture skeleton node IDs before adding zone boundary roads
  const skeletonNodeIds = new Set(map.graph ? [...map.graph.nodes.keys()] : []);

  // Step 2: Simplify, clip (wide buffer prevents duplicates), and add as roads
  const roadsBefore = map.roads.length;

  for (const boundary of candidateBoundaries) {
    let pts = [...boundary];
    pts = simplifyPolyline(pts, cs * 4);

    const segments = clipStreetToGrid(pts, map);
    for (const seg of segments) {
      if (seg.length < 2) continue;
      // Note: endpoint snapping removed — it was pulling polyline starts
      // onto arterials, causing zone boundary roads to overlap arterials.
      // The graph's node snapping (snapDist = cellSize * 3) in addRoad
      // handles junction connection at the topology level instead.
      addRoad(map, seg, 'collector', 6);
    }
  }

  // Walk skeleton roads and merge nearby zone boundary nodes onto them.
  // For each skeleton edge, sample points along it. If a zone boundary
  // node is nearby, split the skeleton edge at that point and merge the
  // zone boundary node into the split node.
  if (map.graph) {
    const mergeDist = map.cellSize * 6; // ~30m search radius
    const mergeDistSq = mergeDist * mergeDist;

    // Collect zone boundary node IDs (the ones we just added)
    const zbNodes = new Set();
    for (const id of map.graph.nodes.keys()) {
      if (!skeletonNodeIds.has(id)) zbNodes.add(id);
    }

    // Walk each skeleton edge
    const skeletonEdgeIds = [...map.graph.edges.keys()].filter(eid => {
      const e = map.graph.edges.get(eid);
      return e && (e.hierarchy === 'arterial' || e.hierarchy === 'collector' || e.source === 'skeleton');
    });

    let mergeCount = 0;
    for (const edgeId of skeletonEdgeIds) {
      if (!map.graph.edges.has(edgeId)) continue; // may have been removed by a previous split
      const poly = map.graph.edgePolyline(edgeId);

      // For each zone boundary node, check distance to this edge
      for (const zbId of [...zbNodes]) {
        if (!map.graph.nodes.has(zbId)) { zbNodes.delete(zbId); continue; }
        const zbNode = map.graph.nodes.get(zbId);

        // Find closest point on this skeleton edge to the zb node
        let bestDistSq = Infinity, bestProjX = 0, bestProjZ = 0;
        for (let i = 0; i < poly.length - 1; i++) {
          const ax = poly[i].x, az = poly[i].z;
          const bx = poly[i+1].x, bz = poly[i+1].z;
          const dx = bx - ax, dz = bz - az;
          const lenSq = dx * dx + dz * dz;
          if (lenSq < 0.001) continue;
          const t = Math.max(0, Math.min(1, ((zbNode.x - ax) * dx + (zbNode.z - az) * dz) / lenSq));
          const px = ax + t * dx, pz = az + t * dz;
          const d = (zbNode.x - px) * (zbNode.x - px) + (zbNode.z - pz) * (zbNode.z - pz);
          if (d < bestDistSq) { bestDistSq = d; bestProjX = px; bestProjZ = pz; }
        }

        if (bestDistSq < mergeDistSq) {
          // Split the skeleton edge at the projected point
          const splitNodeId = map.graph.splitEdge(edgeId, bestProjX, bestProjZ);
          // Merge the zone boundary node into the split node
          map.graph.mergeNodes(zbId, splitNodeId);
          zbNodes.delete(zbId);
          mergeCount++;
          break; // edge was split, move to next edge iteration
        }
      }
    }

    console.log(`[zoneBoundaryRoads] skeleton-walk merge: ${mergeCount} zone boundary nodes merged onto skeleton`);
  }

  const segmentsAdded = map.roads.length - roadsBefore;
  console.log(`[zoneBoundaryRoads] ${candidateBoundaries.length} boundaries → ${segmentsAdded} road segments`);
  return { segmentsAdded };
}

/**
 * Snap a polyline endpoint to the nearest existing road cell.
 * If the endpoint is within SNAP_TO_ROAD_DIST_M of a road cell,
 * move it to that cell's world position so the road connects.
 */
function snapEndpointToRoad(polyline, idx, map) {
  const pt = polyline[idx];
  const cs = map.cellSize;
  const gx = Math.round((pt.x - map.originX) / cs);
  const gz = Math.round((pt.z - map.originZ) / cs);
  const searchR = Math.ceil(SNAP_TO_ROAD_DIST_M / cs);
  const roadGrid = map.hasLayer('roadGrid') ? map.getLayer('roadGrid') : null;
  if (!roadGrid) return;

  let bestDist = Infinity;
  let bestX = gx, bestZ = gz;

  for (let dz = -searchR; dz <= searchR; dz++) {
    for (let dx = -searchR; dx <= searchR; dx++) {
      const nx = gx + dx, nz = gz + dz;
      if (nx < 0 || nx >= map.width || nz < 0 || nz >= map.height) continue;
      if (roadGrid.get(nx, nz) === 0) continue;
      const d = dx * dx + dz * dz;
      if (d < bestDist) {
        bestDist = d;
        bestX = nx;
        bestZ = nz;
      }
    }
  }

  if (bestDist < searchR * searchR && bestDist > 0) {
    polyline[idx] = {
      x: map.originX + bestX * cs,
      z: map.originZ + bestZ * cs,
    };
  }
}

// ── Shared road utilities (same as layoutRibbons.js) ──────────────

function addRoad(map, polyline, hierarchy, width) {
  map.roadNetwork.add(polyline, {
    width,
    hierarchy,
    importance: hierarchy === 'collector' ? 0.5 : 0.2,
    source: 'zone-boundary',
  });
}

function clipStreetToGrid(street, map) {
  if (street.length < 2) return [];

  const roadGrid = map.getLayer('roadGrid');
  const waterMask = map.getLayer('waterMask');
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
