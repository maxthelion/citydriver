import * as THREE from 'three';
import { sampleHeightmap, TERRAIN_SIZE, TERRAIN_SEGMENTS, ROAD_WIDTH, CELL_SIZE, GRID_COUNT } from './heightmap.js';
import { materials, sharedGeo } from './materials.js';
import { DISTRICT_TEMPLATES, addDoor } from './buildingTemplates.js';

export function createTerrain(heightmapData) {
  const geo = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, TERRAIN_SEGMENTS, TERRAIN_SEGMENTS);
  const pos = geo.attributes.position;

  // Write heightmap data directly into mesh vertices
  // PlaneGeometry iterates Y (rows) then X (cols): vertex index = row * (segs+1) + col
  // But PlaneGeometry's own layout: it iterates top-to-bottom (Y descending), left-to-right (X ascending)
  // The local XY of the plane maps to world XZ after rotation.
  // We need to match our heightmap indexing to the PlaneGeometry's vertex order.
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    // Use sampleHeightmap which reads from the same array — guarantees exact match at grid points
    // and correct bilinear interpolation between them
    pos.setZ(i, sampleHeightmap(x, -y));
  }

  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    color: 0x556B2F,
    roughness: 0.95,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.receiveShadow = true;
  return mesh;
}

// Road lift above terrain
export const ROAD_LIFT = 0.15;

export function buildRoadChunk(road) {
  const group = new THREE.Group();
  const isH = road.horizontal;
  const totalLen = isH ? (road.endX - road.x) : (road.endZ - road.z);
  const segLen = 4;
  const numSegs = Math.ceil(Math.abs(totalLen) / segLen);
  const halfW = ROAD_WIDTH / 2;
  const crossStrips = 3; // subdivisions across the road width

  const positions = [];
  const indices = [];
  const linePositions = [];
  const lineIndices = [];

  // Build a grid: (numSegs+1) rows along road × (crossStrips+1) columns across road
  for (let i = 0; i <= numSegs; i++) {
    const t = i / numSegs;
    const cx = isH ? road.x + t * totalLen : road.x;
    const cz = isH ? road.z : road.z + t * totalLen;

    for (let j = 0; j <= crossStrips; j++) {
      const s = j / crossStrips; // 0 = left edge, 1 = right edge
      let vx, vz;
      if (isH) {
        vx = cx;
        vz = cz + halfW - s * ROAD_WIDTH; // +halfW to -halfW (correct winding)
      } else {
        vx = cx - halfW + s * ROAD_WIDTH; // -halfW to +halfW
        vz = cz;
      }
      positions.push(vx, sampleHeightmap(vx, vz) + ROAD_LIFT, vz);
    }

    linePositions.push(cx, sampleHeightmap(cx, cz) + ROAD_LIFT + 0.05, cz);
    if (i < numSegs) lineIndices.push(i, i + 1);
  }

  // Build triangle indices for the grid
  const cols = crossStrips + 1;
  for (let i = 0; i < numSegs; i++) {
    for (let j = 0; j < crossStrips; j++) {
      const a = i * cols + j;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const roadGeo = new THREE.BufferGeometry();
  roadGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  roadGeo.setIndex(indices);
  roadGeo.computeVertexNormals();
  const roadMesh = new THREE.Mesh(roadGeo, materials.road);
  roadMesh.receiveShadow = true;
  group.add(roadMesh);

  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
  lineGeo.setIndex(lineIndices);
  group.add(new THREE.LineSegments(lineGeo, materials.roadLine));

  return group;
}

export function buildIntersection(ix, iz) {
  const hw = ROAD_WIDTH / 2 + 1;
  const res = 3;
  const positions = [];
  const indices = [];

  for (let py = 0; py <= res; py++) {
    for (let px = 0; px <= res; px++) {
      const x = ix - hw + (px / res) * hw * 2;
      const z = iz - hw + (py / res) * hw * 2;
      positions.push(x, sampleHeightmap(x, z) + ROAD_LIFT, z);
    }
  }
  for (let py = 0; py < res; py++) {
    for (let px = 0; px < res; px++) {
      const a = py * (res + 1) + px;
      indices.push(a, a + res + 1, a + 1, a + 1, a + res + 1, a + res + 2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, materials.road);
  mesh.receiveShadow = true;
  return mesh;
}

export const BUILDING_EXTRA_DEPTH = 8;

export function buildBuilding(b) {
  const group = new THREE.Group();

  // Use the MAX height so the door/base sits at the highest ground point.
  // The extra depth buries the low side into the slope.
  const groundY = Math.max(
    sampleHeightmap(b.x, b.z),
    sampleHeightmap(b.x - b.w / 2, b.z - b.d / 2),
    sampleHeightmap(b.x + b.w / 2, b.z - b.d / 2),
    sampleHeightmap(b.x - b.w / 2, b.z + b.d / 2),
    sampleHeightmap(b.x + b.w / 2, b.z + b.d / 2),
  );

  if (b.district && DISTRICT_TEMPLATES[b.district]) {
    const templates = DISTRICT_TEMPLATES[b.district];
    const templateFn = templates[b.templateId % templates.length];
    const buildingGroup = templateFn(b);
    group.add(buildingGroup);
  } else {
    // Legacy fallback for old building data
    const mat = materials.building[b.type][b.colorIdx % materials.building[b.type].length];
    const geo = new THREE.BoxGeometry(b.w, b.h + BUILDING_EXTRA_DEPTH, b.d);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0, (b.h + BUILDING_EXTRA_DEPTH) / 2 - BUILDING_EXTRA_DEPTH, 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);

    if (b.h > 10) {
      const floors = Math.floor(b.h / 4);
      const windowsPerFloor = Math.max(1, Math.floor(b.w / 5));
      for (let f = 0; f < floors; f++) {
        for (let w = 0; w < windowsPerFloor; w++) {
          const wy = f * 4 + 3;
          const wx = (w - (windowsPerFloor - 1) / 2) * 4.5;
          for (const side of [1, -1]) {
            const winMesh = new THREE.Mesh(sharedGeo.windowPane, materials.window);
            winMesh.position.set(wx, wy, side * (b.d / 2 + 0.05));
            if (side === -1) winMesh.rotation.y = Math.PI;
            group.add(winMesh);
          }
        }
      }
    }

    if (b.type === 'skyscraper' && b.h > 30) {
      const antenna = new THREE.Mesh(sharedGeo.antenna, materials.antenna);
      antenna.position.set(0, b.h + 4, 0);
      group.add(antenna);
      const ac = new THREE.Mesh(sharedGeo.ac, materials.ac);
      ac.position.set(b.w * 0.2, b.h + 1, b.d * 0.2);
      group.add(ac);
    }

    // Add door to legacy buildings too
    if (b.doorFace == null) b.doorFace = 0;
    if (b.seed == null) b.seed = 0;
    addDoor(group, b);
  }

  group.position.set(b.x, groundY, b.z);
  return group;
}

export function buildPark(park) {
  const group = new THREE.Group();
  const res = 6;
  const halfS = park.size / 2;
  const positions = [];
  const indices = [];

  for (let py = 0; py <= res; py++) {
    for (let px = 0; px <= res; px++) {
      const x = park.x - halfS + (px / res) * park.size;
      const z = park.z - halfS + (py / res) * park.size;
      positions.push(x, sampleHeightmap(x, z) + 0.05, z);
    }
  }
  for (let py = 0; py < res; py++) {
    for (let px = 0; px < res; px++) {
      const a = py * (res + 1) + px;
      indices.push(a, a + res + 1, a + 1, a + 1, a + res + 1, a + res + 2);
    }
  }

  const grassGeo = new THREE.BufferGeometry();
  grassGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  grassGeo.setIndex(indices);
  grassGeo.computeVertexNormals();
  const grass = new THREE.Mesh(grassGeo, materials.grass);
  grass.receiveShadow = true;
  group.add(grass);

  const treeCount = 5 + Math.floor(Math.random() * 8);
  for (let i = 0; i < treeCount; i++) {
    const tx = park.x + (Math.random() - 0.5) * (park.size - 8);
    const tz = park.z + (Math.random() - 0.5) * (park.size - 8);
    const elev = sampleHeightmap(tx, tz);
    const treeH = 4 + Math.random() * 6;

    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.3, 0.5, treeH * 0.5, 6),
      materials.trunk
    );
    trunk.position.set(tx, elev + treeH * 0.25, tz);
    trunk.castShadow = true;
    group.add(trunk);

    const canopy = new THREE.Mesh(
      new THREE.SphereGeometry(treeH * 0.35, 6, 5),
      Math.random() > 0.5 ? materials.leaf1 : materials.leaf2
    );
    canopy.position.set(tx, elev + treeH * 0.6, tz);
    canopy.castShadow = true;
    group.add(canopy);
  }

  const benchCount = 1 + Math.floor(Math.random() * 3);
  for (let i = 0; i < benchCount; i++) {
    const bx = park.x + (Math.random() - 0.5) * (park.size - 10);
    const bz = park.z + (Math.random() - 0.5) * (park.size - 10);
    const bench = new THREE.Mesh(sharedGeo.bench, materials.bench);
    bench.position.set(bx, sampleHeightmap(bx, bz) + 0.4, bz);
    bench.castShadow = true;
    group.add(bench);
  }

  return group;
}
