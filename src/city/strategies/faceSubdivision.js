import { buildSkeletonRoads } from '../skeleton.js';
import { findPath, simplifyPath, smoothPath } from '../../core/pathfinding.js';

const TARGET_BLOCK_AREA = 4000; // ~60x60m
const MAX_SUBDIVISIONS_PER_TICK = 5;
const CONNECTOR_SPACING = 80; // meters between perpendicular connectors
const CONNECTOR_MAX_LENGTH = 40; // max cells for connector pathfinding

export class FaceSubdivision {
  constructor(map) {
    this.map = map;
    this._tick = 0;
  }

  tick() {
    this._tick++;
    if (this._tick === 1) {
      buildSkeletonRoads(this.map);
      return true;
    }
    if (this._tick === 2) {
      return this._addConnectors();
    }
    return this._subdivide();
  }

  /**
   * Walk along each skeleton road and cast perpendicular rays.
   * When a ray hits another road's roadGrid cells nearby, pathfind a
   * connecting road. This creates enclosed faces between skeleton roads.
   */
  _addConnectors() {
    const map = this.map;
    const skeletonRoads = map.roads.filter(r => r.source === 'skeleton');
    if (skeletonRoads.length === 0) return false;

    let added = 0;

    for (const road of skeletonRoads) {
      const polyline = road.polyline;
      if (!polyline || polyline.length < 2) continue;

      // Walk the polyline, spacing connectors at CONNECTOR_SPACING intervals
      let accDist = 0;
      let lastConnAt = 0;

      for (let i = 0; i < polyline.length - 1; i++) {
        const ax = polyline[i].x, az = polyline[i].z;
        const bx = polyline[i + 1].x, bz = polyline[i + 1].z;
        const dx = bx - ax, dz = bz - az;
        const segLen = Math.sqrt(dx * dx + dz * dz);
        accDist += segLen;

        if (accDist - lastConnAt < CONNECTOR_SPACING) continue;
        lastConnAt = accDist;

        if (segLen < 1) continue;
        // Perpendicular direction
        const perpX = -dz / segLen;
        const perpZ = dx / segLen;

        // Midpoint of this segment
        const mx = (ax + bx) / 2;
        const mz = (az + bz) / 2;
        const fromGx = Math.round((mx - map.originX) / map.cellSize);
        const fromGz = Math.round((mz - map.originZ) / map.cellSize);

        // Try both perpendicular directions
        for (const dir of [1, -1]) {
          // Scan outward along perpendicular to find another road
          let targetGx = -1, targetGz = -1;
          for (let d = 5; d <= CONNECTOR_MAX_LENGTH; d++) {
            const gx = fromGx + Math.round(perpX * dir * d);
            const gz = fromGz + Math.round(perpZ * dir * d);
            if (gx < 2 || gx >= map.width - 2 || gz < 2 || gz >= map.height - 2) break;
            if (map.roadGrid.get(gx, gz) > 0) {
              targetGx = gx;
              targetGz = gz;
              break;
            }
          }

          if (targetGx < 0) continue;
          // Must be at least 5 cells away (not just adjacent)
          const dist = Math.sqrt((targetGx - fromGx) ** 2 + (targetGz - fromGz) ** 2);
          if (dist < 5) continue;

          if (fromGx < 2 || fromGx >= map.width - 2 || fromGz < 2 || fromGz >= map.height - 2) continue;

          const costFn = map.createPathCost('growth');
          const result = findPath(fromGx, fromGz, targetGx, targetGz, map.width, map.height, costFn);
          if (!result || result.path.length < 3) continue;

          const simplified = simplifyPath(result.path, 1.0);
          const worldPoints = smoothPath(simplified, map.cellSize, 2);
          if (worldPoints.length < 2) continue;

          const connPolyline = worldPoints.map(p => ({
            x: p.x + map.originX,
            z: p.z + map.originZ,
          }));

          map.addFeature('road', {
            polyline: connPolyline, width: 6, hierarchy: 'local',
            importance: 0.35, source: 'connector',
          });
          this._addToGraph(connPolyline);
          added++;
          break; // one connector per location
        }
      }
    }

    return added > 0;
  }

  _addToGraph(polyline) {
    const map = this.map;
    const graph = map.graph;
    const snapDist = map.cellSize * 3;
    if (polyline.length < 2) return;

    const startPt = polyline[0];
    const endPt = polyline[polyline.length - 1];

    const startNode = this._findOrCreateNode(graph, startPt.x, startPt.z, snapDist);
    const endNode = this._findOrCreateNode(graph, endPt.x, endPt.z, snapDist);
    if (startNode === endNode) return;

    const points = polyline.slice(1, -1).map(p => ({ x: p.x, z: p.z }));
    graph.addEdge(startNode, endNode, { points, width: 6, hierarchy: 'local' });
  }

  _findOrCreateNode(graph, x, z, snapDist) {
    const nearest = graph.nearestNode(x, z);
    if (nearest && nearest.dist < snapDist) return nearest.id;
    return graph.addNode(x, z);
  }

  /**
   * Find oversized faces and split them by connecting midpoints of the two longest edges.
   * Returns true if any faces were subdivided, false if done.
   */
  _subdivide() {
    const map = this.map;
    const graph = map.graph;

    const faces = graph.facesWithEdges();
    if (faces.length === 0) return false;

    // Filter to simple inner faces with area > target
    const oversized = [];
    for (const face of faces) {
      const { nodeIds } = face;

      // Simple check: no repeated node IDs
      if (new Set(nodeIds).size !== nodeIds.length) continue;

      const area = signedArea(nodeIds, graph);
      // Inner faces have positive signed area (CCW in x-right, z-down)
      if (area <= 0) continue;
      if (area <= TARGET_BLOCK_AREA) continue;

      oversized.push({ ...face, area });
    }

    if (oversized.length === 0) return false;

    // Sort largest first
    oversized.sort((a, b) => b.area - a.area);

    let subdivided = 0;

    for (const face of oversized) {
      if (subdivided >= MAX_SUBDIVISIONS_PER_TICK) break;

      const success = this._splitFace(face);
      if (success) subdivided++;
    }

    return subdivided > 0;
  }

  /**
   * Split a face by connecting midpoints of its two longest edges.
   */
  _splitFace(face) {
    const map = this.map;
    const graph = map.graph;
    const { nodeIds, edgeIds } = face;

    // Compute edge lengths and find two longest
    const edgeLengths = [];
    for (let i = 0; i < edgeIds.length; i++) {
      const eid = edgeIds[i];
      const polyline = graph.edgePolyline(eid);
      const len = polylineLength(polyline);
      edgeLengths.push({ edgeId: eid, length: len, index: i });
    }

    edgeLengths.sort((a, b) => b.length - a.length);
    if (edgeLengths.length < 2) return false;

    const edgeA = edgeLengths[0];
    const edgeB = edgeLengths[1];

    // Compute geometric midpoints
    const midA = polylineMidpoint(graph.edgePolyline(edgeA.edgeId));
    const midB = polylineMidpoint(graph.edgePolyline(edgeB.edgeId));

    if (!midA || !midB) return false;

    // Convert to grid coordinates
    const gxA = Math.round((midA.x - map.originX) / map.cellSize);
    const gzA = Math.round((midA.z - map.originZ) / map.cellSize);
    const gxB = Math.round((midB.x - map.originX) / map.cellSize);
    const gzB = Math.round((midB.z - map.originZ) / map.cellSize);

    // Bounds check
    if (gxA < 0 || gxA >= map.width || gzA < 0 || gzA >= map.height) return false;
    if (gxB < 0 || gxB >= map.width || gzB < 0 || gzB >= map.height) return false;

    // Pathfind between midpoints
    const costFn = map.createPathCost('growth');
    const result = findPath(gxA, gzA, gxB, gzB, map.width, map.height, costFn);
    if (!result || !result.path || result.path.length < 2) return false;

    // Simplify and smooth the path
    const simplified = simplifyPath(result.path, 1.0);
    const worldPoints = smoothPath(simplified, map.cellSize, 1);

    if (worldPoints.length < 2) return false;

    // Offset world points by origin
    const polyline = worldPoints.map(p => ({
      x: p.x + map.originX,
      z: p.z + map.originZ,
    }));

    // Split the two face edges at their midpoints
    const midNodeA = graph.splitEdge(edgeA.edgeId, midA.x, midA.z);
    const midNodeB = graph.splitEdge(edgeB.edgeId, midB.x, midB.z);

    // Add connecting edge to graph
    const intermediatePoints = polyline.slice(1, -1);
    const newEdgeId = graph.addEdge(midNodeA, midNodeB, {
      points: intermediatePoints,
      width: 6,
      hierarchy: 'local',
    });

    // Add road feature
    map.addFeature('road', {
      polyline,
      width: 6,
      hierarchy: 'local',
      importance: 0.3,
      source: 'subdivision',
    });

    return true;
  }
}

/** Signed area via shoelace. Positive = CCW (inner face in x-right, z-down). */
function signedArea(nodeIds, graph) {
  let area = 0;
  for (let i = 0; i < nodeIds.length; i++) {
    const a = graph.getNode(nodeIds[i]);
    const b = graph.getNode(nodeIds[(i + 1) % nodeIds.length]);
    area += (a.x * b.z - b.x * a.z);
  }
  return area / 2;
}

/** Total length of a polyline [{x,z}]. */
function polylineLength(pts) {
  let len = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    const dz = pts[i + 1].z - pts[i].z;
    len += Math.sqrt(dx * dx + dz * dz);
  }
  return len;
}

/** Geometric midpoint of a polyline (50% of total length). */
function polylineMidpoint(pts) {
  if (pts.length === 0) return null;
  if (pts.length === 1) return { x: pts[0].x, z: pts[0].z };

  const totalLen = polylineLength(pts);
  if (totalLen === 0) return { x: pts[0].x, z: pts[0].z };

  const halfLen = totalLen / 2;
  let accumulated = 0;

  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    const dz = pts[i + 1].z - pts[i].z;
    const segLen = Math.sqrt(dx * dx + dz * dz);

    if (accumulated + segLen >= halfLen) {
      const t = (halfLen - accumulated) / segLen;
      return {
        x: pts[i].x + dx * t,
        z: pts[i].z + dz * t,
      };
    }
    accumulated += segLen;
  }

  // Fallback: last point
  return { x: pts[pts.length - 1].x, z: pts[pts.length - 1].z };
}
