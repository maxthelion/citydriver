/**
 * Three skeleton generation strategies for comparison.
 * Each is a function (map) => void that builds roads on a FeatureMap.
 */

import { buildSkeletonRoads } from './skeleton.js';
import { UnionFind } from '../core/UnionFind.js';
import { distance2D } from '../core/math.js';

// ============================================================
// Strategy 1: Current A* skeleton (baseline)
// ============================================================

export function currentSkeleton(map) {
  buildSkeletonRoads(map);
}

// ============================================================
// Strategy 2: Straight-line connections with obstacle avoidance
// ============================================================

export function straightLineSkeleton(map) {
  const nuclei = map.nuclei;

  // 1. Import anchor roads as sparse polylines (regional waypoints, no A*)
  const anchorRoads = _importAnchorsSparse(map);
  for (const road of anchorRoads) {
    _addSparseRoad(map, road.polyline, road.hierarchy);
  }

  // 2. MST connections between nuclei — straight lines with obstacle avoidance
  const { mstConnections, extraConnections } = _getMSTConnections(nuclei);

  for (const conn of mstConnections) {
    const polyline = _straightLineWithAvoidance(map, conn.from, conn.to);
    if (polyline.length >= 2) {
      _addSparseRoad(map, polyline, conn.hierarchy);
    }
  }

  // 3. Extra cycle edges
  for (const conn of extraConnections) {
    const polyline = _straightLineWithAvoidance(map, conn.from, conn.to);
    if (polyline.length >= 2) {
      _addSparseRoad(map, polyline, conn.hierarchy);
    }
  }
}

// ============================================================
// Strategy 3: Topology-first (graph then geometry)
// ============================================================

export function topologySkeleton(map) {
  const nuclei = map.nuclei;

  // 1. Collect all topology nodes: nuclei + anchor entry/exit points
  const topoNodes = [];

  // Nuclei as nodes
  for (const n of nuclei) {
    topoNodes.push({
      gx: n.gx, gz: n.gz,
      type: 'nucleus', tier: n.tier,
    });
  }

  // Anchor entry/exit points as nodes
  const anchorRoads = _importAnchorsSparse(map);
  for (const road of anchorRoads) {
    const first = road.gridPoints[0];
    const last = road.gridPoints[road.gridPoints.length - 1];
    topoNodes.push({ gx: first.gx, gz: first.gz, type: 'anchor-entry' });
    topoNodes.push({ gx: last.gx, gz: last.gz, type: 'anchor-exit' });
  }

  // 2. Build topology edges
  const topoEdges = [];

  // Anchor roads as edges (keep regional geometry)
  for (const road of anchorRoads) {
    topoEdges.push({
      from: road.gridPoints[0],
      to: road.gridPoints[road.gridPoints.length - 1],
      hierarchy: road.hierarchy,
      waypoints: road.gridPoints.slice(1, -1), // intermediate regional waypoints
    });
  }

  // MST between all topo nodes
  const { mstConnections, extraConnections } = _getMSTConnections(topoNodes);
  for (const conn of [...mstConnections, ...extraConnections]) {
    topoEdges.push({
      from: conn.from,
      to: conn.to,
      hierarchy: conn.hierarchy,
      waypoints: [],
    });
  }

  // 3. Assign geometry: straight lines with obstacle avoidance for non-anchor edges
  for (const edge of topoEdges) {
    let polyline;
    if (edge.waypoints.length > 0) {
      // Anchor road — use regional waypoints as-is
      const allPts = [edge.from, ...edge.waypoints, edge.to];
      polyline = allPts.map(p => ({
        x: map.originX + p.gx * map.cellSize,
        z: map.originZ + p.gz * map.cellSize,
      }));
    } else {
      // MST/extra — straight line with obstacle avoidance
      polyline = _straightLineWithAvoidance(map, edge.from, edge.to);
    }

    if (polyline.length >= 2) {
      _addSparseRoad(map, polyline, edge.hierarchy);
    }
  }
}

// ============================================================
// Shared helpers
// ============================================================

/**
 * Import anchor roads as sparse polylines (regional waypoints converted to city coords).
 * No A* pathfinding, no Chaikin smoothing — just the waypoints.
 */
function _importAnchorsSparse(map) {
  const layers = map.regionalLayers;
  const roads = layers.getData('roads');
  if (!roads || roads.length === 0) return [];

  const params = layers.getData('params');
  const rcs = params.cellSize;

  const cityMinX = map.originX;
  const cityMinZ = map.originZ;
  const cityMaxX = map.originX + map.width * map.cellSize;
  const cityMaxZ = map.originZ + map.height * map.cellSize;

  const hierRank = { arterial: 1, collector: 2, local: 3, track: 4 };
  const relevant = [];

  for (const road of roads) {
    const path = road.rawPath || road.path;
    if (!path) continue;

    let inside = false;
    for (const p of path) {
      const wx = p.gx * rcs, wz = p.gz * rcs;
      if (wx >= cityMinX && wx <= cityMaxX && wz >= cityMinZ && wz <= cityMaxZ) {
        inside = true;
        break;
      }
    }
    if (inside) relevant.push(road);
  }

  relevant.sort((a, b) => (hierRank[a.hierarchy] || 3) - (hierRank[b.hierarchy] || 3));

  const result = [];
  for (const road of relevant) {
    const path = road.rawPath || road.path;

    // Convert to city grid coords, keep only points inside city
    const gridPoints = [];
    for (const p of path) {
      const wx = p.gx * rcs, wz = p.gz * rcs;
      const cgx = Math.round((wx - map.originX) / map.cellSize);
      const cgz = Math.round((wz - map.originZ) / map.cellSize);
      if (cgx >= 1 && cgx < map.width - 1 && cgz >= 1 && cgz < map.height - 1) {
        gridPoints.push({ gx: cgx, gz: cgz });
      }
    }

    if (gridPoints.length < 2) continue;

    // Skip if start and end are too close
    const first = gridPoints[0], last = gridPoints[gridPoints.length - 1];
    if (distance2D(first.gx, first.gz, last.gx, last.gz) < 5) continue;

    // Convert to world-coord polyline
    const polyline = gridPoints.map(p => ({
      x: map.originX + p.gx * map.cellSize,
      z: map.originZ + p.gz * map.cellSize,
    }));

    result.push({
      polyline,
      gridPoints,
      hierarchy: road.hierarchy || 'local',
    });
  }

  return result;
}

/**
 * MST connections between a set of nodes with {gx, gz}.
 * Same algorithm as skeleton.js but decoupled from map.
 */
function _getMSTConnections(nodes) {
  if (nodes.length < 2) return { mstConnections: [], extraConnections: [] };

  const uf = new UnionFind(nodes.length);
  const edges = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const d = distance2D(nodes[i].gx, nodes[i].gz, nodes[j].gx, nodes[j].gz);
      edges.push({ i, j, cost: d });
    }
  }
  edges.sort((a, b) => a.cost - b.cost);

  const mstConnections = [];
  const candidateExtras = [];

  for (const edge of edges) {
    const a = nodes[edge.i], b = nodes[edge.j];
    const tierA = a.tier || 3, tierB = b.tier || 3;
    const w = (_tierWeight(tierA) + _tierWeight(tierB)) / 2;
    const hierarchy = w > 0.6 ? 'arterial' : w > 0.3 ? 'collector' : 'local';

    if (!uf.connected(edge.i, edge.j)) {
      uf.union(edge.i, edge.j);
      mstConnections.push({
        from: { gx: a.gx, gz: a.gz },
        to: { gx: b.gx, gz: b.gz },
        hierarchy,
      });
    } else {
      candidateExtras.push({
        from: { gx: a.gx, gz: a.gz },
        to: { gx: b.gx, gz: b.gz },
        hierarchy: hierarchy === 'arterial' ? 'collector' : 'local',
      });
    }
  }

  const maxExtras = Math.max(2, Math.floor(mstConnections.length * 0.4));
  return { mstConnections, extraConnections: candidateExtras.slice(0, maxExtras) };
}

function _tierWeight(tier) {
  if (tier <= 1) return 1.0;
  if (tier <= 2) return 0.7;
  if (tier <= 3) return 0.45;
  if (tier <= 4) return 0.2;
  return 0.1;
}

/**
 * Create a straight-line polyline from A to B (grid coords → world coords),
 * with waypoints inserted to avoid water/river crossings.
 */
function _straightLineWithAvoidance(map, from, to) {
  const cs = map.cellSize;
  const waterMask = map.getLayer?.('waterMask') ?? map.waterMask;
  const buildability = map.getLayer?.('terrainSuitability') ?? map.buildability;

  // Walk the line in grid space, check for water crossings
  const dx = to.gx - from.gx;
  const dz = to.gz - from.gz;
  const dist = Math.sqrt(dx * dx + dz * dz);
  if (dist < 1) return [];

  const steps = Math.ceil(dist);
  const crossings = []; // ranges of water cells
  let inWater = false;
  let waterStart = -1;

  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const gx = Math.round(from.gx + dx * t);
    const gz = Math.round(from.gz + dz * t);

    if (gx < 0 || gx >= map.width || gz < 0 || gz >= map.height) continue;

    const isWater = waterMask.get(gx, gz) > 0;

    if (isWater && !inWater) {
      waterStart = s;
      inWater = true;
    } else if (!isWater && inWater) {
      crossings.push({ start: waterStart, end: s - 1 });
      inWater = false;
    }
  }
  if (inWater) {
    crossings.push({ start: waterStart, end: steps });
  }

  // If no water crossings, straight line
  if (crossings.length === 0) {
    return [
      { x: map.originX + from.gx * cs, z: map.originZ + from.gz * cs },
      { x: map.originX + to.gx * cs, z: map.originZ + to.gz * cs },
    ];
  }

  // Insert waypoints to go around water
  const points = [{ gx: from.gx, gz: from.gz }];

  for (const crossing of crossings) {
    // Find the midpoint of the crossing on the line
    const midT = (crossing.start + crossing.end) / 2 / steps;
    const midGx = from.gx + dx * midT;
    const midGz = from.gz + dz * midT;

    // Try perpendicular offsets to find a non-water path
    const perpX = -dz / dist;
    const perpZ = dx / dist;

    let bestWaypoint = null;
    for (let offset = 5; offset <= 30; offset += 5) {
      for (const sign of [1, -1]) {
        const wgx = Math.round(midGx + perpX * offset * sign);
        const wgz = Math.round(midGz + perpZ * offset * sign);

        if (wgx < 1 || wgx >= map.width - 1 || wgz < 1 || wgz >= map.height - 1) continue;
        if (waterMask.get(wgx, wgz) > 0) continue;
        if (buildability.get(wgx, wgz) < 0.05) continue;

        bestWaypoint = { gx: wgx, gz: wgz };
        break;
      }
      if (bestWaypoint) break;
    }

    if (bestWaypoint) {
      points.push(bestWaypoint);
    }
    // If no waypoint found, skip (road will cross water — bridge implied)
  }

  points.push({ gx: to.gx, gz: to.gz });

  // Convert to world coords
  return points.map(p => ({
    x: map.originX + p.gx * cs,
    z: map.originZ + p.gz * cs,
  }));
}

/**
 * Add a sparse road to the map: feature + graph + roadGrid stamp.
 */
function _addSparseRoad(map, polyline, hierarchy) {
  if (polyline.length < 2) return;

  const importance = hierarchy === 'arterial' ? 0.9 :
                     hierarchy === 'collector' ? 0.6 : 0.45;
  const width = 6 + importance * 10;

  map.roadNetwork.add(polyline, {
    width,
    hierarchy,
    importance,
    source: 'skeleton',
  });
}
