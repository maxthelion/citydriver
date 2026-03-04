import * as THREE from 'three';

const BUILDING_EXTRA_DEPTH = 8; // extra depth below ground to hide gaps on slopes

/**
 * Compute the four footprint corners of a building in world space.
 * @param {number} cx - center x
 * @param {number} cz - center z
 * @param {number} w - width
 * @param {number} d - depth
 * @param {number} rotation - rotation around Y axis in radians
 * @returns {{x: number, z: number}[]}
 */
function getFootprintCorners(cx, cz, w, d, rotation) {
  const halfW = w / 2;
  const halfD = d / 2;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  // Local corners (before rotation)
  const local = [
    { x: -halfW, z: -halfD },
    { x: halfW, z: -halfD },
    { x: halfW, z: halfD },
    { x: -halfW, z: halfD },
  ];

  return local.map(p => ({
    x: cx + p.x * cos - p.z * sin,
    z: cz + p.x * sin + p.z * cos,
  }));
}

/**
 * Compute the base Y for a building: maximum heightmap value at center + 4 corners.
 * @param {object} building
 * @param {import('../core/heightmap.js').Heightmap} heightmap
 * @returns {number}
 */
function computeBaseY(building, heightmap) {
  const corners = getFootprintCorners(
    building.x, building.z,
    building.w, building.d,
    building.rotation || 0
  );

  let maxH = heightmap.sample(building.x, building.z);
  for (const c of corners) {
    const h = heightmap.sample(c.x, c.z);
    if (h > maxH) maxH = h;
  }
  return maxH;
}

/**
 * Build a pitched (gable) roof using direct vertex construction.
 * Ridge runs along the local X axis (width dimension).
 * @param {number} w - building width
 * @param {number} d - building depth
 * @param {number} ridgeH - ridge height above building top
 * @returns {THREE.BufferGeometry}
 */
function buildPitchedRoof(w, d, ridgeH) {
  const halfW = w / 2;
  const halfD = d / 2;

  // Vertices in local space, Y=0 is the building top
  // Ridge line runs along X at Y=ridgeH, Z=0
  //
  // Slope faces:
  //   Front slope: (-halfW,0,-halfD), (halfW,0,-halfD), (halfW,ridgeH,0), (-halfW,ridgeH,0)
  //   Back slope:  (-halfW,ridgeH,0), (halfW,ridgeH,0), (halfW,0,halfD), (-halfW,0,halfD)
  // Gable ends:
  //   Left gable:  (-halfW,0,-halfD), (-halfW,ridgeH,0), (-halfW,0,halfD)
  //   Right gable: (halfW,0,-halfD), (halfW,0,halfD), (halfW,ridgeH,0)

  const positions = [];

  // Front slope (2 triangles)
  positions.push(
    -halfW, 0, -halfD,
    halfW, ridgeH, 0,
    halfW, 0, -halfD,

    -halfW, 0, -halfD,
    -halfW, ridgeH, 0,
    halfW, ridgeH, 0,
  );

  // Back slope (2 triangles)
  positions.push(
    -halfW, ridgeH, 0,
    -halfW, 0, halfD,
    halfW, 0, halfD,

    -halfW, ridgeH, 0,
    halfW, 0, halfD,
    halfW, ridgeH, 0,
  );

  // Left gable (1 triangle)
  positions.push(
    -halfW, 0, -halfD,
    -halfW, 0, halfD,
    -halfW, ridgeH, 0,
  );

  // Right gable (1 triangle)
  positions.push(
    halfW, 0, -halfD,
    halfW, ridgeH, 0,
    halfW, 0, halfD,
  );

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.computeVertexNormals();
  return geom;
}

/**
 * Build a mansard roof using direct vertex construction.
 * Lower steep section (~70 degrees) and upper shallow section (~20 degrees).
 * @param {number} w - building width
 * @param {number} d - building depth
 * @param {number} totalH - total roof height
 * @returns {THREE.BufferGeometry}
 */
function buildMansardRoof(w, d, totalH) {
  const halfW = w / 2;
  const halfD = d / 2;

  // Lower section is 60% of height, upper is 40%
  const lowerH = totalH * 0.6;
  const upperH = totalH * 0.4;

  // Lower section inset: steep angle (~70 deg from horizontal)
  // tan(70) ~ 2.75, but we use a fraction of the depth
  const lowerInset = lowerH / 2.75; // how far in the lower section goes

  // Upper ridge inset from lower break
  const upperInset = (halfD - lowerInset) * 0.3; // slight additional inset for top

  const breakD = halfD - lowerInset;
  const ridgeD = breakD - upperInset;

  const positions = [];

  // Front lower (2 triangles) - from base edge to break line
  positions.push(
    -halfW, 0, -halfD,
    halfW, lowerH, -breakD,
    halfW, 0, -halfD,

    -halfW, 0, -halfD,
    -halfW, lowerH, -breakD,
    halfW, lowerH, -breakD,
  );

  // Front upper (2 triangles) - from break line to ridge
  positions.push(
    -halfW, lowerH, -breakD,
    halfW, totalH, 0,
    halfW, lowerH, -breakD,

    -halfW, lowerH, -breakD,
    -halfW, totalH, 0,
    halfW, totalH, 0,
  );

  // Back lower (2 triangles)
  positions.push(
    -halfW, lowerH, breakD,
    -halfW, 0, halfD,
    halfW, 0, halfD,

    -halfW, lowerH, breakD,
    halfW, 0, halfD,
    halfW, lowerH, breakD,
  );

  // Back upper (2 triangles)
  positions.push(
    -halfW, totalH, 0,
    -halfW, lowerH, breakD,
    halfW, lowerH, breakD,

    -halfW, totalH, 0,
    halfW, lowerH, breakD,
    halfW, totalH, 0,
  );

  // Left gable - lower triangle
  positions.push(
    -halfW, 0, -halfD,
    -halfW, 0, halfD,
    -halfW, lowerH, -breakD,
  );
  positions.push(
    -halfW, lowerH, -breakD,
    -halfW, 0, halfD,
    -halfW, lowerH, breakD,
  );
  // Left gable - upper triangle
  positions.push(
    -halfW, lowerH, -breakD,
    -halfW, lowerH, breakD,
    -halfW, totalH, 0,
  );

  // Right gable - lower triangle
  positions.push(
    halfW, 0, -halfD,
    halfW, lowerH, -breakD,
    halfW, 0, halfD,
  );
  positions.push(
    halfW, lowerH, -breakD,
    halfW, lowerH, breakD,
    halfW, 0, halfD,
  );
  // Right gable - upper triangle
  positions.push(
    halfW, lowerH, -breakD,
    halfW, totalH, 0,
    halfW, lowerH, breakD,
  );

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.computeVertexNormals();
  return geom;
}

/**
 * Build a sawtooth roof using direct vertex construction.
 * @param {number} w - building width
 * @param {number} d - building depth
 * @param {number} toothH - height of each tooth
 * @returns {THREE.BufferGeometry}
 */
function buildSawtoothRoof(w, d, toothH) {
  const halfW = w / 2;
  const numTeeth = Math.max(1, Math.ceil(d / 8));
  const toothD = d / numTeeth;

  const positions = [];

  for (let t = 0; t < numTeeth; t++) {
    const z0 = -d / 2 + t * toothD;
    const z1 = z0 + toothD;

    // Each tooth: vertical face on front, angled face sloping back
    // Vertical face (glazed) at z0, from Y=0 to Y=toothH
    // 2 triangles for vertical face
    positions.push(
      -halfW, 0, z0,
      halfW, 0, z0,
      halfW, toothH, z0,

      -halfW, 0, z0,
      halfW, toothH, z0,
      -halfW, toothH, z0,
    );

    // Angled face from top of vertical (z0, toothH) down to bottom of next (z1, 0)
    // 2 triangles
    positions.push(
      -halfW, toothH, z0,
      halfW, toothH, z0,
      halfW, 0, z1,

      -halfW, toothH, z0,
      halfW, 0, z1,
      -halfW, 0, z1,
    );
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.computeVertexNormals();
  return geom;
}

/**
 * Determine which face index (0-3) the door is on based on doorFace.
 * 0 = front (-Z), 1 = right (+X), 2 = back (+Z), 3 = left (-X)
 * @param {string} doorFace
 * @returns {number}
 */
function doorFaceIndex(doorFace) {
  switch (doorFace) {
    case 'right': return 1;
    case 'back': return 2;
    case 'left': return 3;
    default: return 0; // front
  }
}

/**
 * Build all building meshes.
 * @param {Array} buildings
 * @param {import('../core/heightmap.js').Heightmap} heightmap
 * @param {import('./materials.js').MaterialRegistry} materials
 * @returns {THREE.Group}
 */
export function buildBuildingMeshes(buildings, heightmap, materials) {
  const group = new THREE.Group();
  group.name = 'buildings';

  for (const b of buildings) {
    const buildingGroup = new THREE.Group();
    buildingGroup.name = `building_${b.style || 'default'}`;

    const rotation = b.rotation || 0;
    const baseY = computeBaseY(b, heightmap);
    const totalBodyH = b.h + BUILDING_EXTRA_DEPTH;

    // --- Body ---
    const bodyGeom = new THREE.BoxGeometry(b.w, totalBodyH, b.d);
    const wallMatName = b.wallMaterial || 'building_brick';
    const bodyMesh = new THREE.Mesh(bodyGeom, materials.get(wallMatName));
    bodyMesh.position.set(0, baseY + (b.h - BUILDING_EXTRA_DEPTH) / 2, 0);
    bodyMesh.castShadow = true;
    bodyMesh.receiveShadow = true;
    bodyMesh.name = 'body';
    buildingGroup.add(bodyMesh);

    // --- Roof ---
    const roofType = b.roofType || 'flat';
    let roofMesh = null;

    if (roofType === 'pitched') {
      const ridgeH = b.d * 0.3;
      const roofGeom = buildPitchedRoof(b.w, b.d, ridgeH);
      const roofMatName = b.roofMaterial || 'roof_tile';
      roofMesh = new THREE.Mesh(roofGeom, materials.get(roofMatName));
      roofMesh.position.set(0, baseY + b.h, 0);
      roofMesh.name = 'roof';
    } else if (roofType === 'mansard') {
      const totalRoofH = b.d * 0.35;
      const roofGeom = buildMansardRoof(b.w, b.d, totalRoofH);
      const roofMatName = b.roofMaterial || 'roof_slate';
      roofMesh = new THREE.Mesh(roofGeom, materials.get(roofMatName));
      roofMesh.position.set(0, baseY + b.h, 0);
      roofMesh.name = 'roof';
    } else if (roofType === 'sawtooth') {
      const toothH = 2.5;
      const roofGeom = buildSawtoothRoof(b.w, b.d, toothH);
      const roofMatName = b.roofMaterial || 'roof_flat';
      roofMesh = new THREE.Mesh(roofGeom, materials.get(roofMatName));
      roofMesh.position.set(0, baseY + b.h, 0);
      roofMesh.name = 'roof';
    }
    // 'flat' -> no extra roof geometry

    if (roofMesh) {
      roofMesh.castShadow = true;
      buildingGroup.add(roofMesh);
    }

    // --- Door ---
    const doorW = 1.0;
    const doorH = 2.2;
    const doorD = 0.15;
    const doorGeom = new THREE.BoxGeometry(doorW, doorH, doorD);
    const doorMesh = new THREE.Mesh(doorGeom, materials.get('door'));
    doorMesh.name = 'door';

    // Position door: if doorPosition is given, use it directly in local space
    // Otherwise, place on front face
    const faceIdx = doorFaceIndex(b.doorFace);
    const doorOffset = 0.05; // offset from wall to prevent z-fighting
    let doorLocalX = 0;
    let doorLocalZ = 0;
    let doorRotY = 0;

    if (b.doorPosition) {
      // doorPosition is in world space; convert to local
      const cos = Math.cos(-rotation);
      const sin = Math.sin(-rotation);
      const relX = b.doorPosition.x - b.x;
      const relZ = b.doorPosition.z - b.z;
      doorLocalX = relX * cos - relZ * sin;
      doorLocalZ = relX * sin + relZ * cos;
    }

    // Place door on the correct face
    switch (faceIdx) {
      case 0: // front (-Z)
        doorLocalZ = -b.d / 2 - doorOffset;
        doorRotY = 0;
        break;
      case 1: // right (+X)
        doorLocalX = b.w / 2 + doorOffset;
        doorRotY = Math.PI / 2;
        break;
      case 2: // back (+Z)
        doorLocalZ = b.d / 2 + doorOffset;
        doorRotY = Math.PI;
        break;
      case 3: // left (-X)
        doorLocalX = -b.w / 2 - doorOffset;
        doorRotY = -Math.PI / 2;
        break;
    }

    doorMesh.position.set(doorLocalX, baseY + doorH / 2, doorLocalZ);
    doorMesh.rotation.y = doorRotY;
    buildingGroup.add(doorMesh);

    // --- Windows ---
    if (b.style !== 'industrial') {
      const windowW = 1.0;
      const windowH = 1.4;
      const windowD = 0.1;
      const windowGeom = new THREE.BoxGeometry(windowW, windowH, windowD);
      const windowMat = materials.get('window');
      const floorH = 3.2;
      const numFloors = b.floors || Math.max(1, Math.floor(b.h / floorH));
      const windowSpacing = 3.5;

      // Generate windows on each face
      const faces = [
        { axis: 'z', sign: -1, span: b.w, depth: b.d, fIdx: 0 }, // front
        { axis: 'x', sign: 1, span: b.d, depth: b.w, fIdx: 1 },  // right
        { axis: 'z', sign: 1, span: b.w, depth: b.d, fIdx: 2 },  // back
        { axis: 'x', sign: -1, span: b.d, depth: b.w, fIdx: 3 }, // left
      ];

      for (const face of faces) {
        const numWindows = Math.max(0, Math.floor((face.span - 1) / windowSpacing));
        if (numWindows === 0) continue;

        const totalWindowSpan = (numWindows - 1) * windowSpacing;
        const startOffset = -totalWindowSpan / 2;

        for (let floor = 0; floor < numFloors; floor++) {
          // Skip ground floor on the door face
          if (floor === 0 && face.fIdx === faceIdx) continue;

          const wy = baseY + floorH * (floor + 0.5) + windowH / 2;
          if (wy + windowH / 2 > baseY + b.h) continue;

          for (let wi = 0; wi < numWindows; wi++) {
            const along = startOffset + wi * windowSpacing;
            const winMesh = new THREE.Mesh(windowGeom, windowMat);
            winMesh.name = 'window';

            if (face.axis === 'z') {
              winMesh.position.set(
                along,
                wy,
                face.sign * (b.d / 2 + 0.05)
              );
              winMesh.rotation.y = face.sign < 0 ? 0 : Math.PI;
            } else {
              winMesh.position.set(
                face.sign * (b.w / 2 + 0.05),
                wy,
                along
              );
              winMesh.rotation.y = face.sign > 0 ? Math.PI / 2 : -Math.PI / 2;
            }

            buildingGroup.add(winMesh);
          }
        }
      }
    }

    // Apply building rotation and position
    buildingGroup.position.set(b.x, 0, b.z);
    buildingGroup.rotation.y = rotation;

    group.add(buildingGroup);
  }

  return group;
}

export { BUILDING_EXTRA_DEPTH };
