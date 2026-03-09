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
 * Check if a test point (offset slightly from a wall center in the normal
 * direction) is inside any other volume. Used to cull interior wall faces.
 */
function isInsideOtherVolume(testX, testY, testZ, vol, allVolumes, style) {
  for (const other of allVolumes) {
    if (other === vol) continue;
    const otherWallTop = other.floors * style.floorHeight;
    if (
      testX > other.x && testX < other.x + other.width &&
      testZ > other.z && testZ < other.z + other.depth &&
      testY < otherWallTop
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Compute the wall face definitions for a volume.
 * Returns an array of { v0, v1, v2, v3, nx, ny, nz, wallLength, axis } objects,
 * one per face. Faces whose outward test point lies inside another volume are excluded.
 */
function getExteriorWallFaces(vol, wallHeight, allVolumes, style) {
  const x0 = vol.x;
  const x1 = vol.x + vol.width;
  const z0 = vol.z;
  const z1 = vol.z + vol.depth;
  const y0 = 0;
  const y1 = wallHeight;
  const EPS = 0.05; // outward offset for inside test

  // Define all 4 wall faces
  const faces = [
    // Front face (z = z0, normal toward -Z)
    {
      v0: [x0, y1, z0], v1: [x1, y1, z0],
      v2: [x0, y0, z0], v3: [x1, y0, z0],
      nx: 0, ny: 0, nz: -1,
      wallLength: vol.width, axis: 'x',
    },
    // Back face (z = z1, normal toward +Z)
    {
      v0: [x1, y1, z1], v1: [x0, y1, z1],
      v2: [x1, y0, z1], v3: [x0, y0, z1],
      nx: 0, ny: 0, nz: 1,
      wallLength: vol.width, axis: 'x',
    },
    // Left face (x = x0, normal toward -X)
    {
      v0: [x0, y1, z1], v1: [x0, y1, z0],
      v2: [x0, y0, z1], v3: [x0, y0, z0],
      nx: -1, ny: 0, nz: 0,
      wallLength: vol.depth, axis: 'z',
    },
    // Right face (x = x1, normal toward +X)
    {
      v0: [x1, y1, z0], v1: [x1, y1, z1],
      v2: [x1, y0, z0], v3: [x1, y0, z1],
      nx: 1, ny: 0, nz: 0,
      wallLength: vol.depth, axis: 'z',
    },
  ];

  // Filter out interior faces
  const exterior = [];
  for (const face of faces) {
    // Center of the wall face
    const cx = (face.v0[0] + face.v3[0]) / 2;
    const cy = (face.v0[1] + face.v2[1]) / 2;
    const cz = (face.v0[2] + face.v3[2]) / 2;
    // Test point offset outward by EPS
    const testX = cx + face.nx * EPS;
    const testY = cy;
    const testZ = cz + face.nz * EPS;

    if (!isInsideOtherVolume(testX, testY, testZ, vol, allVolumes, style)) {
      exterior.push(face);
    }
  }
  return exterior;
}

/**
 * Generate wall geometry for a single volume, skipping interior faces
 * that are occluded by another volume.
 */
function generateWalls(vol, wallHeight, allVolumes, style) {
  const faces = getExteriorWallFaces(vol, wallHeight, allVolumes, style);

  const positions = [];
  const normals = [];
  const indices = [];

  function addQuad(v0, v1, v2, v3, nx, ny, nz) {
    const base = positions.length / 3;
    positions.push(...v0, ...v1, ...v2, ...v3);
    normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz);
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }

  for (const face of faces) {
    addQuad(face.v0, face.v1, face.v2, face.v3, face.nx, face.ny, face.nz);
  }

  return { positions, normals, indices };
}

/**
 * Generate window geometry for a single volume's exterior walls.
 * Windows are dark quads offset 0.01m from the wall surface.
 */
function generateWindows(vol, wallHeight, allVolumes, style) {
  const faces = getExteriorWallFaces(vol, wallHeight, allVolumes, style);

  const positions = [];
  const normals = [];
  const indices = [];

  function addQuad(v0, v1, v2, v3, nx, ny, nz) {
    const base = positions.length / 3;
    positions.push(...v0, ...v1, ...v2, ...v3);
    normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz);
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }

  const spacing = style.windowSpacing;
  const winW = style.windowWidth;
  const floorH = style.floorHeight;
  const OFFSET = 0.01;

  for (const face of faces) {
    const wallLen = face.wallLength;

    // Number of windows along this wall
    const count = Math.max(1, Math.floor((wallLen - spacing * 0.5) / spacing));

    // Total span occupied by windows array
    const totalSpan = (count - 1) * spacing;

    for (let floor = 0; floor < vol.floors; floor++) {
      const winBottom = floor * floorH + floorH * 0.3;
      const winHeight = style.windowHeight * (1 - style.windowHeightDecay * floor);
      const winTop = winBottom + winHeight;

      // Skip if window top is within 0.1m of the ceiling
      const ceiling = (floor + 1) * floorH;
      if (winTop > ceiling - 0.1) continue;

      for (let wi = 0; wi < count; wi++) {
        // Center position along wall for this window
        const t = (wallLen - totalSpan) / 2 + wi * spacing;
        const halfW = winW / 2;
        const tLeft = t - halfW;
        const tRight = t + halfW;

        // Compute world-space corners
        // The wall quad has v2 as bottom-left and v3 as bottom-right
        // along the wall's length axis.
        let p0, p1, p2, p3; // top-left, top-right, bottom-left, bottom-right

        if (face.axis === 'x') {
          // Wall runs along X axis
          // v2 and v3 are the bottom corners; figure out x direction
          const xMin = Math.min(face.v2[0], face.v3[0]);
          const z = face.v0[2] + face.nz * OFFSET;

          p0 = [xMin + tLeft, winTop, z];
          p1 = [xMin + tRight, winTop, z];
          p2 = [xMin + tLeft, winBottom, z];
          p3 = [xMin + tRight, winBottom, z];
        } else {
          // Wall runs along Z axis
          const zMin = Math.min(face.v2[2], face.v3[2]);
          const x = face.v0[0] + face.nx * OFFSET;

          p0 = [x, winTop, zMin + tLeft];
          p1 = [x, winTop, zMin + tRight];
          p2 = [x, winBottom, zMin + tLeft];
          p3 = [x, winBottom, zMin + tRight];
        }

        addQuad(p0, p1, p2, p3, face.nx, face.ny, face.nz);
      }
    }
  }

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
 * Generate sill geometry for a single volume's exterior walls.
 * Sills are thin horizontal strips below each window.
 */
function generateSills(vol, wallHeight, allVolumes, style) {
  const faces = getExteriorWallFaces(vol, wallHeight, allVolumes, style);

  const positions = [];
  const normals = [];
  const indices = [];

  function addQuad(v0, v1, v2, v3, nx, ny, nz) {
    const base = positions.length / 3;
    positions.push(...v0, ...v1, ...v2, ...v3);
    normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz);
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }

  const spacing = style.windowSpacing;
  const winW = style.windowWidth;
  const floorH = style.floorHeight;
  const OFFSET = 0.015;
  const sillH = 0.05;
  const sillW = winW + 0.1;

  for (const face of faces) {
    const wallLen = face.wallLength;
    const count = Math.max(1, Math.floor((wallLen - spacing * 0.5) / spacing));
    const totalSpan = (count - 1) * spacing;

    for (let floor = 0; floor < vol.floors; floor++) {
      const winBottom = floor * floorH + floorH * 0.3;
      const winHeight = style.windowHeight * (1 - style.windowHeightDecay * floor);
      const winTop = winBottom + winHeight;
      const ceiling = (floor + 1) * floorH;
      if (winTop > ceiling - 0.1) continue;

      const sillBottom = winBottom - sillH;
      const sillTop = winBottom;

      for (let wi = 0; wi < count; wi++) {
        const t = (wallLen - totalSpan) / 2 + wi * spacing;
        const halfW = sillW / 2;
        const tLeft = t - halfW;
        const tRight = t + halfW;

        let p0, p1, p2, p3;
        if (face.axis === 'x') {
          const xMin = Math.min(face.v2[0], face.v3[0]);
          const z = face.v0[2] + face.nz * OFFSET;
          p0 = [xMin + tLeft, sillTop, z];
          p1 = [xMin + tRight, sillTop, z];
          p2 = [xMin + tLeft, sillBottom, z];
          p3 = [xMin + tRight, sillBottom, z];
        } else {
          const zMin = Math.min(face.v2[2], face.v3[2]);
          const x = face.v0[0] + face.nx * OFFSET;
          p0 = [x, sillTop, zMin + tLeft];
          p1 = [x, sillTop, zMin + tRight];
          p2 = [x, sillBottom, zMin + tLeft];
          p3 = [x, sillBottom, zMin + tRight];
        }

        addQuad(p0, p1, p2, p3, face.nx, face.ny, face.nz);
      }
    }
  }

  return { positions, normals, indices };
}

/**
 * Generate cornice geometry for a single volume's exterior walls.
 * Cornice is a horizontal band at the top of each wall.
 */
function generateCornice(vol, wallHeight, allVolumes, style) {
  const faces = getExteriorWallFaces(vol, wallHeight, allVolumes, style);

  const positions = [];
  const normals = [];
  const indices = [];

  function addQuad(v0, v1, v2, v3, nx, ny, nz) {
    const base = positions.length / 3;
    positions.push(...v0, ...v1, ...v2, ...v3);
    normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz);
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }

  const OFFSET = 0.02;
  const corniceH = 0.15;
  const corniceTop = wallHeight;
  const corniceBottom = wallHeight - corniceH;

  for (const face of faces) {
    // Full-length cornice strip on this wall face
    if (face.axis === 'x') {
      const xMin = Math.min(face.v2[0], face.v3[0]);
      const xMax = Math.max(face.v2[0], face.v3[0]);
      const z = face.v0[2] + face.nz * OFFSET;
      const p0 = [xMin, corniceTop, z];
      const p1 = [xMax, corniceTop, z];
      const p2 = [xMin, corniceBottom, z];
      const p3 = [xMax, corniceBottom, z];
      addQuad(p0, p1, p2, p3, face.nx, face.ny, face.nz);
    } else {
      const zMin = Math.min(face.v2[2], face.v3[2]);
      const zMax = Math.max(face.v2[2], face.v3[2]);
      const x = face.v0[0] + face.nx * OFFSET;
      const p0 = [x, corniceTop, zMin];
      const p1 = [x, corniceTop, zMax];
      const p2 = [x, corniceBottom, zMin];
      const p3 = [x, corniceBottom, zMax];
      addQuad(p0, p1, p2, p3, face.nx, face.ny, face.nz);
    }
  }

  return { positions, normals, indices };
}

/**
 * Generate quoin geometry for a single volume's exterior corners.
 * Alternating blocks placed up the full wall height at each corner.
 */
function generateQuoins(vol, wallHeight, allVolumes, style) {
  const positions = [];
  const normals = [];
  const indices = [];

  function addQuad(v0, v1, v2, v3, nx, ny, nz) {
    const base = positions.length / 3;
    positions.push(...v0, ...v1, ...v2, ...v3);
    normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz);
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }

  const OFFSET = 0.015;
  const blockW = 0.3;
  const blockH = 0.4;

  const x0 = vol.x;
  const x1 = vol.x + vol.width;
  const z0 = vol.z;
  const z1 = vol.z + vol.depth;

  // Four corners, each has two wall faces
  const corners = [
    { cx: x0, cz: z0, normals: [[-1, 0, 0], [0, 0, -1]], axes: ['z', 'x'] },
    { cx: x1, cz: z0, normals: [[1, 0, 0], [0, 0, -1]], axes: ['z', 'x'] },
    { cx: x0, cz: z1, normals: [[-1, 0, 0], [0, 0, 1]], axes: ['z', 'x'] },
    { cx: x1, cz: z1, normals: [[1, 0, 0], [0, 0, 1]], axes: ['z', 'x'] },
  ];

  // Check which corners are exterior (both adjacent faces must be exterior)
  const exteriorFaces = getExteriorWallFaces(vol, wallHeight, allVolumes, style);

  for (const corner of corners) {
    const blockCount = Math.floor(wallHeight / blockH);

    for (let i = 0; i < blockCount; i++) {
      const yBot = i * blockH;
      const yTop = yBot + blockH;

      // Place a quoin quad on each of the two wall faces at this corner
      for (let fi = 0; fi < 2; fi++) {
        const n = corner.normals[fi];
        const nx = n[0], ny = n[1], nz = n[2];

        let p0, p1, p2, p3;
        if (fi === 0) {
          // Face along Z axis (left or right wall)
          const x = corner.cx + nx * OFFSET;
          const zDir = corner.cz === z0 ? 1 : -1;
          const zStart = corner.cz;
          p0 = [x, yTop, zStart];
          p1 = [x, yTop, zStart + zDir * blockW];
          p2 = [x, yBot, zStart];
          p3 = [x, yBot, zStart + zDir * blockW];
        } else {
          // Face along X axis (front or back wall)
          const z = corner.cz + nz * OFFSET;
          const xDir = corner.cx === x0 ? 1 : -1;
          const xStart = corner.cx;
          p0 = [xStart, yTop, z];
          p1 = [xStart + xDir * blockW, yTop, z];
          p2 = [xStart, yBot, z];
          p3 = [xStart + xDir * blockW, yBot, z];
        }

        addQuad(p0, p1, p2, p3, nx, ny, nz);
      }
    }
  }

  return { positions, normals, indices };
}

/**
 * Generate porch geometry: posts and a roof slab extending from the front wall.
 */
function generatePorch(recipe, style) {
  const positions = [];
  const normals = [];
  const indices = [];

  function addQuad(v0, v1, v2, v3, nx, ny, nz) {
    const base = positions.length / 3;
    positions.push(...v0, ...v1, ...v2, ...v3);
    normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz);
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }

  const depth = recipe.porchDepth;
  const width = recipe.mainWidth;
  const floorH = style.floorHeight;
  const postSize = 0.15;

  // Front wall is at z=0, porch extends in -Z direction
  const z0 = 0;
  const z1 = -depth;

  // Roof slab (thin horizontal quad) at floorHeight above ground
  const roofY = floorH;
  addQuad(
    [0, roofY, z0], [width, roofY, z0],
    [0, roofY, z1], [width, roofY, z1],
    0, 1, 0,
  );

  // Posts at corners and every 2m along front edge
  const postPositions = [0, width - postSize];
  const step = 2.0;
  for (let x = step; x < width - postSize; x += step) {
    postPositions.push(x);
  }

  for (const px of postPositions) {
    // Each post is a thin box: 4 vertical faces
    const pxR = px + postSize;
    const pzF = z1;
    const pzB = z1 + postSize;

    // Front face (-Z)
    addQuad(
      [px, floorH, pzF], [pxR, floorH, pzF],
      [px, 0, pzF], [pxR, 0, pzF],
      0, 0, -1,
    );
    // Back face (+Z)
    addQuad(
      [pxR, floorH, pzB], [px, floorH, pzB],
      [pxR, 0, pzB], [px, 0, pzB],
      0, 0, 1,
    );
    // Left face (-X)
    addQuad(
      [px, floorH, pzB], [px, floorH, pzF],
      [px, 0, pzB], [px, 0, pzF],
      -1, 0, 0,
    );
    // Right face (+X)
    addQuad(
      [pxR, floorH, pzF], [pxR, floorH, pzB],
      [pxR, 0, pzF], [pxR, 0, pzB],
      1, 0, 0,
    );
  }

  return { positions, normals, indices };
}

/**
 * Generate balcony geometry on the front wall of the main volume.
 */
function generateBalconies(recipe, style) {
  const positions = [];
  const normals = [];
  const indices = [];

  function addQuad(v0, v1, v2, v3, nx, ny, nz) {
    const base = positions.length / 3;
    positions.push(...v0, ...v1, ...v2, ...v3);
    normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz);
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }

  const floorH = style.floorHeight;
  const platDepth = 1.2;
  const platThick = 0.1;
  const platWidth = recipe.mainWidth - 1.0;
  const railH = 1.0;
  const railThick = 0.03;
  const xOffset = 0.5; // centered on main volume

  for (const floorIndex of recipe.balconyFloors) {
    const platY = floorIndex * floorH;
    const platBot = platY - platThick;
    const z0 = 0; // front wall
    const z1 = -platDepth;

    // Platform top face
    addQuad(
      [xOffset, platY, z0], [xOffset + platWidth, platY, z0],
      [xOffset, platY, z1], [xOffset + platWidth, platY, z1],
      0, 1, 0,
    );
    // Platform bottom face
    addQuad(
      [xOffset + platWidth, platBot, z0], [xOffset, platBot, z0],
      [xOffset + platWidth, platBot, z1], [xOffset, platBot, z1],
      0, -1, 0,
    );
    // Platform front edge
    addQuad(
      [xOffset, platY, z1], [xOffset + platWidth, platY, z1],
      [xOffset, platBot, z1], [xOffset + platWidth, platBot, z1],
      0, 0, -1,
    );

    // Railing at outer edge
    const railTop = platY + railH;
    addQuad(
      [xOffset, railTop, z1], [xOffset + platWidth, railTop, z1],
      [xOffset, platY, z1], [xOffset + platWidth, platY, z1],
      0, 0, -1,
    );
    // Railing back face (facing building)
    addQuad(
      [xOffset + platWidth, railTop, z1 + railThick], [xOffset, railTop, z1 + railThick],
      [xOffset + platWidth, platY, z1 + railThick], [xOffset, platY, z1 + railThick],
      0, 0, 1,
    );
  }

  return { positions, normals, indices };
}

/**
 * Generate dormer geometry on the front roof slope.
 * Simplified: positioned at wall-top height as small gabled boxes.
 */
function generateDormers(recipe, style) {
  const positions = [];
  const normals = [];
  const indices = [];

  function addQuad(v0, v1, v2, v3, nx, ny, nz) {
    const base = positions.length / 3;
    positions.push(...v0, ...v1, ...v2, ...v3);
    normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz);
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }

  const wallHeight = recipe.floors * style.floorHeight;
  const dormerW = style.windowWidth + 0.4;
  const dormerH = style.windowHeight * 0.7;
  const dormerD = 0.6;
  const spacing = style.windowSpacing;
  const width = recipe.mainWidth;

  // How many dormers fit
  let count = Math.max(1, Math.floor((width - spacing * 0.5) / spacing));
  if (recipe.dormerCount < 99) {
    count = Math.min(count, recipe.dormerCount);
  }

  const totalSpan = (count - 1) * spacing;
  const z0 = -0.1; // slightly in front of front wall

  for (let i = 0; i < count; i++) {
    const cx = (width - totalSpan) / 2 + i * spacing;
    const cy = wallHeight + dormerH / 2;
    const halfW = dormerW / 2;
    const halfH = dormerH / 2;

    const xL = cx - halfW;
    const xR = cx + halfW;
    const yBot = cy - halfH;
    const yTop = cy + halfH;
    const zFront = z0;
    const zBack = z0 + dormerD;

    // Front face (wallColor)
    addQuad(
      [xL, yTop, zFront], [xR, yTop, zFront],
      [xL, yBot, zFront], [xR, yBot, zFront],
      0, 0, -1,
    );
    // Left side
    addQuad(
      [xL, yTop, zBack], [xL, yTop, zFront],
      [xL, yBot, zBack], [xL, yBot, zFront],
      -1, 0, 0,
    );
    // Right side
    addQuad(
      [xR, yTop, zFront], [xR, yTop, zBack],
      [xR, yBot, zFront], [xR, yBot, zBack],
      1, 0, 0,
    );
    // Top face (acts as tiny roof)
    addQuad(
      [xL, yTop, zFront], [xR, yTop, zFront],
      [xL, yTop, zBack], [xR, yTop, zBack],
      0, 1, 0,
    );
  }

  return { positions, normals, indices };
}

/**
 * Generate chimney geometry sitting on the roof ridge.
 */
function generateChimneys(recipe, style) {
  const positions = [];
  const normals = [];
  const indices = [];

  function addQuad(v0, v1, v2, v3, nx, ny, nz) {
    const base = positions.length / 3;
    positions.push(...v0, ...v1, ...v2, ...v3);
    normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz);
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }

  const wallHeight = recipe.floors * style.floorHeight;
  const pitchRad = (style.roofPitch * Math.PI) / 180;
  const w = recipe.mainWidth;
  const d = recipe.mainDepth;
  const shorter = Math.min(w, d);

  // Compute ridge Y based on roof type
  let ridgeY;
  switch (style.roofType) {
    case 'flat':
      ridgeY = wallHeight + 0.15;
      break;
    case 'mansard': {
      const inset = shorter * 0.15;
      const breakHeight = wallHeight + inset * Math.tan((70 * Math.PI) / 180);
      const innerShorter = shorter - 2 * inset;
      const innerInset = innerShorter / 2;
      ridgeY = breakHeight + innerInset * Math.tan(pitchRad);
      break;
    }
    default: // gable, hip
      ridgeY = wallHeight + (shorter / 2) * Math.tan(pitchRad);
      break;
  }

  // Ridge runs along the longer axis
  const ridgeLen = Math.max(w, d);

  const chimW = 0.4;
  const chimD = 0.6;
  const chimH = 1.5;

  // Placement along ridge
  const placements = [];
  if (recipe.chimneyCount === 1) {
    placements.push(0.3);
  } else if (recipe.chimneyCount >= 2) {
    placements.push(0.25, 0.75);
  }

  for (const t of placements) {
    // Position along the ridge
    let cx, cz;
    if (w >= d) {
      // Ridge along X
      cx = t * w;
      cz = d / 2;
    } else {
      // Ridge along Z
      cx = w / 2;
      cz = t * d;
    }

    const x0 = cx - chimW / 2;
    const x1 = cx + chimW / 2;
    const z0 = cz - chimD / 2;
    const z1 = cz + chimD / 2;
    const yBot = ridgeY;
    const yTop = ridgeY + chimH;

    // Four vertical faces
    // Front (-Z)
    addQuad(
      [x0, yTop, z0], [x1, yTop, z0],
      [x0, yBot, z0], [x1, yBot, z0],
      0, 0, -1,
    );
    // Back (+Z)
    addQuad(
      [x1, yTop, z1], [x0, yTop, z1],
      [x1, yBot, z1], [x0, yBot, z1],
      0, 0, 1,
    );
    // Left (-X)
    addQuad(
      [x0, yTop, z1], [x0, yTop, z0],
      [x0, yBot, z1], [x0, yBot, z0],
      -1, 0, 0,
    );
    // Right (+X)
    addQuad(
      [x1, yTop, z0], [x1, yTop, z1],
      [x1, yBot, z0], [x1, yBot, z1],
      1, 0, 0,
    );
    // Top
    addQuad(
      [x0, yTop, z0], [x1, yTop, z0],
      [x0, yTop, z1], [x1, yTop, z1],
      0, 1, 0,
    );
  }

  return { positions, normals, indices };
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

  // --- Walls (with interior face clipping) ---
  const wallParts = [];
  for (const vol of volumes) {
    const wallHeight = vol.floors * style.floorHeight;
    wallParts.push(generateWalls(vol, wallHeight, volumes, style));
  }
  const wallData = mergeGeometryData(wallParts);
  const wallGeometry = buildGeometry(wallData);
  const wallMaterial = new THREE.MeshLambertMaterial({ color: recipe.wallColor });
  const wallMesh = new THREE.Mesh(wallGeometry, wallMaterial);
  wallMesh.name = 'walls';
  group.add(wallMesh);

  // --- Windows ---
  const windowParts = [];
  for (const vol of volumes) {
    const wallHeight = vol.floors * style.floorHeight;
    windowParts.push(generateWindows(vol, wallHeight, volumes, style));
  }
  const windowData = mergeGeometryData(windowParts);
  const windowGeometry = buildGeometry(windowData);
  const windowMaterial = new THREE.MeshLambertMaterial({
    color: recipe.windowColor,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const windowMesh = new THREE.Mesh(windowGeometry, windowMaterial);
  windowMesh.name = 'windows';
  group.add(windowMesh);

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

  // --- Trim material (shared by sills, cornice, quoins, porch, balconies) ---
  const trimMaterial = new THREE.MeshLambertMaterial({
    color: recipe.trimColor,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });

  // --- Sills ---
  if (recipe.hasSills) {
    const sillParts = [];
    for (const vol of volumes) {
      const wallHeight = vol.floors * style.floorHeight;
      sillParts.push(generateSills(vol, wallHeight, volumes, style));
    }
    const sillData = mergeGeometryData(sillParts);
    if (sillData.positions.length > 0) {
      const sillGeometry = buildGeometry(sillData);
      const sillMesh = new THREE.Mesh(sillGeometry, trimMaterial);
      sillMesh.name = 'sills';
      group.add(sillMesh);
    }
  }

  // --- Cornice ---
  if (recipe.hasCornice) {
    const corniceParts = [];
    for (const vol of volumes) {
      const wallHeight = vol.floors * style.floorHeight;
      corniceParts.push(generateCornice(vol, wallHeight, volumes, style));
    }
    const corniceData = mergeGeometryData(corniceParts);
    if (corniceData.positions.length > 0) {
      const corniceGeometry = buildGeometry(corniceData);
      const corniceMesh = new THREE.Mesh(corniceGeometry, trimMaterial);
      corniceMesh.name = 'cornice';
      group.add(corniceMesh);
    }
  }

  // --- Quoins ---
  if (recipe.hasQuoins) {
    const quoinParts = [];
    for (const vol of volumes) {
      const wallHeight = vol.floors * style.floorHeight;
      quoinParts.push(generateQuoins(vol, wallHeight, volumes, style));
    }
    const quoinData = mergeGeometryData(quoinParts);
    if (quoinData.positions.length > 0) {
      const quoinGeometry = buildGeometry(quoinData);
      const quoinMesh = new THREE.Mesh(quoinGeometry, trimMaterial);
      quoinMesh.name = 'quoins';
      group.add(quoinMesh);
    }
  }

  // --- Porch ---
  if (recipe.hasPorch && recipe.porchDepth > 0) {
    const porchData = generatePorch(recipe, style);
    if (porchData.positions.length > 0) {
      const porchGeometry = buildGeometry(porchData);
      const porchMesh = new THREE.Mesh(porchGeometry, trimMaterial);
      porchMesh.name = 'porch';
      group.add(porchMesh);
    }
  }

  // --- Balconies ---
  if (recipe.hasBalcony && recipe.balconyFloors.length > 0) {
    const balconyData = generateBalconies(recipe, style);
    if (balconyData.positions.length > 0) {
      const balconyGeometry = buildGeometry(balconyData);
      const balconyMesh = new THREE.Mesh(balconyGeometry, trimMaterial);
      balconyMesh.name = 'balconies';
      group.add(balconyMesh);
    }
  }

  // --- Dormers ---
  if (recipe.hasDormers && recipe.dormerCount > 0) {
    const dormerData = generateDormers(recipe, style);
    if (dormerData.positions.length > 0) {
      const dormerGeometry = buildGeometry(dormerData);
      const dormerMaterial = new THREE.MeshLambertMaterial({ color: recipe.wallColor });
      const dormerMesh = new THREE.Mesh(dormerGeometry, dormerMaterial);
      dormerMesh.name = 'dormers';
      group.add(dormerMesh);
    }
  }

  // --- Chimneys ---
  if (recipe.chimneyCount > 0) {
    const chimneyData = generateChimneys(recipe, style);
    if (chimneyData.positions.length > 0) {
      const chimneyGeometry = buildGeometry(chimneyData);
      const chimneyMaterial = new THREE.MeshLambertMaterial({ color: 0x8b4513 });
      const chimneyMesh = new THREE.Mesh(chimneyGeometry, chimneyMaterial);
      chimneyMesh.name = 'chimneys';
      group.add(chimneyMesh);
    }
  }

  return group;
}
