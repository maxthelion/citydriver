import * as THREE from 'three';

/**
 * Composable building API.
 *
 * createHouse(w, d, floorHeight) → house object with a one-storey box
 * addFloor(house)                → adds a storey
 * addPitchedRoof(house, pitch, direction) → gable roof
 * addFrontDoor(house, placement)  → door on front face
 * addBackDoor(house, placement)  → door on back face
 * addPorch(house, {face})        → covered porch (front or back)
 * addWindows(house, opts)        → windows on all walls
 * addExtension(house, opts)      → rear extension (half/full width)
 * addDormer(house, opts)         → dormer on roof slope
 *
 * house.group is the THREE.Group to add to a scene.
 */

// ── Window pane textures ─────────────────────────────────────

const _windowTextureCache = new Map();

function _createCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  // Minimal stub for headless environments
  const buf = { width: w, height: h };
  buf.getContext = () => ({
    fillStyle: '', strokeStyle: '', lineWidth: 0,
    fillRect() {}, strokeRect() {}, beginPath() {},
    moveTo() {}, lineTo() {}, stroke() {},
  });
  return buf;
}

function _drawWindowPattern(ctx, w, h, style) {
  // Glass background
  ctx.fillStyle = '#88aabb';
  ctx.fillRect(0, 0, w, h);

  // Mullion lines
  ctx.strokeStyle = '#c8c8c8';
  ctx.lineWidth = 2;

  if (style === 'sash') {
    // 2x2 grid: horizontal bar at middle, vertical bar at middle
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(w / 2, 0);
    ctx.lineTo(w / 2, h);
    ctx.stroke();
  } else if (style === 'georgian') {
    // 3x2 grid: vertical bar at middle, horizontal bars at 1/3 and 2/3
    ctx.beginPath();
    ctx.moveTo(w / 2, 0);
    ctx.lineTo(w / 2, h);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, h / 3);
    ctx.lineTo(w, h / 3);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, (2 * h) / 3);
    ctx.lineTo(w, (2 * h) / 3);
    ctx.stroke();
  } else if (style === 'casement') {
    // 2x1: vertical bar only
    ctx.beginPath();
    ctx.moveTo(w / 2, 0);
    ctx.lineTo(w / 2, h);
    ctx.stroke();
  }
  // 'single' — no mullions, just the frame below

  // Frame border
  ctx.strokeStyle = '#c0c0c0';
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, w, h);
}

/**
 * Get a cached CanvasTexture for a window pane style.
 * @param {'sash'|'georgian'|'casement'|'single'} style
 * @returns {THREE.CanvasTexture}
 */
export function getWindowTexture(style) {
  const VALID = ['sash', 'georgian', 'casement', 'single'];
  if (!VALID.includes(style)) style = 'sash';

  if (_windowTextureCache.has(style)) return _windowTextureCache.get(style);

  const canvas = _createCanvas(64, 96);
  const ctx = canvas.getContext('2d');
  _drawWindowPattern(ctx, 64, 96, style);

  const tex = new THREE.CanvasTexture(canvas);
  _windowTextureCache.set(style, tex);
  return tex;
}

// ── Roof tile textures ──────────────────────────────────────

const _roofTextureCache = new Map();

function _hexToRgb(hex) {
  return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}

function _drawRoofPattern(ctx, w, h, style, baseColor) {
  const [br, bg, bb] = _hexToRgb(baseColor);

  // Fill with base colour
  ctx.fillStyle = `rgb(${br},${bg},${bb})`;
  ctx.fillRect(0, 0, w, h);

  if (style === 'slate') {
    // Staggered rectangular tiles
    const tileH = 16;
    const tileW = 24;
    const rows = Math.ceil(h / tileH);
    for (let row = 0; row < rows; row++) {
      const y = row * tileH;
      const offset = (row % 2) * (tileW / 2);
      // Per-row shade variation
      const shade = (row % 3 === 0) ? -15 : (row % 3 === 1) ? 10 : 0;
      const r = Math.min(255, Math.max(0, br + shade));
      const g = Math.min(255, Math.max(0, bg + shade));
      const b = Math.min(255, Math.max(0, bb + shade));
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(0, y, w, tileH);
      // Tile edge lines
      ctx.strokeStyle = `rgb(${Math.max(0, br - 30)},${Math.max(0, bg - 30)},${Math.max(0, bb - 30)})`;
      ctx.lineWidth = 1;
      // Horizontal line at bottom of row
      ctx.beginPath();
      ctx.moveTo(0, y + tileH);
      ctx.lineTo(w, y + tileH);
      ctx.stroke();
      // Vertical dividers (staggered)
      const cols = Math.ceil(w / tileW) + 1;
      for (let col = 0; col < cols; col++) {
        const x = col * tileW + offset;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + tileH);
        ctx.stroke();
      }
    }
  } else if (style === 'clay') {
    // Wavy interlocking tiles (pantile)
    const tileH = 20;
    const tileW = 16;
    const rows = Math.ceil(h / tileH);
    for (let row = 0; row < rows; row++) {
      const y = row * tileH;
      const offset = (row % 2) * (tileW / 2);
      // Per-row shade variation (more pronounced for clay)
      const shade = (row % 3 === 0) ? -20 : (row % 3 === 1) ? 12 : 0;
      const r = Math.min(255, Math.max(0, br + shade));
      const g = Math.min(255, Math.max(0, bg + shade));
      const b = Math.min(255, Math.max(0, bb + shade));
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(0, y, w, tileH);
      // Horizontal seam
      ctx.strokeStyle = `rgb(${Math.max(0, br - 25)},${Math.max(0, bg - 25)},${Math.max(0, bb - 25)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y + tileH);
      ctx.lineTo(w, y + tileH);
      ctx.stroke();
      // Wavy vertical lines (simulated with alternating half-height strokes)
      const cols = Math.ceil(w / tileW) + 1;
      const highlight = `rgba(255,255,255,0.12)`;
      for (let col = 0; col < cols; col++) {
        const x = col * tileW + offset;
        // Dark edge
        ctx.strokeStyle = `rgb(${Math.max(0, br - 25)},${Math.max(0, bg - 25)},${Math.max(0, bb - 25)})`;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + tileH);
        ctx.stroke();
        // Light highlight next to edge (gives the curved tile illusion)
        ctx.strokeStyle = highlight;
        ctx.beginPath();
        ctx.moveTo(x + 2, y);
        ctx.lineTo(x + 2, y + tileH);
        ctx.stroke();
      }
    }
  } else {
    // 'shingle' — small uniform flat tiles, minimal texture
    const tileH = 10;
    const tileW = 16;
    const rows = Math.ceil(h / tileH);
    for (let row = 0; row < rows; row++) {
      const y = row * tileH;
      const offset = (row % 2) * (tileW / 2);
      const shade = (row % 4 === 0) ? -8 : (row % 4 === 2) ? 6 : 0;
      const r = Math.min(255, Math.max(0, br + shade));
      const g = Math.min(255, Math.max(0, bg + shade));
      const b = Math.min(255, Math.max(0, bb + shade));
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(0, y, w, tileH);
      // Subtle seam lines
      ctx.strokeStyle = `rgba(${Math.max(0, br - 20)},${Math.max(0, bg - 20)},${Math.max(0, bb - 20)},0.5)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y + tileH);
      ctx.lineTo(w, y + tileH);
      ctx.stroke();
      const cols = Math.ceil(w / tileW) + 1;
      for (let col = 0; col < cols; col++) {
        const x = col * tileW + offset;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + tileH);
        ctx.stroke();
      }
    }
  }
}

/**
 * Get a cached CanvasTexture for a roof tile style.
 * @param {'slate'|'clay'|'shingle'} style
 * @param {number} baseColor - hex color (e.g. 0x6b4e37)
 * @returns {THREE.CanvasTexture}
 */
export function getRoofTexture(style, baseColor) {
  const VALID = ['slate', 'clay', 'shingle'];
  if (!VALID.includes(style)) style = 'slate';

  const key = `${style}:${baseColor}`;
  if (_roofTextureCache.has(key)) return _roofTextureCache.get(key);

  const canvas = _createCanvas(128, 128);
  const ctx = canvas.getContext('2d');
  _drawRoofPattern(ctx, 128, 128, style, baseColor);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  _roofTextureCache.set(key, tex);
  return tex;
}

export function createHouse(width, depth, floorHeight, color = 0xd4c4a8) {
  const house = {
    width,
    depth,
    floorHeight,
    floors: 1,
    wallColor: color,
    roofColor: 0x6b4e37,
    group: new THREE.Group(),
    _roofPitch: null,
    _roofDirection: null,
  };
  _rebuildWalls(house);
  return house;
}

export function addFloor(house) {
  house.floors++;
  _rebuildWalls(house);
  // Move roof up if one exists
  if (house._roofPitch !== null) {
    addPitchedRoof(house, house._roofPitch, house._roofDirection);
  }
  return house;
}

export function removeFloor(house) {
  if (house.floors <= 1) return house;
  house.floors--;
  _rebuildWalls(house);
  if (house._roofPitch !== null) {
    addPitchedRoof(house, house._roofPitch, house._roofDirection);
  }
  return house;
}

/**
 * Add a pitched roof.
 * @param {object} house
 * @param {number} pitch - degrees
 * @param {'sides'|'frontback'|'all'|'mansard'} direction
 *   'sides'     – gable: slopes on left/right, flat gable triangles front/back
 *   'frontback' – gable: slopes on front/back, flat gable triangles left/right
 *   'all'       – hip: all four sides slope up; ridge along the longer axis
 *   'mansard'   – hip slopes that stop partway up, with a flat top
 */
export function addPitchedRoof(house, pitch = 35, direction = 'sides', overhang = 0) {
  _removePart(house, 'roof');
  house._roofPitch = pitch;
  house._roofDirection = direction;

  const { width: w, depth: d } = house;
  const h = house.floors * house.floorHeight;
  const pitchRad = pitch * Math.PI / 180;
  const oh = overhang;

  const P = [];
  const I = [];
  const useTexture = !!house._roofTileStyle;
  const U = useTexture ? [] : null;

  if (direction === 'mansard') {
    _mansardRoof(P, I, w, d, h, pitchRad, U);
  } else if (direction === 'all') {
    _hipRoof(P, I, w, d, h, pitchRad, oh, U);
  } else if (direction === 'sides') {
    _gableRoofSides(P, I, w, d, h, pitchRad, oh, U);
  } else {
    _gableRoofFrontBack(P, I, w, d, h, pitchRad, oh, U);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setIndex(I);
  if (U) geo.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  geo.computeVertexNormals();

  let mat;
  if (useTexture) {
    mat = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      map: getRoofTexture(house._roofTileStyle, house.roofColor),
      side: THREE.DoubleSide,
    });
  } else {
    mat = new THREE.MeshLambertMaterial({
      color: house.roofColor,
      side: THREE.DoubleSide,
    });
  }

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'roof';
  house.group.add(mesh);
  return house;
}

function _gableRoofSides(P, I, w, d, h, pitchRad, oh = 0, U) {
  const rise = (w / 2) * Math.tan(pitchRad);
  const ry = h + rise;
  const mx = w / 2;

  _quad(P, I, [-oh,h,d+oh], [-oh,h,-oh], [mx,ry,-oh], [mx,ry,d+oh],
    U, _roofUV(-oh,h,d+oh), _roofUV(-oh,h,-oh), _roofUV(mx,ry,-oh), _roofUV(mx,ry,d+oh));
  _quad(P, I, [w+oh,h,-oh], [w+oh,h,d+oh], [mx,ry,d+oh], [mx,ry,-oh],
    U, _roofUV(w+oh,h,-oh), _roofUV(w+oh,h,d+oh), _roofUV(mx,ry,d+oh), _roofUV(mx,ry,-oh));
  _tri(P, I, [w+oh,h,-oh], [-oh,h,-oh], [mx,ry,-oh],
    U, _roofUV(w+oh,h,-oh), _roofUV(-oh,h,-oh), _roofUV(mx,ry,-oh));
  _tri(P, I, [-oh,h,d+oh], [w+oh,h,d+oh], [mx,ry,d+oh],
    U, _roofUV(-oh,h,d+oh), _roofUV(w+oh,h,d+oh), _roofUV(mx,ry,d+oh));
}

function _gableRoofFrontBack(P, I, w, d, h, pitchRad, oh = 0, U) {
  const rise = (d / 2) * Math.tan(pitchRad);
  const ry = h + rise;
  const mz = d / 2;

  _quad(P, I, [w+oh,h,-oh], [-oh,h,-oh], [-oh,ry,mz], [w+oh,ry,mz],
    U, _roofUV(w+oh,h,-oh), _roofUV(-oh,h,-oh), _roofUV(-oh,ry,mz), _roofUV(w+oh,ry,mz));
  _quad(P, I, [-oh,h,d+oh], [w+oh,h,d+oh], [w+oh,ry,mz], [-oh,ry,mz],
    U, _roofUV(-oh,h,d+oh), _roofUV(w+oh,h,d+oh), _roofUV(w+oh,ry,mz), _roofUV(-oh,ry,mz));
  _tri(P, I, [-oh,h,d+oh], [-oh,h,-oh], [-oh,ry,mz],
    U, _roofUV(-oh,h,d+oh), _roofUV(-oh,h,-oh), _roofUV(-oh,ry,mz));
  _tri(P, I, [w+oh,h,-oh], [w+oh,h,d+oh], [w+oh,ry,mz],
    U, _roofUV(w+oh,h,-oh), _roofUV(w+oh,h,d+oh), _roofUV(w+oh,ry,mz));
}

function _hipRoof(P, I, w, d, h, pitchRad, oh = 0, U) {
  const span = Math.min(w, d);
  const rise = (span / 2) * Math.tan(pitchRad);
  const ry = h + rise;
  const inset = span / 2;

  if (w >= d) {
    const rx0 = inset, rx1 = w - inset, mz = d / 2;
    if (rx0 >= rx1) {
      const cx = w / 2;
      _tri(P, I, [-oh,h,-oh], [w+oh,h,-oh], [cx,ry,mz],
        U, _roofUV(-oh,h,-oh), _roofUV(w+oh,h,-oh), _roofUV(cx,ry,mz));
      _tri(P, I, [w+oh,h,-oh], [w+oh,h,d+oh], [cx,ry,mz],
        U, _roofUV(w+oh,h,-oh), _roofUV(w+oh,h,d+oh), _roofUV(cx,ry,mz));
      _tri(P, I, [w+oh,h,d+oh], [-oh,h,d+oh], [cx,ry,mz],
        U, _roofUV(w+oh,h,d+oh), _roofUV(-oh,h,d+oh), _roofUV(cx,ry,mz));
      _tri(P, I, [-oh,h,d+oh], [-oh,h,-oh], [cx,ry,mz],
        U, _roofUV(-oh,h,d+oh), _roofUV(-oh,h,-oh), _roofUV(cx,ry,mz));
    } else {
      _quad(P, I, [-oh,h,-oh], [w+oh,h,-oh], [rx1,ry,mz], [rx0,ry,mz],
        U, _roofUV(-oh,h,-oh), _roofUV(w+oh,h,-oh), _roofUV(rx1,ry,mz), _roofUV(rx0,ry,mz));
      _quad(P, I, [w+oh,h,d+oh], [-oh,h,d+oh], [rx0,ry,mz], [rx1,ry,mz],
        U, _roofUV(w+oh,h,d+oh), _roofUV(-oh,h,d+oh), _roofUV(rx0,ry,mz), _roofUV(rx1,ry,mz));
      _tri(P, I, [-oh,h,d+oh], [-oh,h,-oh], [rx0,ry,mz],
        U, _roofUV(-oh,h,d+oh), _roofUV(-oh,h,-oh), _roofUV(rx0,ry,mz));
      _tri(P, I, [w+oh,h,-oh], [w+oh,h,d+oh], [rx1,ry,mz],
        U, _roofUV(w+oh,h,-oh), _roofUV(w+oh,h,d+oh), _roofUV(rx1,ry,mz));
    }
  } else {
    const rz0 = inset, rz1 = d - inset, mx = w / 2;
    if (rz0 >= rz1) {
      const cz = d / 2;
      _tri(P, I, [-oh,h,-oh], [w+oh,h,-oh], [mx,ry,cz],
        U, _roofUV(-oh,h,-oh), _roofUV(w+oh,h,-oh), _roofUV(mx,ry,cz));
      _tri(P, I, [w+oh,h,-oh], [w+oh,h,d+oh], [mx,ry,cz],
        U, _roofUV(w+oh,h,-oh), _roofUV(w+oh,h,d+oh), _roofUV(mx,ry,cz));
      _tri(P, I, [w+oh,h,d+oh], [-oh,h,d+oh], [mx,ry,cz],
        U, _roofUV(w+oh,h,d+oh), _roofUV(-oh,h,d+oh), _roofUV(mx,ry,cz));
      _tri(P, I, [-oh,h,d+oh], [-oh,h,-oh], [mx,ry,cz],
        U, _roofUV(-oh,h,d+oh), _roofUV(-oh,h,-oh), _roofUV(mx,ry,cz));
    } else {
      _quad(P, I, [-oh,h,d+oh], [-oh,h,-oh], [mx,ry,rz0], [mx,ry,rz1],
        U, _roofUV(-oh,h,d+oh), _roofUV(-oh,h,-oh), _roofUV(mx,ry,rz0), _roofUV(mx,ry,rz1));
      _quad(P, I, [w+oh,h,-oh], [w+oh,h,d+oh], [mx,ry,rz1], [mx,ry,rz0],
        U, _roofUV(w+oh,h,-oh), _roofUV(w+oh,h,d+oh), _roofUV(mx,ry,rz1), _roofUV(mx,ry,rz0));
      _tri(P, I, [w+oh,h,-oh], [-oh,h,-oh], [mx,ry,rz0],
        U, _roofUV(w+oh,h,-oh), _roofUV(-oh,h,-oh), _roofUV(mx,ry,rz0));
      _tri(P, I, [-oh,h,d+oh], [w+oh,h,d+oh], [mx,ry,rz1],
        U, _roofUV(-oh,h,d+oh), _roofUV(w+oh,h,d+oh), _roofUV(mx,ry,rz1));
    }
  }
}

function _mansardRoof(P, I, w, d, h, pitchRad, U) {
  const insetFrac = 0.2;
  const insetX = w * insetFrac;
  const insetZ = d * insetFrac;
  const steepAngle = 70 * Math.PI / 180;
  const rise = Math.min(insetX, insetZ) * Math.tan(steepAngle);
  const topY = h + rise;

  const bx0 = insetX, bx1 = w - insetX;
  const bz0 = insetZ, bz1 = d - insetZ;

  _quad(P, I, [0,h,0], [w,h,0], [bx1,topY,bz0], [bx0,topY,bz0],
    U, _roofUV(0,h,0), _roofUV(w,h,0), _roofUV(bx1,topY,bz0), _roofUV(bx0,topY,bz0));
  _quad(P, I, [w,h,0], [w,h,d], [bx1,topY,bz1], [bx1,topY,bz0],
    U, _roofUV(w,h,0), _roofUV(w,h,d), _roofUV(bx1,topY,bz1), _roofUV(bx1,topY,bz0));
  _quad(P, I, [w,h,d], [0,h,d], [bx0,topY,bz1], [bx1,topY,bz1],
    U, _roofUV(w,h,d), _roofUV(0,h,d), _roofUV(bx0,topY,bz1), _roofUV(bx1,topY,bz1));
  _quad(P, I, [0,h,d], [0,h,0], [bx0,topY,bz0], [bx0,topY,bz1],
    U, _roofUV(0,h,d), _roofUV(0,h,0), _roofUV(bx0,topY,bz0), _roofUV(bx0,topY,bz1));
  _quad(P, I, [bx0,topY,bz0], [bx1,topY,bz0], [bx1,topY,bz1], [bx0,topY,bz1],
    U, _roofUV(bx0,topY,bz0), _roofUV(bx1,topY,bz0), _roofUV(bx1,topY,bz1), _roofUV(bx0,topY,bz1));
}

// Scale factor: 1 texture repeat per ROOF_TEX_SCALE metres of roof surface
const ROOF_TEX_SCALE = 2.0;

function _roofUV(x, y, z) {
  return [x / ROOF_TEX_SCALE, (y + z) / ROOF_TEX_SCALE];
}

// Append a quad (4 verts, 2 triangles) to position/index arrays
function _quad(P, I, a, b, c, d, U, uvA, uvB, uvC, uvD) {
  const i = P.length / 3;
  P.push(...a, ...b, ...c, ...d);
  I.push(i, i+1, i+2, i, i+2, i+3);
  if (U && uvA) U.push(...uvA, ...uvB, ...uvC, ...uvD);
}

// Append a triangle (3 verts, 1 triangle) to position/index arrays
function _tri(P, I, a, b, c, U, uvA, uvB, uvC) {
  const i = P.length / 3;
  P.push(...a, ...b, ...c);
  I.push(i, i+1, i+2);
  if (U && uvA) U.push(...uvA, ...uvB, ...uvC);
}

export function addFrontDoor(house, placement = 'center') {
  return _addDoor(house, 'front', placement);
}

export function addBackDoor(house, placement = 'center') {
  return _addDoor(house, 'back', placement);
}

function _addDoor(house, face, placement) {
  const name = face === 'front' ? 'door' : 'backDoor';
  _removePart(house, name);
  const dw = 0.9, dh = 2.1;

  // Place door on the window grid so they align
  const cx = _doorPositionOnGrid(house.width, house._winSpacing || 2.5, placement);

  if (face === 'front') { house._doorX = cx; house._doorW = dw; }
  else { house._backDoorX = cx; house._backDoorW = dw; }

  const geo = new THREE.PlaneGeometry(dw, dh);
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
    color: 0x4a3728,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    side: THREE.DoubleSide,
  }));
  const z = face === 'front' ? -0.01 : house.depth + 0.01;
  mesh.position.set(cx, dh / 2, z);
  mesh.name = name;
  house.group.add(mesh);
  return house;
}

export function addPorch(house, {
  face = 'front',
  porchDepth = 1.8,
  porchWidth,
  porchCenter,
  postSize = 0.12,
  roofStyle = 'slope', // 'slope' (lean-to) or 'hip' (3-sided)
} = {}) {
  const name = face === 'front' ? 'porch' : 'backPorch';
  _removePart(house, name);
  const pw = porchWidth != null ? porchWidth : house.width;
  const cx = porchCenter != null ? porchCenter : house.width / 2;
  const roofY = house.floorHeight * 0.85;
  const stepH = 0.15;
  const sign = face === 'front' ? -1 : 1;
  const wallZ = face === 'front' ? 0 : house.depth;

  // Inherit pitch from main roof
  const pitch = house._roofPitch || 25;
  const pitchRad = pitch * Math.PI / 180;
  const rise = porchDepth * Math.tan(pitchRad);

  const porch = new THREE.Group();
  porch.name = name;

  const wallMat = new THREE.MeshLambertMaterial({ color: house.wallColor });

  // Floor slab / step
  const stepGeo = new THREE.BoxGeometry(pw, stepH, porchDepth);
  stepGeo.translate(cx, stepH / 2, wallZ + sign * porchDepth / 2);
  porch.add(new THREE.Mesh(stepGeo, wallMat));

  // Two posts at the outer edge
  const postH = roofY - stepH;
  const postInset = postSize * 2;
  const leftX = cx - pw / 2 + postInset;
  const rightX = cx + pw / 2 - postInset;
  const postZ = wallZ + sign * (porchDepth - postInset);

  for (const px of [leftX, rightX]) {
    const postGeo = new THREE.BoxGeometry(postSize, postH, postSize);
    postGeo.translate(px, stepH + postH / 2, postZ);
    porch.add(new THREE.Mesh(postGeo, wallMat));
  }

  // Pitched roof
  const oh = 0.1;
  const lx = cx - pw / 2 - oh;
  const rx = cx + pw / 2 + oh;
  const wz = wallZ - sign * oh;                    // wall edge (with overhang into wall)
  const oz = wallZ + sign * (porchDepth + oh);      // outer edge (with overhang)
  const wy = roofY + rise;                          // wall edge height (high)
  const oy = roofY;                                 // outer edge height (low, at posts)

  const P = [], I = [];

  if (roofStyle === 'hip') {
    const inset = Math.min(porchDepth + oh, (rx - lx) / 2);
    const rlx = lx + inset;
    const rrx = rx - inset;

    if (rlx >= rrx) {
      // Pyramid
      const peakX = (lx + rx) / 2;
      _tri(P, I, [rx,oy,oz], [lx,oy,oz], [peakX,wy,wz]);
      _tri(P, I, [lx,oy,oz], [lx,oy,wz], [peakX,wy,wz]);
      _tri(P, I, [rx,oy,wz], [rx,oy,oz], [peakX,wy,wz]);
    } else {
      // Front slope + 2 side triangles
      _quad(P, I, [rx,oy,oz], [lx,oy,oz], [rlx,wy,wz], [rrx,wy,wz]);
      _tri(P, I, [lx,oy,oz], [lx,oy,wz], [rlx,wy,wz]);
      _tri(P, I, [rx,oy,wz], [rx,oy,oz], [rrx,wy,wz]);
    }
  } else if (roofStyle === 'gable') {
    // Gable — ridge runs front-to-back along the center, slopes fall left/right
    const mx = (lx + rx) / 2;
    const gableRise = (pw / 2) * Math.tan(pitchRad);
    const gy = roofY + gableRise;
    // Left slope
    _quad(P, I, [lx,oy,oz], [lx,oy,wz], [mx,gy,wz], [mx,gy,oz]);
    // Right slope
    _quad(P, I, [rx,oy,wz], [rx,oy,oz], [mx,gy,oz], [mx,gy,wz]);
    // Front gable triangle
    _tri(P, I, [rx,oy,oz], [lx,oy,oz], [mx,gy,oz]);
    // Back gable triangle (at wall)
    _tri(P, I, [lx,oy,wz], [rx,oy,wz], [mx,gy,wz]);
  } else {
    // Lean-to (single slope)
    _quad(P, I, [rx,wy,wz], [lx,wy,wz], [lx,oy,oz], [rx,oy,oz]);
  }

  const roofGeo = new THREE.BufferGeometry();
  roofGeo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  roofGeo.setIndex(I);
  roofGeo.computeVertexNormals();
  porch.add(new THREE.Mesh(roofGeo, new THREE.MeshLambertMaterial({
    color: house.roofColor,
    side: THREE.DoubleSide,
  })));

  // Store front porch info for addGroundLevel
  if (face === 'front') {
    house._porchDepth = porchDepth;
    house._porchWidth = pw;
    house._porchCenter = cx;
    house._porchPostSize = postSize;
  }

  house.group.add(porch);
  return house;
}

/**
 * Mark sides as party walls — suppresses windows and features on those sides.
 * @param {object} house
 * @param {string[]} sides - Array of 'left', 'right', 'front', 'back'
 */
export function setPartyWalls(house, sides) {
  house._partyWalls = new Set(sides);
  return house;
}

export function addWindows(house, {
  width = 1.0,
  height = 1.5,
  spacing = 2.5,
  color = 0x88aabb,
} = {}) {
  _removePart(house, 'windows');
  house._winSpacing = spacing;

  const fh = house.floorHeight;
  const sillY = fh * 0.3;
  const windowGroup = new THREE.Group();
  windowGroup.name = 'windows';

  const style = house._windowStyle || 'sash';
  const tex = getWindowTexture(style);
  const mat = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    map: tex,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });

  // 4 walls: front, back, left, right
  const walls = [
    { span: house.width, rot: Math.PI, posFn: (cx, cy) => [cx, cy, -0.01], face: 'front' },
    { span: house.width, rot: 0, posFn: (cx, cy) => [cx, cy, house.depth + 0.01], face: 'back' },
    { span: house.depth, rot: Math.PI / 2, posFn: (cz, cy) => [-0.01, cy, cz], face: 'left' },
    { span: house.depth, rot: -Math.PI / 2, posFn: (cz, cy) => [house.width + 0.01, cy, cz], face: 'right' },
  ];

  for (const wall of walls) {
    if (house._partyWalls?.has(wall.face)) continue;
    const nWin = Math.max(1, Math.floor(wall.span / spacing));
    const startOffset = (wall.span - (nWin - 1) * spacing) / 2;

    for (let floor = 0; floor < house.floors; floor++) {
      const cy = floor * fh + sillY + height / 2;

      for (let i = 0; i < nWin; i++) {
        const along = startOffset + i * spacing;

        // Skip ground-floor windows that overlap a door
        if (floor === 0) {
          const doorX = wall.face === 'front' ? house._doorX : wall.face === 'back' ? house._backDoorX : null;
          const doorW = wall.face === 'front' ? house._doorW : wall.face === 'back' ? house._backDoorW : null;
          if (doorX != null) {
            if (Math.abs(along - doorX) < (doorW || 0.9) / 2 + width / 2) continue;
          }
        }

        // Skip front windows overlapping a bay window
        if (wall.face === 'front' && house._bayX != null && floor < (house._bayFloors || 0)) {
          if (Math.abs(along - house._bayX) < (house._bayW + width) / 2) continue;
        }

        const geo = new THREE.PlaneGeometry(width, height);
        const win = new THREE.Mesh(geo, mat);
        win.rotation.y = wall.rot;
        const [px, py, pz] = wall.posFn(along, cy);
        win.position.set(px, py, pz);
        windowGroup.add(win);
      }
    }
  }

  house.group.add(windowGroup);
  return house;
}

export function addDormer(house, {
  position = 0.5,     // 0–1 along ridge (Z for 'sides', X for 'frontback')
  width = 1.2,
  height = 1.2,
  depth = 1.0,        // how far it protrudes from the slope
  slopeFrac = 0.35,   // 0=eave, 1=ridge — where the back edge sits on slope
  style = 'window',   // 'window' or 'balcony' (taller, with door + railing)
} = {}) {
  if (house._roofPitch === null) return house;

  const wallH = house.floors * house.floorHeight;
  const pitchRad = house._roofPitch * Math.PI / 180;
  const w = house.width, d = house.depth;

  const isBalcony = style === 'balcony';
  const actualH = isBalcony ? height * 1.4 : height;

  // Build dormer in local coords:
  //   origin at back-bottom-center (where it meets the roof slope)
  //   +X = along ridge, +Y = up, -Z = outward from slope
  const dormer = new THREE.Group();

  // Walls — box from z=-depth to z=0, y=0 to y=height
  const boxGeo = new THREE.BoxGeometry(width, actualH, depth);
  boxGeo.translate(0, actualH / 2, -depth / 2);
  const boxMesh = new THREE.Mesh(boxGeo, new THREE.MeshLambertMaterial({ color: house.wallColor }));
  dormer.add(boxMesh);

  if (isBalcony) {
    // Door-like opening on front face
    const doorW = width * 0.6, doorH = actualH * 0.75;
    const doorGeo = new THREE.PlaneGeometry(doorW, doorH);
    const doorMesh = new THREE.Mesh(doorGeo, new THREE.MeshLambertMaterial({
      color: 0x88aabb,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }));
    doorMesh.position.set(0, doorH / 2 + 0.05, -depth - 0.01);
    dormer.add(doorMesh);

    // Small balcony slab + railing
    const balcD = 0.5;
    const railH = 0.7;
    const slabMat = new THREE.MeshLambertMaterial({ color: house.wallColor });
    const railMat = new THREE.MeshLambertMaterial({ color: 0x333333 });

    const slabGeo = new THREE.BoxGeometry(width, 0.08, balcD);
    slabGeo.translate(0, 0, -depth - balcD / 2);
    dormer.add(new THREE.Mesh(slabGeo, slabMat));

    // Front railing
    const fGeo = new THREE.BoxGeometry(width, railH, 0.03);
    fGeo.translate(0, railH / 2, -depth - balcD);
    dormer.add(new THREE.Mesh(fGeo, railMat));

    // Side railings
    for (const dx of [-width / 2, width / 2]) {
      const sGeo = new THREE.BoxGeometry(0.03, railH, balcD);
      sGeo.translate(dx, railH / 2, -depth - balcD / 2);
      dormer.add(new THREE.Mesh(sGeo, railMat));
    }
  } else {
    // Window on front face (z = -depth)
    const winW = width * 0.6, winH = actualH * 0.6;
    const winGeo = new THREE.PlaneGeometry(winW, winH);
    const winMesh = new THREE.Mesh(winGeo, new THREE.MeshLambertMaterial({
      color: 0x88aabb,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }));
    winMesh.position.set(0, actualH * 0.55, -depth - 0.01);
    dormer.add(winMesh);
  }

  // Small gable roof — ridge along Z (local), slopes fall in X
  // Inherit pitch from main roof
  const roofPitch = house._roofPitch || 35;
  const roofPitchRad = roofPitch * Math.PI / 180;
  const oh = 0.1; // small overhang
  const roofRise = (width / 2) * Math.tan(roofPitchRad);
  const topY = actualH;
  const positions = [
    // Left slope
    -width / 2 - oh, topY, -depth - oh,
    -width / 2 - oh, topY, oh,
    0, topY + roofRise, oh,
    0, topY + roofRise, -depth - oh,
    // Right slope
    width / 2 + oh, topY, -depth - oh,
    width / 2 + oh, topY, oh,
    0, topY + roofRise, oh,
    0, topY + roofRise, -depth - oh,
  ];
  const roofIndices = [
    0, 1, 2, 0, 2, 3,  // left slope
    4, 7, 6, 4, 6, 5,  // right slope
  ];
  const roofGeo = new THREE.BufferGeometry();
  roofGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  roofGeo.setIndex(roofIndices);
  roofGeo.computeVertexNormals();
  const roofMesh = new THREE.Mesh(roofGeo, new THREE.MeshLambertMaterial({
    color: house.roofColor,
    side: THREE.DoubleSide,
  }));
  dormer.add(roofMesh);

  // Position and rotate onto the correct roof slope
  if (house._roofDirection === 'sides') {
    const rise = (w / 2) * Math.tan(pitchRad);
    const sx = slopeFrac * (w / 2);
    const sy = wallH + slopeFrac * rise;
    const pz = position * d;
    // Local -Z (outward) should face world -X (left slope)
    dormer.rotation.y = Math.PI / 2;
    dormer.position.set(sx, sy, pz);
  } else {
    const rise = (d / 2) * Math.tan(pitchRad);
    const sz = slopeFrac * (d / 2);
    const sy = wallH + slopeFrac * rise;
    const px = position * w;
    // Local -Z (outward) should face world -Z (front slope) — no rotation needed
    dormer.position.set(px, sy, sz);
  }

  const n = house.group.children.filter(c => c.name.startsWith('dormer')).length;
  dormer.name = `dormer${n}`;
  house.group.add(dormer);
  return house;
}

/**
 * Add a balcony on the front wall at the given floor.
 * @param {object} house
 * @param {number} floor - 1-indexed floor (1 = first above ground)
 * @param {'full'|'window'} style - full-width or per-window balconies
 */
export function addBalcony(house, floor, style = 'full') {
  const name = `balcony_${floor}`;
  _removePart(house, name);

  if (floor < 1 || floor >= house.floors) return house;

  const fh = house.floorHeight;
  const slabY = floor * fh;
  const balconyDepth = 0.9;
  const railH = 1.0;
  const railThick = 0.04;
  const slabThick = 0.12;

  const balcony = new THREE.Group();
  balcony.name = name;

  const slabMat = new THREE.MeshLambertMaterial({ color: house.wallColor });
  const railMat = new THREE.MeshLambertMaterial({ color: 0x333333 });

  if (style === 'full') {
    const bw = house.width;

    // Floor slab
    const slabGeo = new THREE.BoxGeometry(bw, slabThick, balconyDepth);
    slabGeo.translate(bw / 2, slabY - slabThick / 2, -balconyDepth / 2);
    balcony.add(new THREE.Mesh(slabGeo, slabMat));

    // Railings — front + left + right
    const frontGeo = new THREE.BoxGeometry(bw, railH, railThick);
    frontGeo.translate(bw / 2, slabY + railH / 2, -balconyDepth);
    balcony.add(new THREE.Mesh(frontGeo, railMat));

    const leftGeo = new THREE.BoxGeometry(railThick, railH, balconyDepth);
    leftGeo.translate(0, slabY + railH / 2, -balconyDepth / 2);
    balcony.add(new THREE.Mesh(leftGeo, railMat));

    const rightGeo = new THREE.BoxGeometry(railThick, railH, balconyDepth);
    rightGeo.translate(bw, slabY + railH / 2, -balconyDepth / 2);
    balcony.add(new THREE.Mesh(rightGeo, railMat));

    // Support brackets
    const bracketH = 0.3;
    const bracketMat = new THREE.MeshLambertMaterial({ color: house.wallColor });
    for (const bx of [bw * 0.15, bw * 0.85]) {
      const bGeo = new THREE.BoxGeometry(0.08, bracketH, balconyDepth * 0.8);
      bGeo.translate(bx, slabY - slabThick - bracketH / 2, -balconyDepth * 0.4);
      balcony.add(new THREE.Mesh(bGeo, bracketMat));
    }

  } else {
    // Window-style balconies — one per window slot on the front wall
    const spacing = house._winSpacing || 2.5;
    const nWin = Math.max(1, Math.floor(house.width / spacing));
    const startOffset = (house.width - (nWin - 1) * spacing) / 2;
    const bw = Math.min(spacing * 0.65, 1.2);

    for (let i = 0; i < nWin; i++) {
      const wx = startOffset + i * spacing;

      // Slab
      const slabGeo = new THREE.BoxGeometry(bw, slabThick, balconyDepth * 0.6);
      const bd = balconyDepth * 0.6;
      slabGeo.translate(wx, slabY - slabThick / 2, -bd / 2);
      balcony.add(new THREE.Mesh(slabGeo, slabMat));

      // Railing — front
      const frontGeo = new THREE.BoxGeometry(bw, railH * 0.8, railThick);
      frontGeo.translate(wx, slabY + railH * 0.4, -bd);
      balcony.add(new THREE.Mesh(frontGeo, railMat));

      // Railing — sides
      for (const dx of [-bw / 2, bw / 2]) {
        const sideGeo = new THREE.BoxGeometry(railThick, railH * 0.8, bd);
        sideGeo.translate(wx + dx, slabY + railH * 0.4, -bd / 2);
        balcony.add(new THREE.Mesh(sideGeo, railMat));
      }
    }
  }

  house.group.add(balcony);
  return house;
}

export function addBayWindow(house, {
  floors = 1,
  style = 'box',      // 'box' or 'angled'
  span = 1,            // window-grid slots wide
  depth = 0.8,         // protrusion depth
  position = 'center', // 'left', 'center', 'right'
} = {}) {
  _removePart(house, 'bay');

  const spacing = house._winSpacing || 2.5;
  const fh = house.floorHeight;
  const bayFloors = Math.min(floors, house.floors);
  const bayH = bayFloors * fh;
  const bayW = span * spacing;

  const cx = _doorPositionOnGrid(house.width, spacing, position);
  const x0 = cx - bayW / 2;
  const x1 = cx + bayW / 2;

  house._bayX = cx;
  house._bayW = bayW;
  house._bayFloors = bayFloors;

  const bay = new THREE.Group();
  bay.name = 'bay';

  const wallMat = new THREE.MeshLambertMaterial({ color: house.wallColor, side: THREE.DoubleSide });
  const roofMat = new THREE.MeshLambertMaterial({ color: house.roofColor });
  const winMat = new THREE.MeshLambertMaterial({
    color: 0x88aabb,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
    side: THREE.DoubleSide,
  });

  const winW = 0.9, winH = 1.3;
  const sillY = fh * 0.3;
  const d = depth;
  const gh = house._groundHeight || 0;

  if (style === 'box') {
    // Box protrusion walls (extend down to ground if house is raised)
    const totalH = bayH + gh;
    const geo = new THREE.BoxGeometry(bayW, totalH, d);
    geo.translate(cx, bayH / 2 - gh / 2, -d / 2);
    bay.add(new THREE.Mesh(geo, wallMat));

    // Windows per floor
    for (let f = 0; f < bayFloors; f++) {
      const wy = f * fh + sillY + winH / 2;
      // Front face
      const nFront = span;
      const start = (bayW - (nFront - 1) * spacing) / 2;
      for (let i = 0; i < nFront; i++) {
        const wg = new THREE.PlaneGeometry(winW, winH);
        const wm = new THREE.Mesh(wg, winMat);
        wm.rotation.y = Math.PI;
        wm.position.set(x0 + start + i * spacing, wy, -d - 0.01);
        bay.add(wm);
      }
      // Side windows
      if (d >= 0.5) {
        const sw = Math.min(winW, d * 0.7);
        for (const [sx, rot] of [[x0 - 0.01, Math.PI / 2], [x1 + 0.01, -Math.PI / 2]]) {
          const wg = new THREE.PlaneGeometry(sw, winH);
          const wm = new THREE.Mesh(wg, winMat);
          wm.rotation.y = rot;
          wm.position.set(sx, wy, -d / 2);
          bay.add(wm);
        }
      }
    }

    // Lean-to roof sloping away from wall
    const ovh = 0.1;
    const roofRise = 0.25;
    const rP = [], rI = [];
    // Top face (sloped)
    _quad(rP, rI,
      [x0 - ovh, bayH + roofRise, ovh],
      [x0 - ovh, bayH, -d - ovh],
      [x1 + ovh, bayH, -d - ovh],
      [x1 + ovh, bayH + roofRise, ovh]
    );
    // Underside
    _quad(rP, rI,
      [x1 + ovh, bayH + roofRise - 0.06, ovh],
      [x1 + ovh, bayH - 0.06, -d - ovh],
      [x0 - ovh, bayH - 0.06, -d - ovh],
      [x0 - ovh, bayH + roofRise - 0.06, ovh]
    );
    const rGeo = new THREE.BufferGeometry();
    rGeo.setAttribute('position', new THREE.Float32BufferAttribute(rP, 3));
    rGeo.setIndex(rI);
    rGeo.computeVertexNormals();
    bay.add(new THREE.Mesh(rGeo, new THREE.MeshLambertMaterial({ color: house.roofColor, side: THREE.DoubleSide })));

  } else {
    // Angled/canted bay
    const ai = Math.min(d, bayW * 0.3);
    const fx0 = x0 + ai, fx1 = x1 - ai;

    // Walls as custom geometry (extend down to ground if house is raised)
    const by = -gh;
    const P = [], I = [];
    _quad(P, I, [fx1,by,-d], [fx0,by,-d], [fx0,bayH,-d], [fx1,bayH,-d]); // front
    _quad(P, I, [fx0,by,-d], [x0,by,0], [x0,bayH,0], [fx0,bayH,-d]);     // left angled
    _quad(P, I, [x1,by,0], [fx1,by,-d], [fx1,bayH,-d], [x1,bayH,0]);     // right angled

    const wallGeo = new THREE.BufferGeometry();
    wallGeo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    wallGeo.setIndex(I);
    wallGeo.computeVertexNormals();
    bay.add(new THREE.Mesh(wallGeo, wallMat));

    // Windows
    const frontW = fx1 - fx0;
    for (let f = 0; f < bayFloors; f++) {
      const wy = f * fh + sillY + winH / 2;
      // Front face
      const nFront = Math.max(1, Math.floor(frontW / spacing));
      const fStart = (frontW - (nFront - 1) * spacing) / 2;
      for (let i = 0; i < nFront; i++) {
        const wg = new THREE.PlaneGeometry(Math.min(winW, frontW * 0.8), winH);
        const wm = new THREE.Mesh(wg, winMat);
        wm.rotation.y = Math.PI;
        wm.position.set(fx0 + fStart + i * spacing, wy, -d - 0.01);
        bay.add(wm);
      }
      // Angled side windows
      const sideLen = Math.sqrt(ai * ai + d * d);
      if (sideLen >= 0.6) {
        const sw = Math.min(winW * 0.7, sideLen * 0.6);
        // Left angled side
        const leftAngle = Math.atan2(-d, -ai);
        const wgL = new THREE.PlaneGeometry(sw, winH);
        const wmL = new THREE.Mesh(wgL, winMat);
        wmL.rotation.y = leftAngle;
        wmL.position.set((x0 + fx0) / 2, wy, -d / 2);
        bay.add(wmL);
        // Right angled side
        const rightAngle = Math.atan2(d, -ai);
        const wgR = new THREE.PlaneGeometry(sw, winH);
        const wmR = new THREE.Mesh(wgR, winMat);
        wmR.rotation.y = rightAngle;
        wmR.position.set((x1 + fx1) / 2, wy, -d / 2);
        bay.add(wmR);
      }
    }

    // Lean-to roof (trapezoidal, sloping away from wall)
    const ovh = 0.1;
    const roofRise = 0.25;
    const rP = [], rI = [];
    // Top face (sloped)
    _quad(rP, rI,
      [x0 - ovh, bayH + roofRise, ovh],
      [fx0 - ovh, bayH, -d - ovh],
      [fx1 + ovh, bayH, -d - ovh],
      [x1 + ovh, bayH + roofRise, ovh]
    );
    // Underside
    _quad(rP, rI,
      [x1 + ovh, bayH + roofRise - 0.06, ovh],
      [fx1 + ovh, bayH - 0.06, -d - ovh],
      [fx0 - ovh, bayH - 0.06, -d - ovh],
      [x0 - ovh, bayH + roofRise - 0.06, ovh]
    );
    const rGeo = new THREE.BufferGeometry();
    rGeo.setAttribute('position', new THREE.Float32BufferAttribute(rP, 3));
    rGeo.setIndex(rI);
    rGeo.computeVertexNormals();
    bay.add(new THREE.Mesh(rGeo, new THREE.MeshLambertMaterial({ color: house.roofColor, side: THREE.DoubleSide })));
  }

  house.group.add(bay);
  return house;
}

export function addWindowSills(house, {
  protrusion = 0.08,
  thickness = 0.05,
  color,
} = {}) {
  _removePart(house, 'sills');

  const sillGroup = new THREE.Group();
  sillGroup.name = 'sills';
  const sillColor = color != null ? color : house.wallColor;
  const mat = new THREE.MeshLambertMaterial({ color: sillColor });

  const winGroup = house.group.children.find(c => c.name === 'windows');
  if (!winGroup) { house.group.add(sillGroup); return house; }

  for (const win of winGroup.children) {
    // Each window is a PlaneGeometry mesh with position and rotation
    const ww = win.geometry.parameters.width;
    const wh = win.geometry.parameters.height;
    const sillW = ww + 0.1;
    const sillD = protrusion;
    const sillGeo = new THREE.BoxGeometry(sillW, thickness, sillD);

    const sill = new THREE.Mesh(sillGeo, mat);
    // Position below the window, offset outward by sill depth/2
    // Need to account for wall rotation
    const ry = win.rotation.y;
    const outX = Math.sin(ry) * sillD / 2;
    const outZ = Math.cos(ry) * sillD / 2;
    sill.position.set(
      win.position.x - outX,
      win.position.y - wh / 2 - thickness / 2,
      win.position.z - outZ,
    );
    sill.rotation.y = ry;
    sillGroup.add(sill);
  }

  house.group.add(sillGroup);
  return house;
}

export function addExtension(house, {
  widthFrac = 0.5,    // fraction of house width (0.5 = half, 1 = full)
  extDepth = 3,       // how far it extends from the back wall
  floors = 1,         // number of storeys
  side = 'left',      // 'left', 'right', or 'center' (only matters when < full width)
  roofDirection = 'sides', // 'sides', 'frontback', 'all', 'mansard'
  roofPitch = 30,
} = {}) {
  _removePart(house, 'extension');

  const ew = house.width * Math.min(widthFrac, 1);
  const eh = floors * house.floorHeight;
  let ex;
  if (widthFrac >= 1) ex = 0;
  else if (side === 'left') ex = 0;
  else if (side === 'right') ex = house.width - ew;
  else ex = (house.width - ew) / 2;

  const ext = new THREE.Group();
  ext.name = 'extension';

  // Walls
  const wallGeo = new THREE.BoxGeometry(ew, eh, extDepth);
  wallGeo.translate(ex + ew / 2, eh / 2, house.depth + extDepth / 2);
  ext.add(new THREE.Mesh(wallGeo, new THREE.MeshLambertMaterial({ color: house.wallColor })));

  // Roof — reuse the roof builders, extended back to overlap with main roof
  const pitchRad = roofPitch * Math.PI / 180;
  const roofOverlap = 1.0;
  const roofDepth = extDepth + roofOverlap;
  const P = [], I = [];

  if (roofDirection === 'mansard') {
    _mansardRoof(P, I, ew, roofDepth, eh, pitchRad);
  } else if (roofDirection === 'all') {
    _hipRoof(P, I, ew, roofDepth, eh, pitchRad);
  } else if (roofDirection === 'sides') {
    _gableRoofSides(P, I, ew, roofDepth, eh, pitchRad);
  } else {
    _gableRoofFrontBack(P, I, ew, roofDepth, eh, pitchRad);
  }

  // Offset roof positions to extension origin, shifted back by overlap
  for (let i = 0; i < P.length; i += 3) {
    P[i] += ex;
    P[i + 2] += house.depth - roofOverlap;
  }

  const roofGeo = new THREE.BufferGeometry();
  roofGeo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  roofGeo.setIndex(I);
  roofGeo.computeVertexNormals();
  ext.add(new THREE.Mesh(roofGeo, new THREE.MeshLambertMaterial({
    color: house.roofColor,
    side: THREE.DoubleSide,
  })));

  // Windows on the extension (back and exposed side walls)
  const spacing = house._winSpacing || 2.5;
  const winMat = new THREE.MeshLambertMaterial({
    color: 0x88aabb,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const fh = house.floorHeight;
  const sillY = fh * 0.3;
  const winW = 1.0, winH = 1.5;

  // Back wall of extension
  const nBack = Math.max(1, Math.floor(ew / spacing));
  const backStart = (ew - (nBack - 1) * spacing) / 2;
  for (let f = 0; f < floors; f++) {
    const cy = f * fh + sillY + winH / 2;
    for (let i = 0; i < nBack; i++) {
      const wg = new THREE.PlaneGeometry(winW, winH);
      const wm = new THREE.Mesh(wg, winMat);
      wm.position.set(ex + backStart + i * spacing, cy, house.depth + extDepth + 0.01);
      ext.add(wm);
    }
  }

  // Side walls of extension (only exposed sides)
  const sideWalls = [];
  if (widthFrac < 1 || side !== 'center') {
    if (side === 'left' || widthFrac >= 1) {
      // Right side wall exposed (at ex + ew)
      sideWalls.push({ wx: ex + ew + 0.01, rot: -Math.PI / 2 });
    }
    if (side === 'right' || widthFrac >= 1) {
      // Left side wall exposed (at ex)
      sideWalls.push({ wx: ex - 0.01, rot: Math.PI / 2 });
    }
    if (side === 'center') {
      sideWalls.push({ wx: ex - 0.01, rot: Math.PI / 2 });
      sideWalls.push({ wx: ex + ew + 0.01, rot: -Math.PI / 2 });
    }
  }

  const nSide = Math.max(1, Math.floor(extDepth / spacing));
  const sideStart = (extDepth - (nSide - 1) * spacing) / 2;
  for (const sw of sideWalls) {
    for (let f = 0; f < floors; f++) {
      const cy = f * fh + sillY + winH / 2;
      for (let i = 0; i < nSide; i++) {
        const wg = new THREE.PlaneGeometry(winW, winH);
        const wm = new THREE.Mesh(wg, winMat);
        wm.rotation.y = sw.rot;
        wm.position.set(sw.wx, cy, house.depth + sideStart + i * spacing);
        ext.add(wm);
      }
    }
  }

  house.group.add(ext);
  return house;
}

export function addGroundLevel(house, height) {
  if (height <= 0) return house;
  _removePart(house, 'groundLevel');

  const gl = new THREE.Group();
  gl.name = 'groundLevel';
  const mat = new THREE.MeshLambertMaterial({ color: house.wallColor });

  // Raise the entire house
  house.group.position.y = height;

  // Foundation wall (visible base below the house)
  const foundGeo = new THREE.BoxGeometry(house.width + 0.1, height, house.depth + 0.1);
  foundGeo.translate(house.width / 2, -height / 2, house.depth / 2);
  gl.add(new THREE.Mesh(foundGeo, mat));

  const hasPorch = house._porchDepth != null;
  const porchDepth = house._porchDepth || 0;
  const porchWidth = house._porchWidth || house.width;
  const porchCenter = house._porchCenter || house.width / 2;
  const postSize = house._porchPostSize || 0.12;

  // Steps — from porch front if there's a porch, otherwise from front wall
  const stepH = 0.18;
  const stepD = 0.28;
  const stepW = hasPorch ? porchWidth : 1.2;
  const stepStartZ = hasPorch ? -porchDepth : 0;
  const nSteps = Math.ceil(height / stepH);
  const stepCenterX = hasPorch ? porchCenter : (house._doorX || house.width / 2);

  for (let i = 0; i < nSteps; i++) {
    const sy = -height + (i + 1) * stepH;
    const sd = (nSteps - i) * stepD;
    const geo = new THREE.BoxGeometry(stepW, stepH, sd);
    geo.translate(stepCenterX, sy - stepH / 2, stepStartZ - sd / 2);
    gl.add(new THREE.Mesh(geo, mat));
  }

  // Extend porch posts down to ground
  if (hasPorch) {
    const postInset = postSize * 2;
    const leftX = porchCenter - porchWidth / 2 + postInset;
    const rightX = porchCenter + porchWidth / 2 - postInset;
    const postZ = -(porchDepth - postInset);

    for (const px of [leftX, rightX]) {
      const postGeo = new THREE.BoxGeometry(postSize, height, postSize);
      postGeo.translate(px, -height / 2, postZ);
      gl.add(new THREE.Mesh(postGeo, mat));
    }
  }

  house.group.add(gl);
  return house;
}

// ── Internals ────────────────────────────────────────────────

/**
 * Pick a door X position that sits on the window spacing grid.
 * 'left' picks the first grid slot, 'right' the last, 'center' the middle.
 */
function _doorPositionOnGrid(houseWidth, spacing, placement) {
  const nSlots = Math.max(1, Math.floor(houseWidth / spacing));
  const startOffset = (houseWidth - (nSlots - 1) * spacing) / 2;
  let idx;
  if (placement === 'left') idx = 0;
  else if (placement === 'right') idx = nSlots - 1;
  else idx = Math.floor(nSlots / 2);
  return startOffset + idx * spacing;
}

function _removePart(house, name) {
  const child = house.group.children.find(c => c.name === name);
  if (child) {
    house.group.remove(child);
    child.traverse(c => {
      if (c.geometry) c.geometry.dispose();
    });
  }
}

function _rebuildWalls(house) {
  _removePart(house, 'walls');
  const h = house.floors * house.floorHeight;
  const geo = new THREE.BoxGeometry(house.width, h, house.depth);
  geo.translate(house.width / 2, h / 2, house.depth / 2);
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: house.wallColor }));
  mesh.name = 'walls';
  house.group.add(mesh);
}

// ── Legacy adapter ───────────────────────────────────────────
// Keeps existing tests + BuildingStyleScreen working until they're updated.

export function generateBuilding(style, recipe) {
  const house = createHouse(recipe.mainWidth, recipe.mainDepth, style.floorHeight, recipe.wallColor);

  // Add extra floors
  for (let i = 1; i < recipe.floors; i++) {
    addFloor(house);
  }

  // Roof
  if (style.roofType === 'flat') {
    // Flat roof = pitched roof with 0 pitch
    addPitchedRoof(house, 0, 'sides');
  } else {
    addPitchedRoof(house, style.roofPitch, 'sides');
  }

  // Windows
  addWindows(house, {
    width: style.windowWidth,
    height: style.windowHeight,
    spacing: style.windowSpacing,
    color: recipe.windowColor,
  });

  return house.group;
}
