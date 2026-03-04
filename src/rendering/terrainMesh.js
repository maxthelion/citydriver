import * as THREE from 'three';

/**
 * Build a terrain mesh from a Heightmap using custom BufferGeometry.
 *
 * Vertex positions are placed directly in world space:
 *   for grid point (gx, gz) -> position (gx*cellSize, height, gz*cellSize)
 *
 * Vertex colors encode elevation relative to seaLevel:
 *   - Below seaLevel:  sandy (#c2b280)
 *   - 0-20 above sea:  green gradient
 *   - 20-60 above sea: brown gradient
 *   - 60+ above sea:   gray/white gradient
 *
 * @param {import('../core/heightmap.js').Heightmap} heightmap
 * @param {number} seaLevel - water level used for coloring
 * @param {import('./materials.js').MaterialRegistry} materials
 * @returns {THREE.Mesh}
 */
export function buildTerrainMesh(heightmap, seaLevel, materials) {
  const gridW = heightmap.width;
  const gridH = heightmap.height;
  const cellSize = heightmap.cellSize;
  const vertexCount = gridW * gridH;

  // --- Positions and colors ---
  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);

  for (let gz = 0; gz < gridH; gz++) {
    for (let gx = 0; gx < gridW; gx++) {
      const idx = gz * gridW + gx;
      const h = heightmap.get(gx, gz);

      // World-space position: X right, Y up, Z forward
      positions[idx * 3]     = gx * cellSize;
      positions[idx * 3 + 1] = h;
      positions[idx * 3 + 2] = gz * cellSize;

      // Color based on elevation relative to seaLevel
      const above = h - seaLevel;
      let r, g, b;

      if (above < 0) {
        // Below sea level: sandy color (#c2b280)
        r = 0xc2 / 255;
        g = 0xb2 / 255;
        b = 0x80 / 255;
      } else if (above < 20) {
        // Green gradient: dark green -> lighter green
        const t = above / 20;
        r = 0.18 + t * 0.12;  // 0.18 -> 0.30
        g = 0.45 + t * 0.15;  // 0.45 -> 0.60
        b = 0.12 + t * 0.08;  // 0.12 -> 0.20
      } else if (above < 60) {
        // Brown gradient: green-brown -> brown
        const t = (above - 20) / 40;
        r = 0.30 + t * 0.25;  // 0.30 -> 0.55
        g = 0.60 - t * 0.25;  // 0.60 -> 0.35
        b = 0.20 - t * 0.05;  // 0.20 -> 0.15
      } else {
        // Gray/white gradient: gray -> near-white
        const t = Math.min(1, (above - 60) / 60);
        r = 0.55 + t * 0.35;  // 0.55 -> 0.90
        g = 0.55 + t * 0.35;  // 0.55 -> 0.90
        b = 0.55 + t * 0.40;  // 0.55 -> 0.95
      }

      colors[idx * 3]     = r;
      colors[idx * 3 + 1] = g;
      colors[idx * 3 + 2] = b;
    }
  }

  // --- Index buffer: two triangles per quad ---
  const numQuadsX = gridW - 1;
  const numQuadsZ = gridH - 1;
  const indices = new Uint32Array(numQuadsX * numQuadsZ * 6);
  let ii = 0;

  for (let gz = 0; gz < numQuadsZ; gz++) {
    for (let gx = 0; gx < numQuadsX; gx++) {
      const a = gz * gridW + gx;
      const b = a + 1;
      const c = (gz + 1) * gridW + gx;
      const d = c + 1;

      // Triangle 1: a, c, b
      indices[ii++] = a;
      indices[ii++] = c;
      indices[ii++] = b;

      // Triangle 2: b, c, d
      indices[ii++] = b;
      indices[ii++] = c;
      indices[ii++] = d;
    }
  }

  // --- Assemble geometry ---
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();

  const mesh = new THREE.Mesh(geometry, materials.get('terrain'));
  mesh.receiveShadow = true;

  return mesh;
}
