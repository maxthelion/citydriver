import { buildSkeletonRoads } from '../skeleton.js';
import { findPath, simplifyPath, smoothPath } from '../../core/pathfinding.js';

const TARGET_BLOCK_AREA = 4000; // ~60x60m
const MAX_SUBDIVISIONS_PER_TICK = 5;

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
    // Skeleton now includes extra edges beyond MST, creating cycles.
    // Tick 2: merge adjacent triangles into quads.
    if (this._tick === 2) {
      return this._mergeTriangles();
    }
    // Tick 3+: subdivide oversized faces.
    return this._subdivide();
  }

  _mergeTriangles() {
    const graph = this.map.graph;
    const faces = graph.facesWithEdges();

    const innerFaces = [];
    for (const face of faces) {
      const { nodeIds } = face;
      if (new Set(nodeIds).size !== nodeIds.length) continue;
      const area = signedArea(nodeIds, graph);
      if (area <= 0) continue;
      innerFaces.push(face);
    }

    const triangles = innerFaces.filter(f => f.nodeIds.length === 3);

    if (triangles.length < 2) {
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

    const merged = new Set();
    let mergeCount = 0;

    for (const [eid, faceIndices] of edgeToFaces) {
      if (faceIndices.length !== 2) continue;
      const [i, j] = faceIndices;
      if (merged.has(i) || merged.has(j)) continue;

      graph._removeEdge(eid);
      merged.add(i);
      merged.add(j);
      mergeCount++;
    }

    if (mergeCount === 0) {
      return this._subdivide();
    }

    return true;
  }

  _subdivide() {
    const map = this.map;
    const graph = map.graph;

    const faces = graph.facesWithEdges();
    if (faces.length === 0) return false;

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

    oversized.sort((a, b) => b.area - a.area);

    let subdivided = 0;
    for (const face of oversized) {
      if (subdivided >= MAX_SUBDIVISIONS_PER_TICK) break;
      if (this._splitFace(face)) subdivided++;
    }

    return subdivided > 0;
  }

  _splitFace(face) {
    const map = this.map;
    const graph = map.graph;
    const { edgeIds } = face;

    const edgeLengths = [];
    for (const eid of edgeIds) {
      const polyline = graph.edgePolyline(eid);
      edgeLengths.push({ edgeId: eid, length: polylineLength(polyline) });
    }
    edgeLengths.sort((a, b) => b.length - a.length);
    if (edgeLengths.length < 2) return false;

    const edgeA = edgeLengths[0];
    const edgeB = edgeLengths[1];

    const midA = polylineMidpoint(graph.edgePolyline(edgeA.edgeId));
    const midB = polylineMidpoint(graph.edgePolyline(edgeB.edgeId));
    if (!midA || !midB) return false;

    const gxA = Math.round((midA.x - map.originX) / map.cellSize);
    const gzA = Math.round((midA.z - map.originZ) / map.cellSize);
    const gxB = Math.round((midB.x - map.originX) / map.cellSize);
    const gzB = Math.round((midB.z - map.originZ) / map.cellSize);

    if (gxA < 0 || gxA >= map.width || gzA < 0 || gzA >= map.height) return false;
    if (gxB < 0 || gxB >= map.width || gzB < 0 || gzB >= map.height) return false;

    const costFn = map.createPathCost('growth');
    const result = findPath(gxA, gzA, gxB, gzB, map.width, map.height, costFn);
    if (!result || result.path.length < 2) return false;

    const simplified = simplifyPath(result.path, 1.0);
    const worldPoints = smoothPath(simplified, map.cellSize, 1);
    if (worldPoints.length < 2) return false;

    const polyline = worldPoints.map(p => ({
      x: p.x + map.originX,
      z: p.z + map.originZ,
    }));

    const midNodeA = graph.splitEdge(edgeA.edgeId, midA.x, midA.z);
    const midNodeB = graph.splitEdge(edgeB.edgeId, midB.x, midB.z);

    const intermediatePoints = polyline.slice(1, -1);
    graph.addEdge(midNodeA, midNodeB, {
      points: intermediatePoints,
      width: 6,
      hierarchy: 'local',
    });

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

function signedArea(nodeIds, graph) {
  let area = 0;
  for (let i = 0; i < nodeIds.length; i++) {
    const a = graph.getNode(nodeIds[i]);
    const b = graph.getNode(nodeIds[(i + 1) % nodeIds.length]);
    area += (a.x * b.z - b.x * a.z);
  }
  return area / 2;
}

function polylineLength(pts) {
  let len = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    const dz = pts[i + 1].z - pts[i].z;
    len += Math.sqrt(dx * dx + dz * dz);
  }
  return len;
}

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
