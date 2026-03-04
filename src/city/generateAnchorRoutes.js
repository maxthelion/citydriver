/**
 * B2. Anchor routes — the first roads placed in the city.
 * Waterfront routes, natural feature roads, connections to regional entry points.
 * Uses PlanarGraph. Roads follow terrain via A* pathfinding.
 */

import { PlanarGraph } from '../core/PlanarGraph.js';
import { findPath, terrainCostFunction, simplifyPath, smoothPath } from '../core/pathfinding.js';

/**
 * Spiral-search outward from a proposed point until a land cell is found.
 * Returns adjusted {x, z} in world coords.
 */
function snapToLand(x, z, elevation, seaLevel, cs, w, h) {
  let gx = Math.round(x / cs);
  let gz = Math.round(z / cs);
  if (gx >= 0 && gx < w && gz >= 0 && gz < h && elevation.get(gx, gz) >= seaLevel) {
    return { x, z }; // already on land
  }
  for (let r = 1; r < Math.max(w, h); r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue; // only perimeter
        const nx = gx + dx;
        const nz = gz + dz;
        if (nx < 0 || nx >= w || nz < 0 || nz >= h) continue;
        if (elevation.get(nx, nz) >= seaLevel) {
          return { x: nx * cs, z: nz * cs };
        }
      }
    }
  }
  return { x, z }; // fallback
}

/**
 * Generate the initial anchor road network.
 *
 * @param {import('../core/LayerStack.js').LayerStack} cityLayers
 * @param {import('../core/rng.js').SeededRandom} rng
 * @returns {PlanarGraph}
 */
export function generateAnchorRoutes(cityLayers, rng) {
  const graph = new PlanarGraph();
  const params = cityLayers.getData('params');
  const settlement = cityLayers.getData('settlement');
  const elevation = cityLayers.getGrid('elevation');
  const waterMask = cityLayers.getGrid('waterMask');

  if (!elevation || !params) return graph;

  const w = params.width;
  const h = params.height;
  const cs = params.cellSize;
  const seaLevel = params.seaLevel;

  // City seed point (center of settlement in city grid coords)
  const seedGx = Math.floor(w / 2);
  const seedGz = Math.floor(h / 2);
  const seedX = seedGx * cs;
  const seedZ = seedGz * cs;

  // Add seed node
  const seedNode = graph.addNode(seedX, seedZ, { type: 'seed' });

  // Base terrain cost function
  const baseCost = terrainCostFunction(elevation, { waterGrid: waterMask, seaLevel });

  // Regional road entry points (edges of the city area where regional roads enter)
  const regionalRoads = cityLayers.getData('regionalRoads') || [];
  const entryPoints = findEntryPoints(regionalRoads, params);

  // Connect entry points to seed via pathfinding
  for (const entry of entryPoints) {
    const snapped = snapToLand(entry.x, entry.z, elevation, seaLevel, cs, w, h);
    entry.x = snapped.x;
    entry.z = snapped.z;
    const entryNode = graph.addNode(entry.x, entry.z, { type: 'entry', direction: entry.direction });
    const entryGx = Math.round(entry.x / cs);
    const entryGz = Math.round(entry.z / cs);

    const result = findPath(seedGx, seedGz, entryGx, entryGz, w, h, baseCost);
    if (result) {
      const simplified = simplifyPath(result.path, 1.0);
      const smooth = smoothPath(simplified, cs);
      // smooth gives [{x,z}...] in world coords; remove first and last (they're the node positions)
      const intermediates = smooth.slice(1, -1);
      graph.addEdge(seedNode, entryNode, { points: intermediates, width: 12, hierarchy: 'arterial' });
    } else {
      // Fallback: straight line
      graph.addEdge(seedNode, entryNode, { width: 12, hierarchy: 'arterial' });
    }
  }

  // If no entry points, create cardinal connections to edges
  if (entryPoints.length === 0) {
    const margin = cs * 5;
    const directions = [
      { x: seedX, z: margin, dir: 'north' },
      { x: seedX, z: (h - 5) * cs, dir: 'south' },
      { x: margin, z: seedZ, dir: 'west' },
      { x: (w - 5) * cs, z: seedZ, dir: 'east' },
    ];

    for (const d of directions) {
      const snapped = snapToLand(d.x, d.z, elevation, seaLevel, cs, w, h);
      d.x = snapped.x;
      d.z = snapped.z;
      if (rng.next() > 0.3) { // Not all directions get roads
        const node = graph.addNode(d.x, d.z, { type: 'entry', direction: d.dir });
        const dGx = Math.round(d.x / cs);
        const dGz = Math.round(d.z / cs);

        const result = findPath(seedGx, seedGz, dGx, dGz, w, h, baseCost);
        if (result) {
          const simplified = simplifyPath(result.path, 1.0);
          const smooth = smoothPath(simplified, cs);
          const intermediates = smooth.slice(1, -1);
          graph.addEdge(seedNode, node, { points: intermediates, width: 12, hierarchy: 'arterial' });
        } else {
          // Fallback: straight line
          graph.addEdge(seedNode, node, { width: 12, hierarchy: 'arterial' });
        }
      }
    }
  }

  // Waterfront route: if near coast/river, add a road along the waterfront
  // Use pathfinding with a cost function that penalizes distance from water
  const waterfrontEndpoints = findWaterfrontEndpoints(elevation, waterMask, seaLevel, w, h, cs);
  if (waterfrontEndpoints.length >= 2) {
    // Create a waterfront cost function: terrain cost with water-proximity bonus
    const waterfrontCost = createWaterfrontCostFunction(elevation, waterMask, seaLevel, w, h);

    // Pathfind along the waterfront between endpoint pairs
    const startPt = waterfrontEndpoints[0];
    const endPt = waterfrontEndpoints[waterfrontEndpoints.length - 1];

    const startGx = Math.round(startPt.x / cs);
    const startGz = Math.round(startPt.z / cs);
    const endGx = Math.round(endPt.x / cs);
    const endGz = Math.round(endPt.z / cs);

    const result = findPath(startGx, startGz, endGx, endGz, w, h, waterfrontCost);
    if (result) {
      const simplified = simplifyPath(result.path, 2.0);
      const smooth = smoothPath(simplified, cs);

      // Place waterfront nodes along the smoothed path, spaced at ~10 cells
      const segLen = cs * 10;
      let prevNode = graph.addNode(smooth[0].x, smooth[0].z, { type: 'waterfront' });

      // Connect start to nearest existing node
      const nearStart = graph.nearestNode(smooth[0].x, smooth[0].z);
      if (nearStart && nearStart.id !== prevNode) {
        graph.addEdge(prevNode, nearStart.id, { width: 8, hierarchy: 'collector' });
      }

      let accumulated = 0;
      for (let i = 1; i < smooth.length; i++) {
        const dx = smooth[i].x - smooth[i - 1].x;
        const dz = smooth[i].z - smooth[i - 1].z;
        accumulated += Math.sqrt(dx * dx + dz * dz);

        if (accumulated >= segLen || i === smooth.length - 1) {
          const node = graph.addNode(smooth[i].x, smooth[i].z, { type: 'waterfront' });
          graph.addEdge(prevNode, node, { width: 8, hierarchy: 'collector' });
          prevNode = node;
          accumulated = 0;
        }
      }
    } else {
      // Fallback: use the old simple waterfront path
      addFallbackWaterfrontPath(graph, waterfrontEndpoints);
    }
  }

  return graph;
}

function findEntryPoints(regionalRoads, params) {
  const entries = [];
  const w = params.width;
  const h = params.height;
  const cs = params.cellSize;
  const margin = 3;

  for (const road of regionalRoads) {
    if (!road.path) continue;
    for (const p of road.path) {
      const gx = p.gx - (params.regionalMinGx || 0);
      const gz = p.gz - (params.regionalMinGz || 0);

      if (gx <= margin || gx >= w - margin || gz <= margin || gz >= h - margin) {
        let direction = 'unknown';
        if (gz <= margin) direction = 'north';
        else if (gz >= h - margin) direction = 'south';
        else if (gx <= margin) direction = 'west';
        else direction = 'east';

        entries.push({
          x: Math.max(cs, Math.min((w - 1) * cs, gx * cs)),
          z: Math.max(cs, Math.min((h - 1) * cs, gz * cs)),
          direction,
        });
        break; // One entry per road
      }
    }
  }

  return entries;
}

/**
 * Find start and end points along the waterfront for pathfinding.
 */
function findWaterfrontEndpoints(elevation, waterMask, seaLevel, w, h, cs) {
  const points = [];
  const step = 5;

  for (let gz = step; gz < h - step; gz += step) {
    for (let gx = step; gx < w - step; gx += step) {
      if (elevation.get(gx, gz) < seaLevel) continue;
      if (waterMask && waterMask.get(gx, gz) > 0) continue;

      // Check if adjacent to water
      let adjacentWater = false;
      for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        if (elevation.get(gx + dx, gz + dz) < seaLevel ||
            (waterMask && waterMask.get(gx + dx, gz + dz) > 0)) {
          adjacentWater = true;
          break;
        }
      }

      if (adjacentWater) {
        points.push({ x: gx * cs, z: gz * cs });
      }
    }
  }

  // Sort by position to identify endpoints
  if (points.length > 1) {
    points.sort((a, b) => a.z - b.z || a.x - b.x);
  }

  // Return just first and last for pathfinding endpoints
  if (points.length > 2) {
    return [points[0], points[points.length - 1]];
  }
  return points;
}

/**
 * Create a cost function that prefers cells near water (for waterfront roads).
 * Blends terrain cost with a water-proximity bonus.
 */
function createWaterfrontCostFunction(elevation, waterMask, seaLevel, w, h) {
  const baseCost = terrainCostFunction(elevation, { waterGrid: waterMask, waterPenalty: 200, seaLevel });

  return function waterfrontCost(fromGx, fromGz, toGx, toGz) {
    let c = baseCost(fromGx, fromGz, toGx, toGz);

    // Check distance to water in a small radius — prefer being close
    let minWaterDist = Infinity;
    const searchRadius = 5;
    for (let dz = -searchRadius; dz <= searchRadius; dz++) {
      for (let dx = -searchRadius; dx <= searchRadius; dx++) {
        const nx = toGx + dx;
        const nz = toGz + dz;
        if (nx < 0 || nx >= w || nz < 0 || nz >= h) continue;
        const isWater = elevation.get(nx, nz) < seaLevel ||
                        (waterMask && waterMask.get(nx, nz) > 0);
        if (isWater) {
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist < minWaterDist) minWaterDist = dist;
        }
      }
    }

    // Bonus for being near water (lower cost), penalty for being far from water
    if (minWaterDist <= searchRadius) {
      // Scale: distance 1 = 0.3x cost, distance 5 = 1.5x cost
      c *= 0.3 + (minWaterDist / searchRadius) * 1.2;
    } else {
      c *= 3.0; // Far from water = expensive
    }

    return c;
  };
}

/**
 * Fallback: add waterfront path using simple point list (no pathfinding).
 */
function addFallbackWaterfrontPath(graph, points) {
  if (points.length < 2) return;
  let prevNode = graph.addNode(points[0].x, points[0].z, { type: 'waterfront' });

  const nearStart = graph.nearestNode(points[0].x, points[0].z);
  if (nearStart && nearStart.id !== prevNode) {
    graph.addEdge(prevNode, nearStart.id, { width: 8, hierarchy: 'collector' });
  }

  for (let i = 1; i < points.length; i++) {
    const node = graph.addNode(points[i].x, points[i].z, { type: 'waterfront' });
    graph.addEdge(prevNode, node, { width: 8, hierarchy: 'collector' });
    prevNode = node;
  }
}
