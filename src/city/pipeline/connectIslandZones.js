/**
 * Connect island zones (zones with no roads nearby) to the road network.
 *
 * For each zone whose centroid is far from any road:
 * 1. Find the nearest road cell to the zone centroid
 * 2. A* pathfind from that road cell to the centroid
 * 3. Add the path as a road
 */

import { findPath } from '../../core/pathfinding.js';
import { wrapZoneWithRoad } from './wrapZoneWithRoad.js';

const MIN_ZONE_CELLS = 500;       // skip tiny zones
const MAX_ROAD_DIST = 200;        // cells — max distance (in cells) to nearest graph node
const MAX_PATH_COST = 1000;       // A* cost limit
const MIN_PATH_LENGTH = 5;        // cells

/**
 * @param {object} map - FeatureMap
 * @returns {{ roadsAdded: number }}
 */
export function connectIslandZones(map) {
  const zones = map.developmentZones;
  if (!zones) return { roadsAdded: 0 };

  const roadGrid = map.hasLayer('roadGrid') ? map.getLayer('roadGrid') : null;
  const waterMask = map.hasLayer('waterMask') ? map.getLayer('waterMask') : null;
  if (!roadGrid) return { roadsAdded: 0 };

  const w = map.width, h = map.height;
  const cs = map.cellSize;
  const ox = map.originX, oz = map.originZ;

  let connected = 0;

  for (const zone of zones) {
    if (zone.cells.length < MIN_ZONE_CELLS) continue;

    const cx = zone.centroidGx;
    const cz = zone.centroidGz;

    // Check if centroid is already near a road (within 2 cells)
    if (isNearRoad(cx, cz, roadGrid, w, h, 2)) continue;

    // Step 1: Find nearest graph node (road junction) within range
    if (!map.graph) continue;
    const centWorldX = ox + cx * cs;
    const centWorldZ = oz + cz * cs;
    const nearestNode = map.graph.nearestNode(centWorldX, centWorldZ);
    if (!nearestNode || nearestNode.dist > MAX_ROAD_DIST * cs) continue;

    // Convert node position to grid
    const node = map.graph.getNode(nearestNode.id);
    if (!node) continue;
    const nodeGx = Math.round((node.x - ox) / cs);
    const nodeGz = Math.round((node.z - oz) / cs);

    // Step 2: A* from node to centroid (short distance, bounded)
    const costFn = (ax, az, bx, bz) => {
      if (bx < 0 || bx >= w || bz < 0 || bz >= h) return Infinity;
      if (waterMask && waterMask.get(bx, bz) > 0) return Infinity;
      return 1;
    };

    const result = findPath(nodeGx, nodeGz, cx, cz, w, h, costFn);
    if (!result || !result.path || result.path.length < MIN_PATH_LENGTH) continue;
    if (result.cost > MAX_PATH_COST) continue;

    // Step 3: Convert to world polyline and simplify
    const polyline = result.path.map(p => ({ x: ox + p.gx * cs, z: oz + p.gz * cs }));
    const simplified = simplify(polyline, cs * 3);
    if (simplified.length < 2) continue;

    // Step 4: Add as road directly to the network
    map.roadNetwork.add(simplified, {
      width: 6,
      hierarchy: 'local',
      importance: 0.2,
      source: 'island-connect',
    });

    // Wrap the island zone boundary with a road now that it's connected
    wrapZoneWithRoad(map, zone);

    connected++;
  }

  console.log(`[connectIslandZones] ${connected} island zones connected and wrapped`);
  return { roadsAdded: connected };
}

function isNearRoad(gx, gz, roadGrid, w, h, radius) {
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const nx = gx + dx, nz = gz + dz;
      if (nx >= 0 && nx < w && nz >= 0 && nz < h && roadGrid.get(nx, nz) > 0) return true;
    }
  }
  return false;
}

function simplify(pts, tolerance) {
  if (pts.length < 3) return pts;
  const tolSq = tolerance * tolerance;
  let maxDist = 0, maxIdx = 0;
  const first = pts[0], last = pts[pts.length - 1];
  const dx = last.x - first.x, dz = last.z - first.z;
  const lenSq = dx * dx + dz * dz;

  for (let i = 1; i < pts.length - 1; i++) {
    let dist;
    if (lenSq < 0.001) {
      const ex = pts[i].x - first.x, ez = pts[i].z - first.z;
      dist = ex * ex + ez * ez;
    } else {
      const t = Math.max(0, Math.min(1, ((pts[i].x - first.x) * dx + (pts[i].z - first.z) * dz) / lenSq));
      const px = first.x + t * dx, pz = first.z + t * dz;
      const ex = pts[i].x - px, ez = pts[i].z - pz;
      dist = ex * ex + ez * ez;
    }
    if (dist > maxDist) { maxDist = dist; maxIdx = i; }
  }

  if (maxDist > tolSq) {
    const left = simplify(pts.slice(0, maxIdx + 1), tolerance);
    const right = simplify(pts.slice(maxIdx), tolerance);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}
