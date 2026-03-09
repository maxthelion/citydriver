import * as THREE from 'three';

/**
 * Compute the list of volumes (main + wings) from a recipe.
 * Each volume has { x, z, width, depth, floors, role }.
 */
function computeVolumes(recipe) {
  const volumes = [];

  // Main volume at origin
  volumes.push({
    x: 0,
    z: 0,
    width: recipe.mainWidth,
    depth: recipe.mainDepth,
    floors: recipe.floors,
    role: 'main',
  });

  // Wings
  for (const wing of recipe.wings) {
    let x, z;
    switch (wing.side) {
      case 'left':
        x = -wing.width;
        z = 0;
        break;
      case 'right':
        x = recipe.mainWidth;
        z = 0;
        break;
      case 'back':
        x = (recipe.mainWidth - wing.width) / 2;
        z = recipe.mainDepth;
        break;
      default:
        x = 0;
        z = 0;
    }
    volumes.push({
      x,
      z,
      width: wing.width,
      depth: wing.depth,
      floors: wing.floors,
      role: 'wing',
    });
  }

  return volumes;
}

/**
 * Generate wall geometry for a single volume.
 * 4 wall quads: front (z=z0), back (z=z1), left (x=x0), right (x=x1).
 */
function generateWalls(vol, wallHeight) {
  const x0 = vol.x;
  const x1 = vol.x + vol.width;
  const z0 = vol.z;
  const z1 = vol.z + vol.depth;
  const y0 = 0;
  const y1 = wallHeight;

  const positions = [];
  const normals = [];
  const indices = [];

  function addQuad(v0, v1, v2, v3, nx, ny, nz) {
    // v0--v1
    // |  / |
    // v2--v3
    const base = positions.length / 3;
    positions.push(...v0, ...v1, ...v2, ...v3);
    normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz);
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }

  // Front face (z = z0, normal toward -Z)
  addQuad(
    [x0, y1, z0], [x1, y1, z0],
    [x0, y0, z0], [x1, y0, z0],
    0, 0, -1
  );

  // Back face (z = z1, normal toward +Z)
  addQuad(
    [x1, y1, z1], [x0, y1, z1],
    [x1, y0, z1], [x0, y0, z1],
    0, 0, 1
  );

  // Left face (x = x0, normal toward -X)
  addQuad(
    [x0, y1, z1], [x0, y1, z0],
    [x0, y0, z1], [x0, y0, z0],
    -1, 0, 0
  );

  // Right face (x = x1, normal toward +X)
  addQuad(
    [x1, y1, z0], [x1, y1, z1],
    [x1, y0, z0], [x1, y0, z1],
    1, 0, 0
  );

  return { positions, normals, indices };
}

/**
 * Generate a flat roof: thin slab 0.15m above wall top.
 */
function generateFlatRoof(vol, wallHeight) {
  const x0 = vol.x;
  const x1 = vol.x + vol.width;
  const z0 = vol.z;
  const z1 = vol.z + vol.depth;
  const y = wallHeight + 0.15;

  const positions = [
    x0, y, z0, x1, y, z0,
    x0, y, z1, x1, y, z1,
  ];
  const normals = [
    0, 1, 0, 0, 1, 0,
    0, 1, 0, 0, 1, 0,
  ];
  const indices = [0, 2, 1, 1, 2, 3];

  return { positions, normals, indices };
}

/**
 * Generate a gable roof. Ridge runs along the LONGER axis.
 * Two sloped faces + two triangular gable ends.
 */
function generateGableRoof(vol, wallHeight, style) {
  const x0 = vol.x;
  const x1 = vol.x + vol.width;
  const z0 = vol.z;
  const z1 = vol.z + vol.depth;
  const w = vol.width;
  const d = vol.depth;
  const overhang = style.roofOverhang;
  const pitchRad = (style.roofPitch * Math.PI) / 180;
  const y0 = wallHeight;

  const positions = [];
  const normals = [];
  const indices = [];

  function addTri(v0, v1, v2, nx, ny, nz) {
    const base = positions.length / 3;
    positions.push(...v0, ...v1, ...v2);
    normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    indices.push(base, base + 1, base + 2);
  }

  function addQuad(v0, v1, v2, v3, nx, ny, nz) {
    const base = positions.length / 3;
    positions.push(...v0, ...v1, ...v2, ...v3);
    normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz);
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }

  if (w >= d) {
    // Ridge along X axis (longer). Slopes face +Z and -Z.
    const span = d; // shorter dimension
    const peakHeight = y0 + (span / 2) * Math.tan(pitchRad);
    const midZ = (z0 + z1) / 2;

    // Ridge endpoints
    const r0 = [x0, peakHeight, midZ];
    const r1 = [x1, peakHeight, midZ];

    // Eave corners with overhang
    const eFL = [x0, y0, z0 - overhang];
    const eFR = [x1, y0, z0 - overhang];
    const eBL = [x0, y0, z1 + overhang];
    const eBR = [x1, y0, z1 + overhang];

    // Front slope (faces -Z side)
    const frontNormal = computeFaceNormal(eFL, eFR, r0);
    addQuad(r0, r1, eFL, eFR, frontNormal[0], frontNormal[1], frontNormal[2]);

    // Back slope (faces +Z side)
    const backNormal = computeFaceNormal(r1, r0, eBR);
    addQuad(r1, r0, eBR, eBL, backNormal[0], backNormal[1], backNormal[2]);

    // Left gable end (x = x0)
    const leftNormal = [-1, 0, 0];
    addTri(r0, eFL, eBL, leftNormal[0], leftNormal[1], leftNormal[2]);

    // Right gable end (x = x1)
    const rightNormal = [1, 0, 0];
    addTri(r1, eBR, eFR, rightNormal[0], rightNormal[1], rightNormal[2]);
  } else {
    // Ridge along Z axis (longer). Slopes face +X and -X.
    const span = w; // shorter dimension
    const peakHeight = y0 + (span / 2) * Math.tan(pitchRad);
    const midX = (x0 + x1) / 2;

    // Ridge endpoints
    const r0 = [midX, peakHeight, z0];
    const r1 = [midX, peakHeight, z1];

    // Eave corners with overhang
    const eFL = [x0 - overhang, y0, z0];
    const eFR = [x1 + overhang, y0, z0];
    const eBL = [x0 - overhang, y0, z1];
    const eBR = [x1 + overhang, y0, z1];

    // Left slope (faces -X side)
    const leftNormal = computeFaceNormal(r0, r1, eFL);
    addQuad(r0, r1, eFL, eBL, leftNormal[0], leftNormal[1], leftNormal[2]);

    // Right slope (faces +X side)
    const rightNormal = computeFaceNormal(r1, r0, eBR);
    addQuad(r1, r0, eBR, eFR, rightNormal[0], rightNormal[1], rightNormal[2]);

    // Front gable end (z = z0)
    const frontNormal = [0, 0, -1];
    addTri(r0, eFR, eFL, frontNormal[0], frontNormal[1], frontNormal[2]);

    // Back gable end (z = z1)
    const backNormal = [0, 0, 1];
    addTri(r1, eBL, eBR, backNormal[0], backNormal[1], backNormal[2]);
  }

  return { positions, normals, indices };
}

/**
 * Generate a hip roof. Four sloped faces meeting at a ridge (or peak if square).
 */
function generateHipRoof(vol, wallHeight, style) {
  const x0 = vol.x;
  const x1 = vol.x + vol.width;
  const z0 = vol.z;
  const z1 = vol.z + vol.depth;
  const w = vol.width;
  const d = vol.depth;
  const pitchRad = (style.roofPitch * Math.PI) / 180;
  const y0 = wallHeight;

  const positions = [];
  const normals = [];
  const indices = [];

  function addTri(v0, v1, v2, nx, ny, nz) {
    const base = positions.length / 3;
    positions.push(...v0, ...v1, ...v2);
    normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    indices.push(base, base + 1, base + 2);
  }

  function addQuad(v0, v1, v2, v3, nx, ny, nz) {
    const base = positions.length / 3;
    positions.push(...v0, ...v1, ...v2, ...v3);
    normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz);
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }

  const shorter = Math.min(w, d);
  const inset = shorter / 2;
  const peakHeight = y0 + inset * Math.tan(pitchRad);

  // Eave corners
  const eFL = [x0, y0, z0]; // front-left
  const eFR = [x1, y0, z0]; // front-right
  const eBL = [x0, y0, z1]; // back-left
  const eBR = [x1, y0, z1]; // back-right

  if (Math.abs(w - d) < 0.01) {
    // Square: pyramid with single peak
    const peak = [(x0 + x1) / 2, peakHeight, (z0 + z1) / 2];

    const fn = computeFaceNormal(peak, eFL, eFR);
    addTri(peak, eFL, eFR, fn[0], fn[1], fn[2]);

    const rn = computeFaceNormal(peak, eFR, eBR);
    addTri(peak, eFR, eBR, rn[0], rn[1], rn[2]);

    const bn = computeFaceNormal(peak, eBR, eBL);
    addTri(peak, eBR, eBL, bn[0], bn[1], bn[2]);

    const ln = computeFaceNormal(peak, eBL, eFL);
    addTri(peak, eBL, eFL, ln[0], ln[1], ln[2]);
  } else if (w >= d) {
    // Ridge along X. Inset from front/back by d/2.
    const ridgeZ = (z0 + z1) / 2;
    const ridgeX0 = x0 + inset;
    const ridgeX1 = x1 - inset;
    const r0 = [ridgeX0, peakHeight, ridgeZ];
    const r1 = [ridgeX1, peakHeight, ridgeZ];

    // Front slope (quad)
    const fn = computeFaceNormal(r0, r1, eFL);
    addQuad(r0, r1, eFL, eFR, fn[0], fn[1], fn[2]);

    // Back slope (quad)
    const bn = computeFaceNormal(r1, r0, eBR);
    addQuad(r1, r0, eBR, eBL, bn[0], bn[1], bn[2]);

    // Left hip (triangle)
    const ln = computeFaceNormal(r0, eBL, eFL);
    addTri(r0, eBL, eFL, ln[0], ln[1], ln[2]);

    // Right hip (triangle)
    const rn = computeFaceNormal(r1, eFR, eBR);
    addTri(r1, eFR, eBR, rn[0], rn[1], rn[2]);
  } else {
    // Ridge along Z. Inset from left/right by w/2.
    const ridgeX = (x0 + x1) / 2;
    const ridgeZ0 = z0 + inset;
    const ridgeZ1 = z1 - inset;
    const r0 = [ridgeX, peakHeight, ridgeZ0];
    const r1 = [ridgeX, peakHeight, ridgeZ1];

    // Left slope (quad)
    const ln = computeFaceNormal(r0, r1, eFL);
    addQuad(r0, r1, eFL, eBL, ln[0], ln[1], ln[2]);

    // Right slope (quad)
    const rn = computeFaceNormal(r1, r0, eBR);
    addQuad(r1, r0, eBR, eFR, rn[0], rn[1], rn[2]);

    // Front hip (triangle)
    const fn = computeFaceNormal(r0, eFL, eFR);
    addTri(r0, eFL, eFR, fn[0], fn[1], fn[2]);

    // Back hip (triangle)
    const bn = computeFaceNormal(r1, eBR, eBL);
    addTri(r1, eBR, eBL, bn[0], bn[1], bn[2]);
  }

  return { positions, normals, indices };
}

/**
 * Generate a mansard roof.
 * Lower steep slope at 70° + upper shallow slope at style.roofPitch.
 * Break line at ~15% of shorter dimension inset from edges.
 * Lower section: 4 quads from eave to break.
 * Upper section: a hip roof on the inner rectangle.
 */
function generateMansardRoof(vol, wallHeight, style) {
  const x0 = vol.x;
  const x1 = vol.x + vol.width;
  const z0 = vol.z;
  const z1 = vol.z + vol.depth;
  const w = vol.width;
  const d = vol.depth;
  const y0 = wallHeight;

  const positions = [];
  const normals = [];
  const indices = [];

  function addTri(v0, v1, v2, nx, ny, nz) {
    const base = positions.length / 3;
    positions.push(...v0, ...v1, ...v2);
    normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    indices.push(base, base + 1, base + 2);
  }

  function addQuad(v0, v1, v2, v3, nx, ny, nz) {
    const base = positions.length / 3;
    positions.push(...v0, ...v1, ...v2, ...v3);
    normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz);
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }

  const shorter = Math.min(w, d);
  const inset = shorter * 0.15;
  const steepAngle = (70 * Math.PI) / 180;
  const breakHeight = y0 + inset * Math.tan(steepAngle);

  // Inner rectangle at break level
  const ix0 = x0 + inset;
  const ix1 = x1 - inset;
  const iz0 = z0 + inset;
  const iz1 = z1 - inset;

  // Eave corners
  const eFL = [x0, y0, z0];
  const eFR = [x1, y0, z0];
  const eBL = [x0, y0, z1];
  const eBR = [x1, y0, z1];

  // Break corners
  const bFL = [ix0, breakHeight, iz0];
  const bFR = [ix1, breakHeight, iz0];
  const bBL = [ix0, breakHeight, iz1];
  const bBR = [ix1, breakHeight, iz1];

  // Lower section: 4 steep quads
  // Front
  const fn = computeFaceNormal(bFL, bFR, eFL);
  addQuad(bFL, bFR, eFL, eFR, fn[0], fn[1], fn[2]);

  // Back
  const bn = computeFaceNormal(bBR, bBL, eBR);
  addQuad(bBR, bBL, eBR, eBL, bn[0], bn[1], bn[2]);

  // Left
  const ln = computeFaceNormal(bBL, bFL, eBL);
  addQuad(bBL, bFL, eBL, eFL, ln[0], ln[1], ln[2]);

  // Right
  const rn = computeFaceNormal(bFR, bBR, eFR);
  addQuad(bFR, bBR, eFR, eBR, rn[0], rn[1], rn[2]);

  // Upper section: hip roof on inner rectangle
  const innerW = ix1 - ix0;
  const innerD = iz1 - iz0;
  const innerShorter = Math.min(innerW, innerD);
  const innerInset = innerShorter / 2;
  const pitchRad = (style.roofPitch * Math.PI) / 180;
  const upperPeakHeight = breakHeight + innerInset * Math.tan(pitchRad);

  if (Math.abs(innerW - innerD) < 0.01) {
    // Square: pyramid
    const peak = [(ix0 + ix1) / 2, upperPeakHeight, (iz0 + iz1) / 2];
    const ufn = computeFaceNormal(peak, bFL, bFR);
    addTri(peak, bFL, bFR, ufn[0], ufn[1], ufn[2]);

    const urn = computeFaceNormal(peak, bFR, bBR);
    addTri(peak, bFR, bBR, urn[0], urn[1], urn[2]);

    const ubn = computeFaceNormal(peak, bBR, bBL);
    addTri(peak, bBR, bBL, ubn[0], ubn[1], ubn[2]);

    const uln = computeFaceNormal(peak, bBL, bFL);
    addTri(peak, bBL, bFL, uln[0], uln[1], uln[2]);
  } else if (innerW >= innerD) {
    // Ridge along X
    const ridgeZ = (iz0 + iz1) / 2;
    const ridgeX0 = ix0 + innerInset;
    const ridgeX1 = ix1 - innerInset;
    const r0 = [ridgeX0, upperPeakHeight, ridgeZ];
    const r1 = [ridgeX1, upperPeakHeight, ridgeZ];

    const ufn = computeFaceNormal(r0, r1, bFL);
    addQuad(r0, r1, bFL, bFR, ufn[0], ufn[1], ufn[2]);

    const ubn = computeFaceNormal(r1, r0, bBR);
    addQuad(r1, r0, bBR, bBL, ubn[0], ubn[1], ubn[2]);

    const uln = computeFaceNormal(r0, bBL, bFL);
    addTri(r0, bBL, bFL, uln[0], uln[1], uln[2]);

    const urn = computeFaceNormal(r1, bFR, bBR);
    addTri(r1, bFR, bBR, urn[0], urn[1], urn[2]);
  } else {
    // Ridge along Z
    const ridgeX = (ix0 + ix1) / 2;
    const ridgeZ0 = iz0 + innerInset;
    const ridgeZ1 = iz1 - innerInset;
    const r0 = [ridgeX, upperPeakHeight, ridgeZ0];
    const r1 = [ridgeX, upperPeakHeight, ridgeZ1];

    const uln = computeFaceNormal(r0, r1, bFL);
    addQuad(r0, r1, bFL, bBL, uln[0], uln[1], uln[2]);

    const urn = computeFaceNormal(r1, r0, bBR);
    addQuad(r1, r0, bBR, bFR, urn[0], urn[1], urn[2]);

    const ufn = computeFaceNormal(r0, bFL, bFR);
    addTri(r0, bFL, bFR, ufn[0], ufn[1], ufn[2]);

    const ubn = computeFaceNormal(r1, bBR, bBL);
    addTri(r1, bBR, bBL, ubn[0], ubn[1], ubn[2]);
  }

  return { positions, normals, indices };
}

/**
 * Compute a face normal from 3 vertices (counter-clockwise winding).
 * Returns [nx, ny, nz] normalized.
 */
function computeFaceNormal(a, b, c) {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
  let nx = aby * acz - abz * acy;
  let ny = abz * acx - abx * acz;
  let nz = abx * acy - aby * acx;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len > 0) {
    nx /= len;
    ny /= len;
    nz /= len;
  }
  return [nx, ny, nz];
}

/**
 * Merge multiple geometry data objects into one.
 */
function mergeGeometryData(parts) {
  const positions = [];
  const normals = [];
  const indices = [];
  let vertexOffset = 0;

  for (const part of parts) {
    positions.push(...part.positions);
    normals.push(...part.normals);
    for (const idx of part.indices) {
      indices.push(idx + vertexOffset);
    }
    vertexOffset += part.positions.length / 3;
  }

  return { positions, normals, indices };
}

/**
 * Build a THREE.BufferGeometry from raw positions, normals, indices.
 */
function buildGeometry(data) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(data.positions, 3)
  );
  geometry.setAttribute(
    'normal',
    new THREE.Float32BufferAttribute(data.normals, 3)
  );
  geometry.setIndex(data.indices);
  return geometry;
}

/**
 * Generate a complete building as a THREE.Group.
 *
 * @param {object} style - Style object from getClimateStyle()
 * @param {object} recipe - Recipe object from buildRecipe()
 * @returns {THREE.Group} Group containing 'walls' and 'roof' child meshes
 */
export function generateBuilding(style, recipe) {
  const group = new THREE.Group();
  const volumes = computeVolumes(recipe);

  // --- Walls ---
  const wallParts = [];
  for (const vol of volumes) {
    const wallHeight = vol.floors * style.floorHeight;
    wallParts.push(generateWalls(vol, wallHeight));
  }
  const wallData = mergeGeometryData(wallParts);
  const wallGeometry = buildGeometry(wallData);
  const wallMaterial = new THREE.MeshLambertMaterial({ color: recipe.wallColor });
  const wallMesh = new THREE.Mesh(wallGeometry, wallMaterial);
  wallMesh.name = 'walls';
  group.add(wallMesh);

  // --- Roofs ---
  const roofParts = [];
  for (const vol of volumes) {
    const wallHeight = vol.floors * style.floorHeight;
    switch (style.roofType) {
      case 'flat':
        roofParts.push(generateFlatRoof(vol, wallHeight));
        break;
      case 'gable':
        roofParts.push(generateGableRoof(vol, wallHeight, style));
        break;
      case 'hip':
        roofParts.push(generateHipRoof(vol, wallHeight, style));
        break;
      case 'mansard':
        roofParts.push(generateMansardRoof(vol, wallHeight, style));
        break;
      default:
        roofParts.push(generateFlatRoof(vol, wallHeight));
    }
  }
  const roofData = mergeGeometryData(roofParts);
  const roofGeometry = buildGeometry(roofData);
  const roofMaterial = new THREE.MeshLambertMaterial({ color: recipe.roofColor });
  const roofMesh = new THREE.Mesh(roofGeometry, roofMaterial);
  roofMesh.name = 'roof';
  group.add(roofMesh);

  return group;
}
