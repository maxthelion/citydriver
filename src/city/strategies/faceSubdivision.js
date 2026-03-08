import { buildSkeletonRoads } from '../skeleton.js';
import { findPath, simplifyPath, gridPathToWorldPolyline } from '../../core/pathfinding.js';

const TARGET_BLOCK_AREA = 4000; // ~60x60m
const MAX_SUBDIVISIONS_PER_TICK = 5;
const MAX_SUBDIVISION_TICKS = 20;

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
    if (this._tick > MAX_SUBDIVISION_TICKS + 1) return false;
    return this._subdivide();
  }

  _subdivide() {
    const map = this.map;
    const faces = map.extractFaces({ minArea: TARGET_BLOCK_AREA + 1 });
    if (faces.length === 0) return false;

    // Sort largest first
    faces.sort((a, b) => b.area - a.area);

    let subdivided = 0;
    for (const face of faces) {
      if (subdivided >= MAX_SUBDIVISIONS_PER_TICK) break;
      if (this._splitFace(face)) subdivided++;
    }

    return subdivided > 0;
  }

  _splitFace(face) {
    const map = this.map;
    const polygon = face.polygon;
    if (polygon.length < 4) return false;

    // Find the two longest sides of the polygon
    const sides = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i];
      const b = polygon[(i + 1) % polygon.length];
      const dx = b.x - a.x, dz = b.z - a.z;
      sides.push({ idx: i, length: Math.sqrt(dx * dx + dz * dz), a, b });
    }
    sides.sort((a, b) => b.length - a.length);

    if (sides.length < 2) return false;

    // Pick two longest sides that aren't adjacent (opposite-ish)
    const sideA = sides[0];
    let sideB = null;
    for (let i = 1; i < sides.length; i++) {
      const diff = Math.abs(sides[i].idx - sideA.idx);
      const wrap = polygon.length - diff;
      if (Math.min(diff, wrap) > 1) {
        sideB = sides[i];
        break;
      }
    }
    if (!sideB) sideB = sides[1]; // fallback to adjacent if no better option

    // Midpoints of the two sides
    const midA = { x: (sideA.a.x + sideA.b.x) / 2, z: (sideA.a.z + sideA.b.z) / 2 };
    const midB = { x: (sideB.a.x + sideB.b.x) / 2, z: (sideB.a.z + sideB.b.z) / 2 };

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
    const polyline = gridPathToWorldPolyline(simplified, map.cellSize, map.originX, map.originZ);
    if (polyline.length < 2) return false;

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
