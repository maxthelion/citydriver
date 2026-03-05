import * as THREE from 'three';
import { getRoadMaterial } from './materials.js';

/**
 * Build 3D road ribbons from the PlanarGraph.
 * Roads are colored by hierarchy: arterial (dark), collector (medium), local (light).
 *
 * @param {import('../core/PlanarGraph.js').PlanarGraph} graph
 * @param {import('../core/Grid2D.js').Grid2D} elevation
 * @returns {THREE.Group}
 */
export function buildRoadMeshes(graph, elevation) {
  const group = new THREE.Group();
  const cs = elevation ? elevation.cellSize : 10;

  // Collect geometry per hierarchy level for fewer draw calls
  const buckets = new Map(); // hierarchy -> { vertices, indices }

  for (const [edgeId, edge] of graph.edges) {
    const polyline = graph.edgePolyline(edgeId);
    if (polyline.length < 2) continue;

    const hierarchy = edge.attrs?.hierarchy || edge.hierarchy || 'local';
    const halfWidth = (edge.width || 6) / 2;

    if (!buckets.has(hierarchy)) {
      buckets.set(hierarchy, { vertices: [], indices: [] });
    }
    const bucket = buckets.get(hierarchy);
    const baseVertex = bucket.vertices.length / 3;

    for (let i = 0; i < polyline.length; i++) {
      const p = polyline[i];

      let dx, dz;
      if (i < polyline.length - 1) {
        dx = polyline[i + 1].x - p.x;
        dz = polyline[i + 1].z - p.z;
      } else {
        dx = p.x - polyline[i - 1].x;
        dz = p.z - polyline[i - 1].z;
      }

      const len = Math.sqrt(dx * dx + dz * dz) || 1;
      const perpX = -dz / len;
      const perpZ = dx / len;

      // Sample elevation at each edge separately so roads follow cross-slope
      const lx = p.x + perpX * halfWidth;
      const lz = p.z + perpZ * halfWidth;
      const rx = p.x - perpX * halfWidth;
      const rz = p.z - perpZ * halfWidth;
      const yL = elevation ? elevation.sample(lx / cs, lz / cs) + 0.3 : 0.3;
      const yR = elevation ? elevation.sample(rx / cs, rz / cs) + 0.3 : 0.3;

      bucket.vertices.push(
        lx, yL, lz,
        rx, yR, rz,
      );

      if (i > 0) {
        const base = baseVertex + (i - 1) * 2;
        bucket.indices.push(base, base + 1, base + 2);
        bucket.indices.push(base + 1, base + 3, base + 2);
      }
    }
  }

  // Create one mesh per hierarchy level
  for (const [hierarchy, bucket] of buckets) {
    if (bucket.vertices.length < 6) continue;

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(bucket.vertices, 3));
    geom.setIndex(bucket.indices);
    geom.computeVertexNormals();

    const material = getRoadMaterial(hierarchy);
    const mesh = new THREE.Mesh(geom, material);
    group.add(mesh);
  }

  return group;
}
