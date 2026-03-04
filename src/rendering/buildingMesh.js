import * as THREE from 'three';
import { getBuildingMaterial, getRoofMaterial } from './materials.js';

/**
 * Build 3D meshes for all buildings.
 * Each building is a box oriented along its longest footprint edge, with a pitched roof.
 *
 * @param {Array} buildings
 * @returns {THREE.Group}
 */
export function buildBuildingMeshes(buildings) {
  const group = new THREE.Group();

  for (const b of buildings) {
    if (!b.footprint || b.footprint.length < 3) continue;

    // Find the oriented bounding box: use longest edge for orientation
    const { cx, cz, width, depth, angle } = orientedBBox(b.footprint);
    const height = b.height || 6;
    const groundY = b.groundHeight || 0;

    if (width < 1 || depth < 1) continue;

    const wallMat = getBuildingMaterial(b.material || 'brick');
    const roofMat = getRoofMaterial();

    // Wall box
    const wallGeom = new THREE.BoxGeometry(width, height, depth);
    const wall = new THREE.Mesh(wallGeom, wallMat);
    wall.position.set(cx, groundY + height / 2, cz);
    wall.rotation.y = angle;
    group.add(wall);

    // Pitched roof
    const roofHeight = Math.min(width, depth) * 0.35;
    const roofGeom = new THREE.ConeGeometry(
      Math.max(width, depth) * 0.55,
      roofHeight,
      4,
    );
    roofGeom.rotateY(Math.PI / 4);
    const roof = new THREE.Mesh(roofGeom, roofMat);
    roof.position.set(cx, groundY + height + roofHeight / 2, cz);
    roof.rotation.y = angle;
    roof.scale.set(1, 1, depth / width || 1);
    group.add(roof);
  }

  return group;
}

/**
 * Compute an oriented bounding box from footprint vertices.
 * Uses the longest edge to determine the main axis.
 */
function orientedBBox(vertices) {
  // Find longest edge
  let bestLen = 0;
  let bestDx = 1;
  let bestDz = 0;

  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = dx * dx + dz * dz;
    if (len > bestLen) {
      bestLen = len;
      bestDx = dx;
      bestDz = dz;
    }
  }

  const angle = Math.atan2(bestDx, bestDz);
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);

  // Rotate all points to axis-aligned space
  let minU = Infinity, maxU = -Infinity;
  let minV = Infinity, maxV = -Infinity;
  let sumX = 0, sumZ = 0;

  for (const v of vertices) {
    sumX += v.x;
    sumZ += v.z;
    const u = v.x * cos - v.z * sin;
    const vv = v.x * sin + v.z * cos;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (vv < minV) minV = vv;
    if (vv > maxV) maxV = vv;
  }

  const cx = sumX / vertices.length;
  const cz = sumZ / vertices.length;
  const width = maxU - minU;
  const depth = maxV - minV;

  return { cx, cz, width, depth, angle };
}
