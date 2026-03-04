import * as THREE from 'three';
import { pointInPolygon } from '../core/math.js';

/**
 * Compute the axis-aligned bounding box of a polygon.
 * @param {{x: number, z: number}[]} polygon
 * @returns {{minX: number, maxX: number, minZ: number, maxZ: number}}
 */
function polygonBounds(polygon) {
  let minX = Infinity, maxX = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (const p of polygon) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  return { minX, maxX, minZ, maxZ };
}

/**
 * Generate a random point inside a polygon using rejection sampling.
 * @param {{x: number, z: number}[]} polygon
 * @param {import('../core/rng.js').SeededRandom} rng
 * @param {number} maxAttempts
 * @returns {{x: number, z: number} | null}
 */
function randomPointInPolygon(polygon, rng, maxAttempts = 50) {
  const { minX, maxX, minZ, maxZ } = polygonBounds(polygon);

  for (let i = 0; i < maxAttempts; i++) {
    const x = rng.range(minX, maxX);
    const z = rng.range(minZ, maxZ);
    if (pointInPolygon(x, z, polygon)) {
      return { x, z };
    }
  }
  return null;
}

/**
 * Find a point near the edge of a polygon.
 * Picks a random edge and places the point partway along it,
 * slightly inset toward the centroid.
 * @param {{x: number, z: number}[]} polygon
 * @param {{x: number, z: number}} centroid
 * @param {import('../core/rng.js').SeededRandom} rng
 * @returns {{x: number, z: number}}
 */
function randomPointNearEdge(polygon, centroid, rng) {
  const n = polygon.length;
  const edgeIdx = rng.int(0, n - 1);
  const a = polygon[edgeIdx];
  const b = polygon[(edgeIdx + 1) % n];

  const t = rng.range(0.2, 0.8);
  const ex = a.x + (b.x - a.x) * t;
  const ez = a.z + (b.z - a.z) * t;

  // Inset slightly toward centroid (2 units)
  const dx = centroid.x - ex;
  const dz = centroid.z - ez;
  const dist = Math.sqrt(dx * dx + dz * dz);
  const inset = Math.min(2, dist * 0.3);

  if (dist > 0.01) {
    return {
      x: ex + (dx / dist) * inset,
      z: ez + (dz / dist) * inset,
    };
  }
  return { x: ex, z: ez };
}

/**
 * Compute the angle of the nearest polygon edge to a point.
 * Used to orient benches along the nearest road/park edge.
 * @param {number} px
 * @param {number} pz
 * @param {{x: number, z: number}[]} polygon
 * @returns {number} angle in radians around Y axis
 */
function nearestEdgeAngle(px, pz, polygon) {
  let bestDist = Infinity;
  let bestAngle = 0;
  const n = polygon.length;

  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];
    const mx = (a.x + b.x) / 2;
    const mz = (a.z + b.z) / 2;
    const d = (px - mx) * (px - mx) + (pz - mz) * (pz - mz);
    if (d < bestDist) {
      bestDist = d;
      bestAngle = Math.atan2(b.x - a.x, b.z - a.z);
    }
  }

  return bestAngle;
}

/**
 * Build park meshes for blocks with landUse 'park'.
 * @param {Array} parkBlocks - Blocks filtered to only park blocks
 * @param {import('../core/heightmap.js').Heightmap} heightmap
 * @param {import('./materials.js').MaterialRegistry} materials
 * @param {import('../core/rng.js').SeededRandom} rng
 * @returns {THREE.Group}
 */
export function buildParkMeshes(parkBlocks, heightmap, materials, rng) {
  const group = new THREE.Group();
  group.name = 'parks';

  const trunkMat = materials.get('tree_trunk');
  const canopyMat = materials.get('tree_canopy');
  const benchMat = materials.get('bridge');

  // Shared geometries
  const trunkGeom = new THREE.CylinderGeometry(0.3, 0.3, 3, 6);
  const canopyGeom = new THREE.SphereGeometry(2, 8, 6);
  const benchGeom = new THREE.BoxGeometry(1.5, 0.5, 0.5);

  for (const block of parkBlocks) {
    const polygon = block.polygon;
    if (!polygon || polygon.length < 3) continue;

    const centroid = block.centroid || {
      x: polygon.reduce((s, p) => s + p.x, 0) / polygon.length,
      z: polygon.reduce((s, p) => s + p.z, 0) / polygon.length,
    };

    const parkGroup = new THREE.Group();
    parkGroup.name = 'park';

    // --- Trees ---
    const numTrees = rng.int(5, 15);
    for (let i = 0; i < numTrees; i++) {
      const pt = randomPointInPolygon(polygon, rng);
      if (!pt) continue;

      const groundY = heightmap.sample(pt.x, pt.z);
      const scale = rng.range(0.8, 1.2);

      const treeGroup = new THREE.Group();
      treeGroup.name = 'tree';

      // Trunk
      const trunk = new THREE.Mesh(trunkGeom, trunkMat);
      trunk.position.set(0, 1.5 * scale, 0); // trunk center is at half trunk height
      trunk.scale.set(scale, scale, scale);
      trunk.name = 'trunk';
      treeGroup.add(trunk);

      // Canopy
      const canopy = new THREE.Mesh(canopyGeom, canopyMat);
      canopy.position.set(0, (3 + 1.5) * scale, 0); // canopy center above trunk
      canopy.scale.set(scale, scale, scale);
      canopy.name = 'canopy';
      treeGroup.add(canopy);

      treeGroup.position.set(pt.x, groundY, pt.z);
      treeGroup.castShadow = true;
      parkGroup.add(treeGroup);
    }

    // --- Benches ---
    const numBenches = rng.int(2, 5);
    for (let i = 0; i < numBenches; i++) {
      const pt = randomPointNearEdge(polygon, centroid, rng);
      const groundY = heightmap.sample(pt.x, pt.z);
      const angle = nearestEdgeAngle(pt.x, pt.z, polygon);

      const bench = new THREE.Mesh(benchGeom, benchMat);
      bench.position.set(pt.x, groundY + 0.25, pt.z);
      bench.rotation.y = angle;
      bench.name = 'bench';
      parkGroup.add(bench);
    }

    group.add(parkGroup);
  }

  return group;
}
