# Roof Tile Textures Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace solid-colour roof materials with procedurally drawn tile patterns (slate, clay, shingle) using canvas textures, same approach as window pane textures.

**Architecture:** A `getRoofTexture(style, baseColor)` function draws tile patterns on a 128x128 canvas with per-row shade variation, caches by `style:color` key, returns `THREE.CanvasTexture` with `RepeatWrapping`. The four roof geometry helpers gain UV coordinates. `addPitchedRoof` reads `house._roofTileStyle` to apply the texture. Archetypes specify `roofTileStyle` in their `shared` params.

**Tech Stack:** THREE.js (CanvasTexture, MeshLambertMaterial, RepeatWrapping), Vitest

---

### Task 1: Add getRoofTexture to generate.js

**Files:**
- Modify: `src/buildings/generate.js`
- Test: `test/buildings/generate.test.js`

**Step 1: Write the failing tests**

Add `getRoofTexture` to the import at line 9 of `test/buildings/generate.test.js`:

```js
import {
  createHouse, addFloor, removeFloor,
  addPitchedRoof, addFrontDoor, addBackDoor, addPorch, addWindows,
  addExtension, addDormer, addBayWindow, addWindowSills, addGroundLevel,
  setPartyWalls,
  generateBuilding,
  getWindowTexture,
  getRoofTexture,
} from '../../src/buildings/generate.js';
```

Then add this describe block after the `getWindowTexture` describe block (after line 461):

```js
describe('getRoofTexture', () => {
  it('returns a THREE.CanvasTexture for each style', () => {
    for (const style of ['slate', 'clay', 'shingle']) {
      const tex = getRoofTexture(style, 0x6b4e37);
      expect(tex).toBeInstanceOf(THREE.CanvasTexture);
    }
  });

  it('caches textures — same style+color returns same object', () => {
    const a = getRoofTexture('slate', 0x6b4e37);
    const b = getRoofTexture('slate', 0x6b4e37);
    expect(a).toBe(b);
  });

  it('different styles return different objects', () => {
    const a = getRoofTexture('slate', 0x6b4e37);
    const b = getRoofTexture('clay', 0x6b4e37);
    expect(a).not.toBe(b);
  });

  it('different colors return different objects', () => {
    const a = getRoofTexture('slate', 0x6b4e37);
    const b = getRoofTexture('slate', 0x4a4a4a);
    expect(a).not.toBe(b);
  });

  it('unknown style falls back to slate', () => {
    const tex = getRoofTexture('nonexistent', 0x6b4e37);
    const slate = getRoofTexture('slate', 0x6b4e37);
    expect(tex).toBe(slate);
  });

  it('texture has RepeatWrapping', () => {
    const tex = getRoofTexture('slate', 0x6b4e37);
    expect(tex.wrapS).toBe(THREE.RepeatWrapping);
    expect(tex.wrapT).toBe(THREE.RepeatWrapping);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/buildings/generate.test.js`
Expected: FAIL — `getRoofTexture` is not exported.

**Step 3: Implement getRoofTexture**

Add this code to `src/buildings/generate.js`, after the `getWindowTexture` function (after line 106), before `createHouse`:

```js
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
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/buildings/generate.test.js`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/buildings/generate.js test/buildings/generate.test.js
git commit -m "feat: getRoofTexture draws and caches roof tile patterns

Three styles: slate (staggered rectangular), clay (pantile), shingle (small uniform).
Colour baked into texture with per-row shade variation.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 2: Add UV coordinates to roof geometry helpers and wire texture into addPitchedRoof

**Files:**
- Modify: `src/buildings/generate.js:154-296` (addPitchedRoof, _gableRoofSides, _gableRoofFrontBack, _hipRoof, _mansardRoof, _quad, _tri)
- Test: `test/buildings/generate.test.js`

**Step 1: Write the failing tests**

Add to the `addPitchedRoof` describe block in `test/buildings/generate.test.js` (after line 141):

```js
  it('uses roof texture when house._roofTileStyle is set', () => {
    const house = createHouse(6, 5, 3);
    house._roofTileStyle = 'clay';
    house.roofColor = 0x4a4a4a;
    addPitchedRoof(house, 35, 'sides');
    const roof = getChild(house.group, 'roof');
    expect(roof.material.map).toBeDefined();
    expect(roof.material.map).toBe(getRoofTexture('clay', 0x4a4a4a));
  });

  it('roof geometry has UV attribute when textured', () => {
    const house = createHouse(6, 5, 3);
    house._roofTileStyle = 'slate';
    addPitchedRoof(house, 35, 'sides');
    const roof = getChild(house.group, 'roof');
    expect(roof.geometry.getAttribute('uv')).toBeDefined();
  });

  it('roof geometry has UV attribute for all directions', () => {
    for (const dir of ['sides', 'frontback', 'all', 'mansard']) {
      const house = createHouse(6, 5, 3);
      house._roofTileStyle = 'slate';
      addPitchedRoof(house, 35, dir);
      const roof = getChild(house.group, 'roof');
      expect(roof.geometry.getAttribute('uv')).toBeDefined();
    }
  });

  it('defaults to no texture when _roofTileStyle not set', () => {
    const house = createHouse(6, 5, 3);
    addPitchedRoof(house, 35, 'sides');
    const roof = getChild(house.group, 'roof');
    expect(roof.material.map).toBeNull();
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/buildings/generate.test.js`
Expected: FAIL — `roof.material.map` is null, no `uv` attribute.

**Step 3: Modify _quad, _tri, roof helpers, and addPitchedRoof**

The approach: `_quad` and `_tri` now accept an optional `U` array (parallel to `P`) and UV coordinate pairs. The four roof helpers generate UVs by mapping vertex world positions to texture coordinates. `addPitchedRoof` reads `house._roofTileStyle` and applies the texture.

**3a. Modify `_quad` and `_tri`** (replace lines 284-296):

```js
// Append a quad (4 verts, 2 triangles) to position/index arrays, optionally with UVs
function _quad(P, I, a, b, c, d, U, uvA, uvB, uvC, uvD) {
  const i = P.length / 3;
  P.push(...a, ...b, ...c, ...d);
  I.push(i, i+1, i+2, i, i+2, i+3);
  if (U && uvA) U.push(...uvA, ...uvB, ...uvC, ...uvD);
}

// Append a triangle (3 verts, 1 triangle) to position/index arrays, optionally with UVs
function _tri(P, I, a, b, c, U, uvA, uvB, uvC) {
  const i = P.length / 3;
  P.push(...a, ...b, ...c);
  I.push(i, i+1, i+2);
  if (U && uvA) U.push(...uvA, ...uvB, ...uvC);
}
```

**3b. UV helper — compute UV from 3D roof vertex position:**

Add this helper right before the `_quad` function:

```js
// Scale factor: 1 texture repeat per ROOF_TEX_SCALE metres of roof surface
const ROOF_TEX_SCALE = 2.0;

// Compute UV for a roof vertex based on its world-space position.
// u = horizontal extent along roof, v = distance along slope.
function _roofUV(x, y, z) {
  // Use XZ for horizontal and Y for vertical mapping
  // The texture repeats via RepeatWrapping so values > 1 are fine
  return [x / ROOF_TEX_SCALE, (y + z) / ROOF_TEX_SCALE];
}
```

**3c. Modify `_gableRoofSides`** (replace lines 191-204):

```js
function _gableRoofSides(P, I, w, d, h, pitchRad, oh = 0, U) {
  const rise = (w / 2) * Math.tan(pitchRad);
  const ry = h + rise;
  const mx = w / 2;

  // Left slope (with overhang)
  _quad(P, I, [-oh,h,d+oh], [-oh,h,-oh], [mx,ry,-oh], [mx,ry,d+oh],
    U, _roofUV(-oh,h,d+oh), _roofUV(-oh,h,-oh), _roofUV(mx,ry,-oh), _roofUV(mx,ry,d+oh));
  // Right slope
  _quad(P, I, [w+oh,h,-oh], [w+oh,h,d+oh], [mx,ry,d+oh], [mx,ry,-oh],
    U, _roofUV(w+oh,h,-oh), _roofUV(w+oh,h,d+oh), _roofUV(mx,ry,d+oh), _roofUV(mx,ry,-oh));
  // Front gable
  _tri(P, I, [w+oh,h,-oh], [-oh,h,-oh], [mx,ry,-oh],
    U, _roofUV(w+oh,h,-oh), _roofUV(-oh,h,-oh), _roofUV(mx,ry,-oh));
  // Back gable
  _tri(P, I, [-oh,h,d+oh], [w+oh,h,d+oh], [mx,ry,d+oh],
    U, _roofUV(-oh,h,d+oh), _roofUV(w+oh,h,d+oh), _roofUV(mx,ry,d+oh));
}
```

**3d. Modify `_gableRoofFrontBack`** (replace lines 206-219):

```js
function _gableRoofFrontBack(P, I, w, d, h, pitchRad, oh = 0, U) {
  const rise = (d / 2) * Math.tan(pitchRad);
  const ry = h + rise;
  const mz = d / 2;

  // Front slope (with overhang)
  _quad(P, I, [w+oh,h,-oh], [-oh,h,-oh], [-oh,ry,mz], [w+oh,ry,mz],
    U, _roofUV(w+oh,h,-oh), _roofUV(-oh,h,-oh), _roofUV(-oh,ry,mz), _roofUV(w+oh,ry,mz));
  // Back slope
  _quad(P, I, [-oh,h,d+oh], [w+oh,h,d+oh], [w+oh,ry,mz], [-oh,ry,mz],
    U, _roofUV(-oh,h,d+oh), _roofUV(w+oh,h,d+oh), _roofUV(w+oh,ry,mz), _roofUV(-oh,ry,mz));
  // Left gable
  _tri(P, I, [-oh,h,d+oh], [-oh,h,-oh], [-oh,ry,mz],
    U, _roofUV(-oh,h,d+oh), _roofUV(-oh,h,-oh), _roofUV(-oh,ry,mz));
  // Right gable
  _tri(P, I, [w+oh,h,-oh], [w+oh,h,d+oh], [w+oh,ry,mz],
    U, _roofUV(w+oh,h,-oh), _roofUV(w+oh,h,d+oh), _roofUV(w+oh,ry,mz));
}
```

**3e. Modify `_hipRoof`** (replace lines 221-256):

```js
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
```

**3f. Modify `_mansardRoof`** (replace lines 258-282):

```js
function _mansardRoof(P, I, w, d, h, pitchRad, U) {
  const insetFrac = 0.2;
  const insetX = w * insetFrac;
  const insetZ = d * insetFrac;
  const steepAngle = 70 * Math.PI / 180;
  const rise = Math.min(insetX, insetZ) * Math.tan(steepAngle);
  const topY = h + rise;

  const bx0 = insetX, bx1 = w - insetX;
  const bz0 = insetZ, bz1 = d - insetZ;

  // Four steep lower slopes
  _quad(P, I, [0,h,0], [w,h,0], [bx1,topY,bz0], [bx0,topY,bz0],
    U, _roofUV(0,h,0), _roofUV(w,h,0), _roofUV(bx1,topY,bz0), _roofUV(bx0,topY,bz0));
  _quad(P, I, [w,h,0], [w,h,d], [bx1,topY,bz1], [bx1,topY,bz0],
    U, _roofUV(w,h,0), _roofUV(w,h,d), _roofUV(bx1,topY,bz1), _roofUV(bx1,topY,bz0));
  _quad(P, I, [w,h,d], [0,h,d], [bx0,topY,bz1], [bx1,topY,bz1],
    U, _roofUV(w,h,d), _roofUV(0,h,d), _roofUV(bx0,topY,bz1), _roofUV(bx1,topY,bz1));
  _quad(P, I, [0,h,d], [0,h,0], [bx0,topY,bz0], [bx0,topY,bz1],
    U, _roofUV(0,h,d), _roofUV(0,h,0), _roofUV(bx0,topY,bz0), _roofUV(bx0,topY,bz1));

  // Flat top cap
  _quad(P, I, [bx0,topY,bz0], [bx1,topY,bz0], [bx1,topY,bz1], [bx0,topY,bz1],
    U, _roofUV(bx0,topY,bz0), _roofUV(bx1,topY,bz0), _roofUV(bx1,topY,bz1), _roofUV(bx0,topY,bz1));
}
```

**3g. Modify `addPitchedRoof`** (replace lines 154-189):

```js
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
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/buildings/generate.test.js`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/buildings/generate.js test/buildings/generate.test.js
git commit -m "feat: addPitchedRoof uses roof tile texture with UV coordinates

All four roof types (gable sides/frontback, hip, mansard) generate UVs.
Texture applied when house._roofTileStyle is set, otherwise solid colour.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 3: Add roofTileStyle to archetypes and generateRow

**Files:**
- Modify: `src/buildings/archetypes.js`
- Test: `test/buildings/archetypes.test.js`

**Step 1: Write the failing test**

Add to the `generateRow` describe block in `test/buildings/archetypes.test.js`. First, add `getRoofTexture` to the imports from generate.js (you may need to add this import line):

```js
import { getRoofTexture } from '../../src/buildings/generate.js';
```

Then add this test:

```js
  it('applies roofTileStyle texture from archetype', () => {
    const group = generateRow(victorianTerrace, 2, 42);
    const house = group.children[0];
    let roof = null;
    house.traverse(c => { if (c.name === 'roof') roof = c; });
    expect(roof).toBeDefined();
    expect(roof.material.map).toBeDefined();
    expect(roof.material.map).toBe(getRoofTexture('slate', victorianTerrace.shared.roofColor));
  });
```

**Step 2: Run tests to verify it fails**

Run: `npx vitest run test/buildings/archetypes.test.js`
Expected: FAIL — archetypes don't have `roofTileStyle` yet, and `generateRow` doesn't set `house._roofTileStyle`.

**Step 3: Add roofTileStyle to archetypes and generateRow**

In `src/buildings/archetypes.js`, add `roofTileStyle` to each archetype's `shared` block:

- `victorianTerrace.shared`: add `roofTileStyle: 'slate',` (after `windowStyle: 'sash',`)
- `parisianHaussmann.shared`: add `roofTileStyle: 'clay',` (after `windowStyle: 'georgian',`)
- `germanTownhouse.shared`: add `roofTileStyle: 'slate',` (after `windowStyle: 'georgian',`)
- `suburbanDetached.shared`: add `roofTileStyle: 'shingle',` (after `windowStyle: 'single',`)
- `lowRiseApartments.shared`: add `roofTileStyle: 'shingle',` (after `windowStyle: 'casement',`)

In `generateRow`, add this line just before the `addPitchedRoof` call (around line 278, before `addPitchedRoof(house, roofPitch, s.roofDirection, s.roofOverhang)`):

```js
    house._roofTileStyle = s.roofTileStyle || 'slate';
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/buildings/archetypes.test.js`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/buildings/archetypes.js test/buildings/archetypes.test.js
git commit -m "feat: archetypes specify roofTileStyle, generateRow applies it

Victorian/German=slate, Haussmann=clay, Suburban/Apartments=shingle.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 4: Run all tests and verify

**Step 1: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS — no regressions.

**Step 2: Visual verification**

Run the dev server, navigate to `?mode=terraced`. Cycle through archetypes and verify:

- **Victorian Terrace** — slate tile pattern (staggered rectangles, brown)
- **Parisian Haussmann** — clay tile pattern (pantile, dark grey)
- **German Townhouse** — slate tile pattern (staggered rectangles, saddle brown)
- **Suburban Detached** — shingle pattern (small uniform tiles, brown)
- **Low-rise Apartments** — shingle pattern (small uniform tiles, grey)

All main roofs should show tile patterns instead of solid colour. Porch/bay/extension/dormer roofs will still be solid — this is expected and noted in the design as out of scope.
