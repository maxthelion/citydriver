import { buildSkeletonRoads } from '../skeleton.js';
import { findPath, simplifyPath, gridPathToWorldPolyline } from '../../core/pathfinding.js';

const TARGET_BLOCK_AREA = 4000; // ~60x60m
const MAX_SUBDIVISIONS_PER_TICK = 5;
const MAX_SUBDIVISION_TICKS = 20;

export class TriangleMergeSubdiv {
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

    faces.sort((a, b) => b.area - a.area);

    let subdivided = 0;
    for (const face of faces) {
      if (subdivided >= MAX_SUBDIVISIONS_PER_TICK) break;
      if (this._splitFace(face)) subdivided++;
    }

    return subdivided > 0;
  }

  /**
   * Split a face by connecting midpoints of its two longest non-adjacent sides.
   * Prefers splitting along the shorter axis to create squarish blocks.
   */
  _splitFace(face) {
    const map = this.map;
    const polygon = face.polygon;
    if (polygon.length < 4) return false;

    // Compute bounding box to determine split axis
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of polygon) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    const spanX = maxX - minX;
    const spanZ = maxZ - minZ;

    // Split perpendicular to the longer axis (across the block)
    const splitAlongX = spanZ > spanX; // if taller, split horizontally

    // Find two polygon sides most aligned with the split direction
    const sides = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i];
      const b = polygon[(i + 1) % polygon.length];
      const dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len < 1) continue;

      // Alignment: how much this side runs along the split axis
      const alignment = splitAlongX ? Math.abs(dx) / len : Math.abs(dz) / len;
      sides.push({ idx: i, length: len, alignment, a, b });
    }

    // Sort by alignment (most aligned = most perpendicular to cut direction)
    sides.sort((a, b) => b.alignment - a.alignment || b.length - a.length);

    if (sides.length < 2) return false;

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
    if (!sideB) sideB = sides[1];

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
