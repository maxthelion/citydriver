/**
 * City skeleton (tick 1).
 * Place nuclei, import anchor routes, connect via Union-Find MST.
 *
 * Uses the shared buildRoadNetwork pipeline for pathfind → merge → smooth.
 *
 * Spec: statement-of-intent.md "Tick 1: Satellite settlements and road skeleton"
 * Constants: technical-reference.md
 */

import { findPath, gridPathToWorldPolyline } from '../core/pathfinding.js';
import { buildRoadNetwork } from '../core/buildRoadNetwork.js';
import { UnionFind } from '../core/UnionFind.js';
import { distance2D } from '../core/math.js';
import { Grid2D } from '../core/Grid2D.js';
import { placeBridges } from './bridges.js';
import { clipPolylineToBounds } from '../core/clipPolyline.js';

// Importance weight for hierarchy computation
function importanceTierWeight(tier) {
  if (tier <= 1) return 1.0;
  if (tier <= 2) return 0.7;
  if (tier <= 3) return 0.45;
  if (tier <= 4) return 0.2;
  return 0.1;
}

/**
 * Build skeleton roads on the FeatureMap.
 * Collects anchor + MST + fallback connections, then pathfinds and adds roads.
 *
 * @param {import('../core/FeatureMap.js').FeatureMap} map
 */
export function buildSkeletonRoads(map) {
  const layers = map.regionalLayers;
  const nuclei = map.nuclei;

  // Debug grids
  map.debugAnchorGrid = new Grid2D(map.width, map.height, { type: 'uint8' });
  map.debugMstGrid = new Grid2D(map.width, map.height, { type: 'uint8' });
  map.debugExtraGrid = new Grid2D(map.width, map.height, { type: 'uint8' });
  map.roadPopularity = new Grid2D(map.width, map.height, { type: 'uint8' });

  // 2. Collect ALL connections in one list — tag by source.
  //    Order matters: anchors first (stamped for reuse), then MST, then extras.
  //    All go through one buildRoadNetwork call so _snapPaths merges across groups.
  const { mstConnections, extraConnections } = getMSTConnections(map, nuclei);
  const anchorConnections = getAnchorConnections(map, layers);

  const connections = [];
  for (const c of anchorConnections) connections.push({ ...c, tag: 'anchor' });
  for (const c of mstConnections) connections.push({ ...c, tag: 'mst' });
  for (const c of extraConnections) connections.push({ ...c, tag: 'extra' });

  if (connections.length === 0) {
    for (const c of getFallbackConnections(map)) connections.push({ ...c, tag: 'mst' });
  }

  // 3. Single pipeline: pathfind → snap → merge → simplify.
  //    Reuse discount is 99% — paths converge onto existing road cells.
  //    Extras are pathfound last so they get the discount from anchors + MST.
  //    Snap + merge operates on ALL paths together, eliminating cross-group parallels.
  const costFn = map.createPathCost('anchor');
  const networkResult = buildRoadNetwork({
    width: map.width,
    height: map.height,
    cellSize: map.cellSize,
    costFn,
    connections,
    roadGrid: map.roadGrid,
    smooth: { simplifyEpsilon: 1.0 },
    originX: map.originX,
    originZ: map.originZ,
    tagGrids: { anchor: map.debugAnchorGrid, mst: map.debugMstGrid, extra: map.debugExtraGrid },
    popularityGrid: map.roadPopularity,
    collectDebugPaths: true,
  });

  const builtRoads = networkResult.roads;

  // Store debug path data on the map for the path viewer tool
  map.debugPaths = networkResult.debugPaths;
  map.debugPathsGridWidth = networkResult.gridWidth;
  map.debugPathsGridHeight = networkResult.gridHeight;

  // Auto-dump to localStorage for tools/path-viewer.html
  try {
    if (typeof localStorage !== 'undefined' && networkResult.debugPaths) {
      localStorage.setItem('debugPaths', JSON.stringify({
        gridWidth: networkResult.gridWidth,
        gridHeight: networkResult.gridHeight,
        paths: networkResult.debugPaths,
        timestamp: Date.now(),
      }));
    }
  } catch (_) { /* ignore in headless/test environments */ }

  // 4. Add merged roads as features
  for (const road of builtRoads) {
    if (!road.polyline || road.polyline.length < 2) continue;

    const importance = road.hierarchy === 'arterial' ? 0.9 :
                       road.hierarchy === 'collector' ? 0.6 : 0.45;
    const width = 6 + importance * 10;

    map.addFeature('road', {
      polyline: road.polyline,
      width,
      hierarchy: road.hierarchy,
      importance,
      source: 'skeleton',
    });
  }

  // 5. Connect any nuclei that ended up far from the road network.
  _connectDisconnectedNuclei(map);

  // 7. Compact road polylines: snap nearby vertices, remove duplicates.
  //    Then rebuild the graph from the cleaned roads.
  compactRoads(map, map.cellSize * 1.5);
  rebuildGraphFromRoads(map);

  // 8. Place bridges where skeleton roads cross rivers.
  placeBridges(map);
}

/**
 * Place nuclei and build road skeleton on the FeatureMap.
 * Thin wrapper around buildSkeletonRoads for backward compatibility.
 *
 * @param {import('../core/FeatureMap.js').FeatureMap} map
 */
export function buildSkeleton(map) {
  buildSkeletonRoads(map);
}

/**
 * Get connections from regional roads that cross the city.
 * Uses clipPolylineToBounds to find exact boundary crossing points,
 * preserving intermediate waypoints so the pathfinder follows the
 * regional road's angle through the city.
 *
 * Returns chained grid-coord connection pairs for buildRoadNetwork.
 */
function getAnchorConnections(map, layers) {
  const roads = layers.getData('roads');
  if (!roads || roads.length === 0) return [];

  const params = layers.getData('params');
  const regionalCellSize = params.cellSize;

  const bounds = {
    minX: map.originX,
    minZ: map.originZ,
    maxX: map.originX + map.width * map.cellSize,
    maxZ: map.originZ + map.height * map.cellSize,
  };

  const hierRank = { arterial: 1, collector: 2, local: 3, track: 4 };

  // Collect candidate roads that have any waypoint inside the city
  const relevantRoads = [];
  for (const road of roads) {
    const path = road.path || road.rawPath;
    if (!path || path.length < 2) continue;

    // Quick check: does any waypoint fall inside the city bounds?
    let inside = false;
    for (const p of path) {
      const wx = p.gx * regionalCellSize;
      const wz = p.gz * regionalCellSize;
      if (wx >= bounds.minX && wx <= bounds.maxX &&
          wz >= bounds.minZ && wz <= bounds.maxZ) {
        inside = true;
        break;
      }
    }
    // Even if no waypoint is inside, the segment might pass through
    // (handled by clipPolylineToBounds), so also check nearby roads
    if (!inside) {
      // Check if any segment crosses the city bounds by testing if
      // the road's bounding box overlaps the city bounds
      let rMinX = Infinity, rMinZ = Infinity, rMaxX = -Infinity, rMaxZ = -Infinity;
      for (const p of path) {
        const wx = p.gx * regionalCellSize;
        const wz = p.gz * regionalCellSize;
        if (wx < rMinX) rMinX = wx;
        if (wz < rMinZ) rMinZ = wz;
        if (wx > rMaxX) rMaxX = wx;
        if (wz > rMaxZ) rMaxZ = wz;
      }
      if (rMaxX >= bounds.minX && rMinX <= bounds.maxX &&
          rMaxZ >= bounds.minZ && rMinZ <= bounds.maxZ) {
        inside = true;
      }
    }
    if (inside) relevantRoads.push(road);
  }

  // Sort by hierarchy (arterials first)
  relevantRoads.sort((a, b) => (hierRank[a.hierarchy] || 3) - (hierRank[b.hierarchy] || 3));

  const connections = [];

  for (const road of relevantRoads) {
    // Prefer smoothed path for better boundary angles
    const path = road.path || road.rawPath;

    // Convert regional grid coords to world coords
    const worldPoly = path.map(p => ({
      x: p.gx * regionalCellSize,
      z: p.gz * regionalCellSize,
    }));

    // Clip to city bounds — first/last points will be boundary intersections
    const clipResult = clipPolylineToBounds(worldPoly, bounds);
    if (!clipResult || clipResult.clipped.length < 2) continue;

    // Convert clipped world-coord points to city grid coords
    const gridPoints = [];
    for (const p of clipResult.clipped) {
      const gx = Math.round((p.x - map.originX) / map.cellSize);
      const gz = Math.round((p.z - map.originZ) / map.cellSize);
      // Clamp to valid grid positions
      if (gx >= 0 && gx < map.width && gz >= 0 && gz < map.height) {
        gridPoints.push({ gx, gz });
      }
    }

    if (gridPoints.length < 2) continue;

    // Deduplicate consecutive identical grid points
    const deduped = [gridPoints[0]];
    for (let i = 1; i < gridPoints.length; i++) {
      if (gridPoints[i].gx !== deduped[deduped.length - 1].gx ||
          gridPoints[i].gz !== deduped[deduped.length - 1].gz) {
        deduped.push(gridPoints[i]);
      }
    }

    if (deduped.length < 2) continue;

    // Break into chained connections through consecutive waypoints
    const hierarchy = road.hierarchy || 'local';
    for (let i = 0; i < deduped.length - 1; i++) {
      const from = deduped[i];
      const to = deduped[i + 1];

      // Skip very short segments (< 3 cells)
      if (distance2D(from.gx, from.gz, to.gx, to.gz) < 3) continue;

      connections.push({ from, to, hierarchy });
    }
  }

  return connections;
}

/**
 * Get MST connections between nuclei.
 * Uses Union-Find to find inter-component edges, returns connection pairs.
 */
function getMSTConnections(map, nuclei) {
  if (nuclei.length < 2) return { mstConnections: [], extraConnections: [] };

  const uf = new UnionFind(nuclei.length);

  const edges = [];
  for (let i = 0; i < nuclei.length; i++) {
    for (let j = i + 1; j < nuclei.length; j++) {
      const d = distance2D(nuclei[i].gx, nuclei[i].gz, nuclei[j].gx, nuclei[j].gz);
      edges.push({ i, j, cost: d });
    }
  }
  edges.sort((a, b) => a.cost - b.cost);

  const mstConnections = [];
  const candidateExtras = [];

  for (const edge of edges) {
    const a = nuclei[edge.i];
    const b = nuclei[edge.j];
    const pairWeight = (importanceTierWeight(a.tier) + importanceTierWeight(b.tier)) / 2;
    const hierarchy = pairWeight > 0.6 ? 'arterial' : pairWeight > 0.3 ? 'collector' : 'local';

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

  // Take the shortest non-MST edges, up to ~40% of the MST edge count.
  const maxExtras = Math.max(2, Math.floor(mstConnections.length * 0.4));
  const extraConnections = candidateExtras.slice(0, maxExtras);

  return { mstConnections, extraConnections };
}

/**
 * Fallback connections when no regional roads cross the city.
 */
function getFallbackConnections(map) {
  const cx = Math.floor(map.width / 2);
  const cz = Math.floor(map.height / 2);
  const margin = 5;

  return [
    { from: { gx: cx, gz: cz }, to: { gx: margin, gz: cz }, hierarchy: 'collector' },
    { from: { gx: cx, gz: cz }, to: { gx: map.width - margin, gz: cz }, hierarchy: 'collector' },
  ];
}


/** Simplified RDP for grid paths. */
function _simplifyPathInline(path, epsilon) {
  if (path.length <= 2) return path;
  let maxDist = 0, maxIdx = 0;
  const first = path[0], last = path[path.length - 1];
  for (let i = 1; i < path.length - 1; i++) {
    const d = _pointLineDistSq(path[i].gx, path[i].gz, first.gx, first.gz, last.gx, last.gz);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }
  if (Math.sqrt(maxDist) > epsilon) {
    const left = _simplifyPathInline(path.slice(0, maxIdx + 1), epsilon);
    const right = _simplifyPathInline(path.slice(maxIdx), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

function _pointLineDistSq(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq === 0) return (px - ax) ** 2 + (pz - az) ** 2;
  let t = ((px - ax) * dx + (pz - az) * dz) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return (px - ax - t * dx) ** 2 + (pz - az - t * dz) ** 2;
}

/**
 * Connect nuclei that are far from the road network.
 * After buildRoadNetwork merges paths, some nucleus endpoints get absorbed
 * into anchor routes. This adds short spur roads from each disconnected
 * nucleus to the nearest road cell.
 */
function _connectDisconnectedNuclei(map) {
  const threshold = 3; // cells — consider connected if road within this radius

  for (const n of map.nuclei) {
    // Check if nucleus is already near a road cell
    let nearRoad = false;
    for (let dz = -threshold; dz <= threshold && !nearRoad; dz++) {
      for (let dx = -threshold; dx <= threshold && !nearRoad; dx++) {
        const gx = n.gx + dx, gz = n.gz + dz;
        if (gx >= 0 && gx < map.width && gz >= 0 && gz < map.height) {
          if (map.roadGrid.get(gx, gz) > 0) nearRoad = true;
        }
      }
    }
    if (nearRoad) continue;

    // Nucleus is far from roads — find nearest road cell and pathfind a spur
    let bestDist = Infinity, bestGx = -1, bestGz = -1;
    const searchRadius = 20;
    for (let dz = -searchRadius; dz <= searchRadius; dz++) {
      for (let dx = -searchRadius; dx <= searchRadius; dx++) {
        const gx = n.gx + dx, gz = n.gz + dz;
        if (gx < 0 || gx >= map.width || gz < 0 || gz >= map.height) continue;
        if (map.roadGrid.get(gx, gz) === 0) continue;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < bestDist) { bestDist = d; bestGx = gx; bestGz = gz; }
      }
    }

    if (bestGx < 0) continue;

    // Use 'nucleus' preset — tolerates low buildability (cost 12, not Infinity)
    const costFn = map.createPathCost('nucleus');
    const result = findPath(n.gx, n.gz, bestGx, bestGz, map.width, map.height, costFn);
    if (!result || result.path.length < 2) continue;

    // Stamp debug grid (roadGrid stamping handled by addFeature below)
    if (map.debugMstGrid) {
      for (const p of result.path) {
        map.debugMstGrid.set(p.gx, p.gz, 1);
      }
    }

    // Simplify and smooth
    const simplified = _simplifyPathInline(result.path, 1.0);
    const smoothed = gridPathToWorldPolyline(simplified, map.cellSize, map.originX, map.originZ);
    if (smoothed.length < 2) continue;

    const width = 6 + 0.3 * 10;
    map.addFeature('road', {
      polyline: smoothed,
      width,
      hierarchy: 'local',
      importance: 0.3,
      source: 'skeleton',
    });
  }
}

// ============================================================
// Road compaction — unify polylines and graph
// ============================================================

const HIER_RANK = { arterial: 1, collector: 2, local: 3, track: 4 };

/**
 * Compact road polylines: snap nearby vertices, deduplicate roads.
 * Then rebuild the graph from the cleaned roads.
 *
 * @param {import('../core/FeatureMap.js').FeatureMap} map
 * @param {number} snapDist - Max distance to merge vertices
 */
export function compactRoads(map, snapDist) {
  const network = map.roadNetwork;
  const roads = network.roads.filter(r => r.source === 'skeleton');
  if (roads.length === 0) return;

  // --- Pass 1: Snap polyline ENDPOINTS to nearest representative ---
  const reps = [];
  const snapDistSq = snapDist * snapDist;

  function findSnap(p) {
    let bestDist = snapDistSq;
    let bestRep = null;
    for (const rep of reps) {
      const dx = p.x - rep.x, dz = p.z - rep.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestDist) { bestDist = d2; bestRep = rep; }
    }
    if (bestRep) return bestRep;
    const newRep = { x: p.x, z: p.z };
    reps.push(newRep);
    return newRep;
  }

  // Compute snapped endpoints for each road
  const snappedPolys = new Map(); // roadId → newPolyline
  for (const road of roads) {
    const poly = road.polyline;
    if (poly.length < 2) continue;
    const snappedStart = findSnap(poly[0]);
    const snappedEnd = findSnap(poly[poly.length - 1]);

    // Build new polyline with snapped endpoints
    const newPoly = poly.map(p => ({ x: p.x, z: p.z }));
    newPoly[0] = { x: snappedStart.x, z: snappedStart.z };
    newPoly[newPoly.length - 1] = { x: snappedEnd.x, z: snappedEnd.z };

    // Deduplicate consecutive identical points
    const deduped = [newPoly[0]];
    for (let i = 1; i < newPoly.length; i++) {
      if (newPoly[i].x !== deduped[deduped.length - 1].x ||
          newPoly[i].z !== deduped[deduped.length - 1].z) {
        deduped.push(newPoly[i]);
      }
    }
    snappedPolys.set(road.id, deduped);
  }

  // Apply snapped polylines via updatePolyline, or remove if too short
  for (const [id, poly] of snappedPolys) {
    if (poly.length < 2) {
      network.remove(id);
    } else {
      network.updatePolyline(id, poly);
    }
  }

  // --- Pass 2: Remove duplicate roads (same snapped endpoints, keep best hierarchy) ---
  const remaining = network.roads.filter(r => r.source === 'skeleton');
  const toRemove = new Set();

  function endpointKey(road) {
    const s = road.start, e = road.end;
    return s.x < e.x || (s.x === e.x && s.z <= e.z)
      ? `${s.x},${s.z}-${e.x},${e.z}`
      : `${e.x},${e.z}-${s.x},${s.z}`;
  }

  const roadsByEndpoints = new Map();
  for (const road of remaining) {
    if (road.polyline.length < 2) continue;
    const key = endpointKey(road);
    if (!roadsByEndpoints.has(key)) roadsByEndpoints.set(key, []);
    roadsByEndpoints.get(key).push(road);
  }

  for (const [, group] of roadsByEndpoints) {
    if (group.length <= 1) continue;
    group.sort((a, b) =>
      (HIER_RANK[a.hierarchy] || 9) - (HIER_RANK[b.hierarchy] || 9));
    for (let i = 1; i < group.length; i++) {
      toRemove.add(group[i].id);
    }
  }

  for (const id of toRemove) {
    network.remove(id);
  }

  // Also clean up features[] for backward compat
  if (toRemove.size > 0) {
    map.features = map.features.filter(f => f.type !== 'road' || !toRemove.has(f.id));
  }
}

/**
 * Rebuild the PlanarGraph from current map.roads.
 * Clears the graph and re-adds all road polylines.
 *
 * @param {import('../core/FeatureMap.js').FeatureMap} map
 */
export function rebuildGraphFromRoads(map) {
  // With RoadNetwork, the graph is already in sync with roads.
  // Just compact graph nodes to merge nearby nodes.
  map.graph.compact(map.cellSize * 1.5);
}

// ============================================================
// Debug path export for the path-viewer tool
// ============================================================

/**
 * Export debug path data from a FeatureMap as a JSON string.
 * The resulting JSON can be loaded in tools/path-viewer.html.
 *
 * @param {import('../core/FeatureMap.js').FeatureMap} map
 * @returns {string|null} JSON string, or null if no debug paths collected
 */
export function exportDebugPathsJSON(map) {
  if (!map.debugPaths) return null;
  return JSON.stringify({
    gridWidth: map.debugPathsGridWidth,
    gridHeight: map.debugPathsGridHeight,
    paths: map.debugPaths,
  });
}
