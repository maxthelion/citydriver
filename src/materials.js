import * as THREE from 'three';

export const materials = {};
export const sharedGeo = {};

export function initMaterials() {
  materials.road = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  materials.roadLine = new THREE.LineBasicMaterial({ color: 0xCCCC44 });
  materials.grass = new THREE.MeshStandardMaterial({ color: 0x3A7D2A, roughness: 0.95 });
  materials.trunk = new THREE.MeshStandardMaterial({ color: 0x5C3A1E });
  materials.leaf1 = new THREE.MeshStandardMaterial({ color: 0x2D6B1E });
  materials.leaf2 = new THREE.MeshStandardMaterial({ color: 0x1E8B1E });
  materials.bench = new THREE.MeshStandardMaterial({ color: 0x6B4226 });
  materials.pole = new THREE.MeshStandardMaterial({ color: 0x555555, metalness: 0.8 });
  materials.streetLight = new THREE.MeshStandardMaterial({ color: 0xFFDD88, emissive: 0xFFAA44, emissiveIntensity: 1.0 });
  materials.window = new THREE.MeshStandardMaterial({ color: 0x88AACC, emissive: 0x334455, emissiveIntensity: 0.3, roughness: 0.2, metalness: 0.8 });
  materials.antenna = new THREE.MeshStandardMaterial({ color: 0x888888, metalness: 0.9 });
  materials.ac = new THREE.MeshStandardMaterial({ color: 0x777777 });

  const buildingColorHexes = {
    residential: [0x8B7355, 0x9C8B6E, 0xA0926B, 0xC4B5A0, 0xBDB0A0],
    commercial:  [0x6B8BA4, 0x7B98B0, 0x5A7A8A, 0x8BAABB, 0x4A6A7A],
    skyscraper:  [0x4A5A6A, 0x5A6A7A, 0x3A4A5A, 0x6A7A8A, 0x2A3A4A]
  };
  materials.building = {};
  for (const [type, colors] of Object.entries(buildingColorHexes)) {
    materials.building[type] = colors.map(c =>
      new THREE.MeshStandardMaterial({ color: c, roughness: 0.8, metalness: 0.1 })
    );
  }
}

export function initGeometries() {
  sharedGeo.pole = new THREE.CylinderGeometry(0.12, 0.12, 7, 4);
  sharedGeo.streetLight = new THREE.SphereGeometry(0.3, 6, 6);
  sharedGeo.antenna = new THREE.CylinderGeometry(0.15, 0.15, 8, 4);
  sharedGeo.ac = new THREE.BoxGeometry(3, 2, 3);
  sharedGeo.bench = new THREE.BoxGeometry(3, 0.8, 1);
  sharedGeo.windowPane = new THREE.PlaneGeometry(2.5, 2.5);
}
