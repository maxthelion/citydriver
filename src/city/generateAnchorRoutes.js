/**
 * B2. Anchor routes — inherit regional roads scaled to city resolution.
 * Regional roads are mapped directly (no re-pathfinding), smoothed, and
 * clipped at the city boundary. Adds waterfront structural roads.
 */

import { PlanarGraph } from '../core/PlanarGraph.js';
import { Grid2D } from '../core/Grid2D.js';
import { findPath, terrainCostFunction, simplifyPath, smoothPath } from '../core/pathfinding.js';

/**
 * Generate the initial anchor road network by inheriting regional roads.
 *
 * @param {import('../core/LayerStack.js').LayerStack} cityLayers
 * @param {import('../core/rng.js').SeededRandom} rng
 * @returns {PlanarGraph}
 */
export function generateAnchorRoutes(cityLayers, rng) {
  const graph = new PlanarGraph();
  const params = cityLayers.getData('params');
  const elevation = cityLayers.getGrid('elevation');
  const waterMask = cityLayers.getGrid('waterMask');

  if (!elevation || !params) return graph;

  const w = params.width;
  const h = params.height;
  const cs = params.cellSize;
  const seaLevel = params.seaLevel;

  const baseCost = terrainCostFunction(elevation, { waterGrid: waterMask, seaLevel });
  const regionalRoads = cityLayers.getData('regionalRoads') || [];

  // Shared node lookup: regional grid key → graph node ID.
  // Roads sharing a settlement endpoint share the same node.
  const sharedNodes = new Map();

  // Track existing road cells so later roads prefer sharing established routes
  const roadGrid = new Grid2D(w, h, { type: 'uint8' });

  // 1. Inherit each regional road — re-pathfind at city resolution within a corridor
  for (const road of regionalRoads) {
    addRegionalRoad(graph, road, sharedNodes, params, elevation, waterMask, roadGrid);
  }

  // 2. Place seed and connect to nearest road
  const seedX = Math.floor(w / 2) * cs;
  const seedZ = Math.floor(h / 2) * cs;
  connectSeed(graph, seedX, seedZ, baseCost, params);

  // 3. Waterfront road (limited, near center)
  addWaterfrontRoad(graph, cityLayers, baseCost);

  // 4. Fallback: if no regional roads, add 2 simple roads from seed
  if (regionalRoads.length === 0) {
    addFallbackRoads(graph, seedX, seedZ, baseCost, params, rng);
  }

  return graph;
}

/**
 * Add one regional road to the graph. Converts regional path to city coords,
 * clips at boundary, then re-pathfinds at city resolution within a corridor
 * around the regional centerline. This gives terrain-responsive detail while
 * keeping the broad route faithful to the regional model.
 */
function addRegionalRoad(graph, road, sharedNodes, params, elevation, waterMask, roadGrid) {
  const { width: w, height: h, cellSize: cs, regionalCellSize, regionalMinGx, regionalMinGz, seaLevel } = params;
  const rcs = regionalCellSize || 50;
  const maxX = (w - 1) * cs;
  const maxZ = (h - 1) * cs;

  if (!road.path || road.path.length < 2) return;

  // Use raw (unsimplified) path for full terrain-following detail
  const sourcePath = road.rawPath || road.path;

  // Convert regional path to city-local world coords
  const worldPts = sourcePath.map(p => ({
    x: (p.gx - regionalMinGx) * rcs,
    z: (p.gz - regionalMinGz) * rcs,
    key: `${p.gx},${p.gz}`,
  }));

  // Clip to city boundary, interpolating entry/exit crossing points
  const clipped = clipPathToBounds(worldPts, maxX, maxZ);
  if (clipped.length < 2) return;

  const roadWidth = road.hierarchy === 'arterial' ? 12 : 8;
  const hierarchy = road.hierarchy || 'arterial';

  // Build a distance field from the regional centerline for corridor-constrained pathfinding.
  // For each city grid cell, compute min distance to the regional path segments.
  const corridorRadius = 10; // city grid cells (~100m at 10m cellSize)
  const corridorGrid = buildCorridorDistanceGrid(clipped, w, h, cs, corridorRadius);

  // Corridor-constrained cost: normal terrain cost + penalty for distance from centerline
  const corridorCost = (fromGx, fromGz, toGx, toGz) => {
    const dist = corridorGrid.get(toGx, toGz);
    if (dist > corridorRadius) return Infinity; // outside corridor entirely

    // Base terrain cost (use waterPenalty not seaLevel so bridges are possible)
    const dx = toGx - fromGx;
    const dz = toGz - fromGz;
    const baseDist = Math.sqrt(dx * dx + dz * dz);
    const fromH = elevation.get(fromGx, fromGz);
    const toH = elevation.get(toGx, toGz);
    const slope = Math.abs(toH - fromH) / baseDist;
    let c = baseDist + slope * 10;

    if (waterMask && waterMask.get(toGx, toGz) > 0) c += 50;
    if (seaLevel !== null && elevation.get(toGx, toGz) < seaLevel) c += 50;

    // Discount for reusing existing road cells (encourages road sharing)
    if (roadGrid.get(toGx, toGz) > 0) c *= 0.3;

    // Quadratic penalty for straying from centerline
    const t = dist / corridorRadius; // 0 at center, 1 at edge
    c *= 1.0 + t * t * 4.0;

    return c;
  };

  // Convert clipped start/end to grid coords
  const startGx = Math.round(clipped[0].x / cs);
  const startGz = Math.round(clipped[0].z / cs);
  const endGx = Math.round(clipped[clipped.length - 1].x / cs);
  const endGz = Math.round(clipped[clipped.length - 1].z / cs);

  // Clamp to grid bounds
  const clampGx = gx => Math.max(0, Math.min(w - 1, gx));
  const clampGz = gz => Math.max(0, Math.min(h - 1, gz));

  const result = findPath(
    clampGx(startGx), clampGz(startGz),
    clampGx(endGx), clampGz(endGz),
    w, h, corridorCost,
  );

  if (!result) {
    // Fallback: use the regional path directly if corridor pathfinding fails
    addRegionalRoadDirect(graph, road, clipped, sharedNodes, roadWidth, hierarchy);
    return;
  }

  // Stamp raw path cells onto roadGrid so later roads prefer sharing this route
  for (const p of result.path) {
    roadGrid.set(p.gx, p.gz, 1);
  }

  // Simplify and smooth the city-resolution path
  const simplified = simplifyPath(result.path, 1.5);
  const smooth = smoothPath(simplified, cs);
  if (smooth.length < 2) return;

  // Place nodes at start and end; everything else is polyline intermediates
  const startPos = { x: smooth[0].x, z: smooth[0].z, key: clipped[0].key };
  const endPos = { x: smooth[smooth.length - 1].x, z: smooth[smooth.length - 1].z, key: clipped[clipped.length - 1].key };

  const startNode = getOrCreateNode(graph, sharedNodes, startPos);
  const endNode = getOrCreateNode(graph, sharedNodes, endPos);
  if (startNode === endNode) return;

  graph.addEdge(startNode, endNode, {
    points: smooth.slice(1, -1),
    width: roadWidth,
    hierarchy,
  });
}

/**
 * Fallback: add regional road directly without re-pathfinding (used when corridor
 * pathfinding fails, e.g. if start/end are in water at city resolution).
 */
function addRegionalRoadDirect(graph, road, clipped, sharedNodes, roadWidth, hierarchy) {
  const startNode = getOrCreateNode(graph, sharedNodes, clipped[0]);
  const endNode = getOrCreateNode(graph, sharedNodes, clipped[clipped.length - 1]);
  if (startNode === endNode) return;

  const intermediates = [];
  for (let i = 1; i < clipped.length - 1; i++) {
    intermediates.push({ x: clipped[i].x, z: clipped[i].z });
  }

  graph.addEdge(startNode, endNode, {
    points: intermediates,
    width: roadWidth,
    hierarchy,
  });
}

/**
 * Build a grid where each cell stores its distance (in grid cells) to the nearest
 * point on the regional centerline. Only fills cells within corridorRadius.
 */
function buildCorridorDistanceGrid(clippedWorldPts, gridW, gridH, cs, corridorRadius) {
  const grid = new Grid2D(gridW, gridH, { type: 'float32', fill: corridorRadius + 1 });

  // Rasterize centerline segments and BFS outward
  const queue = [];

  for (let i = 0; i < clippedWorldPts.length - 1; i++) {
    const ax = clippedWorldPts[i].x / cs;
    const az = clippedWorldPts[i].z / cs;
    const bx = clippedWorldPts[i + 1].x / cs;
    const bz = clippedWorldPts[i + 1].z / cs;

    // Walk along the segment, marking cells at distance 0
    const segLen = Math.sqrt((bx - ax) ** 2 + (bz - az) ** 2);
    const steps = Math.max(1, Math.ceil(segLen));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const gx = Math.round(ax + (bx - ax) * t);
      const gz = Math.round(az + (bz - az) * t);
      if (gx < 0 || gx >= gridW || gz < 0 || gz >= gridH) continue;
      if (grid.get(gx, gz) === 0) continue; // already marked
      grid.set(gx, gz, 0);
      queue.push(gx, gz);
    }
  }

  // BFS to fill distance field up to corridorRadius
  let head = 0;
  while (head < queue.length) {
    const cx = queue[head++];
    const cz = queue[head++];
    const cd = grid.get(cx, cz);
    if (cd >= corridorRadius) continue;

    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nx >= gridW || nz < 0 || nz >= gridH) continue;
        const nd = cd + (dx !== 0 && dz !== 0 ? 1.414 : 1.0);
        if (nd < grid.get(nx, nz)) {
          grid.set(nx, nz, nd);
          queue.push(nx, nz);
        }
      }
    }
  }

  return grid;
}

function getOrCreateNode(graph, sharedNodes, pos) {
  if (sharedNodes.has(pos.key)) {
    return sharedNodes.get(pos.key);
  }
  const id = graph.addNode(pos.x, pos.z, { type: 'inherited' });
  sharedNodes.set(pos.key, id);
  return id;
}

/**
 * Clip a world-coord path to the city rectangle [0,maxX] × [0,maxZ].
 * Interpolates crossing points where the path enters/exits the boundary.
 */
function clipPathToBounds(worldPts, maxX, maxZ) {
  const result = [];
  const isInside = p => p.x >= 0 && p.x <= maxX && p.z >= 0 && p.z <= maxZ;

  for (let i = 0; i < worldPts.length; i++) {
    const cur = worldPts[i];
    const curIn = isInside(cur);

    if (i > 0) {
      const prev = worldPts[i - 1];
      const prevIn = isInside(prev);

      if (!prevIn && curIn) {
        const entry = interpolateBoundaryCrossing(prev, cur, maxX, maxZ);
        if (entry) {
          entry.key = `boundary_${Math.round(entry.x)}_${Math.round(entry.z)}`;
          result.push(entry);
        }
      }
      if (prevIn && !curIn) {
        const exit = interpolateBoundaryCrossing(cur, prev, maxX, maxZ);
        if (exit) {
          exit.key = `boundary_${Math.round(exit.x)}_${Math.round(exit.z)}`;
          result.push(exit);
        }
        break; // Road has left the city
      }
    }

    if (curIn) {
      result.push(cur);
    }
  }

  return result;
}

/**
 * Find the point where a line segment from outside to inside crosses the city boundary.
 * Uses Liang-Barsky line clipping. Returns {x, z} on the boundary.
 */
function interpolateBoundaryCrossing(outside, inside, maxX, maxZ) {
  const dx = inside.x - outside.x;
  const dz = inside.z - outside.z;
  let tMin = 0;
  let tMax = 1;

  const clips = [
    { p: -dx, q: outside.x },
    { p: dx, q: maxX - outside.x },
    { p: -dz, q: outside.z },
    { p: dz, q: maxZ - outside.z },
  ];

  for (const { p, q } of clips) {
    if (Math.abs(p) < 1e-10) continue;
    const t = q / p;
    if (p < 0) {
      if (t > tMin) tMin = t;
    } else {
      if (t < tMax) tMax = t;
    }
  }

  if (tMin > tMax) return null;

  return {
    x: Math.max(0, Math.min(maxX, outside.x + tMin * dx)),
    z: Math.max(0, Math.min(maxZ, outside.z + tMin * dz)),
  };
}

/**
 * Spiral-search outward from a grid cell until a land cell is found.
 * Returns {gx, gz} or null if no land within radius 15.
 */
function snapToLand(gx, gz, elevationGrid, waterMask, seaLevel, w, h) {
  for (let r = 1; r <= 15; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue; // perimeter only
        const nx = gx + dx;
        const nz = gz + dz;
        if (nx < 0 || nx >= w || nz < 0 || nz >= h) continue;
        const onLand = elevationGrid.get(nx, nz) >= seaLevel &&
                       !(waterMask && waterMask.get(nx, nz) > 0);
        if (onLand) return { gx: nx, gz: nz };
      }
    }
  }
  return null;
}

/**
 * Connect the city seed to the nearest inherited road.
 */
function connectSeed(graph, seedX, seedZ, baseCost, params) {
  const { width, height, cellSize: cs } = params;

  if (graph.nodes.size === 0) {
    graph.addNode(seedX, seedZ, { type: 'seed' });
    return;
  }

  const nearest = graph.nearestNode(seedX, seedZ);
  if (!nearest) {
    graph.addNode(seedX, seedZ, { type: 'seed' });
    return;
  }

  // If seed is already very close to an inherited road node, snap to it
  if (nearest.dist < cs * 5) {
    const node = graph.getNode(nearest.id);
    node.attrs.type = 'seed';
    return;
  }

  // Otherwise, pathfind a spur from seed to nearest node
  const seedNode = graph.addNode(seedX, seedZ, { type: 'seed' });
  const targetNode = graph.getNode(nearest.id);

  const seedGx = Math.round(seedX / cs);
  const seedGz = Math.round(seedZ / cs);
  const targetGx = Math.round(targetNode.x / cs);
  const targetGz = Math.round(targetNode.z / cs);

  const result = findPath(seedGx, seedGz, targetGx, targetGz, width, height, baseCost);
  if (result) {
    const simplified = simplifyPath(result.path, 1.0);
    const smooth = smoothPath(simplified, cs);
    graph.addEdge(seedNode, nearest.id, {
      points: smooth.slice(1, -1),
      width: 10,
      hierarchy: 'arterial',
    });
  }
}

/**
 * Add a short waterfront promenade road near the city center (if coastal).
 */
function addWaterfrontRoad(graph, cityLayers, baseCost) {
  const params = cityLayers.getData('params');
  const elevation = cityLayers.getGrid('elevation');
  const waterMask = cityLayers.getGrid('waterMask');
  if (!elevation || !params) return;

  const { width, height, cellSize: cs, seaLevel } = params;
  const centerX = Math.floor(width / 2);
  const centerZ = Math.floor(height / 2);
  const maxRadius = Math.floor(Math.min(width, height) * 0.25);

  // Find waterfront cells near the city center
  const waterfrontCells = [];
  for (let gz = centerZ - maxRadius; gz <= centerZ + maxRadius; gz++) {
    for (let gx = centerX - maxRadius; gx <= centerX + maxRadius; gx++) {
      if (gx < 1 || gx >= width - 1 || gz < 1 || gz >= height - 1) continue;
      if (elevation.get(gx, gz) < seaLevel) continue;
      if (waterMask && waterMask.get(gx, gz) > 0) continue;

      let adjacentWater = false;
      for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = gx + dx;
        const nz = gz + dz;
        if (elevation.get(nx, nz) < seaLevel ||
            (waterMask && waterMask.get(nx, nz) > 0)) {
          adjacentWater = true;
          break;
        }
      }
      if (adjacentWater) waterfrontCells.push({ gx, gz });
    }
  }

  if (waterfrontCells.length < 4) return;

  // Pick two endpoints roughly at opposite ends of the waterfront
  waterfrontCells.sort((a, b) => {
    const angleA = Math.atan2(a.gz - centerZ, a.gx - centerX);
    const angleB = Math.atan2(b.gz - centerZ, b.gx - centerX);
    return angleA - angleB;
  });

  const startCell = waterfrontCells[0];
  const endCell = waterfrontCells[Math.floor(waterfrontCells.length / 2)];

  const waterfrontCost = createWaterfrontCostFunction(baseCost, elevation, waterMask, seaLevel, width, height);
  const result = findPath(startCell.gx, startCell.gz, endCell.gx, endCell.gz, width, height, waterfrontCost);
  if (!result) return;

  const simplified = simplifyPath(result.path, 2.0);
  const smooth = smoothPath(simplified, cs);
  if (smooth.length < 2) return;

  // Add as a single edge with polyline intermediates
  const startNode = graph.addNode(smooth[0].x, smooth[0].z, { type: 'waterfront' });
  const endNode = graph.addNode(smooth[smooth.length - 1].x, smooth[smooth.length - 1].z, { type: 'waterfront' });
  graph.addEdge(startNode, endNode, {
    points: smooth.slice(1, -1),
    width: 8,
    hierarchy: 'structural',
  });

  // Connect waterfront endpoints to nearest road nodes via pathfinding
  for (const wfNodeId of [startNode, endNode]) {
    const wfPos = graph.getNode(wfNodeId);
    let nearestId = null;
    let nearestDist = Infinity;
    for (const [id, node] of graph.nodes) {
      if (id === startNode || id === endNode) continue;
      const dx = node.x - wfPos.x;
      const dz = node.z - wfPos.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < nearestDist) { nearestDist = dist; nearestId = id; }
    }
    if (nearestId !== null && nearestDist < cs * 30) {
      const target = graph.getNode(nearestId);
      const wGx = Math.round(wfPos.x / cs);
      const wGz = Math.round(wfPos.z / cs);
      const tGx = Math.round(target.x / cs);
      const tGz = Math.round(target.z / cs);
      const connResult = findPath(wGx, wGz, tGx, tGz, width, height, baseCost);
      if (connResult) {
        const connSmooth = smoothPath(simplifyPath(connResult.path, 1.0), cs);
        graph.addEdge(wfNodeId, nearestId, {
          points: connSmooth.slice(1, -1),
          width: 8,
          hierarchy: 'structural',
        });
      }
    }
  }
}

function createWaterfrontCostFunction(baseCost, elevation, waterMask, seaLevel, w, h) {
  return function waterfrontCost(fromGx, fromGz, toGx, toGz) {
    let c = baseCost(fromGx, fromGz, toGx, toGz);
    if (!isFinite(c)) return c;

    let minWaterDist = Infinity;
    const searchRadius = 4;
    for (let dz = -searchRadius; dz <= searchRadius; dz++) {
      for (let dx = -searchRadius; dx <= searchRadius; dx++) {
        const nx = toGx + dx;
        const nz = toGz + dz;
        if (nx < 0 || nx >= w || nz < 0 || nz >= h) continue;
        if (elevation.get(nx, nz) < seaLevel ||
            (waterMask && waterMask.get(nx, nz) > 0)) {
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist < minWaterDist) minWaterDist = dist;
        }
      }
    }

    if (minWaterDist <= searchRadius) {
      c *= 0.3 + (minWaterDist / searchRadius) * 1.0;
    } else {
      c *= 3.0;
    }
    return c;
  };
}

function addFallbackRoads(graph, seedX, seedZ, baseCost, params, rng) {
  const { width, height, cellSize: cs } = params;
  const margin = cs * 5;

  const allDirs = [
    { x: seedX, z: margin, dir: 'north' },
    { x: seedX, z: (height - 5) * cs, dir: 'south' },
    { x: margin, z: seedZ, dir: 'west' },
    { x: (width - 5) * cs, z: seedZ, dir: 'east' },
  ];

  for (let i = allDirs.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [allDirs[i], allDirs[j]] = [allDirs[j], allDirs[i]];
  }
  const chosen = allDirs.slice(0, 2);

  let seedNode = null;
  for (const [id, node] of graph.nodes) {
    if (node.attrs.type === 'seed') { seedNode = id; break; }
  }
  if (seedNode === null) {
    seedNode = graph.addNode(seedX, seedZ, { type: 'seed' });
  }

  const seedGx = Math.round(seedX / cs);
  const seedGz = Math.round(seedZ / cs);

  for (const d of chosen) {
    const dGx = Math.round(d.x / cs);
    const dGz = Math.round(d.z / cs);
    const result = findPath(seedGx, seedGz, dGx, dGz, width, height, baseCost);
    if (result) {
      const simplified = simplifyPath(result.path, 1.0);
      const smooth = smoothPath(simplified, cs);
      const node = graph.addNode(smooth[smooth.length - 1].x, smooth[smooth.length - 1].z, {
        type: 'entry',
        direction: d.dir,
      });
      graph.addEdge(seedNode, node, {
        points: smooth.slice(1, -1),
        width: 12,
        hierarchy: 'arterial',
      });
    }
  }
}
