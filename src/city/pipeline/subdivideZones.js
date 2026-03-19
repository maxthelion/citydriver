/**
 * Subdivide large zones by cutting roads through their interior.
 *
 * For each large zone:
 * 1. Find the longest boundary edge
 * 2. Find its midpoint
 * 3. Project a point inward, perpendicular to that edge (with some randomness)
 * 4. Pathfind from the midpoint toward the projected point until hitting a road
 * 5. Add the path as a road — this cuts through the zone interior
 */

import { findPath, simplifyPath, gridPathToWorldPolyline } from '../../core/pathfinding.js';

const MIN_ZONE_SIZE = 5000;  // cells — only subdivide zones larger than this

/**
 * @param {object} map - FeatureMap with developmentZones, roadGrid, waterMask, graph
 * @param {object} [options]
 * @param {number} [options.minZoneSize=5000] - min cells to consider for subdivision
 * @param {number} [options.projectionDist=0.4] - how far inward to project (fraction of edge length)
 * @returns {{ roadsAdded: number }}
 */
export function subdivideLargeZones(map, options = {}) {
  const minSize = options.minZoneSize || MIN_ZONE_SIZE;
  const projFrac = options.projectionDist || 0.4;
  const zones = map.developmentZones;
  if (!zones) return { roadsAdded: 0 };

  const roadGrid = map.hasLayer('roadGrid') ? map.getLayer('roadGrid') : null;
  const waterMask = map.hasLayer('waterMask') ? map.getLayer('waterMask') : null;
  if (!roadGrid) return { roadsAdded: 0 };

  const w = map.width, h = map.height;
  const cs = map.cellSize;
  const ox = map.originX, oz = map.originZ;

  const costFn = map.createPathCost ? map.createPathCost('growth') : null;
  const roadsBefore = map.roads.length;

  let cutsPlaced = 0;

  for (const zone of zones) {
    if (zone.cells.length < minSize) continue;
    if (!zone.boundary || zone.boundary.length < 4) continue;

    // Step 1: Find the longest boundary edge
    let longestLen = 0, longestIdx = 0;
    const b = zone.boundary;
    for (let i = 0; i < b.length; i++) {
      const next = b[(i + 1) % b.length];
      const dx = next.x - b[i].x, dz = next.z - b[i].z;
      const len = dx * dx + dz * dz; // squared is fine for comparison
      if (len > longestLen) { longestLen = len; longestIdx = i; }
    }

    // Step 2: Midpoint of the longest edge
    const p1 = b[longestIdx];
    const p2 = b[(longestIdx + 1) % b.length];
    const midX = (p1.x + p2.x) / 2;
    const midZ = (p1.z + p2.z) / 2;

    // Step 3: Project inward perpendicular
    const edgeDx = p2.x - p1.x, edgeDz = p2.z - p1.z;
    const edgeLen = Math.sqrt(edgeDx * edgeDx + edgeDz * edgeDz);
    if (edgeLen < cs * 5) continue; // edge too short

    // Perpendicular (two options — pick the one pointing toward zone centroid)
    const perpX1 = -edgeDz / edgeLen, perpZ1 = edgeDx / edgeLen;
    const centX = ox + zone.centroidGx * cs;
    const centZ = oz + zone.centroidGz * cs;
    const toCentX = centX - midX, toCentZ = centZ - midZ;
    const dot = perpX1 * toCentX + perpZ1 * toCentZ;
    const perpX = dot >= 0 ? perpX1 : -perpX1;
    const perpZ = dot >= 0 ? perpZ1 : -perpZ1;

    // Project to the far side of the map — the walk stops when it hits a road
    // Add some randomness (±20% angle variation)
    const rng = map.rng;
    const jitter = rng ? (rng.next() - 0.5) * 0.4 : (Math.random() - 0.5) * 0.4;
    const angle = Math.atan2(perpZ, perpX) + jitter;
    const mapDiag = Math.sqrt(w * w + h * h) * cs;
    const targetX = midX + Math.cos(angle) * mapDiag;
    const targetZ = midZ + Math.sin(angle) * mapDiag;

    // Convert to grid coords, clamp target to map bounds
    const startGx = Math.round((midX - ox) / cs);
    const startGz = Math.round((midZ - oz) / cs);
    const endGx = Math.max(0, Math.min(w - 1, Math.round((targetX - ox) / cs)));
    const endGz = Math.max(0, Math.min(h - 1, Math.round((targetZ - oz) / cs)));

    // Bounds check start only
    if (startGx < 0 || startGx >= w || startGz < 0 || startGz >= h) continue;

    // Step 4: Walk from midpoint toward projected point, stop when hitting a road
    const { path, hitRoad } = walkTowardTarget(startGx, startGz, endGx, endGz, roadGrid, waterMask, w, h);
    if (!hitRoad) continue; // only keep cuts that connect to another road
    if (path.length < 10) continue;

    // Convert to world polyline
    const polyline = path.map(p => ({ x: ox + p.gx * cs, z: oz + p.gz * cs }));

    // Simplify
    const simplified = simplifyGridPath(polyline, cs * 3);
    if (simplified.length < 2) continue;

    // Step 5: Add as road
    const roadData = {
      type: 'road',
      polyline: simplified,
      width: 6,
      hierarchy: 'local',
      importance: 0.2,
      source: 'zone-subdivide',
      id: map.roads ? map.roads.length : 0,
    };

    if (map.addFeature) {
      map.addFeature('road', roadData);
    } else {
      map.roads.push(roadData);
    }

    if (map.graph && simplified.length >= 2) {
      const snapDist = cs * 3;
      const graph = map.graph;
      const startPt = simplified[0];
      const endPt = simplified[simplified.length - 1];
      const startNode = findOrCreate(graph, startPt.x, startPt.z, snapDist);
      const endNode = findOrCreate(graph, endPt.x, endPt.z, snapDist);
      if (startNode !== endNode) {
        graph.addEdge(startNode, endNode, {
          points: simplified.slice(1, -1),
          width: 6,
          hierarchy: 'local',
        });
      }
    }

    cutsPlaced++;
  }

  console.log(`[subdivideLargeZones] ${cutsPlaced} cuts placed through large zones`);
  return { roadsAdded: cutsPlaced };
}

/**
 * Walk from (sx,sz) toward (tx,tz) on the grid.
 * Stop when hitting a road cell, water, or going out of bounds.
 * Returns the path of grid cells walked.
 */
function walkTowardTarget(sx, sz, tx, tz, roadGrid, waterMask, w, h) {
  const path = [];
  const dx = tx - sx, dz = tz - sz;
  const steps = Math.max(Math.abs(dx), Math.abs(dz));
  if (steps === 0) return { path, hitRoad: false };

  let hitRoad = false;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const gx = Math.round(sx + dx * t);
    const gz = Math.round(sz + dz * t);

    if (gx < 0 || gx >= w || gz < 0 || gz >= h) break;
    if (waterMask && waterMask.get(gx, gz) > 0) break;

    // Stop when near a road — but only after walking far enough to leave
    // the starting road behind (~100m)
    if (i > 20) {
      let nearRoad = false;
      for (let dz2 = -2; dz2 <= 2 && !nearRoad; dz2++) {
        for (let dx2 = -2; dx2 <= 2 && !nearRoad; dx2++) {
          const nx = gx + dx2, nz = gz + dz2;
          if (nx >= 0 && nx < w && nz >= 0 && nz < h && roadGrid.get(nx, nz) > 0) {
            nearRoad = true;
          }
        }
      }
      if (nearRoad) {
        path.push({ gx, gz });
        hitRoad = true;
        break;
      }
    }

    path.push({ gx, gz });
  }

  return { path, hitRoad };
}

function simplifyGridPath(pts, tolerance) {
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
    const left = simplifyGridPath(pts.slice(0, maxIdx + 1), tolerance);
    const right = simplifyGridPath(pts.slice(maxIdx), tolerance);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

function findOrCreate(graph, x, z, snapDist) {
  const nearest = graph.nearestNode(x, z);
  if (nearest && nearest.dist < snapDist) return nearest.id;
  return graph.addNode(x, z);
}
