import * as THREE from 'three';

/**
 * Build a 3D terrain mesh from city-scale elevation data.
 *
 * @param {import('../core/LayerStack.js').LayerStack} cityLayers
 * @returns {THREE.Mesh}
 */
export function buildCityTerrainMesh(cityLayers) {
  const elevation = cityLayers.getGrid('elevation');
  const urbanCover = cityLayers.getGrid('urbanCover');
  const params = cityLayers.getData('params');
  const seaLevel = params?.seaLevel ?? 0;

  const w = elevation.width;
  const h = elevation.height;
  const cs = elevation.cellSize;

  const geometry = new THREE.PlaneGeometry(w * cs, h * cs, w - 1, h - 1);
  geometry.rotateX(-Math.PI / 2);
  // Shift geometry from centered (-half..+half) to local coords (0..w*cs)
  geometry.translate(w * cs / 2, 0, h * cs / 2);

  const positions = geometry.attributes.position.array;
  const colors = new Float32Array(positions.length);

  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      const idx = gz * w + gx;
      const elev = elevation.get(gx, gz);
      positions[idx * 3 + 1] = elev;

      let r, g, b;
      const cover = urbanCover ? urbanCover.get(gx, gz) : 0;

      if (elev < seaLevel) {
        r = 0.1; g = 0.25; b = 0.5;
      } else {
        switch (cover) {
          case 1: // Garden
            r = 0.35; g = 0.55; b = 0.2;
            break;
          case 2: // Park
            r = 0.2; g = 0.6; b = 0.15;
            break;
          case 3: // Woodland
            r = 0.12; g = 0.35; b = 0.1;
            break;
          case 4: // River buffer
            r = 0.25; g = 0.5; b = 0.25;
            break;
          case 5: // Paved
            r = 0.6; g = 0.58; b = 0.55;
            break;
          default:
            r = 0.35; g = 0.5; b = 0.2;
        }
      }

      colors[idx * 3] = r;
      colors[idx * 3 + 1] = g;
      colors[idx * 3 + 2] = b;
    }
  }

  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  return new THREE.Mesh(geometry, material);
}
