import { buildSkeletonRoads } from '../skeleton.js';
import { findPath, simplifyPath, smoothPath } from '../../core/pathfinding.js';

const PLOT_DEPTH = 35; // meters, distance for offset curves
const BLOCK_LENGTH = 70; // meters, spacing for cross streets

/**
 * Offset polyline by a signed distance.
 * Positive = right side, negative = left side (relative to travel direction).
 * At each vertex, averages the normals of adjacent segments for smooth corners.
 *
 * @param {Array<{x, z}>} polyline
 * @param {number} distance - signed offset distance
 * @returns {Array<{x, z}>}
 */
function offsetPolyline(polyline, distance) {
  if (polyline.length < 2) return [];

  const result = [];

  for (let i = 0; i < polyline.length; i++) {
    // Compute normal at this vertex by averaging adjacent segment normals
    let nx = 0, nz = 0;
    let count = 0;

    if (i > 0) {
      const dx = polyline[i].x - polyline[i - 1].x;
      const dz = polyline[i].z - polyline[i - 1].z;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len > 0.001) {
        // Perpendicular: rotate 90 degrees CW -> (dz, -dx)
        nx += dz / len;
        nz += -dx / len;
        count++;
      }
    }

    if (i < polyline.length - 1) {
      const dx = polyline[i + 1].x - polyline[i].x;
      const dz = polyline[i + 1].z - polyline[i].z;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len > 0.001) {
        nx += dz / len;
        nz += -dx / len;
        count++;
      }
    }

    if (count === 0) continue;

    nx /= count;
    nz /= count;

    // Normalize the averaged normal
    const nLen = Math.sqrt(nx * nx + nz * nz);
    if (nLen < 0.001) continue;
    nx /= nLen;
    nz /= nLen;

    result.push({
      x: polyline[i].x + nx * distance,
      z: polyline[i].z + nz * distance,
    });
  }

  return result;
}

/**
 * Filter offset points that are unbuildable or already have roads.
 * Returns contiguous runs of valid points (splitting at gaps).
 */
function filterOffsetPoints(points, map) {
  const runs = [];
  let currentRun = [];

  for (const pt of points) {
    const gx = Math.round((pt.x - map.originX) / map.cellSize);
    const gz = Math.round((pt.z - map.originZ) / map.cellSize);

    // Out of bounds check
    if (gx < 1 || gx >= map.width - 1 || gz < 1 || gz >= map.height - 1) {
      if (currentRun.length >= 3) runs.push(currentRun);
      currentRun = [];
      continue;
    }

    const buildable = map.buildability.get(gx, gz);
    const hasRoad = map.roadGrid.get(gx, gz);

    if (buildable < 0.1 || hasRoad > 0) {
      if (currentRun.length >= 3) runs.push(currentRun);
      currentRun = [];
      continue;
    }

    currentRun.push(pt);
  }

  if (currentRun.length >= 3) runs.push(currentRun);
  return runs;
}

/**
 * Add a road polyline to the graph and FeatureMap.
 */
function addRoadToMap(map, polyline, source, width = 6, hierarchy = 'local', importance = 0.2) {
  if (polyline.length < 2) return null;

  map.addFeature('road', {
    polyline,
    width,
    hierarchy,
    importance,
    source,
  });

  const graph = map.graph;
  const snapDist = map.cellSize * 3;

  const startPt = polyline[0];
  const endPt = polyline[polyline.length - 1];

  const startNodeId = findOrCreateNode(graph, startPt.x, startPt.z, snapDist);
  const endNodeId = findOrCreateNode(graph, endPt.x, endPt.z, snapDist);

  if (startNodeId === endNodeId) return null;

  const points = polyline.slice(1, -1).map(p => ({ x: p.x, z: p.z }));
  graph.addEdge(startNodeId, endNodeId, { points, width, hierarchy });

  return { startNodeId, endNodeId };
}

function findOrCreateNode(graph, x, z, snapDist) {
  const nearest = graph.nearestNode(x, z);
  if (nearest && nearest.dist < snapDist) {
    return nearest.id;
  }
  return graph.addNode(x, z);
}

export class OffsetInfill {
  constructor(map) {
    this.map = map;
    this._tick = 0;
    this._offsetRoads = []; // track offset curve polylines for cross-street generation
  }

  tick() {
    this._tick++;
    if (this._tick === 1) {
      buildSkeletonRoads(this.map);
      return true;
    }
    if (this._tick <= 5) {
      return this._growOffsets();
    }
    return false;
  }

  _growOffsets() {
    const map = this.map;
    let addedAny = false;

    if (this._tick === 2 || this._tick === 4) {
      // Generate offset curves
      addedAny = this._generateOffsetCurves();
    } else if (this._tick === 3 || this._tick === 5) {
      // Add cross streets
      addedAny = this._generateCrossStreets();
    }

    return addedAny || this._tick < 5;
  }

  /**
   * Generate offset curves on both sides of source roads.
   * Tick 2: offset from skeleton roads.
   * Tick 4: offset from first-level offset roads.
   */
  _generateOffsetCurves() {
    const map = this.map;
    let addedAny = false;

    // Determine which roads to offset from
    const sourceLabel = this._tick === 2 ? 'skeleton' : 'offset';
    const sourceRoads = map.roads.filter(r => r.source === sourceLabel);

    const newOffsetRoads = [];

    for (const road of sourceRoads) {
      const polyline = road.polyline;
      if (!polyline || polyline.length < 2) continue;

      // Generate offset curves on both sides
      for (const sign of [1, -1]) {
        const offsetPoints = offsetPolyline(polyline, PLOT_DEPTH * sign);
        const validRuns = filterOffsetPoints(offsetPoints, map);

        for (const run of validRuns) {
          const result = addRoadToMap(map, run, 'offset');
          if (result) {
            newOffsetRoads.push(run);
            addedAny = true;
          }
        }
      }
    }

    this._offsetRoads.push(...newOffsetRoads);
    return addedAny;
  }

  /**
   * Generate cross streets connecting offset curves back to their parent roads.
   * Finds points along offset curves spaced at BLOCK_LENGTH intervals,
   * then pathfinds perpendicular connections.
   */
  _generateCrossStreets() {
    const map = this.map;
    let addedAny = false;

    const costFn = map.createPathCost('growth');
    const maxPathCells = Math.ceil(PLOT_DEPTH * 2.5 / map.cellSize);

    for (const offsetPoly of this._offsetRoads) {
      if (offsetPoly.length < 2) continue;

      // Compute cumulative distance along offset curve
      let totalLen = 0;
      for (let i = 1; i < offsetPoly.length; i++) {
        const dx = offsetPoly[i].x - offsetPoly[i - 1].x;
        const dz = offsetPoly[i].z - offsetPoly[i - 1].z;
        totalLen += Math.sqrt(dx * dx + dz * dz);
      }

      // Place cross streets at BLOCK_LENGTH intervals
      const numCrossStreets = Math.floor(totalLen / BLOCK_LENGTH);
      if (numCrossStreets < 1) continue;

      let cumDist = 0;
      let segIdx = 0;
      let nextTarget = BLOCK_LENGTH;

      for (let i = 1; i < offsetPoly.length && nextTarget <= totalLen; i++) {
        const dx = offsetPoly[i].x - offsetPoly[i - 1].x;
        const dz = offsetPoly[i].z - offsetPoly[i - 1].z;
        const segLen = Math.sqrt(dx * dx + dz * dz);

        while (cumDist + segLen >= nextTarget && nextTarget <= totalLen) {
          // Interpolate point on offset curve
          const t = (nextTarget - cumDist) / segLen;
          const px = offsetPoly[i - 1].x + dx * t;
          const pz = offsetPoly[i - 1].z + dz * t;

          // Convert to grid coords
          const startGx = Math.round((px - map.originX) / map.cellSize);
          const startGz = Math.round((pz - map.originZ) / map.cellSize);

          if (startGx < 1 || startGx >= map.width - 1 || startGz < 1 || startGz >= map.height - 1) {
            nextTarget += BLOCK_LENGTH;
            continue;
          }

          // Find nearest road node (should be the parent skeleton/offset road)
          const nearest = map.graph.nearestNode(px, pz);
          if (!nearest || nearest.dist < map.cellSize * 2) {
            // Already too close to existing road node
            nextTarget += BLOCK_LENGTH;
            continue;
          }

          // Compute perpendicular direction toward parent road
          // Use the segment normal to aim toward the parent road
          const segNormX = -dz / (segLen || 1);
          const segNormZ = dx / (segLen || 1);

          // Target point: move toward parent road along perpendicular
          const targetX = px + segNormX * PLOT_DEPTH;
          const targetZ = pz + segNormZ * PLOT_DEPTH;
          const goalGx = Math.round((targetX - map.originX) / map.cellSize);
          const goalGz = Math.round((targetZ - map.originZ) / map.cellSize);

          if (goalGx < 1 || goalGx >= map.width - 1 || goalGz < 1 || goalGz >= map.height - 1) {
            nextTarget += BLOCK_LENGTH;
            continue;
          }

          // Pathfind the cross street
          const pathResult = findPath(
            startGx, startGz, goalGx, goalGz,
            map.width, map.height, costFn
          );

          if (pathResult && pathResult.path.length >= 2 && pathResult.path.length <= maxPathCells) {
            const simplified = simplifyPath(pathResult.path, 0.5);
            const smoothed = smoothPath(simplified, map.cellSize, 2);

            // Add origin offset
            const polyline = smoothed.map(p => ({
              x: p.x + map.originX,
              z: p.z + map.originZ,
            }));

            if (polyline.length >= 2) {
              const result = addRoadToMap(map, polyline, 'cross-street');
              if (result) addedAny = true;
            }
          }

          nextTarget += BLOCK_LENGTH;
        }

        cumDist += segLen;
      }
    }

    return addedAny;
  }
}
