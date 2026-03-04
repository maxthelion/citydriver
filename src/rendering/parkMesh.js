import * as THREE from 'three';
import { getParkMaterial } from './materials.js';

/**
 * Build park markers/areas.
 *
 * @param {Array} amenities
 * @param {import('../core/Grid2D.js').Grid2D} elevation
 * @returns {THREE.Group}
 */
export function buildParkMeshes(amenities, elevation) {
  const group = new THREE.Group();
  const material = getParkMaterial();

  for (const a of amenities) {
    if (a.type !== 'park') continue;

    // Park coords are in local space, convert to grid indices
    const cs = elevation ? elevation.cellSize : 10;
    const y = elevation ? elevation.sample(a.x / cs, a.z / cs) + 0.1 : 0.1;
    const radius = a.radius || 30;

    const geom = new THREE.CircleGeometry(radius, 16);
    geom.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geom, material);
    mesh.position.set(a.x, y, a.z);
    group.add(mesh);
  }

  return group;
}
