import * as THREE from 'three';

/**
 * MaterialRegistry -- creates and manages all shared Three.js materials.
 * Materials are created once in the constructor and reused across all meshes
 * to reduce GPU state changes.
 *
 * Usage:
 *   const materials = new MaterialRegistry();
 *   const mat = materials.get('terrain'); // throws if name not found
 *   materials.dispose(); // free all GPU resources
 */
export class MaterialRegistry {
  constructor() {
    /** @type {Map<string, THREE.Material>} */
    this._materials = new Map();
    this._init();
  }

  _init() {
    const m = this._materials;

    // Terrain -- vertex colors enabled so elevation coloring works
    m.set('terrain', new THREE.MeshLambertMaterial({ vertexColors: true }));

    // Roads
    m.set('road_primary', new THREE.MeshLambertMaterial({
      color: 0x333333,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }));
    m.set('road_secondary', new THREE.MeshLambertMaterial({
      color: 0x555555,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }));

    // Water
    m.set('water', new THREE.MeshLambertMaterial({
      color: 0x2266aa,
      transparent: true,
      opacity: 0.7,
    }));

    // Nature
    m.set('grass', new THREE.MeshLambertMaterial({ color: 0x44aa44 }));

    // Building walls
    m.set('building_brick', new THREE.MeshLambertMaterial({ color: 0xaa6644 }));
    m.set('building_stone', new THREE.MeshLambertMaterial({ color: 0xbbaa99 }));
    m.set('building_concrete', new THREE.MeshLambertMaterial({ color: 0x999999 }));
    m.set('building_glass', new THREE.MeshLambertMaterial({
      color: 0x88bbdd,
      transparent: true,
      opacity: 0.6,
    }));
    m.set('building_white', new THREE.MeshLambertMaterial({ color: 0xeeeedd }));

    // Roofs
    m.set('roof_slate', new THREE.MeshLambertMaterial({ color: 0x556666 }));
    m.set('roof_tile', new THREE.MeshLambertMaterial({ color: 0xcc7755 }));
    m.set('roof_flat', new THREE.MeshLambertMaterial({ color: 0x777777 }));

    // Building details
    m.set('door', new THREE.MeshLambertMaterial({ color: 0x664422 }));
    m.set('window', new THREE.MeshLambertMaterial({
      color: 0xaaccee,
      emissive: new THREE.Color(0x223344),
    }));

    // Car
    m.set('car_body', new THREE.MeshLambertMaterial({ color: 0xcc2222 }));
    m.set('car_glass', new THREE.MeshLambertMaterial({
      color: 0x88bbdd,
      transparent: true,
      opacity: 0.5,
    }));
    m.set('car_wheel', new THREE.MeshLambertMaterial({ color: 0x222222 }));
    m.set('car_headlight', new THREE.MeshLambertMaterial({
      color: 0xffff88,
      emissive: new THREE.Color(0xffff44),
    }));
    m.set('car_taillight', new THREE.MeshLambertMaterial({
      color: 0xff2222,
      emissive: new THREE.Color(0xff0000),
    }));

    // Trees
    m.set('tree_trunk', new THREE.MeshLambertMaterial({ color: 0x665533 }));
    m.set('tree_canopy', new THREE.MeshLambertMaterial({ color: 0x338833 }));

    // Bridge
    m.set('bridge', new THREE.MeshLambertMaterial({ color: 0x888888 }));
  }

  /**
   * Get a material by name. Throws if not found (catches typos early).
   * @param {string} name
   * @returns {THREE.Material}
   */
  get(name) {
    const mat = this._materials.get(name);
    if (!mat) {
      throw new Error(`MaterialRegistry: unknown material "${name}"`);
    }
    return mat;
  }

  /**
   * Dispose all materials to free GPU memory.
   */
  dispose() {
    for (const mat of this._materials.values()) {
      mat.dispose();
    }
    this._materials.clear();
  }
}
