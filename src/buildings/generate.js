import * as THREE from 'three';

/**
 * Generate a building as a THREE.Group from style + recipe.
 * Geometry is intentionally simple: box walls, pitched/flat roof, painted window rects.
 */
export function generateBuilding(style, recipe) {
  const group = new THREE.Group();

  const volumes = buildVolumes(recipe);
  const fh = style.floorHeight;

  // --- Walls (one merged mesh) ---
  const wallGeo = mergeGeos(volumes.map(v => boxWalls(v, v.floors * fh)));
  const wallMesh = new THREE.Mesh(wallGeo, new THREE.MeshLambertMaterial({ color: recipe.wallColor }));
  wallMesh.name = 'walls';
  group.add(wallMesh);

  // --- Roof ---
  const roofGeo = mergeGeos(volumes.map(v => buildRoof(v, v.floors * fh, style)));
  const roofMesh = new THREE.Mesh(roofGeo, new THREE.MeshLambertMaterial({ color: recipe.roofColor }));
  roofMesh.name = 'roof';
  group.add(roofMesh);

  // --- Windows ---
  const winGeo = mergeGeos(volumes.map(v => buildWindows(v, v.floors * fh, v.floors, style)));
  if (winGeo) {
    const winMesh = new THREE.Mesh(winGeo, new THREE.MeshLambertMaterial({
      color: recipe.windowColor,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    }));
    winMesh.name = 'windows';
    group.add(winMesh);
  }

  // --- Chimney ---
  if (recipe.chimneyCount > 0) {
    const chimGeo = buildChimneys(volumes[0], volumes[0].floors * fh, style, recipe.chimneyCount);
    if (chimGeo) {
      const chimMesh = new THREE.Mesh(chimGeo, new THREE.MeshLambertMaterial({ color: 0x8b4513 }));
      chimMesh.name = 'chimneys';
      group.add(chimMesh);
    }
  }

  return group;
}

// ── Volume layout ─────────────────────────────────────────────

function buildVolumes(recipe) {
  const main = {
    x: 0, z: 0,
    w: recipe.mainWidth, d: recipe.mainDepth,
    floors: recipe.floors, role: 'main',
  };
  const vols = [main];
  for (const wing of recipe.wings) {
    const v = { w: wing.width, d: wing.depth, floors: wing.floors, role: 'wing' };
    if (wing.side === 'left')  { v.x = -wing.width; v.z = 0; }
    else if (wing.side === 'right') { v.x = recipe.mainWidth; v.z = 0; }
    else { v.x = (recipe.mainWidth - wing.width) / 2; v.z = recipe.mainDepth; }
    vols.push(v);
  }
  return vols;
}

// ── Box walls ─────────────────────────────────────────────────

function boxWalls(vol, h) {
  const { x, z, w, d } = vol;
  const x0 = x, x1 = x + w, z0 = z, z1 = z + d;
  const P = [], N = [], I = [];

  // 4 wall quads + top cap
  const faces = [
    // front (-Z)
    [[x0,0,z0],[x1,0,z0],[x1,h,z0],[x0,h,z0], [0,0,-1]],
    // back (+Z)
    [[x1,0,z1],[x0,0,z1],[x0,h,z1],[x1,h,z1], [0,0,1]],
    // left (-X)
    [[x0,0,z1],[x0,0,z0],[x0,h,z0],[x0,h,z1], [-1,0,0]],
    // right (+X)
    [[x1,0,z0],[x1,0,z1],[x1,h,z1],[x1,h,z0], [1,0,0]],
  ];

  for (const [a, b, c, dd, n] of faces) {
    const i = P.length / 3;
    P.push(...a, ...b, ...c, ...dd);
    N.push(...n, ...n, ...n, ...n);
    I.push(i, i+1, i+2, i, i+2, i+3);
  }

  return makeGeo(P, N, I);
}

// ── Roof ──────────────────────────────────────────────────────

function buildRoof(vol, wallH, style) {
  const { x, z, w, d } = vol;
  const pitch = style.roofPitch * Math.PI / 180;
  const oh = style.roofOverhang;

  if (style.roofType === 'flat') {
    return flatRoof(x, z, w, d, wallH);
  }
  if (style.roofType === 'gable') {
    return gableRoof(x, z, w, d, wallH, pitch, oh);
  }
  if (style.roofType === 'hip') {
    return hipRoof(x, z, w, d, wallH, pitch, oh);
  }
  if (style.roofType === 'mansard') {
    return mansardRoof(x, z, w, d, wallH, pitch);
  }
  return flatRoof(x, z, w, d, wallH);
}

function flatRoof(x, z, w, d, wallH) {
  const P = [], N = [], I = [];
  const y = wallH + 0.15;
  const i = 0;
  P.push(x, y, z,  x+w, y, z,  x+w, y, z+d,  x, y, z+d);
  N.push(0,1,0, 0,1,0, 0,1,0, 0,1,0);
  I.push(i, i+1, i+2, i, i+2, i+3);
  return makeGeo(P, N, I);
}

function gableRoof(x, z, w, d, wallH, pitch, oh) {
  const P = [], N = [], I = [];
  // Ridge along longer axis
  const ridgeAlongX = w >= d;
  const span = ridgeAlongX ? d : w;
  const rise = (span / 2) * Math.tan(pitch);
  const ridgeY = wallH + rise;

  if (ridgeAlongX) {
    const mz = z + d / 2;
    // Left slope
    quad(P, N, I,
      [x-oh, wallH, z-oh], [x+w+oh, wallH, z-oh],
      [x+w+oh, ridgeY, mz], [x-oh, ridgeY, mz]);
    // Right slope
    quad(P, N, I,
      [x+w+oh, wallH, z+d+oh], [x-oh, wallH, z+d+oh],
      [x-oh, ridgeY, mz], [x+w+oh, ridgeY, mz]);
    // Gable ends
    tri(P, N, I, [x, wallH, z], [x, wallH, z+d], [x, ridgeY, mz]);
    tri(P, N, I, [x+w, wallH, z+d], [x+w, wallH, z], [x+w, ridgeY, mz]);
  } else {
    const mx = x + w / 2;
    quad(P, N, I,
      [x-oh, wallH, z-oh], [x-oh, wallH, z+d+oh],
      [mx, ridgeY, z+d+oh], [mx, ridgeY, z-oh]);
    quad(P, N, I,
      [x+w+oh, wallH, z+d+oh], [x+w+oh, wallH, z-oh],
      [mx, ridgeY, z-oh], [mx, ridgeY, z+d+oh]);
    tri(P, N, I, [x, wallH, z], [x+w, wallH, z], [mx, ridgeY, z]);
    tri(P, N, I, [x+w, wallH, z+d], [x, wallH, z+d], [mx, ridgeY, z+d]);
  }
  return makeGeo(P, N, I);
}

function hipRoof(x, z, w, d, wallH, pitch, oh) {
  const P = [], N = [], I = [];
  const span = Math.min(w, d);
  const rise = (span / 2) * Math.tan(pitch);
  const ridgeY = wallH + rise;
  const inset = span / 2;

  if (w >= d) {
    const mz = z + d / 2;
    const rx0 = x + inset, rx1 = x + w - inset;
    if (rx0 >= rx1) {
      // Pyramid
      const cx = x + w / 2;
      tri(P, N, I, [x-oh, wallH, z-oh], [x+w+oh, wallH, z-oh], [cx, ridgeY, mz]);
      tri(P, N, I, [x+w+oh, wallH, z-oh], [x+w+oh, wallH, z+d+oh], [cx, ridgeY, mz]);
      tri(P, N, I, [x+w+oh, wallH, z+d+oh], [x-oh, wallH, z+d+oh], [cx, ridgeY, mz]);
      tri(P, N, I, [x-oh, wallH, z+d+oh], [x-oh, wallH, z-oh], [cx, ridgeY, mz]);
    } else {
      // Front slope
      quad(P, N, I,
        [x-oh, wallH, z-oh], [x+w+oh, wallH, z-oh],
        [rx1, ridgeY, mz], [rx0, ridgeY, mz]);
      // Back slope
      quad(P, N, I,
        [x+w+oh, wallH, z+d+oh], [x-oh, wallH, z+d+oh],
        [rx0, ridgeY, mz], [rx1, ridgeY, mz]);
      // Hip ends
      tri(P, N, I, [x-oh, wallH, z+d+oh], [x-oh, wallH, z-oh], [rx0, ridgeY, mz]);
      tri(P, N, I, [x+w+oh, wallH, z-oh], [x+w+oh, wallH, z+d+oh], [rx1, ridgeY, mz]);
    }
  } else {
    const mx = x + w / 2;
    const rz0 = z + inset, rz1 = z + d - inset;
    if (rz0 >= rz1) {
      const cz = z + d / 2;
      tri(P, N, I, [x-oh, wallH, z-oh], [x+w+oh, wallH, z-oh], [mx, ridgeY, cz]);
      tri(P, N, I, [x+w+oh, wallH, z-oh], [x+w+oh, wallH, z+d+oh], [mx, ridgeY, cz]);
      tri(P, N, I, [x+w+oh, wallH, z+d+oh], [x-oh, wallH, z+d+oh], [mx, ridgeY, cz]);
      tri(P, N, I, [x-oh, wallH, z+d+oh], [x-oh, wallH, z-oh], [mx, ridgeY, cz]);
    } else {
      quad(P, N, I,
        [x-oh, wallH, z-oh], [x-oh, wallH, z+d+oh],
        [mx, ridgeY, rz1], [mx, ridgeY, rz0]);
      quad(P, N, I,
        [x+w+oh, wallH, z+d+oh], [x+w+oh, wallH, z-oh],
        [mx, ridgeY, rz0], [mx, ridgeY, rz1]);
      tri(P, N, I, [x-oh, wallH, z-oh], [x+w+oh, wallH, z-oh], [mx, ridgeY, rz0]);
      tri(P, N, I, [x+w+oh, wallH, z+d+oh], [x-oh, wallH, z+d+oh], [mx, ridgeY, rz1]);
    }
  }
  return makeGeo(P, N, I);
}

function mansardRoof(x, z, w, d, wallH, pitch) {
  const P = [], N = [], I = [];
  const inset = Math.min(w, d) * 0.15;
  const lowerAngle = 70 * Math.PI / 180;
  const lowerRise = inset * Math.tan(lowerAngle);
  const breakY = wallH + lowerRise;

  const bx0 = x + inset, bx1 = x + w - inset;
  const bz0 = z + inset, bz1 = z + d - inset;

  // Lower steep slopes (4 quads)
  quad(P, N, I, [x, wallH, z], [x+w, wallH, z], [bx1, breakY, bz0], [bx0, breakY, bz0]);
  quad(P, N, I, [x+w, wallH, z], [x+w, wallH, z+d], [bx1, breakY, bz1], [bx1, breakY, bz0]);
  quad(P, N, I, [x+w, wallH, z+d], [x, wallH, z+d], [bx0, breakY, bz1], [bx1, breakY, bz1]);
  quad(P, N, I, [x, wallH, z+d], [x, wallH, z], [bx0, breakY, bz0], [bx0, breakY, bz1]);

  // Upper flat or low-pitch cap
  const upperPitch = pitch * Math.PI / 180;
  const upperSpan = Math.min(bx1 - bx0, bz1 - bz0);
  const upperRise = (upperSpan / 2) * Math.tan(upperPitch);
  const topY = breakY + upperRise;

  // Simple flat cap on the upper section
  const ci = P.length / 3;
  P.push(bx0, topY, bz0,  bx1, topY, bz0,  bx1, topY, bz1,  bx0, topY, bz1);
  N.push(0,1,0, 0,1,0, 0,1,0, 0,1,0);
  I.push(ci, ci+1, ci+2, ci, ci+2, ci+3);

  // Connect break to top with 4 sloped quads
  quad(P, N, I, [bx0, breakY, bz0], [bx1, breakY, bz0], [bx1, topY, bz0], [bx0, topY, bz0]);
  quad(P, N, I, [bx1, breakY, bz0], [bx1, breakY, bz1], [bx1, topY, bz1], [bx1, topY, bz0]);
  quad(P, N, I, [bx1, breakY, bz1], [bx0, breakY, bz1], [bx0, topY, bz1], [bx1, topY, bz1]);
  quad(P, N, I, [bx0, breakY, bz1], [bx0, breakY, bz0], [bx0, topY, bz0], [bx0, topY, bz1]);

  return makeGeo(P, N, I);
}

// ── Windows ───────────────────────────────────────────────────

function buildWindows(vol, wallH, floors, style) {
  const P = [], N = [], I = [];
  const { x, z, w, d } = vol;
  const fh = style.floorHeight;
  const ww = style.windowWidth;
  const wh = style.windowHeight;
  const spacing = style.windowSpacing;
  const sillFrac = 0.3; // window sill at 30% of floor height
  const OFF = 0.02; // offset from wall

  // Define 4 walls: start corner, direction along wall, length, outward normal
  const walls = [
    { sx: x,   sz: z,   dx: 1,  dz: 0,  len: w, nx: 0,  nz: -1 }, // front
    { sx: x+w, sz: z,   dx: 0,  dz: 1,  len: d, nx: 1,  nz: 0 },  // right
    { sx: x+w, sz: z+d, dx: -1, dz: 0,  len: w, nx: 0,  nz: 1 },  // back
    { sx: x,   sz: z+d, dx: 0,  dz: -1, len: d, nx: -1, nz: 0 },  // left
  ];

  for (const wall of walls) {
    const nWin = Math.max(1, Math.floor(wall.len / spacing));
    const startOffset = (wall.len - (nWin - 1) * spacing) / 2;

    for (let floor = 0; floor < floors; floor++) {
      const decay = 1 - style.windowHeightDecay * floor;
      const curWh = wh * decay;
      const bot = floor * fh + fh * sillFrac;
      const top = bot + curWh;
      if (top > (floor + 1) * fh - 0.15) continue;

      for (let wi = 0; wi < nWin; wi++) {
        const along = startOffset + wi * spacing;
        const cx = wall.sx + wall.dx * along;
        const cz = wall.sz + wall.dz * along;
        const ox = wall.nx * OFF;
        const oz = wall.nz * OFF;
        const hw = ww / 2;

        const i = P.length / 3;
        if (wall.nx === 0) {
          // Z-facing wall, window spans in X
          P.push(
            cx - wall.dx * hw + ox, bot, cz + oz,
            cx + wall.dx * hw + ox, bot, cz + oz,
            cx + wall.dx * hw + ox, top, cz + oz,
            cx - wall.dx * hw + ox, top, cz + oz,
          );
        } else {
          // X-facing wall, window spans in Z
          P.push(
            cx + ox, bot, cz - wall.dz * hw + oz,
            cx + ox, bot, cz + wall.dz * hw + oz,
            cx + ox, top, cz + wall.dz * hw + oz,
            cx + ox, top, cz - wall.dz * hw + oz,
          );
        }
        N.push(wall.nx, 0, wall.nz, wall.nx, 0, wall.nz, wall.nx, 0, wall.nz, wall.nx, 0, wall.nz);
        I.push(i, i+1, i+2, i, i+2, i+3);
      }
    }
  }

  if (P.length === 0) return null;
  return makeGeo(P, N, I);
}

// ── Chimneys ──────────────────────────────────────────────────

function buildChimneys(vol, wallH, style, count) {
  const P = [], N = [], I = [];
  const pitch = style.roofPitch * Math.PI / 180;
  const span = Math.min(vol.w, vol.d);
  const rise = style.roofType === 'flat' ? 0.15 : (span / 2) * Math.tan(pitch);
  const ridgeY = wallH + rise;
  const cw = 0.4, cd = 0.5, ch = 1.2;

  for (let ci = 0; ci < count; ci++) {
    const t = count === 1 ? 0.5 : (ci === 0 ? 0.3 : 0.7);
    const cx = vol.x + vol.w * t;
    const cz = vol.z + vol.d * 0.5;
    // Simple box
    addBox(P, N, I, cx - cw/2, ridgeY, cz - cd/2, cw, ch, cd);
  }

  if (P.length === 0) return null;
  return makeGeo(P, N, I);
}

function addBox(P, N, I, x, y, z, w, h, d) {
  const faces = [
    [[x,y,z],[x+w,y,z],[x+w,y+h,z],[x,y+h,z], [0,0,-1]],
    [[x+w,y,z+d],[x,y,z+d],[x,y+h,z+d],[x+w,y+h,z+d], [0,0,1]],
    [[x,y,z+d],[x,y,z],[x,y+h,z],[x,y+h,z+d], [-1,0,0]],
    [[x+w,y,z],[x+w,y,z+d],[x+w,y+h,z+d],[x+w,y+h,z], [1,0,0]],
    [[x,y+h,z],[x+w,y+h,z],[x+w,y+h,z+d],[x,y+h,z+d], [0,1,0]],
  ];
  for (const [a, b, c, dd, n] of faces) {
    const i = P.length / 3;
    P.push(...a, ...b, ...c, ...dd);
    N.push(...n, ...n, ...n, ...n);
    I.push(i, i+1, i+2, i, i+2, i+3);
  }
}

// ── Geometry helpers ──────────────────────────────────────────

function quad(P, N, I, a, b, c, d) {
  const i = P.length / 3;
  P.push(...a, ...b, ...c, ...d);
  // Compute face normal from cross product
  const ux = b[0]-a[0], uy = b[1]-a[1], uz = b[2]-a[2];
  const vx = c[0]-a[0], vy = c[1]-a[1], vz = c[2]-a[2];
  let nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx;
  const len = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
  nx /= len; ny /= len; nz /= len;
  N.push(nx,ny,nz, nx,ny,nz, nx,ny,nz, nx,ny,nz);
  I.push(i, i+1, i+2, i, i+2, i+3);
}

function tri(P, N, I, a, b, c) {
  const i = P.length / 3;
  P.push(...a, ...b, ...c);
  const ux = b[0]-a[0], uy = b[1]-a[1], uz = b[2]-a[2];
  const vx = c[0]-a[0], vy = c[1]-a[1], vz = c[2]-a[2];
  let nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx;
  const len = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
  nx /= len; ny /= len; nz /= len;
  N.push(nx,ny,nz, nx,ny,nz, nx,ny,nz);
  I.push(i, i+1, i+2);
}

function makeGeo(P, N, I) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  geo.setIndex(I);
  return geo;
}

function mergeGeos(geos) {
  const filtered = geos.filter(Boolean);
  if (filtered.length === 0) return makeGeo([], [], []);
  if (filtered.length === 1) return filtered[0];

  const P = [], N = [], I = [];
  for (const geo of filtered) {
    const offset = P.length / 3;
    const pos = geo.attributes.position.array;
    const nor = geo.attributes.normal.array;
    const idx = geo.index.array;
    for (let i = 0; i < pos.length; i++) P.push(pos[i]);
    for (let i = 0; i < nor.length; i++) N.push(nor[i]);
    for (let i = 0; i < idx.length; i++) I.push(idx[i] + offset);
    geo.dispose();
  }
  return makeGeo(P, N, I);
}
