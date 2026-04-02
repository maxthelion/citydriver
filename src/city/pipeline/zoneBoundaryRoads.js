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

  // Capture existing network state before adding zone boundary roads.
  const existingWayIds = new Set(map.ways.map(way => way.id));
  const existingNodeIds = new Set(map.roadNetwork.nodes.map(node => node.id));

  // Step 2: Simplify, clip (wide buffer prevents duplicates), and add as roads
  const roadsBefore = map.ways.length;
  const addedWayIds = [];

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
      const way = addRoad(map, seg, 'collector', 6);
      if (way) addedWayIds.push(way.id);
    }
  }

  // Walk pre-existing roads and merge nearby zone-boundary nodes onto them
  // through RoadNetwork's shared-node model instead of mutating PlanarGraph
  // directly. This keeps the ways, derived graph, and stamped grids aligned.
  if (addedWayIds.length > 0 && existingWayIds.size > 0) {
    const mergeDist = map.cellSize * 6; // ~30m search radius
    const mergeDistSq = mergeDist * mergeDist;
    const addedNodeIds = new Set();
    for (const wayId of addedWayIds) {
      const way = map.roadNetwork.getWay(wayId);
      if (!way) continue;
      for (const node of way.nodes) {
        if (!existingNodeIds.has(node.id)) addedNodeIds.add(node.id);
      }
    }
    const skeletonWays = map.ways.filter(way => existingWayIds.has(way.id));

    let mergeCount = 0;
    map.roadNetwork.mutate(() => {
      for (const zbNodeId of addedNodeIds) {
        const nodeById = new Map(map.roadNetwork.nodes.map(node => [node.id, node]));
        const zbNode = nodeById.get(zbNodeId);
        if (!zbNode) continue; // already merged

        let best = null;
        for (const skeletonWay of skeletonWays) {
          const poly = skeletonWay.polyline;
          for (let i = 0; i < poly.length - 1; i++) {
            const ax = poly[i].x, az = poly[i].z;
            const bx = poly[i + 1].x, bz = poly[i + 1].z;
            const dx = bx - ax, dz = bz - az;
            const lenSq = dx * dx + dz * dz;
            if (lenSq < 0.001) continue;
            const t = Math.max(0, Math.min(1, ((zbNode.x - ax) * dx + (zbNode.z - az) * dz) / lenSq));
            const px = ax + t * dx;
            const pz = az + t * dz;
            const d = (zbNode.x - px) * (zbNode.x - px) + (zbNode.z - pz) * (zbNode.z - pz);
            if (!best || d < best.distSq) {
              best = { wayId: skeletonWay.id, x: px, z: pz, distSq: d };
            }
          }
        }

        if (!best || best.distSq >= mergeDistSq) continue;

        const splitNodeId = map.roadNetwork.ensureNodeOnWay(best.wayId, best.x, best.z);
        if (splitNodeId === null || splitNodeId === zbNodeId) continue;

        const mergedId = map.roadNetwork.mergeNodes(splitNodeId, zbNodeId);
        if (mergedId !== null) {
          mergeCount++;
        }
      }
    });

    console.log(`[zoneBoundaryRoads] skeleton-walk merge: ${mergeCount} zone boundary nodes merged onto skeleton`);
  }

  const segmentsAdded = map.ways.length - roadsBefore;
  console.log(`[zoneBoundaryRoads] ${candidateBoundaries.length} boundaries → ${segmentsAdded} road segments`);
  return { segmentsAdded };
}

// ── Shared road utilities (same as layoutRibbons.js) ──────────────

function addRoad(map, polyline, hierarchy, width) {
  return map.roadNetwork.add(polyline, {
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
