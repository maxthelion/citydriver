import * as THREE from 'three';

const ROAD_LIFT = 0.15; // height above terrain to prevent z-fighting

/**
 * Resample a polyline so that consecutive points are spaced roughly `spacing` apart.
 * Always includes the first and last original point.
 * @param {{x: number, z: number}[]} points
 * @param {number} spacing
 * @returns {{x: number, z: number}[]}
 */
function resamplePolyline(points, spacing) {
  if (points.length < 2) return [...points];

  const result = [points[0]];
  let accumDist = 0;
  let prevPt = points[0];

  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - prevPt.x;
    const dz = points[i].z - prevPt.z;
    const segLen = Math.sqrt(dx * dx + dz * dz);

    if (segLen < 1e-6) continue;

    let remaining = segLen;
    let fromX = prevPt.x;
    let fromZ = prevPt.z;
    const dirX = dx / segLen;
    const dirZ = dz / segLen;

    while (accumDist + remaining >= spacing) {
      const step = spacing - accumDist;
      fromX += dirX * step;
      fromZ += dirZ * step;
      result.push({ x: fromX, z: fromZ });
      remaining -= step;
      accumDist = 0;
    }

    accumDist += remaining;
    prevPt = points[i];
  }

  // Always include the last point
  const last = points[points.length - 1];
  const lastResult = result[result.length - 1];
  if (Math.abs(last.x - lastResult.x) > 1e-6 || Math.abs(last.z - lastResult.z) > 1e-6) {
    result.push(last);
  }

  return result;
}

/**
 * Build road meshes from road edge data.
 * Each road is a triangle strip following the terrain.
 *
 * @param {Array} edges - Road edges with points and width
 * @param {import('../core/heightmap.js').Heightmap} heightmap
 * @param {import('./materials.js').MaterialRegistry} materials
 * @param {number} [seaLevel=0] - vertices below this are clamped up
 * @returns {THREE.Group} containing all road meshes
 */
export function buildRoadMeshes(edges, heightmap, materials, seaLevel = 0) {
  const group = new THREE.Group();
  group.name = 'roads';

  for (const edge of edges) {
    if (!edge.points || edge.points.length < 2) continue;

    const sampled = resamplePolyline(edge.points, 4);
    if (sampled.length < 2) continue;

    const halfWidth = (edge.width || 8) / 2;

    // Build cross-section vertices: left and right at each sample point
    const leftVerts = [];
    const rightVerts = [];

    for (let i = 0; i < sampled.length; i++) {
      const pt = sampled[i];

      // Compute tangent direction
      let tx, tz;
      if (i === 0) {
        tx = sampled[1].x - sampled[0].x;
        tz = sampled[1].z - sampled[0].z;
      } else if (i === sampled.length - 1) {
        tx = sampled[i].x - sampled[i - 1].x;
        tz = sampled[i].z - sampled[i - 1].z;
      } else {
        tx = sampled[i + 1].x - sampled[i - 1].x;
        tz = sampled[i + 1].z - sampled[i - 1].z;
      }

      // Normalize tangent
      const tLen = Math.sqrt(tx * tx + tz * tz);
      if (tLen < 1e-6) continue;
      tx /= tLen;
      tz /= tLen;

      // Perpendicular (rotate tangent 90 degrees): (-tz, tx)
      const px = -tz;
      const pz = tx;

      const lx = pt.x + px * halfWidth;
      const lz = pt.z + pz * halfWidth;
      const ly = Math.max(heightmap.sample(lx, lz), seaLevel) + ROAD_LIFT;

      const rx = pt.x - px * halfWidth;
      const rz = pt.z - pz * halfWidth;
      const ry = Math.max(heightmap.sample(rx, rz), seaLevel) + ROAD_LIFT;

      leftVerts.push({ x: lx, y: ly, z: lz });
      rightVerts.push({ x: rx, y: ry, z: rz });
    }

    if (leftVerts.length < 2) continue;

    // Build triangle strip geometry
    const numSegments = leftVerts.length - 1;
    const positions = new Float32Array(numSegments * 6 * 3); // 2 triangles * 3 verts * 3 coords
    let vi = 0;

    for (let i = 0; i < numSegments; i++) {
      const l0 = leftVerts[i];
      const l1 = leftVerts[i + 1];
      const r0 = rightVerts[i];
      const r1 = rightVerts[i + 1];

      // Triangle 1: l0, l1, r0
      // Triangle 2: r0, l1, r1
      // Check winding by computing normal of triangle 1
      // edge1 = l1 - l0, edge2 = r0 - l0
      const e1x = l1.x - l0.x, e1y = l1.y - l0.y, e1z = l1.z - l0.z;
      const e2x = r0.x - l0.x, e2y = r0.y - l0.y, e2z = r0.z - l0.z;
      const ny = e1z * e2x - e1x * e2z; // y component of cross product (e1 x e2)

      if (ny > 0) {
        // Normal points up: l0, l1, r0 is correct
        positions[vi++] = l0.x; positions[vi++] = l0.y; positions[vi++] = l0.z;
        positions[vi++] = l1.x; positions[vi++] = l1.y; positions[vi++] = l1.z;
        positions[vi++] = r0.x; positions[vi++] = r0.y; positions[vi++] = r0.z;

        positions[vi++] = r0.x; positions[vi++] = r0.y; positions[vi++] = r0.z;
        positions[vi++] = l1.x; positions[vi++] = l1.y; positions[vi++] = l1.z;
        positions[vi++] = r1.x; positions[vi++] = r1.y; positions[vi++] = r1.z;
      } else {
        // Normal points down: reverse winding
        positions[vi++] = l0.x; positions[vi++] = l0.y; positions[vi++] = l0.z;
        positions[vi++] = r0.x; positions[vi++] = r0.y; positions[vi++] = r0.z;
        positions[vi++] = l1.x; positions[vi++] = l1.y; positions[vi++] = l1.z;

        positions[vi++] = r0.x; positions[vi++] = r0.y; positions[vi++] = r0.z;
        positions[vi++] = r1.x; positions[vi++] = r1.y; positions[vi++] = r1.z;
        positions[vi++] = l1.x; positions[vi++] = l1.y; positions[vi++] = l1.z;
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.computeVertexNormals();

    const matName = edge.hierarchy === 'primary' ? 'road_primary'
      : (edge.hierarchy === 'secondary' || edge.hierarchy === 'collector' || edge.hierarchy === 'local')
        ? 'road_secondary'
        : 'road_secondary';
    const mesh = new THREE.Mesh(geometry, materials.get(matName));
    mesh.receiveShadow = true;
    mesh.name = `road_${edge.id || ''}`;

    group.add(mesh);
  }

  return group;
}

export { ROAD_LIFT };
