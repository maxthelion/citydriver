/**
 * B6. Collector roads — medium-width roads subdividing districts.
 * Organic curves in hilly areas, grid patterns on flat terrain.
 * Uses A* pathfinding with road-proximity avoidance for terrain-following roads.
 */

import { distance2D } from '../core/math.js';
import { Grid2D } from '../core/Grid2D.js';
import { findPath, terrainCostFunction, simplifyPath, smoothPath } from '../core/pathfinding.js';

/**
 * Add collector roads to the road graph.
 *
 * @param {import('../core/LayerStack.js').LayerStack} cityLayers
 * @param {import('../core/PlanarGraph.js').PlanarGraph} graph
 * @param {import('../core/rng.js').SeededRandom} rng
 */
export function generateCollectors(cityLayers, graph, rng) {
  const params = cityLayers.getData('params');
  const density = cityLayers.getGrid('density');
  const elevation = cityLayers.getGrid('elevation');
  const waterMask = cityLayers.getGrid('waterMask');

  if (!params || !density || !elevation) return;

  const w = params.width;
  const h = params.height;
  const cs = params.cellSize;

  // Find destination points: density peaks + arterial edge midpoints
  const destinations = findCollectorDestinations(graph, density, w, h, cs, rng);

  if (destinations.length < 2) return;

  // Budget cap: limit collector edges to 1.5x existing road count
  const existingEdges = graph.edges.size;
  const maxCollectorEdges = Math.max(5, Math.floor(existingEdges * 1.5));
  let collectorEdgesAdded = 0;

  // Build proximity grid of existing roads for spacing enforcement
  const roadProximity = buildRoadProximityGrid(graph, w, h, cs);

  // Cost function: terrain + avoid existing roads + density preference
  const baseCost = terrainCostFunction(elevation, { waterGrid: waterMask });
  const costFn = (fromGx, fromGz, toGx, toGz) => {
    let c = baseCost(fromGx, fromGz, toGx, toGz);
    // Penalize being too close to existing roads (want spacing)
    const proximity = roadProximity.get(toGx, toGz);
    if (proximity > 0.5) c *= 1.5; // Near existing road
    // Density: only route through areas with some density
    const d = density.get(toGx, toGz);
    if (d < 0.1) c *= 3; // Avoid empty areas
    return c;
  };

  // Build and sort candidate pairs by distance (shortest first)
  const pairs = [];
  for (let i = 0; i < destinations.length; i++) {
    for (let j = i + 1; j < destinations.length; j++) {
      const a = destinations[i];
      const b = destinations[j];
      const dist = distance2D(a.x, a.z, b.x, b.z);
      if (dist < cs * 8 || dist > cs * 30) continue;
      pairs.push({ a, b, dist });
    }
  }
  pairs.sort((a, b) => a.dist - b.dist);

  for (const { a, b } of pairs) {
    if (collectorEdgesAdded >= maxCollectorEdges) break;

    const aGx = Math.round(a.x / cs);
    const aGz = Math.round(a.z / cs);
    const bGx = Math.round(b.x / cs);
    const bGz = Math.round(b.z / cs);

    const result = findPath(aGx, aGz, bGx, bGz, w, h, costFn);
    if (!result) continue;

    const simplified = simplifyPath(result.path, 1.5);
    const smooth = smoothPath(simplified, cs);

    let prevNode = findOrCreateNode(graph, a.x, a.z, cs * 2);
    for (let k = 1; k < smooth.length; k++) {
      if (k < smooth.length - 1 && distance2D(smooth[k].x, smooth[k].z, smooth[k - 1].x, smooth[k - 1].z) < cs * 5) continue;
      const node = k === smooth.length - 1
        ? findOrCreateNode(graph, b.x, b.z, cs * 2)
        : graph.addNode(smooth[k].x, smooth[k].z, { type: 'collector' });
      graph.addEdge(prevNode, node, { width: 12, hierarchy: 'collector' });
      collectorEdgesAdded++;
      prevNode = node;
    }
  }
}

/**
 * Find destination points for collector roads: density peaks and arterial edge midpoints.
 */
function findCollectorDestinations(graph, density, w, h, cs, rng) {
  const destinations = [];

  // 1. Density peaks — local maxima sampled at a coarse grid
  const peakStep = 8;
  for (let gz = peakStep; gz < h - peakStep; gz += peakStep) {
    for (let gx = peakStep; gx < w - peakStep; gx += peakStep) {
      const d = density.get(gx, gz);
      if (d < 0.2) continue;

      // Check if this is a local peak
      let isPeak = true;
      for (const [dx, dz] of [[-peakStep, 0], [peakStep, 0], [0, -peakStep], [0, peakStep]]) {
        if (density.get(gx + dx, gz + dz) > d) {
          isPeak = false;
          break;
        }
      }

      if (isPeak) {
        destinations.push({
          x: gx * cs + rng.range(-cs, cs),
          z: gz * cs + rng.range(-cs, cs),
        });
      }
    }
  }

  // 2. Arterial edge midpoints
  for (const [, edge] of graph.edges) {
    if (edge.hierarchy !== 'arterial') continue;
    const fromNode = graph.getNode(edge.from);
    const toNode = graph.getNode(edge.to);
    if (!fromNode || !toNode) continue;

    destinations.push({
      x: (fromNode.x + toNode.x) / 2,
      z: (fromNode.z + toNode.z) / 2,
    });
  }

  return destinations;
}

/**
 * Build a Grid2D where cells near existing road nodes are marked (1 = near road, 0 = not).
 */
function buildRoadProximityGrid(graph, w, h, cs) {
  const grid = new Grid2D(w, h);
  const radius = 3; // cells

  for (const [, node] of graph.nodes) {
    const gx = Math.round(node.x / cs);
    const gz = Math.round(node.z / cs);

    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const nx = gx + dx;
        const nz = gz + dz;
        if (nx >= 0 && nx < w && nz >= 0 && nz < h) {
          grid.set(nx, nz, 1);
        }
      }
    }
  }

  return grid;
}

/**
 * Find the nearest existing node within threshold distance, or create a new one.
 */
function findOrCreateNode(graph, x, z, threshold) {
  const nearest = graph.nearestNode(x, z);
  if (nearest && nearest.dist < threshold) {
    return nearest.id;
  }
  return graph.addNode(x, z, { type: 'collector' });
}
