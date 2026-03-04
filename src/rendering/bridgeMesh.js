import * as THREE from 'three';

const DECK_THICKNESS = 0.5;
const RAILING_HEIGHT = 1.0;
const RAILING_WIDTH = 0.2;
const PILLAR_WIDTH = 1.5;
const PILLAR_DEPTH = 1.0;

/**
 * Build bridge meshes.
 * @param {Array} bridges
 * @param {import('../core/heightmap.js').Heightmap} heightmap
 * @param {import('./materials.js').MaterialRegistry} materials
 * @returns {THREE.Group}
 */
export function buildBridgeMeshes(bridges, heightmap, materials) {
  const group = new THREE.Group();
  group.name = 'bridges';

  const bridgeMat = materials.get('bridge');

  for (const bridge of bridges) {
    const bridgeGroup = new THREE.Group();
    bridgeGroup.name = `bridge_${bridge.edgeId || ''}`;

    const sx = bridge.startPoint.x;
    const sz = bridge.startPoint.z;
    const ex = bridge.endPoint.x;
    const ez = bridge.endPoint.z;

    const dx = ex - sx;
    const dz = ez - sz;
    const length = Math.sqrt(dx * dx + dz * dz);
    if (length < 1e-6) continue;

    const midX = (sx + ex) / 2;
    const midZ = (sz + ez) / 2;
    const angle = Math.atan2(dx, dz); // rotation around Y to align with bridge direction

    const width = bridge.width || 10;
    const deckY = bridge.deckHeight;

    // --- Deck ---
    const deckGeom = new THREE.BoxGeometry(width, DECK_THICKNESS, length);
    const deckMesh = new THREE.Mesh(deckGeom, bridgeMat);
    deckMesh.position.set(midX, deckY, midZ);
    deckMesh.rotation.y = angle;
    deckMesh.castShadow = true;
    deckMesh.receiveShadow = true;
    deckMesh.name = 'deck';
    bridgeGroup.add(deckMesh);

    // --- Railings ---
    const railGeom = new THREE.BoxGeometry(RAILING_WIDTH, RAILING_HEIGHT, length);

    // Left railing
    const leftRail = new THREE.Mesh(railGeom, bridgeMat);
    leftRail.name = 'railing_left';
    const halfW = width / 2;
    // Offset perpendicular to bridge direction
    const perpX = -Math.cos(angle);
    const perpZ = Math.sin(angle);

    leftRail.position.set(
      midX + perpX * halfW,
      deckY + DECK_THICKNESS / 2 + RAILING_HEIGHT / 2,
      midZ + perpZ * halfW
    );
    leftRail.rotation.y = angle;
    bridgeGroup.add(leftRail);

    // Right railing
    const rightRail = new THREE.Mesh(railGeom, bridgeMat);
    rightRail.name = 'railing_right';
    rightRail.position.set(
      midX - perpX * halfW,
      deckY + DECK_THICKNESS / 2 + RAILING_HEIGHT / 2,
      midZ - perpZ * halfW
    );
    rightRail.rotation.y = angle;
    bridgeGroup.add(rightRail);

    // --- Support pillars ---
    // Space pillars evenly along the bridge
    const numPillars = Math.max(2, Math.ceil(length / 20));
    const dirX = dx / length;
    const dirZ = dz / length;

    for (let i = 0; i < numPillars; i++) {
      const t = (i + 0.5) / numPillars; // distribute evenly
      const px = sx + dx * t;
      const pz = sz + dz * t;

      const terrainY = heightmap.sample(px, pz);
      const pillarH = Math.max(0.5, deckY - DECK_THICKNESS / 2 - terrainY);

      const pillarGeom = new THREE.BoxGeometry(PILLAR_WIDTH, pillarH, PILLAR_DEPTH);
      const pillarMesh = new THREE.Mesh(pillarGeom, bridgeMat);
      pillarMesh.position.set(
        px,
        terrainY + pillarH / 2,
        pz
      );
      pillarMesh.rotation.y = angle;
      pillarMesh.castShadow = true;
      pillarMesh.name = 'pillar';
      bridgeGroup.add(pillarMesh);
    }

    group.add(bridgeGroup);
  }

  return group;
}
