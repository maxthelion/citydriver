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

  // District palettes
  materials.district = {
    downtown_office: [0x4A5A6A, 0x5A6A7A, 0x3A4A5A, 0x2A3A4A].map(c =>
      new THREE.MeshStandardMaterial({ color: c, roughness: 0.3, metalness: 0.6 })),
    highrise_residential: [0xC4A882, 0xB85C38, 0x8B9E6B, 0xD4A76A, 0x7B8FA1].map(c =>
      new THREE.MeshStandardMaterial({ color: c, roughness: 0.8, metalness: 0.1 })),
    shopping_street: [0xE8D8C4, 0xD4C5A0, 0xC9B99A, 0xF5F0E1, 0xBDB0A0].map(c =>
      new THREE.MeshStandardMaterial({ color: c, roughness: 0.8, metalness: 0.1 })),
    market: [0xCC6633, 0xCC3333, 0x3366CC, 0x33CC33].map(c =>
      new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, metalness: 0.0 })),
    suburban_houses: [0xF5F0E1, 0xE8D8C4, 0xC9B99A, 0xD4C5A0].map(c =>
      new THREE.MeshStandardMaterial({ color: c, roughness: 0.85, metalness: 0.05 })),
    industrial: [0x666666, 0x777777, 0x888888, 0x555555].map(c =>
      new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, metalness: 0.3 })),
  };

  materials.roof = [0x8B4513, 0xA0522D, 0x555555, 0x2F4F4F].map(c =>
    new THREE.MeshStandardMaterial({ color: c, roughness: 0.85 }));

  materials.awning = [0xCC2222, 0x22CC22, 0x2244CC, 0xCCAA22, 0xCC6622].map(c =>
    new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, side: THREE.DoubleSide }));

  materials.shopfront = [0x2D6B1E, 0xB83A3A, 0x2A4A8A, 0xC4A832, 0x8B4513].map(c =>
    new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.15, roughness: 0.3, metalness: 0.2 }));

  materials.door = [0x553311, 0x442200, 0x334455, 0x663322, 0x222222].map(c =>
    new THREE.MeshStandardMaterial({ color: c, roughness: 0.7 }));

  materials.lobby = new THREE.MeshStandardMaterial({ color: 0x2A2A2A, roughness: 0.5, metalness: 0.4 });

  materials.canopy = [0xCC6633, 0xCC3333, 0x3366CC, 0x33CC33, 0xCCAA22].map(c =>
    new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, side: THREE.DoubleSide }));
}

export function initGeometries() {
  sharedGeo.pole = new THREE.CylinderGeometry(0.12, 0.12, 7, 4);
  sharedGeo.streetLight = new THREE.SphereGeometry(0.3, 6, 6);
  sharedGeo.antenna = new THREE.CylinderGeometry(0.15, 0.15, 8, 4);
  sharedGeo.ac = new THREE.BoxGeometry(3, 2, 3);
  sharedGeo.bench = new THREE.BoxGeometry(3, 0.8, 1);
  sharedGeo.windowPane = new THREE.PlaneGeometry(2.5, 2.5);
  sharedGeo.door = new THREE.PlaneGeometry(1.2, 2.2);
  sharedGeo.balcony = new THREE.BoxGeometry(2.5, 0.3, 1.0);
  sharedGeo.canopyPole = new THREE.CylinderGeometry(0.08, 0.08, 3, 4);
  sharedGeo.smokestack = new THREE.CylinderGeometry(0.6, 0.8, 12, 6);
  sharedGeo.waterTower = new THREE.CylinderGeometry(1.2, 1.2, 2.5, 6);
  sharedGeo.waterTowerLegs = new THREE.CylinderGeometry(0.1, 0.1, 3, 4);
}
