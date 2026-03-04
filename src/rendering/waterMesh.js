import * as THREE from 'three';
import { getRiverMaterial } from './materials.js';

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
 * Build a water plane for the city.
 */
export function buildCityWaterMesh(cityLayers) {
  const params = cityLayers.getData('params');
  const seaLevel = params?.seaLevel ?? 0;
  const size = Math.max(params.width, params.height) * params.cellSize;

  const geometry = new THREE.PlaneGeometry(size * 1.5, size * 1.5);
  geometry.rotateX(-Math.PI / 2);

  const material = new THREE.MeshLambertMaterial({
    color: 0x2255aa,
    transparent: true,
    opacity: 0.7,
  });

  const mesh = new THREE.Mesh(geometry, material);
  // Position at center of local coordinate space
  mesh.position.set(
    params.width * params.cellSize / 2,
    seaLevel,
    params.height * params.cellSize / 2,
  );

  return mesh;
}

/**
 * Build smooth river ribbon meshes from river segment tree.
 * Width proportional to sqrt(accumulation).
 *
 * @param {import('../core/LayerStack.js').LayerStack} cityLayers
 * @returns {THREE.Group}
 */
export function buildRiverMeshes(cityLayers) {
  const rivers = cityLayers.getData('rivers');
  const params = cityLayers.getData('params');
  const elevation = cityLayers.getGrid('elevation');
  if (!rivers || !params || !elevation) return new THREE.Group();

  // Derive regional cell size from city params
  const regionalCellSize = params.regionalMinGx > 0
    ? params.originX / params.regionalMinGx
    : params.regionalMinGz > 0
      ? params.originZ / params.regionalMinGz
      : 50;

  // City bounds in regional grid coords
  const minGx = params.regionalMinGx;
  const minGz = params.regionalMinGz;
  const cityWorldW = params.width * params.cellSize;
  const cityWorldH = params.height * params.cellSize;
  const maxGx = minGx + cityWorldW / regionalCellSize;
  const maxGz = minGz + cityWorldH / regionalCellSize;

  const cs = params.cellSize;
  const vertices = [];
  const indices = [];

  function processSegment(seg, confluencePoint) {
    if (!seg.cells || seg.cells.length < 2) {
      for (const child of (seg.children || [])) processSegment(child, confluencePoint);
      return;
    }

    // Filter to cells within city bounds, convert to world coords
    const worldPoints = [];
    for (const cell of seg.cells) {
      if (cell.gx >= minGx && cell.gx <= maxGx &&
          cell.gz >= minGz && cell.gz <= maxGz) {
        worldPoints.push({
          x: (cell.gx - minGx) * regionalCellSize,
          z: (cell.gz - minGz) * regionalCellSize,
          accumulation: cell.accumulation,
        });
      }
    }

    // Extend to parent's confluence point to close gaps
    if (confluencePoint && worldPoints.length > 0) {
      worldPoints.push(confluencePoint);
    }

    if (worldPoints.length >= 2) {
      const smooth = smoothPolyline(worldPoints, 3);
      const baseVertex = vertices.length / 3;

      for (let i = 0; i < smooth.length; i++) {
        const p = smooth[i];
        const y = elevation.sample(p.x / cs, p.z / cs) + 1.0;
        const halfWidth = Math.max(1.5, Math.min(25, Math.sqrt(p.accumulation) / 8));

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
      x: (firstCell.gx - minGx) * regionalCellSize,
      z: (firstCell.gz - minGz) * regionalCellSize,
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
