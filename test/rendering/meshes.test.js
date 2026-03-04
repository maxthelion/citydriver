import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { Heightmap } from '../../src/core/heightmap.js';
import { SeededRandom } from '../../src/core/rng.js';
import { buildRoadMeshes, ROAD_LIFT } from '../../src/rendering/roadMesh.js';
import { buildBuildingMeshes, BUILDING_EXTRA_DEPTH } from '../../src/rendering/buildingMesh.js';
import { buildBridgeMeshes } from '../../src/rendering/bridgeMesh.js';
import { buildParkMeshes } from '../../src/rendering/parkMesh.js';
import { pointInPolygon } from '../../src/core/math.js';

// --- Test helpers ---

function createFlatHeightmap(height = 0) {
  const hm = new Heightmap(32, 32, 5);
  for (let gz = 0; gz < 32; gz++)
    for (let gx = 0; gx < 32; gx++)
      hm.set(gx, gz, height);
  hm.freeze();
  return hm;
}

function createSlopedHeightmap() {
  const hm = new Heightmap(32, 32, 5);
  for (let gz = 0; gz < 32; gz++)
    for (let gx = 0; gx < 32; gx++)
      hm.set(gx, gz, gx * 0.5);  // slope in X
  hm.freeze();
  return hm;
}

function createMockMaterials() {
  return {
    get(_name) { return new THREE.MeshBasicMaterial(); }
  };
}

function makeEdge(id, points, width = 8, hierarchy = 'primary') {
  return { id, from: 0, to: 1, points, width, hierarchy };
}

function makeBuilding(overrides = {}) {
  return {
    x: 40, z: 40,
    w: 10, d: 8, h: 12,
    floors: 3,
    style: 'residential',
    roofType: 'flat',
    landUse: 'residential',
    doorFace: 'front',
    doorPosition: { x: 40, z: 36 },
    rotation: 0,
    wallMaterial: 'building_brick',
    roofMaterial: 'roof_tile',
    color: 0xaa6644,
    isCorner: false,
    isLandmark: false,
    ...overrides,
  };
}

function makeBridge(overrides = {}) {
  return {
    edgeId: 'bridge1',
    startPoint: { x: 20, z: 40 },
    endPoint: { x: 60, z: 40 },
    deckHeight: 15,
    width: 10,
    ...overrides,
  };
}

function makeParkBlock(overrides = {}) {
  return {
    polygon: [
      { x: 20, z: 20 },
      { x: 60, z: 20 },
      { x: 60, z: 60 },
      { x: 20, z: 60 },
    ],
    landUse: 'park',
    centroid: { x: 40, z: 40 },
    ...overrides,
  };
}

/**
 * Extract all vertex positions from a mesh's BufferGeometry.
 * @param {THREE.Mesh} mesh
 * @returns {{x: number, y: number, z: number}[]}
 */
function getVertices(mesh) {
  const pos = mesh.geometry.getAttribute('position');
  const verts = [];
  for (let i = 0; i < pos.count; i++) {
    verts.push({ x: pos.getX(i), y: pos.getY(i), z: pos.getZ(i) });
  }
  return verts;
}

/**
 * Extract face normals from a non-indexed BufferGeometry (3 vertices per face).
 * @param {THREE.Mesh} mesh
 * @returns {{x: number, y: number, z: number}[]}
 */
function getFaceNormals(mesh) {
  const pos = mesh.geometry.getAttribute('position');
  const normals = [];
  for (let i = 0; i < pos.count; i += 3) {
    const ax = pos.getX(i), ay = pos.getY(i), az = pos.getZ(i);
    const bx = pos.getX(i + 1), by = pos.getY(i + 1), bz = pos.getZ(i + 1);
    const cx = pos.getX(i + 2), cy = pos.getY(i + 2), cz = pos.getZ(i + 2);

    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;

    // Cross product e1 x e2
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;

    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 1e-10) {
      normals.push({ x: nx / len, y: ny / len, z: nz / len });
    }
  }
  return normals;
}

/**
 * Recursively find all meshes in a group.
 * @param {THREE.Object3D} obj
 * @returns {THREE.Mesh[]}
 */
function findMeshes(obj) {
  const meshes = [];
  obj.traverse(child => {
    if (child instanceof THREE.Mesh) meshes.push(child);
  });
  return meshes;
}

/**
 * Recursively find meshes by name.
 * @param {THREE.Object3D} obj
 * @param {string} name
 * @returns {THREE.Mesh[]}
 */
function findMeshesByName(obj, name) {
  const meshes = [];
  obj.traverse(child => {
    if (child instanceof THREE.Mesh && child.name === name) meshes.push(child);
  });
  return meshes;
}

// =============================================================================
// Road Mesh Tests
// =============================================================================

describe('buildRoadMeshes', () => {
  it('vertices follow terrain height + ROAD_LIFT', () => {
    const hm = createSlopedHeightmap();
    const materials = createMockMaterials();
    const edges = [
      makeEdge('e1', [
        { x: 10, z: 40 },
        { x: 50, z: 40 },
      ]),
    ];

    const group = buildRoadMeshes(edges, hm, materials);
    const meshes = findMeshes(group);
    expect(meshes.length).toBeGreaterThanOrEqual(1);

    for (const mesh of meshes) {
      const verts = getVertices(mesh);
      for (const v of verts) {
        const expectedY = hm.sample(v.x, v.z) + ROAD_LIFT;
        expect(v.y).toBeCloseTo(expectedY, 0);
      }
    }
  });

  it('normals point upward', () => {
    const hm = createFlatHeightmap(5);
    const materials = createMockMaterials();
    const edges = [
      makeEdge('e1', [
        { x: 10, z: 40 },
        { x: 60, z: 40 },
      ]),
    ];

    const group = buildRoadMeshes(edges, hm, materials);
    const meshes = findMeshes(group);
    expect(meshes.length).toBeGreaterThanOrEqual(1);

    for (const mesh of meshes) {
      const normals = getFaceNormals(mesh);
      for (const n of normals) {
        expect(n.y).toBeGreaterThan(0);
      }
    }
  });

  it('generates one mesh per edge', () => {
    const hm = createFlatHeightmap(0);
    const materials = createMockMaterials();
    const edges = [
      makeEdge('e1', [{ x: 10, z: 20 }, { x: 50, z: 20 }]),
      makeEdge('e2', [{ x: 10, z: 40 }, { x: 50, z: 40 }]),
      makeEdge('e3', [{ x: 10, z: 60 }, { x: 50, z: 60 }]),
    ];

    const group = buildRoadMeshes(edges, hm, materials);
    expect(group.children.length).toBeGreaterThanOrEqual(3);
  });

  it('uses correct material for primary vs secondary', () => {
    const hm = createFlatHeightmap(0);
    const usedNames = [];
    const materials = {
      get(name) {
        usedNames.push(name);
        return new THREE.MeshBasicMaterial();
      }
    };

    const edges = [
      makeEdge('e1', [{ x: 10, z: 20 }, { x: 50, z: 20 }], 8, 'primary'),
      makeEdge('e2', [{ x: 10, z: 40 }, { x: 50, z: 40 }], 6, 'secondary'),
    ];

    buildRoadMeshes(edges, hm, materials);
    expect(usedNames).toContain('road_primary');
    expect(usedNames).toContain('road_secondary');
  });
});

// =============================================================================
// Building Mesh Tests
// =============================================================================

describe('buildBuildingMeshes', () => {
  it('grounds building at correct height on flat terrain', () => {
    const hm = createFlatHeightmap(10);
    const materials = createMockMaterials();
    const buildings = [makeBuilding()];

    const group = buildBuildingMeshes(buildings, hm, materials);
    const bodies = findMeshesByName(group, 'body');
    expect(bodies.length).toBe(1);

    const body = bodies[0];
    // Body is positioned at baseY + (h - EXTRA_DEPTH) / 2 in local space
    // Building group is at (x, 0, z), body Y is in local coords
    const bodyWorldY = body.position.y;
    const expectedY = 10 + (12 - BUILDING_EXTRA_DEPTH) / 2;
    expect(bodyWorldY).toBeCloseTo(expectedY, 1);
  });

  it('grounds building at max corner height on sloped terrain', () => {
    const hm = createSlopedHeightmap();
    const materials = createMockMaterials();

    // Building at x=40, z=40, w=10, d=8
    // Corners in X range: [35, 45] -> heights at grid: 35/5=7 -> 3.5, 45/5=9 -> 4.5
    // Max should be at x=45 -> height = (45/5)*0.5 = 4.5
    const b = makeBuilding({ x: 40, z: 40, w: 10, d: 8 });
    const buildings = [b];

    const group = buildBuildingMeshes(buildings, hm, materials);
    const bodies = findMeshesByName(group, 'body');
    expect(bodies.length).toBe(1);

    // Find the highest terrain point among center + corners
    const samplePoints = [
      { x: 40, z: 40 },
      { x: 35, z: 36 },
      { x: 45, z: 36 },
      { x: 45, z: 44 },
      { x: 35, z: 44 },
    ];
    let maxH = -Infinity;
    for (const p of samplePoints) {
      maxH = Math.max(maxH, hm.sample(p.x, p.z));
    }

    const body = bodies[0];
    const bodyWorldY = body.position.y;
    const expectedY = maxH + (12 - BUILDING_EXTRA_DEPTH) / 2;
    expect(bodyWorldY).toBeCloseTo(expectedY, 1);
  });

  it('has a door mesh', () => {
    const hm = createFlatHeightmap(0);
    const materials = createMockMaterials();
    const buildings = [makeBuilding()];

    const group = buildBuildingMeshes(buildings, hm, materials);
    const doors = findMeshesByName(group, 'door');
    expect(doors.length).toBeGreaterThanOrEqual(1);
  });

  it('body extends below ground by BUILDING_EXTRA_DEPTH', () => {
    const hm = createFlatHeightmap(10);
    const materials = createMockMaterials();
    const b = makeBuilding({ h: 15 });
    const buildings = [b];

    const group = buildBuildingMeshes(buildings, hm, materials);
    const bodies = findMeshesByName(group, 'body');
    expect(bodies.length).toBe(1);

    const body = bodies[0];
    const bodyH = body.geometry.parameters.height;
    expect(bodyH).toBeCloseTo(15 + BUILDING_EXTRA_DEPTH, 1);

    // Body center Y
    const bodyCenterY = body.position.y;
    const baseY = 10; // flat heightmap
    // Bottom of body = centerY - bodyH/2
    const bodyBottom = bodyCenterY - bodyH / 2;
    expect(bodyBottom).toBeCloseTo(baseY - BUILDING_EXTRA_DEPTH, 1);

    // Top of body = centerY + bodyH/2
    const bodyTop = bodyCenterY + bodyH / 2;
    expect(bodyTop).toBeCloseTo(baseY + 15, 1);
  });

  it('generates pitched roof geometry', () => {
    const hm = createFlatHeightmap(0);
    const materials = createMockMaterials();
    const buildings = [makeBuilding({ roofType: 'pitched' })];

    const group = buildBuildingMeshes(buildings, hm, materials);
    const roofs = findMeshesByName(group, 'roof');
    expect(roofs.length).toBe(1);

    // Pitched roof should have vertices above building height
    const roof = roofs[0];
    const verts = getVertices(roof);
    const maxLocalY = Math.max(...verts.map(v => v.y));
    expect(maxLocalY).toBeGreaterThan(0); // roof extends above its position
  });

  it('generates mansard roof geometry', () => {
    const hm = createFlatHeightmap(0);
    const materials = createMockMaterials();
    const buildings = [makeBuilding({ roofType: 'mansard' })];

    const group = buildBuildingMeshes(buildings, hm, materials);
    const roofs = findMeshesByName(group, 'roof');
    expect(roofs.length).toBe(1);
  });

  it('generates sawtooth roof geometry', () => {
    const hm = createFlatHeightmap(0);
    const materials = createMockMaterials();
    const buildings = [makeBuilding({ roofType: 'sawtooth', style: 'industrial' })];

    const group = buildBuildingMeshes(buildings, hm, materials);
    const roofs = findMeshesByName(group, 'roof');
    expect(roofs.length).toBe(1);
  });

  it('does not generate windows for industrial buildings', () => {
    const hm = createFlatHeightmap(0);
    const materials = createMockMaterials();
    const buildings = [makeBuilding({ style: 'industrial', roofType: 'sawtooth' })];

    const group = buildBuildingMeshes(buildings, hm, materials);
    const windows = findMeshesByName(group, 'window');
    expect(windows.length).toBe(0);
  });

  it('generates windows for residential buildings', () => {
    const hm = createFlatHeightmap(0);
    const materials = createMockMaterials();
    const buildings = [makeBuilding({
      style: 'residential',
      w: 12, d: 10, h: 12, floors: 3,
    })];

    const group = buildBuildingMeshes(buildings, hm, materials);
    const windows = findMeshesByName(group, 'window');
    expect(windows.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// Bridge Mesh Tests
// =============================================================================

describe('buildBridgeMeshes', () => {
  it('produces deck and pillars', () => {
    const hm = createFlatHeightmap(0);
    const materials = createMockMaterials();
    const bridges = [makeBridge()];

    const group = buildBridgeMeshes(bridges, hm, materials);
    expect(group.children.length).toBeGreaterThanOrEqual(1);

    const bridgeGroup = group.children[0];
    const allMeshes = findMeshes(bridgeGroup);
    // Should have at least deck + 2 railings + 2 pillars = 5
    expect(allMeshes.length).toBeGreaterThanOrEqual(2);

    const decks = findMeshesByName(bridgeGroup, 'deck');
    expect(decks.length).toBe(1);

    const pillars = findMeshesByName(bridgeGroup, 'pillar');
    expect(pillars.length).toBeGreaterThanOrEqual(2);
  });

  it('deck is at the specified deckHeight', () => {
    const hm = createFlatHeightmap(0);
    const materials = createMockMaterials();
    const deckHeight = 20;
    const bridges = [makeBridge({ deckHeight })];

    const group = buildBridgeMeshes(bridges, hm, materials);
    const decks = findMeshesByName(group, 'deck');
    expect(decks.length).toBe(1);

    expect(decks[0].position.y).toBeCloseTo(deckHeight, 1);
  });

  it('has railings on both sides', () => {
    const hm = createFlatHeightmap(0);
    const materials = createMockMaterials();
    const bridges = [makeBridge()];

    const group = buildBridgeMeshes(bridges, hm, materials);
    const leftRails = findMeshesByName(group, 'railing_left');
    const rightRails = findMeshesByName(group, 'railing_right');
    expect(leftRails.length).toBe(1);
    expect(rightRails.length).toBe(1);
  });

  it('pillar height spans from terrain to deck underside', () => {
    const hm = createFlatHeightmap(5);
    const materials = createMockMaterials();
    const deckHeight = 20;
    const bridges = [makeBridge({ deckHeight })];

    const group = buildBridgeMeshes(bridges, hm, materials);
    const pillars = findMeshesByName(group, 'pillar');
    expect(pillars.length).toBeGreaterThanOrEqual(2);

    for (const pillar of pillars) {
      const pillarH = pillar.geometry.parameters.height;
      // Pillar should span from terrain (5) to deck underside (20 - 0.25)
      const expectedH = deckHeight - 0.25 - 5;
      expect(pillarH).toBeCloseTo(expectedH, 0);
    }
  });
});

// =============================================================================
// Park Mesh Tests
// =============================================================================

describe('buildParkMeshes', () => {
  it('tree trunks are at ground level', () => {
    const hm = createFlatHeightmap(7);
    const materials = createMockMaterials();
    const rng = new SeededRandom(42);
    const parks = [makeParkBlock()];

    const group = buildParkMeshes(parks, hm, materials, rng);
    const trees = findMeshesByName(group, 'tree');

    // We may not find 'tree' by name since it's a group, so look for tree groups
    const treeGroups = [];
    group.traverse(child => {
      if (child.name === 'tree' && child instanceof THREE.Group) {
        treeGroups.push(child);
      }
    });

    expect(treeGroups.length).toBeGreaterThan(0);

    for (const tree of treeGroups) {
      const treeWorldY = tree.position.y;
      const expectedY = hm.sample(tree.position.x, tree.position.z);
      expect(treeWorldY).toBeCloseTo(expectedY, 0);
    }
  });

  it('trees are within the park block polygon', () => {
    const hm = createFlatHeightmap(0);
    const materials = createMockMaterials();
    const rng = new SeededRandom(123);
    const polygon = [
      { x: 20, z: 20 },
      { x: 80, z: 20 },
      { x: 80, z: 80 },
      { x: 20, z: 80 },
    ];
    const parks = [makeParkBlock({ polygon, centroid: { x: 50, z: 50 } })];

    const group = buildParkMeshes(parks, hm, materials, rng);

    const treeGroups = [];
    group.traverse(child => {
      if (child.name === 'tree' && child instanceof THREE.Group) {
        treeGroups.push(child);
      }
    });

    expect(treeGroups.length).toBeGreaterThan(0);

    for (const tree of treeGroups) {
      const inside = pointInPolygon(tree.position.x, tree.position.z, polygon);
      expect(inside).toBe(true);
    }
  });

  it('generates benches near edges', () => {
    const hm = createFlatHeightmap(3);
    const materials = createMockMaterials();
    const rng = new SeededRandom(99);
    const parks = [makeParkBlock()];

    const group = buildParkMeshes(parks, hm, materials, rng);
    const benches = findMeshesByName(group, 'bench');
    expect(benches.length).toBeGreaterThanOrEqual(2);

    for (const bench of benches) {
      // Bench Y should be groundY + 0.25
      const expectedY = hm.sample(bench.position.x, bench.position.z) + 0.25;
      expect(bench.position.y).toBeCloseTo(expectedY, 1);
    }
  });

  it('generates trees on sloped terrain at correct heights', () => {
    const hm = createSlopedHeightmap();
    const materials = createMockMaterials();
    const rng = new SeededRandom(77);
    const parks = [makeParkBlock()];

    const group = buildParkMeshes(parks, hm, materials, rng);

    const treeGroups = [];
    group.traverse(child => {
      if (child.name === 'tree' && child instanceof THREE.Group) {
        treeGroups.push(child);
      }
    });

    for (const tree of treeGroups) {
      const expectedY = hm.sample(tree.position.x, tree.position.z);
      expect(tree.position.y).toBeCloseTo(expectedY, 0);
    }
  });
});
