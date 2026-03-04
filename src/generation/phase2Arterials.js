/**
 * Phase 2: Primary Network — Anchor Routes & Arterials
 *
 * Lays down the major routes that everything else hangs off:
 *   - City seed at the highest-scoring anchor point
 *   - Entry roads connected to seed via A*
 *   - Waterfront routes parallel to river/coastline
 *   - Cross-links between arterial pairs
 *   - Width assignment based on hierarchy
 *   - Bridge detection at water crossings
 *   - Intersection detection at road crossings
 */

import { findPath, terrainCostFunction, simplifyPath, smoothPath } from '../core/pathfinding.js';
import { distance2D, clamp, lerp, segmentsIntersect, pointToSegmentDist } from '../core/math.js';
import { newNodeId, newEdgeId, nearestNode, snapEndpointsToNetwork } from './graph.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Road width ranges by hierarchy */
const WIDTH = {
  primary: { min: 14, max: 20 },
  secondary: { min: 10, max: 14 },
};

/** Distance from waterfront for parallel road */
const WATERFRONT_OFFSET = 30;

/** Maximum distance between arterials before adding cross-links */
const CROSSLINK_MAX_DIST_FACTOR = 0.6; // fraction of world extent

// ---------------------------------------------------------------------------
// Bridge detection (ported from primaryRoads.js)
// ---------------------------------------------------------------------------

/**
 * Detect if a road path crosses water, and generate bridge data.
 *
 * @param {Array<{gx: number, gz: number}>} gridPath
 * @param {Set<number>} waterCells
 * @param {number} gridWidth
 * @param {number} cellSize
 * @param {number} edgeId
 * @param {number} width
 * @param {Object} heightmap
 * @returns {Array<Object>} bridges
 */
function detectBridges(gridPath, waterCells, gridWidth, cellSize, edgeId, width, heightmap) {
  const bridges = [];
  let inWater = false;
  let waterStart = null;

  for (let i = 0; i < gridPath.length; i++) {
    const { gx, gz } = gridPath[i];
    const key = gz * gridWidth + gx;
    const isWater = waterCells.has(key);

    if (isWater && !inWater) {
      inWater = true;
      waterStart = i > 0 ? i - 1 : i;
    } else if (!isWater && inWater) {
      inWater = false;
      const waterEnd = i;

      const startPt = gridPath[waterStart];
      const endPt = gridPath[waterEnd];

      const sx = startPt.gx * cellSize;
      const sz = startPt.gz * cellSize;
      const ex = endPt.gx * cellSize;
      const ez = endPt.gz * cellSize;

      const startH = heightmap.get(startPt.gx, startPt.gz);
      const endH = heightmap.get(endPt.gx, endPt.gz);
      const deckHeight = Math.max(startH, endH) + 2;

      bridges.push({
        edgeId,
        startPoint: { x: sx, z: sz },
        endPoint: { x: ex, z: ez },
        deckHeight,
        width,
      });
    }
  }

  // Handle case where path ends in water
  if (inWater && waterStart !== null) {
    const startPt = gridPath[waterStart];
    const endPt = gridPath[gridPath.length - 1];
    const sx = startPt.gx * cellSize;
    const sz = startPt.gz * cellSize;
    const ex = endPt.gx * cellSize;
    const ez = endPt.gz * cellSize;
    const startH = heightmap.get(startPt.gx, startPt.gz);
    const endH = heightmap.get(endPt.gx, endPt.gz);
    const deckHeight = Math.max(startH, endH) + 2;

    bridges.push({
      edgeId,
      startPoint: { x: sx, z: sz },
      endPoint: { x: ex, z: ez },
      deckHeight,
      width,
    });
  }

  return bridges;
}

// ---------------------------------------------------------------------------
// City seed placement
// ---------------------------------------------------------------------------

/**
 * Choose the city seed point. Uses the highest-scoring anchor point,
 * falling back to the cityContext center.
 *
 * @param {Array} anchorPoints
 * @param {Object} cityContext
 * @param {number} cellSize
 * @param {number} gridWidth
 * @returns {{x: number, z: number}}
 */
function chooseCitySeed(anchorPoints, cityContext, cellSize, gridWidth) {
  // Default: city center from regional data
  const centerLocal = {
    x: cityContext.center.x - cityContext.cityBounds.minX,
    z: cityContext.center.z - cityContext.cityBounds.minZ,
  };

  if (!anchorPoints || anchorPoints.length === 0) {
    return centerLocal;
  }

  // Find highest-scoring anchor, preferring river_crossing and harbor
  let bestAnchor = null;
  let bestScore = -Infinity;
  for (const a of anchorPoints) {
    if (a.score > bestScore) {
      bestScore = a.score;
      bestAnchor = a;
    }
  }

  // Only use anchor if it scores meaningfully better than nothing
  if (bestAnchor && bestScore > 1.0) {
    return { x: bestAnchor.x, z: bestAnchor.z };
  }

  return centerLocal;
}

// ---------------------------------------------------------------------------
// Waterfront route generation
// ---------------------------------------------------------------------------

/**
 * Generate a road roughly parallel to a waterway, offset by a buffer distance.
 * Returns a simplified polyline following the river/coastline.
 *
 * @param {Array<{x: number, z: number}>} centerline - river centerline or shoreline points
 * @param {number} offset - offset distance from centerline
 * @param {string} side - 'left' or 'right' (perpendicular direction)
 * @param {Heightmap} heightmap
 * @param {Set<number>} waterCells
 * @returns {{x: number, z: number}[]} offset polyline
 */
function offsetPolyline(centerline, offset, heightmap, waterCells) {
  if (centerline.length < 2) return [];

  const gridWidth = heightmap.width;
  const cellSize = heightmap._cellSize;
  const worldMax = (gridWidth - 1) * cellSize;
  const result = [];

  for (let i = 0; i < centerline.length; i++) {
    const pt = centerline[i];
    const prev = centerline[Math.max(0, i - 1)];
    const next = centerline[Math.min(centerline.length - 1, i + 1)];

    const dx = next.x - prev.x;
    const dz = next.z - prev.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.001) continue;

    // Perpendicular direction (try both sides, pick the one not in water)
    const perpX = -dz / len;
    const perpZ = dx / len;

    // Try the positive perpendicular side
    const px = pt.x + perpX * offset;
    const pz = pt.z + perpZ * offset;

    // Check if the offset point is on land
    const gx = Math.round(clamp(px / cellSize, 0, gridWidth - 1));
    const gz = Math.round(clamp(pz / cellSize, 0, gridWidth - 1));

    if (!waterCells.has(gz * gridWidth + gx) && px >= 0 && px <= worldMax && pz >= 0 && pz <= worldMax) {
      result.push({ x: px, z: pz });
    } else {
      // Try the other side
      const px2 = pt.x - perpX * offset;
      const pz2 = pt.z - perpZ * offset;
      const gx2 = Math.round(clamp(px2 / cellSize, 0, gridWidth - 1));
      const gz2 = Math.round(clamp(pz2 / cellSize, 0, gridWidth - 1));

      if (!waterCells.has(gz2 * gridWidth + gx2) && px2 >= 0 && px2 <= worldMax && pz2 >= 0 && pz2 <= worldMax) {
        result.push({ x: px2, z: pz2 });
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Route a road via A* between two world-coordinate points
// ---------------------------------------------------------------------------

/**
 * Route a road between two points using A* pathfinding.
 *
 * @param {number} startX - world x
 * @param {number} startZ - world z
 * @param {number} endX - world x
 * @param {number} endZ - world z
 * @param {Heightmap} heightmap
 * @param {Function} costFn
 * @param {number} cellSize
 * @returns {{smoothed: {x,z}[], gridPath: {gx,gz}[]} | null}
 */
function routeRoad(startX, startZ, endX, endZ, heightmap, costFn, cellSize) {
  const gridWidth = heightmap.width;
  const gridHeight = heightmap.height;

  const startG = heightmap.worldToGrid(clamp(startX, 0, (gridWidth - 1) * cellSize),
                                       clamp(startZ, 0, (gridHeight - 1) * cellSize));
  const endG = heightmap.worldToGrid(clamp(endX, 0, (gridWidth - 1) * cellSize),
                                     clamp(endZ, 0, (gridHeight - 1) * cellSize));

  const startGx = clamp(Math.round(startG.gx), 0, gridWidth - 1);
  const startGz = clamp(Math.round(startG.gz), 0, gridHeight - 1);
  const endGx = clamp(Math.round(endG.gx), 0, gridWidth - 1);
  const endGz = clamp(Math.round(endG.gz), 0, gridHeight - 1);

  const pathResult = findPath(startGx, startGz, endGx, endGz, gridWidth, gridHeight, costFn);
  if (!pathResult) return null;

  const simplified = simplifyPath(pathResult.path, 1.5);
  const smoothed = smoothPath(simplified, cellSize, 2);

  return { smoothed, gridPath: pathResult.path };
}

// ---------------------------------------------------------------------------
// Post-path clearance check
// ---------------------------------------------------------------------------

/**
 * Check if a smoothed path is too close to existing edges.
 * Returns true if the path is too close (should be rejected).
 */
function pathTooCloseToExisting(smoothed, existingEdges, minDist = 5) {
  if (smoothed.length < 2) return false;
  const sampleCount = Math.min(5, smoothed.length);
  for (let si = 0; si < sampleCount; si++) {
    const idx = Math.floor(si * (smoothed.length - 1) / Math.max(1, sampleCount - 1));
    const sp = smoothed[idx];
    for (const edge of existingEdges) {
      if (!edge.points || edge.points.length < 2) continue;
      for (let ei = 0; ei < edge.points.length - 1; ei++) {
        if (pointToSegmentDist(sp.x, sp.z, edge.points[ei].x, edge.points[ei].z, edge.points[ei + 1].x, edge.points[ei + 1].z) < minDist) {
          return true;
        }
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Phase 2 entry point
// ---------------------------------------------------------------------------

/**
 * Run Phase 2: Primary Network — Anchor Routes & Arterials.
 *
 * @param {Object} terrainData - output from Phase 1
 * @param {Object} cityContext
 * @param {Object} rng - SeededRandom
 * @param {Object} [params]
 * @param {number} [params.organicness=0.5]
 * @returns {Object} RoadNetwork {nodes, edges, bridges}
 */
export function runPhase2(terrainData, cityContext, rng, params = {}) {
  const { organicness = 0.5 } = params;

  const roadRng = rng.fork('primary-roads');
  const { heightmap, waterCells, anchorPoints } = terrainData;
  const gridWidth = heightmap.width;
  const gridHeight = heightmap.height;
  const cellSize = heightmap._cellSize;
  const worldExtent = (gridWidth - 1) * cellSize;

  const nodes = new Map();
  const edges = [];
  const bridges = [];

  // --- Cost function ---
  // Water penalty must be high so roads strongly avoid water, but finite
  // so bridge crossings can still be detected.
  // Road avoidance: existing road cells get a penalty so new roads route away.
  const roadCells = new Set();
  const baseCostFn = terrainCostFunction(heightmap, {
    slopePenalty: 15,
    waterCells,
    waterPenalty: 300,
    edgeMargin: 3,
    edgePenalty: 3,
  });
  const costFn = (fromGx, fromGz, toGx, toGz) => {
    const base = baseCostFn(fromGx, fromGz, toGx, toGz);
    const key = toGz * gridWidth + toGx;
    return roadCells.has(key) ? base + 200 : base;
  };

  // Mark grid cells along a road path as occupied (with buffer for clearance)
  function markRoadCells(gridPath) {
    if (!gridPath) return;
    const buffer = Math.ceil(5 / cellSize); // 5m clearance in grid cells
    for (const { gx, gz } of gridPath) {
      for (let dz = -buffer; dz <= buffer; dz++) {
        for (let dx = -buffer; dx <= buffer; dx++) {
          const nx = gx + dx;
          const nz = gz + dz;
          if (nx >= 0 && nx < gridWidth && nz >= 0 && nz < gridHeight) {
            roadCells.add(nz * gridWidth + nx);
          }
        }
      }
    }
  }

  // --- 1. Place city seed at best anchor ---
  const seedPos = chooseCitySeed(anchorPoints, cityContext, cellSize, gridWidth);
  const seedX = clamp(seedPos.x, 0, worldExtent);
  const seedZ = clamp(seedPos.z, 0, worldExtent);
  const seedGrid = heightmap.worldToGrid(seedX, seedZ);
  const seedGx = clamp(Math.round(seedGrid.gx), 0, gridWidth - 1);
  const seedGz = clamp(Math.round(seedGrid.gz), 0, gridHeight - 1);

  const centerId = newNodeId();
  nodes.set(centerId, {
    id: centerId,
    gx: seedGx,
    gz: seedGz,
    x: seedGx * cellSize,
    z: seedGz * cellSize,
    type: 'center',
  });
  const centerNode = nodes.get(centerId);

  // --- 2. Create entry nodes from regional road entries ---
  const entryNodes = [];
  for (const entry of cityContext.roadEntries) {
    const localX = clamp(entry.point.x - cityContext.cityBounds.minX, 0, worldExtent);
    const localZ = clamp(entry.point.z - cityContext.cityBounds.minZ, 0, worldExtent);
    const grid = heightmap.worldToGrid(localX, localZ);
    const gx = clamp(Math.round(grid.gx), 0, gridWidth - 1);
    const gz = clamp(Math.round(grid.gz), 0, gridHeight - 1);

    const id = newNodeId();
    const node = {
      id,
      gx,
      gz,
      x: gx * cellSize,
      z: gz * cellSize,
      type: 'entry',
      hierarchy: entry.hierarchy,
      destination: entry.destination,
    };
    nodes.set(id, node);
    entryNodes.push(node);
  }

  // --- 3. Route primary roads from each entry to seed ---
  // Width narrows in historic core
  const coreRadius = worldExtent * 0.15;

  for (const entryNode of entryNodes) {
    const result = routeRoad(
      entryNode.x, entryNode.z,
      centerNode.x, centerNode.z,
      heightmap, costFn, cellSize
    );
    if (!result) continue;

    const edgeId = newEdgeId();

    // Width: primary roads, narrower near core
    const distToCenter = distance2D(entryNode.x, entryNode.z, centerNode.x, centerNode.z);
    const coreFactor = clamp(distToCenter / (worldExtent * 0.5), 0, 1);
    const primaryWidth = lerp(WIDTH.primary.min, WIDTH.primary.max, coreFactor);

    const edgeBridges = detectBridges(
      result.gridPath, waterCells, gridWidth, cellSize,
      edgeId, primaryWidth, heightmap
    );
    bridges.push(...edgeBridges);

    // Mark bridge nodes
    for (const b of edgeBridges) {
      const bridgeId = newNodeId();
      const bx = (b.startPoint.x + b.endPoint.x) / 2;
      const bz = (b.startPoint.z + b.endPoint.z) / 2;
      const bg = heightmap.worldToGrid(clamp(bx, 0, worldExtent), clamp(bz, 0, worldExtent));
      nodes.set(bridgeId, {
        id: bridgeId,
        gx: clamp(Math.round(bg.gx), 0, gridWidth - 1),
        gz: clamp(Math.round(bg.gz), 0, gridHeight - 1),
        x: bx,
        z: bz,
        type: 'bridge',
      });
    }

    edges.push({
      id: edgeId,
      from: entryNode.id,
      to: centerId,
      points: result.smoothed,
      gridPath: result.gridPath,
      width: primaryWidth,
      hierarchy: 'primary',
    });
    markRoadCells(result.gridPath);
  }

  // --- 4. Ring connections between adjacent entry nodes ---
  if (entryNodes.length >= 2) {
    const sorted = [...entryNodes].sort((a, b) => {
      const angleA = Math.atan2(a.z - centerNode.z, a.x - centerNode.x);
      const angleB = Math.atan2(b.z - centerNode.z, b.x - centerNode.x);
      return angleA - angleB;
    });

    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      const b = sorted[(i + 1) % sorted.length];

      const dist = distance2D(a.x, a.z, b.x, b.z);
      if (dist > worldExtent * 1.2) continue;

      const result = routeRoad(a.x, a.z, b.x, b.z, heightmap, costFn, cellSize);
      if (!result) continue;

      const edgeId = newEdgeId();
      const secWidth = lerp(WIDTH.secondary.min, WIDTH.secondary.max, 0.5);

      const edgeBridges = detectBridges(
        result.gridPath, waterCells, gridWidth, cellSize,
        edgeId, secWidth, heightmap
      );
      bridges.push(...edgeBridges);

      edges.push({
        id: edgeId,
        from: a.id,
        to: b.id,
        points: result.smoothed,
        gridPath: result.gridPath,
        width: secWidth,
        hierarchy: 'secondary',
      });
      markRoadCells(result.gridPath);
    }
  }

  // --- 5. Waterfront routes ---
  const { rivers } = terrainData;
  for (const river of rivers) {
    if (river.centerline.length < 4) continue;

    // Generate offset polyline on the land side
    const waterfrontPoints = offsetPolyline(
      river.centerline, WATERFRONT_OFFSET + river.width / 2,
      heightmap, waterCells
    );

    if (waterfrontPoints.length < 2) continue;

    // Subsample to manageable number of points
    const maxPoints = 20;
    let sampled = waterfrontPoints;
    if (waterfrontPoints.length > maxPoints) {
      sampled = [];
      const step = (waterfrontPoints.length - 1) / (maxPoints - 1);
      for (let i = 0; i < maxPoints; i++) {
        sampled.push(waterfrontPoints[Math.round(i * step)]);
      }
    }

    // Route between first and last waterfront point
    if (sampled.length >= 2) {
      const start = sampled[0];
      const end = sampled[sampled.length - 1];

      const result = routeRoad(start.x, start.z, end.x, end.z, heightmap, costFn, cellSize);
      if (result) {
        const edgeId = newEdgeId();
        const wfWidth = WIDTH.secondary.min;

        const edgeBridges = detectBridges(
          result.gridPath, waterCells, gridWidth, cellSize,
          edgeId, wfWidth, heightmap
        );
        bridges.push(...edgeBridges);

        // Create waterfront nodes
        const startId = newNodeId();
        const startGrid = heightmap.worldToGrid(clamp(start.x, 0, worldExtent), clamp(start.z, 0, worldExtent));
        nodes.set(startId, {
          id: startId,
          gx: clamp(Math.round(startGrid.gx), 0, gridWidth - 1),
          gz: clamp(Math.round(startGrid.gz), 0, gridHeight - 1),
          x: start.x,
          z: start.z,
          type: 'intersection',
        });

        const endId = newNodeId();
        const endGrid = heightmap.worldToGrid(clamp(end.x, 0, worldExtent), clamp(end.z, 0, worldExtent));
        nodes.set(endId, {
          id: endId,
          gx: clamp(Math.round(endGrid.gx), 0, gridWidth - 1),
          gz: clamp(Math.round(endGrid.gz), 0, gridHeight - 1),
          x: end.x,
          z: end.z,
          type: 'intersection',
        });

        edges.push({
          id: edgeId,
          from: startId,
          to: endId,
          points: result.smoothed,
          gridPath: result.gridPath,
          width: wfWidth,
          hierarchy: 'secondary',
        });
        markRoadCells(result.gridPath);

        snapEndpointsToNetwork(edgeId, nodes, edges);

        // Connect waterfront endpoints to nearest arterial node
        for (const wfNode of [nodes.get(startId), nodes.get(endId)]) {
          let nearest = null;
          let nearestDist = Infinity;
          for (const node of nodes.values()) {
            if (node.id === wfNode.id) continue;
            if (node.type === 'intersection') continue; // don't connect to other waterfront nodes
            const d = distance2D(wfNode.x, wfNode.z, node.x, node.z);
            if (d < nearestDist) {
              nearestDist = d;
              nearest = node;
            }
          }

          if (nearest && nearestDist < worldExtent * 0.4) {
            const connResult = routeRoad(wfNode.x, wfNode.z, nearest.x, nearest.z, heightmap, costFn, cellSize);
            if (connResult) {
              const connId = newEdgeId();
              edges.push({
                id: connId,
                from: wfNode.id,
                to: nearest.id,
                points: connResult.smoothed,
                gridPath: connResult.gridPath,
                width: WIDTH.secondary.min,
                hierarchy: 'secondary',
              });
              markRoadCells(connResult.gridPath);
            }
          }
        }
      }
    }
  }

  // --- 6. Cross-links between arterials ---
  // Find pairs of arterial midpoints that are close but not connected
  const maxCrosslinkDist = worldExtent * CROSSLINK_MAX_DIST_FACTOR;
  const primaryEdges = edges.filter(e => e.hierarchy === 'primary');

  for (let i = 0; i < primaryEdges.length; i++) {
    for (let j = i + 1; j < primaryEdges.length; j++) {
      const edgeA = primaryEdges[i];
      const edgeB = primaryEdges[j];

      // Skip if they share a node
      if (edgeA.from === edgeB.from || edgeA.from === edgeB.to ||
          edgeA.to === edgeB.from || edgeA.to === edgeB.to) continue;

      // Find closest pair of midpoints
      const midA = edgeA.points[Math.floor(edgeA.points.length / 2)];
      const midB = edgeB.points[Math.floor(edgeB.points.length / 2)];
      if (!midA || !midB) continue;

      const dist = distance2D(midA.x, midA.z, midB.x, midB.z);
      if (dist > maxCrosslinkDist || dist < WIDTH.primary.max * 2) continue;

      // Check they're not already connected via ring roads
      // (Simple check: is there a path between their midpoints through existing edges?)
      // For now, just add the cross-link if distance is reasonable
      const result = routeRoad(midA.x, midA.z, midB.x, midB.z, heightmap, costFn, cellSize);
      if (!result) continue;

      // Skip if path runs too close to existing roads (exclude the two arterials being connected)
      if (pathTooCloseToExisting(result.smoothed, edges.filter(e => e.id !== edgeA.id && e.id !== edgeB.id))) continue;

      const nodeAId = newNodeId();
      const gA = heightmap.worldToGrid(clamp(midA.x, 0, worldExtent), clamp(midA.z, 0, worldExtent));
      nodes.set(nodeAId, {
        id: nodeAId,
        gx: clamp(Math.round(gA.gx), 0, gridWidth - 1),
        gz: clamp(Math.round(gA.gz), 0, gridHeight - 1),
        x: midA.x,
        z: midA.z,
        type: 'intersection',
      });

      const nodeBId = newNodeId();
      const gB = heightmap.worldToGrid(clamp(midB.x, 0, worldExtent), clamp(midB.z, 0, worldExtent));
      nodes.set(nodeBId, {
        id: nodeBId,
        gx: clamp(Math.round(gB.gx), 0, gridWidth - 1),
        gz: clamp(Math.round(gB.gz), 0, gridHeight - 1),
        x: midB.x,
        z: midB.z,
        type: 'intersection',
      });

      const edgeId = newEdgeId();
      const clWidth = lerp(WIDTH.secondary.min, WIDTH.secondary.max, 0.3);

      edges.push({
        id: edgeId,
        from: nodeAId,
        to: nodeBId,
        points: result.smoothed,
        gridPath: result.gridPath,
        width: clWidth,
        hierarchy: 'secondary',
      });
      markRoadCells(result.gridPath);

      snapEndpointsToNetwork(edgeId, nodes, edges);
    }
  }

  // --- 7. Detect intersections where roads cross ---
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const edgeA = edges[i];
      const edgeB = edges[j];

      if (edgeA.from === edgeB.from || edgeA.from === edgeB.to ||
          edgeA.to === edgeB.from || edgeA.to === edgeB.to) continue;

      for (let ai = 0; ai < edgeA.points.length - 1; ai++) {
        let found = false;
        for (let bi = 0; bi < edgeB.points.length - 1; bi++) {
          const intersection = segmentsIntersect(
            edgeA.points[ai], edgeA.points[ai + 1],
            edgeB.points[bi], edgeB.points[bi + 1]
          );

          if (intersection) {
            const grid = heightmap.worldToGrid(
              clamp(intersection.x, 0, worldExtent),
              clamp(intersection.z, 0, worldExtent)
            );
            const gx = clamp(Math.round(grid.gx), 0, gridWidth - 1);
            const gz = clamp(Math.round(grid.gz), 0, gridHeight - 1);

            const id = newNodeId();
            nodes.set(id, {
              id,
              gx,
              gz,
              x: intersection.x,
              z: intersection.z,
              type: 'intersection',
            });
            found = true;
            break;
          }
        }
        if (found) break;
      }
    }
  }

  return { nodes, edges, bridges };
}
