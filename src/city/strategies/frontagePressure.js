import { buildSkeletonRoads } from '../skeleton.js';
import { findPath, simplifyPath, smoothPath } from '../../core/pathfinding.js';

const PLOT_DEPTH = 35; // meters
const BLOCK_LENGTH_MAX = 80; // meters
const FRONTAGE_FILL_THRESHOLD = 0.6;
const MAX_GROWTH_TICKS = 7;

export class FrontagePressure {
  constructor(map) {
    this.map = map;
    this._tick = 0;
    this._processedBackLane = new Set(); // road ids checked for back lanes
    this._processedCross = new Set(); // road ids checked for cross streets
  }

  tick() {
    this._tick++;
    if (this._tick === 1) {
      buildSkeletonRoads(this.map);
      return true;
    }
    if (this._tick > MAX_GROWTH_TICKS + 1) return false;
    return this._grow();
  }

  _grow() {
    let added = 0;
    const roadsSnapshot = [...this.map.roads];

    // Only generate back lanes from skeleton and shortcut roads (not from other back lanes)
    // This prevents cascading spaghetti
    for (const road of roadsSnapshot) {
      if (this._processedBackLane.has(road.id)) continue;
      this._processedBackLane.add(road.id);

      // Only skeleton-level roads generate back lanes
      const source = road.source || '';
      if (source !== 'skeleton' && source !== 'shortcut' && source !== '') continue;

      added += this._checkBackLanes(road);
    }

    // Cross streets connect existing roads — allow from any road
    for (const road of roadsSnapshot) {
      if (this._processedCross.has(road.id)) continue;
      this._processedCross.add(road.id);
      added += this._checkCrossStreets(road);
    }

    return added > 0;
  }

  /**
   * Measure frontage fill on both sides of a road.
   * If a side is heavily filled, place a back lane parallel to it.
   */
  _checkBackLanes(road) {
    const map = this.map;
    const polyline = road.polyline;
    if (!polyline || polyline.length < 2) return 0;

    let added = 0;
    const plotDepthCells = Math.round(PLOT_DEPTH / map.cellSize);

    // Compute road direction and check both sides
    for (const side of [-1, 1]) {
      const { fillRatio, sampleCount } = this._measureFrontage(polyline, side, plotDepthCells);

      if (sampleCount < 3) continue; // road too short
      if (fillRatio < FRONTAGE_FILL_THRESHOLD) continue;

      // Generate back lane offset polyline
      const offsetDist = PLOT_DEPTH * 2;
      const offsetPoly = this._offsetPolyline(polyline, offsetDist * side);

      if (offsetPoly.length < 2) continue;

      // Filter offset points for buildability
      const buildablePoly = this._filterBuildable(offsetPoly);
      if (buildablePoly.length < 2) continue;

      // Check minimum length (at least 3 cells worth)
      const len = this._polylineLength(buildablePoly);
      if (len < map.cellSize * 3) continue;

      // Add the back lane
      this._addRoad(buildablePoly, 'back-lane');
      added++;
    }

    return added;
  }

  /**
   * Walk a road and insert cross streets where blocks are too long.
   */
  _checkCrossStreets(road) {
    const map = this.map;
    const polyline = road.polyline;
    if (!polyline || polyline.length < 2) return 0;

    let added = 0;
    const totalLen = this._polylineLength(polyline);
    if (totalLen < BLOCK_LENGTH_MAX) return 0;

    // Walk along the polyline, accumulating distance
    let accDist = 0;
    let lastCrossAt = 0;

    for (let i = 0; i < polyline.length - 1; i++) {
      const ax = polyline[i].x;
      const az = polyline[i].z;
      const bx = polyline[i + 1].x;
      const bz = polyline[i + 1].z;
      const segLen = Math.sqrt((bx - ax) ** 2 + (bz - az) ** 2);
      accDist += segLen;

      if (accDist - lastCrossAt < BLOCK_LENGTH_MAX) continue;

      // Check if there's already a cross street nearby
      const midX = (ax + bx) / 2;
      const midZ = (az + bz) / 2;
      const mgx = Math.round((midX - map.originX) / map.cellSize);
      const mgz = Math.round((midZ - map.originZ) / map.cellSize);

      if (this._hasNearbyCross(mgx, mgz, 3)) {
        lastCrossAt = accDist;
        continue;
      }

      // Compute perpendicular direction
      const dx = bx - ax;
      const dz = bz - az;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len < 0.01) continue;

      const perpX = -dz / len;
      const perpZ = dx / len;

      // Try both perpendicular directions
      for (const dir of [1, -1]) {
        const targetX = midX + perpX * dir * PLOT_DEPTH * 2.5;
        const targetZ = midZ + perpZ * dir * PLOT_DEPTH * 2.5;

        const fromGx = Math.round((midX - map.originX) / map.cellSize);
        const fromGz = Math.round((midZ - map.originZ) / map.cellSize);
        const toGx = Math.round((targetX - map.originX) / map.cellSize);
        const toGz = Math.round((targetZ - map.originZ) / map.cellSize);

        // Bounds check
        if (toGx < 2 || toGx >= map.width - 2 || toGz < 2 || toGz >= map.height - 2) continue;
        if (fromGx < 2 || fromGx >= map.width - 2 || fromGz < 2 || fromGz >= map.height - 2) continue;

        // Check target buildability
        if (map.buildability.get(toGx, toGz) < 0.1 && map.roadGrid.get(toGx, toGz) === 0) continue;

        const costFn = map.createPathCost('growth');
        const result = findPath(fromGx, fromGz, toGx, toGz, map.width, map.height, costFn);
        if (!result || result.path.length < 2) continue;

        // Simplify and smooth the path
        const simplified = simplifyPath(result.path, 1.0);
        const smoothed = smoothPath(simplified, map.cellSize, 2);

        // smoothPath returns coords relative to (0,0), add origin
        const worldPoly = smoothed.map(p => ({
          x: p.x + map.originX,
          z: p.z + map.originZ,
        }));

        if (worldPoly.length < 2) continue;

        this._addRoad(worldPoly, 'cross-street');
        added++;
        lastCrossAt = accDist;
        break; // only one cross street per location
      }
    }

    return added;
  }

  /**
   * Measure frontage fill ratio on one side of a road polyline.
   * "Filled" means the land is buildable AND there isn't already a road there
   * (indicating the frontage has available but undeveloped land that wants a back lane).
   * We check if the buildable area at plot depth is accessible (not blocked by water).
   */
  _measureFrontage(polyline, side, depthCells) {
    const map = this.map;
    let buildableCount = 0;
    let totalCount = 0;

    for (let i = 0; i < polyline.length - 1; i++) {
      const ax = polyline[i].x;
      const az = polyline[i].z;
      const bx = polyline[i + 1].x;
      const bz = polyline[i + 1].z;
      const dx = bx - ax;
      const dz = bz - az;
      const segLen = Math.sqrt(dx * dx + dz * dz);
      if (segLen < 0.01) continue;

      const perpX = (-dz / segLen) * side;
      const perpZ = (dx / segLen) * side;

      // Sample sparsely along segment (every 2 cells)
      const steps = Math.max(1, Math.floor(segLen / (map.cellSize * 2)));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const px = ax + dx * t;
        const pz = az + dz * t;

        // Check at the back-lane distance (not every depth level)
        const checkX = px + perpX * depthCells * map.cellSize;
        const checkZ = pz + perpZ * depthCells * map.cellSize;
        const gx = Math.round((checkX - map.originX) / map.cellSize);
        const gz = Math.round((checkZ - map.originZ) / map.cellSize);

        if (gx < 2 || gx >= map.width - 2 || gz < 2 || gz >= map.height - 2) continue;

        totalCount++;
        // Buildable = good terrain, no water, no existing road
        if (map.buildability.get(gx, gz) > 0.2 &&
            map.waterMask.get(gx, gz) === 0 &&
            map.roadGrid.get(gx, gz) === 0) {
          buildableCount++;
        }
      }
    }

    return {
      fillRatio: totalCount > 0 ? buildableCount / totalCount : 0,
      sampleCount: totalCount,
    };
  }

  /**
   * Offset a polyline perpendicular by a signed distance.
   * Positive = right side, negative = left side.
   */
  _offsetPolyline(polyline, distance) {
    if (polyline.length < 2) return [];

    const result = [];

    for (let i = 0; i < polyline.length; i++) {
      // Compute average perpendicular at this vertex
      let perpX = 0;
      let perpZ = 0;
      let count = 0;

      if (i > 0) {
        const dx = polyline[i].x - polyline[i - 1].x;
        const dz = polyline[i].z - polyline[i - 1].z;
        const len = Math.sqrt(dx * dx + dz * dz);
        if (len > 0.01) {
          perpX += -dz / len;
          perpZ += dx / len;
          count++;
        }
      }

      if (i < polyline.length - 1) {
        const dx = polyline[i + 1].x - polyline[i].x;
        const dz = polyline[i + 1].z - polyline[i].z;
        const len = Math.sqrt(dx * dx + dz * dz);
        if (len > 0.01) {
          perpX += -dz / len;
          perpZ += dx / len;
          count++;
        }
      }

      if (count === 0) continue;
      perpX /= count;
      perpZ /= count;

      // Normalize
      const pLen = Math.sqrt(perpX * perpX + perpZ * perpZ);
      if (pLen < 0.01) continue;
      perpX /= pLen;
      perpZ /= pLen;

      result.push({
        x: polyline[i].x + perpX * distance,
        z: polyline[i].z + perpZ * distance,
      });
    }

    return result;
  }

  /**
   * Filter a world-coord polyline, keeping only points on buildable terrain.
   * Returns contiguous runs of buildable points (longest run).
   */
  _filterBuildable(polyline) {
    const map = this.map;
    const runs = [];
    let currentRun = [];

    for (const pt of polyline) {
      const gx = Math.round((pt.x - map.originX) / map.cellSize);
      const gz = Math.round((pt.z - map.originZ) / map.cellSize);

      if (gx < 2 || gx >= map.width - 2 || gz < 2 || gz >= map.height - 2) {
        if (currentRun.length > 0) { runs.push(currentRun); currentRun = []; }
        continue;
      }

      const b = map.buildability.get(gx, gz);
      const w = map.waterMask.get(gx, gz);
      // Allow building on existing roads too (for connections)
      if ((b > 0.1 || map.roadGrid.get(gx, gz) > 0) && w === 0) {
        currentRun.push(pt);
      } else {
        if (currentRun.length > 0) { runs.push(currentRun); currentRun = []; }
      }
    }
    if (currentRun.length > 0) runs.push(currentRun);

    // Return the longest buildable run
    let best = [];
    for (const run of runs) {
      if (run.length > best.length) best = run;
    }
    return best;
  }

  /**
   * Check if there's already a road cell near (gx, gz) in perpendicular direction.
   */
  _hasNearbyCross(gx, gz, radius) {
    const map = this.map;
    // Check a small area for existing road grid cells (excluding the road we're on)
    let roadCellCount = 0;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx === 0 && dz === 0) continue;
        const nx = gx + dx;
        const nz = gz + dz;
        if (nx < 0 || nx >= map.width || nz < 0 || nz >= map.height) continue;
        if (map.roadGrid.get(nx, nz) > 0) roadCellCount++;
      }
    }
    // If more than half the nearby cells are road, there's likely an intersection
    return roadCellCount > radius * 2;
  }

  /**
   * Compute total length of a world-coord polyline.
   */
  _polylineLength(polyline) {
    let len = 0;
    for (let i = 0; i < polyline.length - 1; i++) {
      const dx = polyline[i + 1].x - polyline[i].x;
      const dz = polyline[i + 1].z - polyline[i].z;
      len += Math.sqrt(dx * dx + dz * dz);
    }
    return len;
  }

  /**
   * Add a road feature and register it in the graph.
   */
  _addRoad(polyline, source) {
    const map = this.map;
    const width = 6;
    const hierarchy = 'local';
    const importance = 0.2;

    map.addFeature('road', {
      polyline,
      width,
      hierarchy,
      importance,
      source,
    });

    // Add to graph
    if (polyline.length >= 2) {
      const graph = map.graph;
      const snapDist = map.cellSize * 3;

      const startPt = polyline[0];
      const endPt = polyline[polyline.length - 1];

      const startNodeId = this._findOrCreateNode(graph, startPt.x, startPt.z, snapDist);
      const endNodeId = this._findOrCreateNode(graph, endPt.x, endPt.z, snapDist);

      if (startNodeId !== endNodeId) {
        const points = polyline.slice(1, -1).map(p => ({ x: p.x, z: p.z }));
        graph.addEdge(startNodeId, endNodeId, { points, width, hierarchy });
      }
    }
  }

  _findOrCreateNode(graph, x, z, snapDist) {
    const nearest = graph.nearestNode(x, z);
    if (nearest && nearest.dist < snapDist) {
      return nearest.id;
    }
    return graph.addNode(x, z);
  }
}
