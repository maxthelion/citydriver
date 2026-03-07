/**
 * V5 Growth Loop — Grid-Based Growth with A* Road Placement.
 *
 * Every road (local, back lane, cross street) is placed via A* pathfinding
 * on the occupancy grid, not geometric projection. The occupancy grid is the
 * single source of truth — no road can overlap another.
 *
 * Growth proceeds from a priority frontier: targets are scored by density,
 * terrain attraction, and proximity to existing development. The frontier
 * starts along arterials/collectors and expands outward as new roads are built.
 */

import { distance2D } from '../core/math.js';
import { findPath, simplifyPath, smoothPath } from '../core/pathfinding.js';
import { stampEdge, stampPlot, stampJunction, OCCUPANCY_ROAD, OCCUPANCY_JUNCTION, OCCUPANCY_PLOT } from './roadOccupancy.js';
import { fillBlockPlots } from './blockSubdivision.js';
import { growthRoadCost } from './pathCost.js';
import {
  computeGradientField,
  computeWaterDistanceField,
  computeTerrainAttraction,
  computeRoadDistanceField,
} from './terrainFields.js';

/**
 * Run the V5 growth loop.
 *
 * @param {import('../core/LayerStack.js').LayerStack} cityLayers
 * @param {import('../core/PlanarGraph.js').PlanarGraph} graph
 * @param {Array} nuclei - from seedNuclei()
 * @param {import('../core/rng.js').SeededRandom} rng
 * @param {object} [options]
 * @returns {{ plots: Array, buildings: Array, tickSnapshots: Array }}
 */
export function growCity(cityLayers, graph, nuclei, rng, options = {}) {
  const { maxIterations = 2000 } = options;

  const params = cityLayers.getData('params');
  const elevation = cityLayers.getGrid('elevation');
  const waterMask = cityLayers.getGrid('waterMask');
  const slope = cityLayers.getGrid('slope');
  const occupancy = cityLayers.getData('occupancy');

  const w = params.width;
  const h = params.height;
  const cs = params.cellSize;
  const seaLevel = params.seaLevel ?? 0;
  const totalTarget = cityLayers.getData('targetPopulation') || 2000;

  // Buildability is incrementally updated by stamp operations — no recompute needed
  const buildability = cityLayers.getGrid('buildability');

  // Unified cost functions from pathCost factory
  const costFn = growthRoadCost(cityLayers);

  // --- Precompute terrain fields (once) ---
  const { dxGrid: gradDx, dzGrid: gradDz } = computeGradientField(elevation, w, h);
  const { waterDistGrid, shorelineDirGrid } = computeWaterDistanceField(waterMask, elevation, seaLevel, w, h);
  const terrainAttraction = computeTerrainAttraction(elevation, slope, waterDistGrid, w, h, seaLevel);

  const terrainFields = { gradDx, gradDz, waterDistGrid, shorelineDirGrid, terrainAttraction };

  // --- State ---
  const allPlots = [];
  const tickSnapshots = [];
  let totalPopulation = 0;
  const edgeOwnership = assignEdgesToNuclei(graph, nuclei);
  const processedBlocks = new Set();
  const terrain = { elevation, waterMask, occupancy, w, h, cs, seaLevel };

  // --- Initialize frontier ---
  const frontier = [];
  initFrontier(frontier, nuclei, graph, edgeOwnership, buildability, cs, w, h);

  // --- Main growth loop ---
  // Road distance field refreshed per-tick for proximity bands
  let roadDistField = occupancy ? computeRoadDistanceField(occupancy) : null;

  const nucleiById = new Map(nuclei.map(n => [n.id, n]));
  let stagnantCount = 0;
  let recentPeople = 0;
  const startTime = Date.now();
  const timeBudgetMs = 5000; // max 5 seconds for growth

  // Process in ticks; each tick pops a batch of targets
  const maxTicks = 20;

  for (let tick = 0; tick < maxTicks; tick++) {
    if (totalPopulation >= totalTarget) break;
    if (frontier.length === 0) break;
    if (stagnantCount > 5) break;
    if (Date.now() - startTime > timeBudgetMs) break;

    // Refresh road distance field periodically for proximity bands
    if (tick > 0 && tick % 3 === 0 && occupancy) {
      roadDistField = computeRoadDistanceField(occupancy);
    }

    const batchSize = Math.min(20, frontier.length);
    let roadsAdded = 0;

    for (let b = 0; b < batchSize; b++) {
      if (frontier.length === 0) break;

      // Pop highest priority target
      let bestIdx = 0;
      for (let i = 1; i < frontier.length; i++) {
        if (frontier[i].priority > frontier[bestIdx].priority) bestIdx = i;
      }
      const target = frontier[bestIdx];
      frontier[bestIdx] = frontier[frontier.length - 1];
      frontier.pop();

      // Check if target nucleus is satisfied
      const nucleus = nucleiById.get(target.nucleusId);
      if (nucleus && nucleus.population >= nucleus.targetPopulation) continue;

      // Skip if target is unbuildable
      const tgx = Math.round(target.x / cs);
      const tgz = Math.round(target.z / cs);
      if (tgx < 2 || tgx >= w - 2 || tgz < 2 || tgz >= h - 2) continue;
      if (buildability.get(tgx, tgz) < 0.01) continue;

      // Find nearest existing road node to target
      const nearest = graph.nearestNode(target.x, target.z);
      if (!nearest) continue;

      // Skip if target is too close to an existing node
      if (nearest.dist < cs * 4) continue;

      // A* pathfind from nearest node to target
      const newEdgeId = pathfindRoad(
        graph, nearest.id, target.x, target.z,
        costFn, w, h, cs, occupancy,
      );

      if (newEdgeId === null) continue;

      stampEdge(graph, newEdgeId, occupancy);
      edgeOwnership.set(newEdgeId, target.nucleusId);
      roadsAdded++;

      // Spawn perpendicular cross-streets to form blocks
      const newNodeId = graph.getEdge(newEdgeId).to;
      const parentDir = getEdgeDirection(graph, newEdgeId);

      const crossEdges = spawnCrossStreets(
        graph, newNodeId, parentDir, target.nucleusId,
        costFn, w, h, cs, occupancy, elevation, waterMask, seaLevel, nucleus,
        cityLayers.getGrid('buildability'),
      );
      for (const ceId of crossEdges) {
        stampEdge(graph, ceId, occupancy);
        edgeOwnership.set(ceId, target.nucleusId);
        roadsAdded++;
      }

      // Spawn new frontier targets (cap frontier to avoid runaway)
      if (frontier.length < 200) {
        spawnTargetsFromEdge(
          frontier, graph, newEdgeId, target.nucleusId,
          cityLayers.getGrid('buildability'), cs, w, h, nucleus,
        );
      }
    }

    // Stitch dead-ends: connect degree-1 tips to nearby nodes
    const stitchEdges = stitchDeadEnds(graph, costFn, w, h, cs, occupancy);
    for (const { edgeId, nucleusId: nId } of stitchEdges) {
      stampEdge(graph, edgeId, occupancy);
      edgeOwnership.set(edgeId, nId);
      roadsAdded++;
    }

    // Extract blocks and subdivide into plots (expensive, do every 2 ticks or on final tick)
    if (tick % 2 !== 0 && tick < maxTicks - 1 && roadsAdded > 0) {
      // Skip block extraction on odd ticks when roads were added (will catch up next tick)
      tickSnapshots.push({ tick, population: totalPopulation, plotCount: allPlots.length, edgeCount: graph.edges.size });
      continue;
    }
    const newPlots = fillBlockPlots(graph, nuclei, edgeOwnership, terrain, rng, processedBlocks);
    for (const plot of newPlots) {
      allPlots.push(plot);
      if (plot.vertices) stampPlot(plot.vertices, occupancy);

      const people = Math.round(2 + rng.next() * 2);
      plot.people = people;

      const nucleus = nucleiById.get(plot.nucleusId);
      if (nucleus) nucleus.population += people;
      totalPopulation += people;
      recentPeople += people;
    }

    // Track stagnation
    if (roadsAdded === 0 && newPlots.length === 0) {
      stagnantCount++;
    } else {
      stagnantCount = 0;
    }

    // Check diminishing returns
    if (tick > 0 && tick % 10 === 0) {
      if (recentPeople < 10) break;
      recentPeople = 0;
    }

    tickSnapshots.push({
      tick,
      population: totalPopulation,
      plotCount: allPlots.length,
      edgeCount: graph.edges.size,
    });
  }

  return { plots: allPlots, buildings: [], tickSnapshots };
}

// ============================================================
// Edge ownership
// ============================================================

function assignEdgesToNuclei(graph, nuclei) {
  const ownership = new Map();
  for (const [edgeId, edge] of graph.edges) {
    const from = graph.getNode(edge.from);
    const to = graph.getNode(edge.to);
    const mx = (from.x + to.x) / 2;
    const mz = (from.z + to.z) / 2;

    let bestId = nuclei[0]?.id ?? 0;
    let bestDist = Infinity;
    for (const n of nuclei) {
      const d = distance2D(mx, mz, n.x, n.z);
      if (d < bestDist) { bestDist = d; bestId = n.id; }
    }
    ownership.set(edgeId, bestId);
  }
  return ownership;
}

// ============================================================
// Frontier initialization
// ============================================================

function initFrontier(frontier, nuclei, graph, edgeOwnership, buildabilityGrid, cs, w, h) {
  for (const [edgeId, edge] of graph.edges) {
    const hierarchy = edge.hierarchy || 'local';
    if (hierarchy !== 'arterial' && hierarchy !== 'collector' && hierarchy !== 'structural') continue;

    const polyline = graph.edgePolyline(edgeId);
    if (polyline.length < 2) continue;

    const totalLen = polylineLength(polyline);
    const nucleusId = edgeOwnership.get(edgeId) ?? 0;
    const nucleus = nuclei.find(n => n.id === nucleusId);
    const spacing = nucleus?.plotConfig?.crossStreetSpacing || 60;
    const blockDepth = (nucleus?.plotConfig?.plotDepth || 25) * 2 + 10;

    const numTargets = Math.max(1, Math.floor(totalLen / spacing));

    for (let i = 0; i < numTargets; i++) {
      const t = numTargets === 1 ? 0.5 : (i + 0.5) / numTargets;
      const pos = samplePolylineAt(polyline, totalLen, t);
      const dir = samplePolylineDir(polyline, totalLen, t);

      // Project targets perpendicular to the road on both sides
      for (const side of [-1, 1]) {
        const perpX = -dir.z * side;
        const perpZ = dir.x * side;
        const tx = pos.x + perpX * blockDepth;
        const tz = pos.z + perpZ * blockDepth;

        const tgx = Math.round(tx / cs);
        const tgz = Math.round(tz / cs);
        if (tgx < 2 || tgx >= w - 2 || tgz < 2 || tgz >= h - 2) continue;

        const b = (tgx >= 0 && tgx < w && tgz >= 0 && tgz < h)
          ? buildabilityGrid.get(tgx, tgz) : 0;
        if (b < 0.01) continue;

        const hierWeight = hierarchy === 'arterial' ? 1.0 : hierarchy === 'collector' ? 0.7 : 0.5;

        frontier.push({
          x: tx, z: tz,
          nucleusId,
          priority: b * 0.3 + hierWeight * 0.3 + 0.4 * Math.random(),
        });
      }
    }
  }
}

// buildGrowthCostFn removed — replaced by pathCost.growthRoadCost()

// ============================================================
// Pathfind a single road segment
// ============================================================

/**
 * A* pathfind a road from an existing node toward a target position.
 * Uses a direction-biased heuristic that penalizes deviation from the
 * straight-line direction (from→target), preventing wiggly paths.
 */
function pathfindRoad(graph, fromNodeId, targetX, targetZ, costFn, w, h, cs, occupancy) {
  const fromNode = graph.getNode(fromNodeId);
  if (!fromNode) return null;

  const startGx = Math.round(fromNode.x / cs);
  const startGz = Math.round(fromNode.z / cs);
  const goalGx = Math.round(targetX / cs);
  const goalGz = Math.round(targetZ / cs);

  if (startGx === goalGx && startGz === goalGz) return null;

  // Direction-biased heuristic: euclidean + penalty for lateral deviation
  // from the start→goal axis. This keeps paths straighter.
  const dxGoal = goalGx - startGx;
  const dzGoal = goalGz - startGz;
  const goalDist = Math.sqrt(dxGoal * dxGoal + dzGoal * dzGoal) || 1;
  const axisX = dxGoal / goalDist;
  const axisZ = dzGoal / goalDist;

  const biasedHeuristic = (gx, gz, gGoalGx, gGoalGz) => {
    const dx = gGoalGx - gx;
    const dz = gGoalGz - gz;
    const dist = Math.sqrt(dx * dx + dz * dz);
    // Lateral distance from the start→goal line
    const lateral = Math.abs((gx - startGx) * (-axisZ) + (gz - startGz) * axisX);
    return dist + lateral * 1.0; // strong straightness preference
  };

  const result = findPath(startGx, startGz, goalGx, goalGz, w, h, costFn, biasedHeuristic);
  if (!result || result.path.length < 2) return null;

  // Overlap rejection: if >60% of path cells are already road, this is a
  // redundant corridor — reject it to prevent V_noOverlappingRoads failures
  if (occupancy) {
    let roadCells = 0;
    for (const { x: gx, z: gz } of result.path) {
      const ax = Math.floor((gx * cs) / occupancy.res);
      const az = Math.floor((gz * cs) / occupancy.res);
      if (ax >= 0 && ax < occupancy.width && az >= 0 && az < occupancy.height) {
        const val = occupancy.data[az * occupancy.width + ax];
        if (val === OCCUPANCY_ROAD || val === OCCUPANCY_JUNCTION) roadCells++;
      }
    }
    if (result.path.length >= 3 && roadCells / result.path.length > 0.4) return null;
  }

  const simplified = simplifyPath(result.path, 1.5);
  const smooth = smoothPath(simplified, cs);
  if (smooth.length < 2) return null;

  // Snap end to existing node with generous threshold
  const endX = smooth[smooth.length - 1].x;
  const endZ = smooth[smooth.length - 1].z;
  const snapThreshold = cs * 3;

  let targetNodeId;
  const nearEnd = graph.nearestNode(endX, endZ);
  if (nearEnd && nearEnd.dist < snapThreshold && nearEnd.id !== fromNodeId) {
    targetNodeId = nearEnd.id;
  } else {
    targetNodeId = graph.addNode(endX, endZ);
  }

  // Don't create duplicate edges
  if (graph.neighbors(fromNodeId).includes(targetNodeId)) return null;

  const edgeId = graph.addEdge(fromNodeId, targetNodeId, {
    points: smooth.slice(1, -1),
    width: 6,
    hierarchy: 'local',
  });

  return edgeId;
}

// ============================================================
// Cross-street spawning
// ============================================================

/**
 * From a newly-placed node, try to pathfind short perpendicular roads
 * that connect back to existing roads. This is the key block-closing mechanism.
 *
 * Strategy: for each side, first check if there's an existing road node within
 * reach in the perpendicular direction. If so, pathfind to it (block closure).
 * If not, pathfind to a fixed target point (may dead-end, but frontier will extend it later).
 */
function spawnCrossStreets(
  graph, nodeId, parentDir, nucleusId,
  costFn, w, h, cs, occupancy, elevation, waterMask, seaLevel, nucleus,
  buildabilityGrid,
) {
  const newEdges = [];
  const node = graph.getNode(nodeId);
  if (!node) return newEdges;

  const blockDepth = (nucleus?.plotConfig?.plotDepth || 25) + (nucleus?.plotConfig?.setback || 3) + 6;
  const searchRadius = blockDepth * 2.0; // search wider for existing roads to connect to

  for (const side of [-1, 1]) {
    const perpX = -parentDir.z * side;
    const perpZ = parentDir.x * side;

    // Search for an existing road node in the perpendicular direction
    // that we could connect to (forming a closed block)
    let targetX = node.x + perpX * blockDepth;
    let targetZ = node.z + perpZ * blockDepth;
    let connectTarget = null;

    // Scan for nearby non-adjacent nodes in the perpendicular cone
    for (const [candidateId, candidateNode] of graph.nodes) {
      if (candidateId === nodeId) continue;
      if (graph.neighbors(nodeId).includes(candidateId)) continue;

      const dx = candidateNode.x - node.x;
      const dz = candidateNode.z - node.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < cs * 2 || dist > searchRadius) continue;

      // Check that the candidate is roughly in the perpendicular direction
      // (dot product with perp direction > 0.5 of distance = within ~60 degree cone)
      const dot = (dx * perpX + dz * perpZ) / dist;
      if (dot < 0.4) continue;

      // Prefer candidates that are close to blockDepth distance (ideal block closure)
      const idealness = 1 - Math.abs(dist - blockDepth) / blockDepth;
      if (!connectTarget || idealness > connectTarget.idealness) {
        connectTarget = { id: candidateId, x: candidateNode.x, z: candidateNode.z, idealness, dist };
      }
    }

    if (connectTarget) {
      // Pathfind to the existing node for block closure
      targetX = connectTarget.x;
      targetZ = connectTarget.z;
    }

    // Validate target via buildability
    const tgx = Math.round(targetX / cs);
    const tgz = Math.round(targetZ / cs);
    if (tgx < 2 || tgx >= w - 2 || tgz < 2 || tgz >= h - 2) continue;
    if (buildabilityGrid && buildabilityGrid.get(tgx, tgz) < 0.01) continue;

    const edgeId = pathfindRoad(graph, nodeId, targetX, targetZ, costFn, w, h, cs, occupancy);
    if (edgeId !== null) {
      newEdges.push(edgeId);
    }
  }

  return newEdges;
}

// ============================================================
// Frontier expansion from new edges
// ============================================================

function spawnTargetsFromEdge(
  frontier, graph, edgeId, nucleusId,
  buildabilityGrid, cs, w, h, nucleus,
) {
  const edge = graph.getEdge(edgeId);
  if (!edge) return;

  const polyline = graph.edgePolyline(edgeId);
  if (polyline.length < 2) return;

  const totalLen = polylineLength(polyline);
  const spacing = nucleus?.plotConfig?.crossStreetSpacing || 60;
  const blockDepth = (nucleus?.plotConfig?.plotDepth || 25) * 2 + 10;

  // Only add targets if edge is long enough
  if (totalLen < spacing * 0.7) return;

  const numTargets = Math.max(1, Math.floor(totalLen / spacing));

  for (let i = 0; i < numTargets; i++) {
    const t = numTargets === 1 ? 0.5 : (i + 0.5) / numTargets;
    const pos = samplePolylineAt(polyline, totalLen, t);
    const dir = samplePolylineDir(polyline, totalLen, t);

    for (const side of [-1, 1]) {
      const perpX = -dir.z * side;
      const perpZ = dir.x * side;
      const tx = pos.x + perpX * blockDepth;
      const tz = pos.z + perpZ * blockDepth;

      const tgx = Math.round(tx / cs);
      const tgz = Math.round(tz / cs);
      if (tgx < 2 || tgx >= w - 2 || tgz < 2 || tgz >= h - 2) continue;

      const b = buildabilityGrid.get(tgx, tgz);
      if (b < 0.01) continue;

      // Don't add targets too close to existing nodes
      const nearest = graph.nearestNode(tx, tz);
      if (nearest && nearest.dist < cs * 5) continue;

      frontier.push({
        x: tx, z: tz,
        nucleusId,
        priority: b * 0.3 + 0.2 + 0.5 * Math.random(),
      });
    }
  }

  // Also extend from dead-end tips
  const toNode = graph.getNode(edge.to);
  if (toNode && graph.degree(edge.to) === 1) {
    // Extend in the forward direction
    const dir = samplePolylineDir(polyline, totalLen, 0.9);
    const tx = toNode.x + dir.x * blockDepth;
    const tz = toNode.z + dir.z * blockDepth;

    const tgx = Math.round(tx / cs);
    const tgz = Math.round(tz / cs);
    if (tgx >= 2 && tgx < w - 2 && tgz >= 2 && tgz < h - 2) {
      if (buildabilityGrid.get(tgx, tgz) >= 0.01) {
        frontier.push({
          x: tx, z: tz,
          nucleusId,
          priority: 0.6 + 0.3 * Math.random(),
        });
      }
    }
  }
}

// ============================================================
// Dead-end stitching
// ============================================================

/**
 * Find dead-end nodes and try to connect them to nearby non-adjacent
 * nodes. This closes blocks that the cross-street mechanism missed.
 * Limited to a small number per tick to avoid performance issues.
 */
function stitchDeadEnds(graph, costFn, w, h, cs, occupancy) {
  const results = [];
  const deadEnds = graph.deadEnds();
  const maxStitchesPerTick = 10;
  let stitchCount = 0;

  for (const nodeId of deadEnds) {
    if (stitchCount >= maxStitchesPerTick) break;

    const node = graph.getNode(nodeId);
    if (!node) continue;

    // Find the direction this dead-end is pointing (from its single neighbor)
    const neighbors = graph.neighbors(nodeId);
    if (neighbors.length !== 1) continue;
    const neighbor = graph.getNode(neighbors[0]);
    if (!neighbor) continue;

    // Dead-end direction (pointing away from the network)
    const dx = node.x - neighbor.x;
    const dz = node.z - neighbor.z;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    const dirX = dx / len;
    const dirZ = dz / len;

    // Search for nearby non-adjacent nodes to connect to
    let bestId = null;
    let bestScore = -Infinity;
    const maxDist = cs * 15; // search radius
    const minDist = cs * 3;

    for (const [candidateId, candidateNode] of graph.nodes) {
      if (candidateId === nodeId) continue;
      if (graph.neighbors(nodeId).includes(candidateId)) continue;

      const cdx = candidateNode.x - node.x;
      const cdz = candidateNode.z - node.z;
      const dist = Math.sqrt(cdx * cdx + cdz * cdz);
      if (dist < minDist || dist > maxDist) continue;

      // Prefer candidates in the forward or perpendicular direction
      // (not behind us — that would loop back)
      const dot = (cdx * dirX + cdz * dirZ) / dist;
      if (dot < -0.3) continue; // behind us

      // Score: prefer close, forward-facing, higher-degree candidates
      const degreeFactor = graph.degree(candidateId) >= 2 ? 0.3 : 0;
      const score = (1 - dist / maxDist) * 0.4 + Math.max(0, dot) * 0.3 + degreeFactor;

      if (score > bestScore) {
        bestScore = score;
        bestId = candidateId;
      }
    }

    if (bestId === null) continue;

    // Check we can't already reach it in a few hops (avoid short circuits)
    if (bfsReachable(graph, nodeId, bestId, 4)) continue;

    const edgeId = pathfindRoad(graph, nodeId, graph.getNode(bestId).x, graph.getNode(bestId).z, costFn, w, h, cs, occupancy);
    if (edgeId !== null) {
      // Figure out which nucleus owns the neighbor edge
      const incEdges = graph.incidentEdges(nodeId);
      let nucleusId = 0;
      if (incEdges.length > 0) {
        // Infer from the dead-end's edge (nearest nucleus to midpoint)
        const edge = graph.getEdge(incEdges[0]);
        if (edge) {
          const from = graph.getNode(edge.from);
          const to = graph.getNode(edge.to);
          const mx = (from.x + to.x) / 2;
          const mz = (from.z + to.z) / 2;
          // Just use 0 as default — ownership will be assigned by the main loop
        }
      }
      results.push({ edgeId, nucleusId });
      stitchCount++;
    }
  }

  return results;
}

// ============================================================
// Helpers
// ============================================================

function bfsReachable(graph, source, target, maxHops) {
  const visited = new Set([source]);
  let frontier = [source];
  for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
    const next = [];
    for (const id of frontier) {
      for (const neighbor of graph.neighbors(id)) {
        if (neighbor === target) return true;
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
  }
  return false;
}

function getEdgeDirection(graph, edgeId) {
  const edge = graph.getEdge(edgeId);
  if (!edge) return { x: 1, z: 0 };
  const from = graph.getNode(edge.from);
  const to = graph.getNode(edge.to);
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len = Math.sqrt(dx * dx + dz * dz) || 1;
  return { x: dx / len, z: dz / len };
}

function polylineLength(polyline) {
  let len = 0;
  for (let i = 0; i < polyline.length - 1; i++) {
    len += distance2D(polyline[i].x, polyline[i].z, polyline[i + 1].x, polyline[i + 1].z);
  }
  return len;
}

function samplePolylineAt(polyline, totalLen, t) {
  const target = t * totalLen;
  let accum = 0;
  for (let i = 0; i < polyline.length - 1; i++) {
    const segLen = distance2D(polyline[i].x, polyline[i].z, polyline[i + 1].x, polyline[i + 1].z);
    if (accum + segLen >= target) {
      const frac = segLen > 0 ? (target - accum) / segLen : 0;
      return {
        x: polyline[i].x + frac * (polyline[i + 1].x - polyline[i].x),
        z: polyline[i].z + frac * (polyline[i + 1].z - polyline[i].z),
      };
    }
    accum += segLen;
  }
  return polyline[polyline.length - 1];
}

function samplePolylineDir(polyline, totalLen, t) {
  const target = t * totalLen;
  let accum = 0;
  for (let i = 0; i < polyline.length - 1; i++) {
    const dx = polyline[i + 1].x - polyline[i].x;
    const dz = polyline[i + 1].z - polyline[i].z;
    const segLen = Math.sqrt(dx * dx + dz * dz);
    if (accum + segLen >= target || i === polyline.length - 2) {
      const len = segLen || 1;
      return { x: dx / len, z: dz / len };
    }
    accum += segLen;
  }
  return { x: 1, z: 0 };
}
