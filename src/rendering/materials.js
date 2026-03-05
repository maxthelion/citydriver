import * as THREE from 'three';

/**
 * Material registry for building materials derived from geology.
 */

const MATERIAL_COLORS = {
  pale_stone:  0xe8dcc0, // Limestone — warm cream
  warm_stone:  0xc9965e, // Sandstone — warm golden brown
  dark_stone:  0x8a8a8a, // Granite — medium grey
  brick:       0xb85533, // Clay — rich red brick
  flint:       0xa09880, // Chalk — warm grey-brown
};

const cache = new Map();

/**
 * Get a building material by name.
 */
export function getBuildingMaterial(materialName) {
  if (cache.has(materialName)) return cache.get(materialName);

  const color = MATERIAL_COLORS[materialName] || 0xb85533;
  const mat = new THREE.MeshLambertMaterial({ color });
  cache.set(materialName, mat);
  return mat;
}

/**
 * Get a roof material.
 */
export function getRoofMaterial() {
  if (cache.has('roof')) return cache.get('roof');
  const mat = new THREE.MeshLambertMaterial({ color: 0x6b4430 }); // Dark brown/slate
  cache.set('roof', mat);
  return mat;
}

/**
 * Get road material.
 */
export function getRoadMaterial(hierarchy) {
  const key = hierarchy ? `road_${hierarchy}` : 'road';
  if (cache.has(key)) return cache.get(key);
  const colors = {
    arterial: 0x2a2a2a,   // Dark asphalt
    collector: 0x444444,   // Medium gray
    local: 0x666666,       // Lighter gray
  };
  const color = colors[hierarchy] || 0x333333;
  const mat = new THREE.MeshLambertMaterial({
    color,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  cache.set(key, mat);
  return mat;
}

/**
 * Get park/green material.
 */
export function getParkMaterial() {
  if (cache.has('park')) return cache.get('park');
  const mat = new THREE.MeshLambertMaterial({ color: 0x3a7a2a });
  cache.set('park', mat);
  return mat;
}

/**
 * Get river material — semi-transparent blue.
 */
export function getRiverMaterial() {
  if (cache.has('river')) return cache.get('river');
  const mat = new THREE.MeshLambertMaterial({
    color: 0x2255aa,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  cache.set('river', mat);
  return mat;
}
