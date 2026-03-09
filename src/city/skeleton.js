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
import { PlanarGraph } from '../core/PlanarGraph.js';
import { Grid2D } from '../core/Grid2D.js';
import { placeBridges } from './bridges.js';

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
  const builtRoads = buildRoadNetwork({
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
  });

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

  // 9. Resolve graph issues: crossing edges and shallow angles.
  //    Each fix can create new instances of the other, so loop until stable.
  for (let pass = 0; pass < 5; pass++) {
    const crossings = map.graph.detectCrossingEdges().length;
    const shallows = map.graph.detectShallowAngles(DETECT_ANGLE_DEG).length;
    if (crossings === 0 && shallows === 0) break;
    if (crossings > 0) resolveCrossingEdges(map);
    if (shallows > 0) resolveShallowAngles(map);
  }
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
 * Returns grid-coord connection pairs for buildRoadNetwork.
 */
function getAnchorConnections(map, layers) {
  const roads = layers.getData('roads');
  if (!roads || roads.length === 0) return [];

  const params = layers.getData('params');
  const regionalCellSize = params.cellSize;

  const cityMinX = map.originX;
  const cityMinZ = map.originZ;
  const cityMaxX = map.originX + map.width * map.cellSize;
  const cityMaxZ = map.originZ + map.height * map.cellSize;

  const hierRank = { arterial: 1, collector: 2, local: 3, track: 4 };
  const relevantRoads = [];

  for (const road of roads) {
    const path = road.rawPath || road.path;
    if (!path) continue;

    let inside = false;
    for (const p of path) {
      const wx = p.gx * regionalCellSize;
      const wz = p.gz * regionalCellSize;
      if (wx >= cityMinX && wx <= cityMaxX && wz >= cityMinZ && wz <= cityMaxZ) {
        inside = true;
        break;
      }
    }
    if (inside) relevantRoads.push(road);
  }

  // Sort by hierarchy (arterials first)
  relevantRoads.sort((a, b) => (hierRank[a.hierarchy] || 3) - (hierRank[b.hierarchy] || 3));

  const connections = [];
  for (const road of relevantRoads) {
    const path = road.rawPath || road.path;

    // Find entry and exit points within city bounds
    const cityPoints = [];
    for (const p of path) {
      const wx = p.gx * regionalCellSize;
      const wz = p.gz * regionalCellSize;
      const cgx = Math.round((wx - map.originX) / map.cellSize);
      const cgz = Math.round((wz - map.originZ) / map.cellSize);
      if (cgx >= 1 && cgx < map.width - 1 && cgz >= 1 && cgz < map.height - 1) {
        cityPoints.push({ gx: cgx, gz: cgz });
      }
    }

    if (cityPoints.length < 2) continue;

    const startPt = cityPoints[0];
    const endPt = cityPoints[cityPoints.length - 1];
    if (distance2D(startPt.gx, startPt.gz, endPt.gx, endPt.gz) < 5) continue;

    connections.push({
      from: startPt,
      to: endPt,
      hierarchy: road.hierarchy || 'local',
    });
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

    // Stamp road grid + debug grid
    for (const p of result.path) {
      map.roadGrid.set(p.gx, p.gz, 1);
      if (map.debugMstGrid) map.debugMstGrid.set(p.gx, p.gz, 1);
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
// Graph helpers
// ============================================================

/**
 * Add a road polyline to the PlanarGraph.
 */
export function addRoadToGraph(map, polyline, width, hierarchy) {
  if (polyline.length < 2) return;

  const graph = map.graph;
  const snapDist = map.cellSize * 3;

  const startPt = polyline[0];
  const endPt = polyline[polyline.length - 1];

  const startNodeId = _findOrCreateNode(graph, startPt.x, startPt.z, snapDist);
  const endNodeId = _findOrCreateNode(graph, endPt.x, endPt.z, snapDist);

  if (startNodeId === endNodeId) return;

  // Skip if there's already an edge between these nodes (prevents duplicate
  // edges that break the half-edge face extraction algorithm)
  if (graph.neighbors(startNodeId).includes(endNodeId)) return;

  const points = polyline.slice(1, -1).map(p => ({ x: p.x, z: p.z }));
  graph.addEdge(startNodeId, endNodeId, { points, width, hierarchy });
}

function _findOrCreateNode(graph, x, z, snapDist) {
  const nearest = graph.nearestNode(x, z);
  if (nearest && nearest.dist < snapDist) {
    return nearest.id;
  }
  return graph.addNode(x, z);
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
  const roads = map.roads.filter(r => r.source === 'skeleton');
  if (roads.length === 0) return;

  // --- Pass 1: Snap polyline ENDPOINTS to nearest representative ---
  // Only endpoints (first/last point) participate in snapping.
  // This merges roads that start/end at nearby positions without
  // distorting intermediate vertices along a road's path.
  const reps = []; // [{x, z}]
  const snapDistSq = snapDist * snapDist;

  function snapPoint(p) {
    let bestDist = snapDistSq;
    let bestRep = null;
    for (const rep of reps) {
      const dx = p.x - rep.x, dz = p.z - rep.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestDist) {
        bestDist = d2;
        bestRep = rep;
      }
    }
    if (bestRep) {
      p.x = bestRep.x;
      p.z = bestRep.z;
    } else {
      reps.push({ x: p.x, z: p.z });
    }
  }

  for (const road of roads) {
    const poly = road.polyline;
    if (poly.length < 2) continue;
    snapPoint(poly[0]);
    snapPoint(poly[poly.length - 1]);
  }

  // --- Pass 1b: Deduplicate consecutive identical points in each polyline ---
  for (const road of roads) {
    const poly = road.polyline;
    const deduped = [poly[0]];
    for (let i = 1; i < poly.length; i++) {
      if (poly[i].x !== deduped[deduped.length - 1].x ||
          poly[i].z !== deduped[deduped.length - 1].z) {
        deduped.push(poly[i]);
      }
    }
    road.polyline = deduped;
  }

  // --- Pass 2: Remove duplicate/parallel roads ---
  // Two roads are duplicates if they share both endpoints (after snapping).
  // Two roads are parallel if they share one endpoint and the other endpoints
  // are within snapDist of each other.
  const toRemove = new Set();

  // Normalize endpoint pair for a road (direction-agnostic)
  function endpointKey(road) {
    const s = road.polyline[0], e = road.polyline[road.polyline.length - 1];
    return s.x < e.x || (s.x === e.x && s.z <= e.z)
      ? `${s.x},${s.z}-${e.x},${e.z}`
      : `${e.x},${e.z}-${s.x},${s.z}`;
  }

  // 2a: Exact endpoint duplicates
  const roadsByEndpoints = new Map();
  for (const road of roads) {
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

  // 2b: Near-parallel roads — share one endpoint, other endpoints close.
  // Group roads by each endpoint they touch, then within each group
  // find pairs whose OTHER endpoints are within snapDist.
  const roadsByVertex = new Map(); // "x,z" → [{ road, otherEnd }]
  for (const road of roads) {
    if (road.polyline.length < 2 || toRemove.has(road.id)) continue;
    const s = road.polyline[0], e = road.polyline[road.polyline.length - 1];
    const sKey = `${s.x},${s.z}`, eKey = `${e.x},${e.z}`;

    if (!roadsByVertex.has(sKey)) roadsByVertex.set(sKey, []);
    roadsByVertex.get(sKey).push({ road, otherEnd: e });

    if (!roadsByVertex.has(eKey)) roadsByVertex.set(eKey, []);
    roadsByVertex.get(eKey).push({ road, otherEnd: s });
  }

  for (const [, entries] of roadsByVertex) {
    if (entries.length <= 1) continue;
    // For each pair sharing this vertex, check if other ends are close
    for (let i = 0; i < entries.length; i++) {
      if (toRemove.has(entries[i].road.id)) continue;
      for (let j = i + 1; j < entries.length; j++) {
        if (toRemove.has(entries[j].road.id)) continue;
        const dx = entries[i].otherEnd.x - entries[j].otherEnd.x;
        const dz = entries[i].otherEnd.z - entries[j].otherEnd.z;
        if (dx * dx + dz * dz <= snapDistSq) {
          // Keep the one with better hierarchy (or longer polyline if tied)
          const ri = entries[i].road, rj = entries[j].road;
          const rankI = HIER_RANK[ri.hierarchy] || 9;
          const rankJ = HIER_RANK[rj.hierarchy] || 9;
          if (rankI <= rankJ) {
            toRemove.add(rj.id);
          } else {
            toRemove.add(ri.id);
          }
        }
      }
    }
  }

  // Also remove roads that became too short (< 2 distinct points)
  for (const road of roads) {
    if (road.polyline.length < 2) toRemove.add(road.id);
  }

  // Remove from map.roads and map.features
  if (toRemove.size > 0) {
    map.roads = map.roads.filter(r => !toRemove.has(r.id));
    map.features = map.features.filter(f => !toRemove.has(f.id));
  }
}

/**
 * Rebuild the PlanarGraph from current map.roads.
 * Clears the graph and re-adds all road polylines.
 *
 * @param {import('../core/FeatureMap.js').FeatureMap} map
 */
export function rebuildGraphFromRoads(map) {
  // Clear graph and rebuild from road polylines
  map.graph = new PlanarGraph();

  for (const road of map.roads) {
    if (!road.polyline || road.polyline.length < 2) continue;
    addRoadToGraph(map, road.polyline, road.width, road.hierarchy);
  }

  // Compact graph nodes too
  map.graph.compact(map.cellSize * 1.5);
}

// ============================================================
// Crossing edge resolution
// ============================================================

/**
 * Resolve crossing edges by splitting both at the intersection point,
 * creating a proper junction node where roads cross.
 *
 * Operates on the PlanarGraph only.
 *
 * @param {import('../core/FeatureMap.js').FeatureMap} map
 */
export function resolveCrossingEdges(map) {
  const graph = map.graph;

  for (let iter = 0; iter < 50; iter++) {
    const crossings = graph.detectCrossingEdges();
    if (crossings.length === 0) break;

    // Process one crossing at a time (splitting changes edge IDs)
    const { edgeA, edgeB, x, z } = crossings[0];
    if (!graph.getEdge(edgeA) || !graph.getEdge(edgeB)) continue;

    // Split edge A at the crossing point → new node
    const nodeA = graph.splitEdge(edgeA, x, z);

    // Split edge B at the same point → another new node
    // (edgeB ID is still valid since we only split edgeA)
    const nodeB = graph.splitEdge(edgeB, x, z);

    // Merge the two new nodes into one junction
    if (nodeA !== nodeB) {
      graph.mergeNodes(nodeB, nodeA);
    }
  }

  // Clean up any short edges or duplicates from splits
  graph.compact(map.cellSize * 1.5);
}

// ============================================================
// Shallow angle resolution
// ============================================================

const DETECT_ANGLE_DEG = 10;   // flag pairs below this
const BRANCH_ANGLE_RAD = 15 * Math.PI / 180; // merge until this divergence

/**
 * Resolve shallow angles by merging near-parallel edges.
 *
 * Three strategies, tried in order per shallow-angle pair:
 *
 * 1. **Divergence walk** — walk along the longer (base) edge; when the
 *    direction to the shorter (merge) edge's far end diverges by > 15°,
 *    split the base there and re-route the merge edge from the split point.
 *
 * 2. **Projection merge** — if the walk finds no divergence (collinear edges),
 *    project the merge edge's far end onto the base polyline. If close, split
 *    the base there and merge the far node into the split point.
 *
 * 3. **Stub removal** — if the merge edge is very short and projection didn't
 *    apply, just remove it and merge its far node into the shared node.
 *
 * Operates on the PlanarGraph only — road features are unchanged.
 *
 * @param {import('../core/FeatureMap.js').FeatureMap} map
 */
export function resolveShallowAngles(map) {
  const graph = map.graph;
  const step = map.cellSize * 2;
  const snapDist = map.cellSize * 3;
  const compactDist = map.cellSize * 1.5;

  // Outer loop: compact after each batch of resolutions can create new
  // shallow angles from merged nodes. Repeat until stable.
  for (let pass = 0; pass < 10; pass++) {
    let batchResolved = false;

    for (let iter = 0; iter < 50; iter++) {
      const shallows = graph.detectShallowAngles(DETECT_ANGLE_DEG);
      if (shallows.length === 0) break;

      let resolved = false;

      for (const { nodeId, edgeA: eAId, edgeB: eBId } of shallows) {
        const eA = graph.getEdge(eAId);
        const eB = graph.getEdge(eBId);
        if (!eA || !eB) continue;

        const polyA = _orientedPoly(graph, eA, nodeId);
        const polyB = _orientedPoly(graph, eB, nodeId);
        if (polyA.length < 2 || polyB.length < 2) continue;

        const lenA = _polyLenCalc(polyA);
        const lenB = _polyLenCalc(polyB);

        // Base = longer edge (walk along this). Merge = shorter (absorbed).
        let baseEdge, mergeEdge, basePoly, mergePoly, baseLen, mergeLen;
        if (lenA >= lenB) {
          baseEdge = eA; mergeEdge = eB; basePoly = polyA; mergePoly = polyB;
          baseLen = lenA; mergeLen = lenB;
        } else {
          baseEdge = eB; mergeEdge = eA; basePoly = polyB; mergePoly = polyA;
          baseLen = lenB; mergeLen = lenA;
        }

        const mergeFarId = mergeEdge.from === nodeId ? mergeEdge.to : mergeEdge.from;
        const mergeFar = graph.getNode(mergeFarId);
        if (!mergeFar) continue;

        // --- Strategy 1: Divergence walk ---
        // Start walking at least compactDist+1 from shared node so the split
        // point won't be merged back into the shared node by compact().
        let splitDist = -1;
        const sampleStep = Math.min(step, baseLen / 4);
        const startDist = Math.max(sampleStep, compactDist + 1);

        if (sampleStep >= 1 && baseLen > startDist + sampleStep) {
          for (let d = startDist; d < baseLen - sampleStep; d += sampleStep) {
            const pt = _pointAtDist(basePoly, d);
            const fwd = _pointAtDist(basePoly, Math.min(d + sampleStep, baseLen));
            if (!pt || !fwd) continue;

            const baseAng = Math.atan2(fwd.x - pt.x, fwd.z - pt.z);
            const mergeAng = Math.atan2(mergeFar.x - pt.x, mergeFar.z - pt.z);

            let diff = Math.abs(baseAng - mergeAng);
            if (diff > Math.PI) diff = 2 * Math.PI - diff;

            if (diff >= BRANCH_ANGLE_RAD && diff <= Math.PI - BRANCH_ANGLE_RAD) {
              splitDist = d;
              break;
            }
          }
        }

        if (splitDist >= 0) {
          const splitPt = _pointAtDist(basePoly, splitDist);
          if (!splitPt) continue;

          const newNodeId = graph.splitEdge(baseEdge.id, splitPt.x, splitPt.z);
          graph._removeEdge(mergeEdge.id);

          if (newNodeId !== mergeFarId && !graph.neighbors(newNodeId).includes(mergeFarId)) {
            const trimmedPts = _trimWeakPoly(mergePoly, splitDist);
            graph.addEdge(newNodeId, mergeFarId, {
              points: trimmedPts,
              width: mergeEdge.width,
              hierarchy: mergeEdge.hierarchy,
            });
          }
          resolved = true;
          batchResolved = true;
          break;
        }

        // --- Strategy 2: Projection merge (collinear / stub) ---
        const proj = _projectOntoPolyline(basePoly, mergeFar.x, mergeFar.z);

        if (proj && proj.dist < snapDist) {
          graph._removeEdge(mergeEdge.id);

          // If projection is near an endpoint (within compact radius),
          // merge into that endpoint to avoid compact undoing the split.
          const baseFarId = baseEdge.from === nodeId ? baseEdge.to : baseEdge.from;

          if (proj.distAlong <= compactDist) {
            // Near shared node: merge far node into shared node
            if (mergeFarId !== nodeId) {
              graph.mergeNodes(mergeFarId, nodeId);
            }
          } else if (proj.distAlong >= baseLen - compactDist) {
            // Near base far end: merge far node into base far endpoint
            if (mergeFarId !== baseFarId) {
              graph.mergeNodes(mergeFarId, baseFarId);
            }
          } else {
            // Interior: split base, merge far node into split point
            const splitPt = _pointAtDist(basePoly, proj.distAlong);
            const newNodeId = graph.splitEdge(baseEdge.id, splitPt.x, splitPt.z);
            if (newNodeId !== mergeFarId) {
              graph.mergeNodes(mergeFarId, newNodeId);
            }
          }
          resolved = true;
          batchResolved = true;
          break;
        }

        // --- Strategy 3: Remove very short stub ---
        if (mergeLen < snapDist) {
          graph._removeEdge(mergeEdge.id);
          if (graph.degree(mergeFarId) === 0) {
            graph.removeNode(mergeFarId);
          }
          resolved = true;
          batchResolved = true;
          break;
        }
      }

      if (!resolved) break;
    }

    // Clean up duplicates/near-nodes created by merges in this pass.
    // Compact can merge nearby nodes, potentially creating new shallow
    // angles. Loop until none remain (or pass limit reached).
    graph.compact(compactDist);

    if (graph.detectShallowAngles(DETECT_ANGLE_DEG).length === 0) break;
  }
}

/** Get edge polyline oriented so it starts at the given node. */
function _orientedPoly(graph, edge, fromNodeId) {
  const poly = graph.edgePolyline(edge.id);
  if (edge.from !== fromNodeId) poly.reverse();
  return poly;
}

/** Total length of a polyline. */
function _polyLenCalc(poly) {
  let len = 0;
  for (let i = 0; i < poly.length - 1; i++) {
    const dx = poly[i + 1].x - poly[i].x;
    const dz = poly[i + 1].z - poly[i].z;
    len += Math.sqrt(dx * dx + dz * dz);
  }
  return len;
}

/** Interpolate a point at a given distance along a polyline. */
function _pointAtDist(poly, dist) {
  let remaining = dist;
  for (let i = 0; i < poly.length - 1; i++) {
    const dx = poly[i + 1].x - poly[i].x;
    const dz = poly[i + 1].z - poly[i].z;
    const segLen = Math.sqrt(dx * dx + dz * dz);
    if (remaining <= segLen + 1e-9) {
      const t = segLen > 0 ? remaining / segLen : 0;
      return { x: poly[i].x + t * dx, z: poly[i].z + t * dz };
    }
    remaining -= segLen;
  }
  return poly[poly.length - 1];
}

/**
 * Project a point onto a polyline.
 * @returns {{ dist: number, distAlong: number }} perpendicular distance and distance along polyline
 */
function _projectOntoPolyline(poly, px, pz) {
  let bestDist = Infinity;
  let bestAlong = 0;
  let along = 0;

  for (let i = 0; i < poly.length - 1; i++) {
    const ax = poly[i].x, az = poly[i].z;
    const bx = poly[i + 1].x, bz = poly[i + 1].z;
    const dx = bx - ax, dz = bz - az;
    const segLen = Math.sqrt(dx * dx + dz * dz);

    if (segLen < 1e-9) { along += segLen; continue; }

    let t = ((px - ax) * dx + (pz - az) * dz) / (segLen * segLen);
    t = Math.max(0, Math.min(1, t));

    const projX = ax + t * dx, projZ = az + t * dz;
    const d = Math.sqrt((px - projX) ** 2 + (pz - projZ) ** 2);

    if (d < bestDist) {
      bestDist = d;
      bestAlong = along + t * segLen;
    }
    along += segLen;
  }

  return { dist: bestDist, distAlong: bestAlong };
}

/**
 * Trim the initial shared portion of the weak polyline.
 * Skip first `skipDist` of distance, return remaining interior points
 * (excluding endpoints which become graph nodes).
 */
function _trimWeakPoly(poly, skipDist) {
  const result = [];
  let dist = 0;
  let pastMerge = false;

  for (let i = 1; i < poly.length - 1; i++) {
    const dx = poly[i].x - poly[i - 1].x;
    const dz = poly[i].z - poly[i - 1].z;
    dist += Math.sqrt(dx * dx + dz * dz);

    if (dist > skipDist) pastMerge = true;
    if (pastMerge) {
      result.push({ x: poly[i].x, z: poly[i].z });
    }
  }

  return result;
}
