import { buildSkeletonRoads } from '../skeleton.js';
import { findPath, simplifyPath, smoothPath } from '../../core/pathfinding.js';
import { distance2D } from '../../core/math.js';

const TARGET_BLOCK_AREA = 4000; // ~60x60m
const MAX_SUBDIVISIONS_PER_TICK = 5;
const MAX_SHORTCUTS = 12; // more shortcuts than FaceSubdiv to create more triangles to merge

export class TriangleMergeSubdiv {
  constructor(map) {
    this.map = map;
    this._tick = 0;
    this._merged = false;
  }

  tick() {
    this._tick++;
    if (this._tick === 1) {
      buildSkeletonRoads(this.map);
      return true;
    }
    if (this._tick === 2) {
      return this._createCycles();
    }
    if (this._tick === 3) {
      return this._mergeTriangles();
    }
    return this._subdivide();
  }

  /**
   * Add shortcut edges to create cycles. This strategy prefers MORE shorter
   * shortcuts to create many triangular faces that can then be merged into quads.
   * Differs from FaceSubdivision by preferring dead-end connections and
   * allowing more total shortcuts.
   */
  _createCycles() {
    const map = this.map;
    const graph = map.graph;
    const nodes = [...graph.nodes.values()];
    if (nodes.length < 3) return false;

    // Prefer connecting dead-ends (degree 1) and low-degree nodes
    const candidates = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        if (graph.neighbors(a.id).includes(b.id)) continue;

        const geoDist = distance2D(a.x, a.z, b.x, b.z);
        const geoDistCells = geoDist / map.cellSize;
        if (geoDistCells < 5 || geoDistCells > 25) continue; // shorter range than FaceSubdiv

        // Score: prefer short connections between low-degree nodes
        const degA = graph.degree(a.id);
        const degB = graph.degree(b.id);
        const degScore = (degA === 1 ? 0.5 : 0) + (degB === 1 ? 0.5 : 0);
        const score = geoDist * (1 - degScore * 0.3); // discount for dead-ends

        candidates.push({ a, b, geoDist, score });
      }
    }

    candidates.sort((a, b) => a.score - b.score);

    let added = 0;
    for (const { a, b, geoDist } of candidates) {
      if (added >= MAX_SHORTCUTS) break;
      if (graph.neighbors(a.id).includes(b.id)) continue;

      const graphDist = graph.shortestPathLength(a.id, b.id);
      if (graphDist < geoDist * 1.8) continue; // lower threshold = more shortcuts

      const success = this._pathfindShortcut(a, b);
      if (success) added++;
    }

    return added > 0;
  }

  _pathfindShortcut(a, b) {
    const map = this.map;
    const graph = map.graph;

    const gxA = Math.round((a.x - map.originX) / map.cellSize);
    const gzA = Math.round((a.z - map.originZ) / map.cellSize);
    const gxB = Math.round((b.x - map.originX) / map.cellSize);
    const gzB = Math.round((b.z - map.originZ) / map.cellSize);

    if (gxA < 1 || gxA >= map.width - 1 || gzA < 1 || gzA >= map.height - 1) return false;
    if (gxB < 1 || gxB >= map.width - 1 || gzB < 1 || gzB >= map.height - 1) return false;

    const costFn = map.createPathCost('growth');
    const result = findPath(gxA, gzA, gxB, gzB, map.width, map.height, costFn);
    if (!result || result.path.length < 2) return false;

    const simplified = simplifyPath(result.path, 1.0);
    const worldPoints = smoothPath(simplified, map.cellSize, 2);
    if (worldPoints.length < 2) return false;

    const polyline = worldPoints.map(p => ({
      x: p.x + map.originX,
      z: p.z + map.originZ,
    }));

    map.addFeature('road', {
      polyline, width: 6, hierarchy: 'local',
      importance: 0.4, source: 'shortcut',
    });

    const points = polyline.slice(1, -1);
    graph.addEdge(a.id, b.id, { points, width: 6, hierarchy: 'local' });
    return true;
  }

  /**
   * Find adjacent triangle pairs sharing an edge, remove shared edge to create quads.
   * If no merges possible, fall through to subdivision.
   */
  _mergeTriangles() {
    const graph = this.map.graph;
    const faces = graph.facesWithEdges();

    // Filter to simple inner faces (positive signed area)
    const innerFaces = [];
    for (const face of faces) {
      const { nodeIds } = face;
      if (new Set(nodeIds).size !== nodeIds.length) continue;
      const area = signedArea(nodeIds, graph);
      if (area <= 0) continue;
      innerFaces.push(face);
    }

    // Find triangular faces (exactly 3 nodes)
    const triangles = innerFaces.filter(f => f.nodeIds.length === 3);

    if (triangles.length < 2) {
      // No triangle pairs possible, go straight to subdivision
      return this._subdivide();
    }

    // Build edge -> face index map
    const edgeToFaces = new Map();
    for (let i = 0; i < triangles.length; i++) {
      for (const eid of triangles[i].edgeIds) {
        if (!edgeToFaces.has(eid)) edgeToFaces.set(eid, []);
        edgeToFaces.get(eid).push(i);
      }
    }

    // Find mergeable pairs
    const merged = new Set();
    let mergeCount = 0;

    for (const [eid, faceIndices] of edgeToFaces) {
      if (faceIndices.length !== 2) continue;
      const [i, j] = faceIndices;
      if (merged.has(i) || merged.has(j)) continue;

      // Remove the shared edge to merge the two triangles into a quad
      graph._removeEdge(eid);
      merged.add(i);
      merged.add(j);
      mergeCount++;
    }

    this._merged = mergeCount > 0;

    if (!this._merged) {
      return this._subdivide();
    }

    return true;
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
      if (new Set(nodeIds).size !== nodeIds.length) continue;

      const area = signedArea(nodeIds, graph);
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
    const { edgeIds } = face;

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
    graph.addEdge(midNodeA, midNodeB, {
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

  return { x: pts[pts.length - 1].x, z: pts[pts.length - 1].z };
}
