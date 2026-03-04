import * as THREE from 'three';
import { getRiverMaterial } from './materials.js';

/**
 * Build a 3D terrain mesh from a LayerStack for region preview.
 */
export function buildRegionTerrain(layers) {
  const elevation = layers.getGrid('elevation');
  const landCover = layers.getGrid('landCover');
  const params = layers.getData('params');
  const seaLevel = params?.seaLevel ?? 0;

  const w = elevation.width;
  const h = elevation.height;
  const cs = elevation.cellSize;

  const geometry = new THREE.PlaneGeometry(
    w * cs, h * cs,
    w - 1, h - 1,
  );
  geometry.rotateX(-Math.PI / 2);

  const positions = geometry.attributes.position.array;
  const colors = new Float32Array(positions.length);

  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      const idx = gz * w + gx;
      const elev = elevation.get(gx, gz);

      // Set Y position (height)
      positions[idx * 3 + 1] = elev;

      // Set color based on land cover
      const cover = landCover ? landCover.get(gx, gz) : -1;
      let r, g, b;

      if (elev < seaLevel) {
        // Water
        const depth = Math.min(1, (seaLevel - elev) / 30);
        r = 0.1 - depth * 0.05;
        g = 0.3 - depth * 0.1;
        b = 0.6 + depth * 0.2;
      } else {
        switch (cover) {
          case 1: // Farmland
            r = 0.55; g = 0.65; b = 0.2;
            break;
          case 2: // Forest
            r = 0.15; g = 0.4; b = 0.1;
            break;
          case 3: // Moorland
            r = 0.45; g = 0.4; b = 0.3;
            break;
          case 4: // Marsh
            r = 0.3; g = 0.45; b = 0.3;
            break;
          case 5: // Settlement
            r = 0.6; g = 0.5; b = 0.4;
            break;
          case 6: // Open woodland
            r = 0.3; g = 0.5; b = 0.15;
            break;
          case 7: // Bare rock
            r = 0.55; g = 0.52; b = 0.48;
            break;
          case 8: // Scrubland
            r = 0.5; g = 0.48; b = 0.25;
            break;
          default: // Generic green
            r = 0.3; g = 0.5; b = 0.2;
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

/**
 * Build water plane at sea level.
 */
export function buildWaterPlane(layers) {
  const params = layers.getData('params');
  const elevation = layers.getGrid('elevation');
  const seaLevel = params?.seaLevel ?? 0;
  const size = Math.max(elevation.width, elevation.height) * elevation.cellSize;

  const geometry = new THREE.PlaneGeometry(size, size);
  geometry.rotateX(-Math.PI / 2);

  const material = new THREE.MeshLambertMaterial({
    color: 0x2255aa,
    transparent: true,
    opacity: 0.7,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = seaLevel;

  return mesh;
}

/**
 * Build settlement markers as small colored spheres.
 */
export function buildSettlementMarkers(layers) {
  const settlements = layers.getData('settlements');
  const elevation = layers.getGrid('elevation');
  if (!settlements || !elevation) return new THREE.Group();

  const group = new THREE.Group();
  const cs = elevation.cellSize;

  for (const s of settlements) {
    const h = elevation.get(s.gx, s.gz);
    const color = s.tier === 1 ? 0xff0000 : s.tier === 2 ? 0xff8800 : 0xffff00;
    const size = s.tier === 1 ? 80 : s.tier === 2 ? 50 : 30;

    const geom = new THREE.SphereGeometry(size, 8, 6);
    const mat = new THREE.MeshLambertMaterial({ color });
    const marker = new THREE.Mesh(geom, mat);

    marker.position.set(
      s.gx * cs - elevation.width * cs / 2,
      h + size,
      s.gz * cs - elevation.height * cs / 2,
    );
    marker.userData = { settlement: s };
    group.add(marker);
  }

  return group;
}

/**
 * Build road lines from regional road data.
 */
export function buildRegionRoads(layers) {
  const roads = layers.getData('roads');
  const elevation = layers.getGrid('elevation');
  if (!roads || !elevation) return new THREE.Group();

  const group = new THREE.Group();
  const cs = elevation.cellSize;
  const halfW = elevation.width * cs / 2;
  const halfH = elevation.height * cs / 2;

  for (const road of roads) {
    if (!road.path || road.path.length < 2) continue;

    const color = road.hierarchy === 'arterial' ? 0xccaa66 : 0x998855;
    const points = road.path.map(p => {
      const elev = elevation.get(p.gx, p.gz);
      return new THREE.Vector3(
        p.gx * cs - halfW,
        elev + 2,
        p.gz * cs - halfH,
      );
    });

    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({ color });
    group.add(new THREE.Line(geometry, material));
  }

  return group;
}

/**
 * Chaikin's corner-cutting: smooths a polyline of {x, z, accumulation} points.
 */
function smoothPolyline(points, iterations = 3) {
  let result = points;
  for (let iter = 0; iter < iterations; iter++) {
    const next = [result[0]];
    for (let i = 0; i < result.length - 1; i++) {
      const a = result[i];
      const b = result[i + 1];
      next.push({
        x: a.x * 0.75 + b.x * 0.25,
        z: a.z * 0.75 + b.z * 0.25,
        accumulation: a.accumulation * 0.75 + b.accumulation * 0.25,
      });
      next.push({
        x: a.x * 0.25 + b.x * 0.75,
        z: a.z * 0.25 + b.z * 0.75,
        accumulation: a.accumulation * 0.25 + b.accumulation * 0.75,
      });
    }
    next.push(result[result.length - 1]);
    result = next;
  }
  return result;
}

/**
 * Build smooth river ribbon meshes for region 3D preview.
 * Width proportional to sqrt(accumulation).
 */
export function buildRegionRiverMeshes(layers) {
  const rivers = layers.getData('rivers');
  const elevation = layers.getGrid('elevation');
  if (!rivers || !elevation) return new THREE.Group();

  const cs = elevation.cellSize;
  const halfW = elevation.width * cs / 2;
  const halfH = elevation.height * cs / 2;

  const vertices = [];
  const indices = [];

  function processSegment(seg, confluencePoint) {
    if (!seg.cells || seg.cells.length < 2) {
      for (const child of (seg.children || [])) processSegment(child, confluencePoint);
      return;
    }

    // Convert cells to world coords
    const worldPoints = seg.cells.map(cell => ({
      x: cell.gx * cs - halfW,
      z: cell.gz * cs - halfH,
      accumulation: cell.accumulation,
    }));

    // Extend to parent's confluence point to close gaps
    if (confluencePoint && worldPoints.length > 0) {
      worldPoints.push(confluencePoint);
    }

    if (worldPoints.length >= 2) {
      const smooth = smoothPolyline(worldPoints, 3);
      const baseVertex = vertices.length / 3;

      for (let i = 0; i < smooth.length; i++) {
        const p = smooth[i];
        const sampleGx = (p.x + halfW) / cs;
        const sampleGz = (p.z + halfH) / cs;
        const y = elevation.sample(sampleGx, sampleGz) + 1;

        const halfWidth = Math.max(3, Math.min(50, Math.sqrt(p.accumulation) / 4));

        let dx, dz;
        if (i < smooth.length - 1) {
          dx = smooth[i + 1].x - p.x;
          dz = smooth[i + 1].z - p.z;
        } else {
          dx = p.x - smooth[i - 1].x;
          dz = p.z - smooth[i - 1].z;
        }

        const len = Math.sqrt(dx * dx + dz * dz) || 1;
        const perpX = -dz / len;
        const perpZ = dx / len;

        vertices.push(
          p.x + perpX * halfWidth, y, p.z + perpZ * halfWidth,
          p.x - perpX * halfWidth, y, p.z - perpZ * halfWidth,
        );

        if (i > 0) {
          const base = baseVertex + (i - 1) * 2;
          indices.push(base, base + 1, base + 2);
          indices.push(base + 1, base + 3, base + 2);
        }
      }
    }

    // Children join at this segment's first cell (headwater = confluence)
    const firstCell = seg.cells[0];
    const joinPoint = {
      x: firstCell.gx * cs - halfW,
      z: firstCell.gz * cs - halfH,
      accumulation: firstCell.accumulation,
    };
    for (const child of (seg.children || [])) processSegment(child, joinPoint);
  }

  for (const root of rivers) processSegment(root);

  if (vertices.length < 6) return new THREE.Group();

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();

  const group = new THREE.Group();
  group.add(new THREE.Mesh(geom, getRiverMaterial()));
  return group;
}
