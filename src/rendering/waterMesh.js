import * as THREE from 'three';

/**
 * Build a flat water surface mesh at sea level.
 * Covers the full map extent. Terrain that is above seaLevel will poke through
 * the water plane naturally, so no masking is needed.
 *
 * @param {import('../core/heightmap.js').Heightmap} heightmap - for world bounds
 * @param {number} seaLevel - Y position of the water surface
 * @param {import('./materials.js').MaterialRegistry} materials
 * @returns {THREE.Mesh}
 */
export function buildWaterMesh(heightmap, seaLevel, materials) {
  const geometry = new THREE.PlaneGeometry(
    heightmap.worldWidth,
    heightmap.worldHeight,
    1,
    1
  );

  // PlaneGeometry is created in XY. Rotate to lie flat in XZ.
  geometry.rotateX(-Math.PI / 2);

  const mesh = new THREE.Mesh(geometry, materials.get('water'));

  // Position at center of the map at seaLevel height.
  // Heightmap world coords go from 0 to worldWidth/worldHeight,
  // so center is at half-extents.
  mesh.position.set(
    heightmap.worldWidth / 2,
    seaLevel,
    heightmap.worldHeight / 2
  );

  return mesh;
}
