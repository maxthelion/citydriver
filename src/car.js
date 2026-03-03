import * as THREE from 'three';

export function createCar() {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0xCC2222, roughness: 0.3, metalness: 0.7 });

  const lower = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.6, 4.5), bodyMat);
  lower.position.y = 0.5;
  lower.castShadow = true;
  group.add(lower);

  const glassMat = new THREE.MeshStandardMaterial({ color: 0x88CCFF, roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.6 });
  const upper = new THREE.Mesh(new THREE.BoxGeometry(2, 0.6, 2.2), glassMat);
  upper.position.set(0, 1.1, -0.3);
  upper.castShadow = true;
  group.add(upper);

  const wheelGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.3, 12);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.8 });
  group.wheels = [];
  for (const [wx, wy, wz] of [[-1.1, 0.35, 1.3], [1.1, 0.35, 1.3], [-1.1, 0.35, -1.3], [1.1, 0.35, -1.3]]) {
    const wheel = new THREE.Mesh(wheelGeo, wheelMat);
    wheel.position.set(wx, wy, wz);
    wheel.rotation.z = Math.PI / 2;
    wheel.castShadow = true;
    group.add(wheel);
    group.wheels.push(wheel);
  }

  const hlMat = new THREE.MeshStandardMaterial({ color: 0xFFFF99, emissive: 0xFFFF44, emissiveIntensity: 0.8 });
  for (const side of [-0.7, 0.7]) {
    const hl = new THREE.Mesh(new THREE.SphereGeometry(0.15, 6, 6), hlMat);
    hl.position.set(side, 0.6, 2.3);
    group.add(hl);
  }

  const tlMat = new THREE.MeshStandardMaterial({ color: 0xFF2222, emissive: 0xFF0000, emissiveIntensity: 0.5 });
  for (const side of [-0.8, 0.8]) {
    const tl = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 6), tlMat);
    tl.position.set(side, 0.6, -2.2);
    group.add(tl);
  }

  return group;
}
