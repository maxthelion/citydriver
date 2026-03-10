# Window Pane Textures Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace solid-colour window planes with textured windows showing mullion/pane divider patterns, with 4 styles selectable per archetype.

**Architecture:** A `getWindowTexture(style)` function procedurally draws window patterns on canvas and caches them as `CanvasTexture`. `addWindows` uses the texture via `house._windowStyle`. Each archetype specifies its `windowStyle` in shared params.

**Tech Stack:** THREE.js (CanvasTexture, MeshLambertMaterial), Vitest

---

### Task 1: Add getWindowTexture to generate.js

**Files:**
- Modify: `src/buildings/generate.js`
- Test: `test/buildings/generate.test.js`

**Step 1: Write the failing tests**

Add a new describe block in `test/buildings/generate.test.js`. First, add `getWindowTexture` to the import at line 5:

```js
import {
  createHouse, addFloor, removeFloor,
  addPitchedRoof, addFrontDoor, addBackDoor, addPorch, addWindows,
  addExtension, addDormer, addBayWindow, addWindowSills, addGroundLevel,
  setPartyWalls, addBalcony, getWindowTexture,
} from '../../src/buildings/generate.js';
```

Then add this describe block:

```js
describe('getWindowTexture', () => {
  it('returns a THREE.CanvasTexture for each style', () => {
    for (const style of ['sash', 'georgian', 'casement', 'single']) {
      const tex = getWindowTexture(style);
      expect(tex).toBeInstanceOf(THREE.CanvasTexture);
    }
  });

  it('caches textures — same style returns same object', () => {
    const a = getWindowTexture('sash');
    const b = getWindowTexture('sash');
    expect(a).toBe(b);
  });

  it('different styles return different objects', () => {
    const a = getWindowTexture('sash');
    const b = getWindowTexture('georgian');
    expect(a).not.toBe(b);
  });

  it('unknown style falls back to sash', () => {
    const tex = getWindowTexture('nonexistent');
    const sash = getWindowTexture('sash');
    expect(tex).toBe(sash);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/buildings/generate.test.js`
Expected: FAIL — `getWindowTexture` is not exported.

**Step 3: Implement getWindowTexture**

Add this function to `src/buildings/generate.js`, before the `addWindows` function (around line 363). Also add it to the exports.

```js
const _windowTextureCache = new Map();

function _drawWindowPattern(style) {
  const w = 64, h = 96;
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h)
    : document.createElement('canvas');
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');

  // Glass background
  ctx.fillStyle = '#88aabb';
  ctx.fillRect(0, 0, w, h);

  // Frame border
  ctx.strokeStyle = '#c0c0c0';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, w - 2, h - 2);

  // Mullion lines
  ctx.strokeStyle = '#c8c8c8';
  ctx.lineWidth = 2;

  if (style === 'sash') {
    // 2x2: horizontal bar at middle, vertical bar at middle
    ctx.beginPath();
    ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2);
    ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h);
    ctx.stroke();
  } else if (style === 'georgian') {
    // 3x2: two columns, three rows
    ctx.beginPath();
    ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h);
    ctx.moveTo(0, h / 3); ctx.lineTo(w, h / 3);
    ctx.moveTo(0, 2 * h / 3); ctx.lineTo(w, 2 * h / 3);
    ctx.stroke();
  } else if (style === 'casement') {
    // 2x1: vertical bar only
    ctx.beginPath();
    ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h);
    ctx.stroke();
  }
  // 'single' — no mullions, just frame

  return canvas;
}

/**
 * Get a cached CanvasTexture for a window pane style.
 * @param {string} style - 'sash' | 'georgian' | 'casement' | 'single'
 * @returns {THREE.CanvasTexture}
 */
export function getWindowTexture(style) {
  const key = ['sash', 'georgian', 'casement', 'single'].includes(style) ? style : 'sash';
  if (_windowTextureCache.has(key)) return _windowTextureCache.get(key);
  const canvas = _drawWindowPattern(key);
  const tex = new THREE.CanvasTexture(canvas);
  _windowTextureCache.set(key, tex);
  return tex;
}
```

**Note:** Uses `OffscreenCanvas` when available (Node/vitest) with fallback to `document.createElement('canvas')` for the browser. The vitest environment provides `OffscreenCanvas` via the jsdom/happy-dom polyfill — if it doesn't, the tests may need a canvas mock. Check by running first; if `OffscreenCanvas` is not defined, use a simple mock canvas object that returns a stub context.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/buildings/generate.test.js`
Expected: ALL PASS

If `OffscreenCanvas` is not available in the test environment, replace the canvas creation with a simpler approach: create a plain object with `width`, `height`, and a `getContext` that returns a stub with no-op draw methods. `THREE.CanvasTexture` accepts any object with a `width` and `height`. In that case the drawing won't actually happen in tests, but the texture caching and style routing will be tested.

**Step 5: Commit**

```bash
git add src/buildings/generate.js test/buildings/generate.test.js
git commit -m "feat: getWindowTexture draws and caches pane divider patterns

Four styles: sash (2x2), georgian (3x2), casement (2x1), single (frame only).

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 2: Wire texture into addWindows

**Files:**
- Modify: `src/buildings/generate.js:365-430` (the addWindows function)
- Test: `test/buildings/generate.test.js`

**Step 1: Write the failing test**

Add to the `addWindows` describe block in `test/buildings/generate.test.js`:

```js
  it('uses window texture when house._windowStyle is set', () => {
    const house = createHouse(6, 5, 3);
    house._windowStyle = 'georgian';
    addWindows(house);
    const winGroup = getChild(house.group, 'windows');
    const firstWin = winGroup.children[0];
    expect(firstWin.material.map).toBeDefined();
    expect(firstWin.material.map).toBe(getWindowTexture('georgian'));
  });

  it('defaults to sash texture when no windowStyle set', () => {
    const house = createHouse(6, 5, 3);
    addWindows(house);
    const winGroup = getChild(house.group, 'windows');
    const firstWin = winGroup.children[0];
    expect(firstWin.material.map).toBeDefined();
    expect(firstWin.material.map).toBe(getWindowTexture('sash'));
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/buildings/generate.test.js`
Expected: FAIL — `firstWin.material.map` is `null` (current code uses solid colour material).

**Step 3: Modify addWindows to use texture**

In `src/buildings/generate.js`, modify the `addWindows` function. Change the material creation (around line 379) from:

```js
  const mat = new THREE.MeshLambertMaterial({
    color,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
```

to:

```js
  const style = house._windowStyle || 'sash';
  const mat = new THREE.MeshLambertMaterial({
    color,
    map: getWindowTexture(style),
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
```

That's the only change needed. The `color` tints the texture (THREE.js multiplies `color` with the texture), so we should set `color` to white when using a texture so the canvas colours come through clean. Change to:

```js
  const style = house._windowStyle || 'sash';
  const tex = getWindowTexture(style);
  const mat = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    map: tex,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
```

The glass colour is now baked into the texture canvas (the `#88aabb` fill), so we set the material colour to white to avoid tinting.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/buildings/generate.test.js`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/buildings/generate.js test/buildings/generate.test.js
git commit -m "feat: addWindows uses pane divider texture from house._windowStyle

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 3: Add windowStyle to archetypes and generateRow

**Files:**
- Modify: `src/buildings/archetypes.js`
- Test: `test/buildings/archetypes.test.js`

**Step 1: Write the failing test**

Add to the `generateRow` describe block in `test/buildings/archetypes.test.js`:

```js
  it('applies windowStyle texture from archetype', () => {
    // Haussmann has windowStyle: 'georgian'
    const group = generateRow(parisianHaussmann, 2, 42);
    const house = group.children[0];
    let winGroup = null;
    house.traverse(c => { if (c.name === 'windows') winGroup = c; });
    expect(winGroup).toBeDefined();
    expect(winGroup.children[0].material.map).toBeDefined();
  });
```

**Step 2: Run tests to verify it fails**

Run: `npx vitest run test/buildings/archetypes.test.js`
Expected: FAIL — archetypes don't have `windowStyle` yet, and `generateRow` doesn't set `house._windowStyle`.

**Step 3: Add windowStyle to archetypes and generateRow**

In `src/buildings/archetypes.js`, add `windowStyle` to each archetype's `shared` block:

- `victorianTerrace.shared`: add `windowStyle: 'sash',`
- `parisianHaussmann.shared`: add `windowStyle: 'georgian',`
- `germanTownhouse.shared`: add `windowStyle: 'georgian',`
- `suburbanDetached.shared`: add `windowStyle: 'single',`
- `lowRiseApartments.shared`: add `windowStyle: 'casement',`

In `generateRow`, add this line just before the `addWindows` call (around line 300):

```js
    house._windowStyle = s.windowStyle || 'sash';
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/buildings/archetypes.test.js`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/buildings/archetypes.js test/buildings/archetypes.test.js
git commit -m "feat: archetypes specify windowStyle, generateRow applies it

Victorian=sash, Haussmann/German=georgian, Suburban=single, Apartments=casement.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 4: Run all tests and verify

**Step 1: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS — no regressions.

**Step 2: Visual verification**

Run the dev server, navigate to `?mode=terraced`. Cycle through archetypes and verify:

- **Victorian Terrace** — sash (2x2 grid) windows
- **Parisian Haussmann** — georgian (3x2 grid) windows
- **German Townhouse** — georgian (3x2 grid) windows
- **Suburban Detached** — single (frame only) windows
- **Low-rise Apartments** — casement (vertical bar) windows

All windows should show the pane divider pattern instead of solid blue-grey.
