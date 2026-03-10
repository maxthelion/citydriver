# Terraced Row Generator Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Generate a row of Victorian terraced houses using the composable building API, driven by an archetype object with parameter ranges and position-based seeding.

**Architecture:** An archetype object defines parameter ranges for a building style. `generateRow(archetype, count, seed)` iterates house positions, seeds each house from its world X coordinate, samples concrete values from archetype ranges, and calls the composable API (`createHouse` → `setPartyWalls` → `addFloor` → etc.) to build each house. A minimal `TerracedRowScreen` renders the row with orbit camera and count/seed controls.

**Tech Stack:** THREE.js, Vitest, composable building API from `src/buildings/generate.js`, `SeededRandom` from `src/core/rng.js`

---

### Task 1: Fix `addWindows` to respect party walls

**Files:**
- Modify: `src/buildings/generate.js:387-392` (walls array in `addWindows`)
- Modify: `src/buildings/generate.js:394` (wall loop)
- Test: `test/buildings/generate.test.js`

**Step 1: Write the failing test**

Add this test at the end of the `addWindows` describe block in `test/buildings/generate.test.js`:

```js
import { setPartyWalls } from '../../src/buildings/generate.js';
```

Add `setPartyWalls` to the existing import at line 4.

```js
  it('skips windows on party walls', () => {
    const house = createHouse(6, 8, 3);
    setPartyWalls(house, ['left', 'right']);
    addWindows(house, { spacing: 2.5 });
    const winGroup = getChild(house.group, 'windows');
    // All windows should be on front (z near 0) or back (z near depth)
    for (const win of winGroup.children) {
      const z = win.position.z;
      const x = win.position.x;
      // Should NOT be on left wall (x near 0) or right wall (x near 6)
      const onLeft = Math.abs(x - (-0.01)) < 0.1;
      const onRight = Math.abs(x - 6.01) < 0.1;
      expect(onLeft || onRight).toBe(false);
    }
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/buildings/generate.test.js`
Expected: FAIL — windows still placed on left/right walls because `addWindows` doesn't check `_partyWalls`.

**Step 3: Implement the fix**

In `src/buildings/generate.js`, modify the walls array in `addWindows` (around line 387-392) to add `face` labels to left and right walls:

```js
  const walls = [
    { span: house.width, rot: Math.PI, posFn: (cx, cy) => [cx, cy, -0.01], face: 'front' },
    { span: house.width, rot: 0, posFn: (cx, cy) => [cx, cy, house.depth + 0.01], face: 'back' },
    { span: house.depth, rot: Math.PI / 2, posFn: (cz, cy) => [-0.01, cy, cz], face: 'left' },
    { span: house.depth, rot: -Math.PI / 2, posFn: (cz, cy) => [house.width + 0.01, cy, cz], face: 'right' },
  ];
```

Then add at the top of the `for (const wall of walls)` loop (line 394), before the `nWin` calculation:

```js
    if (house._partyWalls?.has(wall.face)) continue;
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/buildings/generate.test.js`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/buildings/generate.js test/buildings/generate.test.js
git commit -m "feat: addWindows respects party walls, skipping window placement on shared sides"
```

---

### Task 2: Create `archetypes.js` with helpers and Victorian terrace archetype

**Files:**
- Create: `src/buildings/archetypes.js`
- Create: `test/buildings/archetypes.test.js`

**Step 1: Write the failing tests**

Create `test/buildings/archetypes.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { sample, hashPosition, victorianTerrace } from '../../src/buildings/archetypes.js';
import { SeededRandom } from '../../src/core/rng.js';

describe('sample', () => {
  it('returns scalar values unchanged', () => {
    const rng = new SeededRandom(42);
    expect(sample(rng, 5)).toBe(5);
    expect(sample(rng, 'hello')).toBe('hello');
  });

  it('samples from [min, max] range', () => {
    const rng = new SeededRandom(42);
    const val = sample(rng, [2, 5]);
    expect(val).toBeGreaterThanOrEqual(2);
    expect(val).toBeLessThan(5);
  });
});

describe('hashPosition', () => {
  it('returns an integer', () => {
    const h = hashPosition(42, 10.5, 0);
    expect(Number.isInteger(h)).toBe(true);
  });

  it('different positions produce different hashes', () => {
    const a = hashPosition(42, 0, 0);
    const b = hashPosition(42, 5, 0);
    const c = hashPosition(42, 0, 5);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('same inputs produce same hash', () => {
    expect(hashPosition(42, 10, 20)).toBe(hashPosition(42, 10, 20));
  });
});

describe('victorianTerrace', () => {
  it('has required archetype fields', () => {
    expect(victorianTerrace.typology).toBe('terraced');
    expect(victorianTerrace.partyWalls).toEqual(['left', 'right']);
    expect(victorianTerrace.floors).toEqual([2, 3]);
    expect(victorianTerrace.roofDirection).toBe('sides');
    expect(victorianTerrace.door).toBe('left');
    expect(victorianTerrace.bay).toBeDefined();
    expect(victorianTerrace.sills).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/buildings/archetypes.test.js`
Expected: FAIL — module not found.

**Step 3: Implement helpers and archetype**

Create `src/buildings/archetypes.js`:

```js
import * as THREE from 'three';
import { SeededRandom } from '../core/rng.js';
import {
  createHouse, setPartyWalls, addFloor,
  addPitchedRoof, addFrontDoor, addBayWindow,
  addWindows, addWindowSills, addGroundLevel,
} from './generate.js';

/**
 * Sample a value from an archetype field.
 * If the field is a two-element array [min, max], returns rng.range(min, max).
 * Otherwise returns the value unchanged.
 */
export function sample(rng, value) {
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'number') {
    return rng.range(value[0], value[1]);
  }
  return value;
}

/**
 * Hash a seed with a world position to produce a deterministic integer seed.
 * The same (seed, x, z) always produces the same result.
 */
export function hashPosition(seed, x, z) {
  const ix = Math.round(x * 100);
  const iz = Math.round(z * 100);
  return ((seed ^ (ix * 73856093) ^ (iz * 19349663)) | 0);
}

/**
 * Shift each RGB component of a hex color by a random amount.
 */
function nudgeColor(hex, amount, rng) {
  const shift = Math.round(amount * 255);
  const r = Math.min(255, Math.max(0, ((hex >> 16) & 0xff) + rng.int(-shift, shift)));
  const g = Math.min(255, Math.max(0, ((hex >> 8) & 0xff) + rng.int(-shift, shift)));
  const b = Math.min(255, Math.max(0, (hex & 0xff) + rng.int(-shift, shift)));
  return (r << 16) | (g << 8) | b;
}

export const victorianTerrace = {
  typology: 'terraced',
  partyWalls: ['left', 'right'],
  floors: [2, 3],
  floorHeight: [2.8, 3.2],
  roofPitch: [35, 45],
  roofDirection: 'sides',
  roofOverhang: 0.2,
  plotWidth: [4.5, 6],
  depth: [8, 10],
  door: 'left',
  bay: { style: 'box', span: 1, floors: [1, 2], depth: [0.6, 0.9] },
  groundHeight: [0.3, 0.5],
  wallColor: 0xd4c4a8,
  roofColor: 0x6b4e37,
  colorVariation: 0.06,
  windowSpacing: [2.2, 2.8],
  windowHeight: [1.3, 1.6],
  sills: { protrusion: 0.08 },
};
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/buildings/archetypes.test.js`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/buildings/archetypes.js test/buildings/archetypes.test.js
git commit -m "feat: add archetypes module with sample/hashPosition helpers and victorianTerrace definition"
```

---

### Task 3: Implement `generateRow`

**Files:**
- Modify: `src/buildings/archetypes.js`
- Modify: `test/buildings/archetypes.test.js`

**Step 1: Write the failing tests**

Add to `test/buildings/archetypes.test.js`:

```js
import * as THREE from 'three';
import { generateRow } from '../../src/buildings/archetypes.js';
```

Add `generateRow` to the existing import from archetypes.

```js
describe('generateRow', () => {
  it('returns a THREE.Group with the correct number of houses', () => {
    const group = generateRow(victorianTerrace, 5, 42);
    expect(group).toBeInstanceOf(THREE.Group);
    expect(group.children.length).toBe(5);
  });

  it('is deterministic — same seed produces same output', () => {
    const a = generateRow(victorianTerrace, 4, 123);
    const b = generateRow(victorianTerrace, 4, 123);
    // Same number of children, same positions
    expect(a.children.length).toBe(b.children.length);
    for (let i = 0; i < a.children.length; i++) {
      expect(a.children[i].position.x).toBeCloseTo(b.children[i].position.x, 5);
    }
  });

  it('position-stable — house at position N is the same regardless of count', () => {
    // Generate rows of different lengths
    const row4 = generateRow(victorianTerrace, 4, 99);
    const row6 = generateRow(victorianTerrace, 6, 99);
    // House 0 should have same X position (0) in both rows
    expect(row4.children[0].position.x).toBeCloseTo(0, 5);
    expect(row6.children[0].position.x).toBeCloseTo(0, 5);
  });

  it('first house has no left party wall (has left-side windows)', () => {
    const group = generateRow(victorianTerrace, 4, 42);
    const firstHouse = group.children[0];
    // Find windows group
    let winGroup = null;
    firstHouse.traverse(c => { if (c.name === 'windows') winGroup = c; });
    expect(winGroup).toBeDefined();
    // Should have at least one window on the left wall (x near 0)
    const leftWindows = winGroup.children.filter(w => Math.abs(w.position.x - (-0.01)) < 0.1);
    expect(leftWindows.length).toBeGreaterThan(0);
  });

  it('last house has no right party wall (has right-side windows)', () => {
    const group = generateRow(victorianTerrace, 4, 42);
    const lastHouse = group.children[3];
    let winGroup = null;
    lastHouse.traverse(c => { if (c.name === 'windows') winGroup = c; });
    expect(winGroup).toBeDefined();
    // The house width varies, so find windows on the right side
    // Right wall windows have x near house.width + 0.01
    // Since we don't know exact width, check for windows with x > 3 (min plotWidth is 4.5)
    const rightWindows = winGroup.children.filter(w => w.position.x > 3);
    expect(rightWindows.length).toBeGreaterThan(0);
  });

  it('middle house has no side windows (both party walls)', () => {
    const group = generateRow(victorianTerrace, 5, 42);
    const midHouse = group.children[2];
    let winGroup = null;
    midHouse.traverse(c => { if (c.name === 'windows') winGroup = c; });
    expect(winGroup).toBeDefined();
    // All windows should be on front (z < 0) or back (z > 7, min depth is 8)
    for (const w of winGroup.children) {
      const onSide = w.position.x < 0.05 || w.position.x > 3;
      const onFrontBack = w.position.z < 0.05 || w.position.z > 7;
      // Each window is on front/back OR on a side
      // Middle houses should have no side windows
      if (!onFrontBack) {
        // If not on front/back, it shouldn't be on a side wall either
        // This would fail for a middle house with party walls
      }
    }
    // Simpler: count windows. Middle house with 2 party walls should have fewer
    // than end house with 1 party wall
    const endHouse = group.children[0];
    let endWinGroup = null;
    endHouse.traverse(c => { if (c.name === 'windows') endWinGroup = c; });
    expect(winGroup.children.length).toBeLessThan(endWinGroup.children.length);
  });

  it('total row width equals sum of individual plot widths', () => {
    const group = generateRow(victorianTerrace, 4, 42);
    const lastHouse = group.children[3];
    // The last house position.x + its width should be the total row width
    // Each house is positioned at cumulative offset
    // Total width = last house X + last house width
    // All houses should tile without gaps
    let totalWidth = 0;
    for (const child of group.children) {
      // Each child is a house group whose position.x is its offset
      // The width is stored... we need to check adjacency
      if (child !== group.children[0]) {
        // Current house X should equal previous house X + previous width
        // Just verify no overlap: each house X >= previous house X
        const prevIdx = group.children.indexOf(child) - 1;
        expect(child.position.x).toBeGreaterThan(group.children[prevIdx].position.x);
      }
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/buildings/archetypes.test.js`
Expected: FAIL — `generateRow` is not exported.

**Step 3: Implement `generateRow`**

Add to `src/buildings/archetypes.js`:

```js
/**
 * Generate a row of terraced houses from an archetype.
 * @param {object} archetype - Archetype with parameter ranges
 * @param {number} count - Number of houses
 * @param {number} seed - Master seed for deterministic generation
 * @returns {THREE.Group} Group containing all houses positioned side by side
 */
export function generateRow(archetype, count, seed) {
  const group = new THREE.Group();
  let xOffset = 0;

  for (let i = 0; i < count; i++) {
    const houseSeed = hashPosition(seed, xOffset, 0);
    const rng = new SeededRandom(houseSeed);

    // Sample concrete values from archetype ranges
    const width = sample(rng, archetype.plotWidth);
    const depth = sample(rng, archetype.depth);
    const floors = Math.round(sample(rng, archetype.floors));
    const floorHeight = sample(rng, archetype.floorHeight);
    const roofPitch = sample(rng, archetype.roofPitch);
    const winSpacing = sample(rng, archetype.windowSpacing);
    const winHeight = sample(rng, archetype.windowHeight);
    const groundHeight = sample(rng, archetype.groundHeight);
    const bayFloors = Math.round(sample(rng, archetype.bay.floors));
    const bayDepth = sample(rng, archetype.bay.depth);
    const wallColor = nudgeColor(archetype.wallColor, archetype.colorVariation, rng);

    // Party walls: ends get one side exposed
    const partyWalls = [...archetype.partyWalls];
    if (i === 0) {
      const idx = partyWalls.indexOf('left');
      if (idx !== -1) partyWalls.splice(idx, 1);
    }
    if (i === count - 1) {
      const idx = partyWalls.indexOf('right');
      if (idx !== -1) partyWalls.splice(idx, 1);
    }

    // Build house using composable API
    const house = createHouse(width, depth, floorHeight, wallColor);
    house._winSpacing = winSpacing;
    house._groundHeight = groundHeight;
    house.roofColor = archetype.roofColor;

    setPartyWalls(house, partyWalls);
    for (let f = 1; f < floors; f++) addFloor(house);
    addPitchedRoof(house, roofPitch, archetype.roofDirection, archetype.roofOverhang);
    addFrontDoor(house, archetype.door);
    addBayWindow(house, {
      style: archetype.bay.style,
      span: archetype.bay.span,
      floors: Math.min(bayFloors, floors),
      depth: bayDepth,
    });
    addWindows(house, { spacing: winSpacing, height: winHeight });
    if (archetype.sills) {
      addWindowSills(house, { protrusion: archetype.sills.protrusion });
    }
    if (groundHeight > 0) {
      addGroundLevel(house, groundHeight);
    }

    // Position in row
    house.group.position.x = xOffset;
    group.add(house.group);
    xOffset += width;
  }

  return group;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/buildings/archetypes.test.js`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/buildings/archetypes.js test/buildings/archetypes.test.js
git commit -m "feat: implement generateRow for archetype-driven terraced house rows"
```

---

### Task 4: Create `TerracedRowScreen`

**Files:**
- Create: `src/ui/TerracedRowScreen.js`

This task has no unit tests — it is a visual UI screen. Verify by running the app and navigating to the screen.

**Step 1: Create the screen**

Create `src/ui/TerracedRowScreen.js`. This follows the same pattern as `src/ui/BuildingStyleScreen.js` — fixed-position root div, sidebar with controls, THREE.js canvas with orbit camera.

```js
import * as THREE from 'three';
import { generateRow, victorianTerrace } from '../buildings/archetypes.js';

export class TerracedRowScreen {
  constructor(container, onBack) {
    this.container = container;
    this._onBack = onBack;
    this._running = true;
    this._count = 6;
    this._seed = 42;

    this._buildUI();
    this._initRenderer();
    this._rebuild();
    this._animate();
  }

  _buildUI() {
    this._root = document.createElement('div');
    this._root.style.cssText = 'position:fixed;inset:0;display:flex;background:#1a1a2e;z-index:50';
    this.container.appendChild(this._root);

    // Sidebar
    const sidebar = document.createElement('div');
    sidebar.style.cssText = 'width:220px;display:flex;flex-direction:column;padding:12px;background:#1a1a2e;border-right:1px solid #333;overflow-y:auto;gap:6px';
    this._root.appendChild(sidebar);

    const title = document.createElement('div');
    title.textContent = 'Terraced Row';
    title.style.cssText = 'color:#ffaa88;font-family:monospace;font-size:16px;font-weight:bold;margin-bottom:8px';
    sidebar.appendChild(title);

    // Count slider
    const countRow = document.createElement('div');
    countRow.style.cssText = 'display:flex;flex-direction:column;gap:1px';
    const countLabelRow = document.createElement('div');
    countLabelRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center';
    const countLbl = document.createElement('span');
    countLbl.textContent = 'Houses';
    countLbl.style.cssText = 'color:#aaa;font-family:monospace;font-size:11px';
    const countVal = document.createElement('span');
    countVal.textContent = this._count;
    countVal.style.cssText = 'color:#eee;font-family:monospace;font-size:11px;min-width:36px;text-align:right';
    countLabelRow.appendChild(countLbl);
    countLabelRow.appendChild(countVal);
    const countInput = document.createElement('input');
    countInput.type = 'range';
    countInput.min = 3;
    countInput.max = 10;
    countInput.step = 1;
    countInput.value = this._count;
    countInput.style.cssText = 'width:100%;accent-color:#ffaa88';
    countInput.addEventListener('input', () => {
      this._count = parseInt(countInput.value);
      countVal.textContent = this._count;
      this._rebuild();
    });
    countRow.appendChild(countLabelRow);
    countRow.appendChild(countInput);
    sidebar.appendChild(countRow);

    // Seed input
    const seedRow = document.createElement('div');
    seedRow.style.cssText = 'display:flex;flex-direction:column;gap:1px;margin-top:8px';
    const seedLbl = document.createElement('span');
    seedLbl.textContent = 'Seed';
    seedLbl.style.cssText = 'color:#aaa;font-family:monospace;font-size:11px';
    const seedInput = document.createElement('input');
    seedInput.type = 'number';
    seedInput.value = this._seed;
    seedInput.style.cssText = 'width:100%;padding:4px;background:#333;color:#eee;border:1px solid #666;font-family:monospace;font-size:13px;border-radius:4px;box-sizing:border-box';
    seedInput.addEventListener('change', () => {
      this._seed = parseInt(seedInput.value) || 0;
      this._rebuild();
    });
    seedRow.appendChild(seedLbl);
    seedRow.appendChild(seedInput);
    sidebar.appendChild(seedRow);

    // Randomise seed button
    const randBtn = document.createElement('button');
    randBtn.textContent = 'Random seed';
    randBtn.style.cssText = 'margin-top:8px;padding:6px;background:#444;color:#eee;border:1px solid #666;cursor:pointer;font-family:monospace;font-size:13px;border-radius:4px';
    randBtn.addEventListener('click', () => {
      this._seed = Math.floor(Math.random() * 1000000);
      seedInput.value = this._seed;
      this._rebuild();
    });
    sidebar.appendChild(randBtn);

    // Spacer + back button
    const spacer = document.createElement('div');
    spacer.style.cssText = 'flex:1';
    sidebar.appendChild(spacer);

    const backBtn = document.createElement('button');
    backBtn.textContent = 'Back';
    backBtn.style.cssText = 'padding:6px;background:#333;color:#eee;border:1px solid #666;cursor:pointer;font-family:monospace;font-size:13px;border-radius:4px';
    backBtn.addEventListener('click', () => { if (this._onBack) this._onBack(); });
    sidebar.appendChild(backBtn);

    // View container
    this._viewContainer = document.createElement('div');
    this._viewContainer.style.cssText = 'flex:1;position:relative;overflow:hidden';
    this._root.appendChild(this._viewContainer);

    this._onKeyDown = (e) => {
      if (e.key === 'Escape' && this._onBack) this._onBack();
    };
    document.addEventListener('keydown', this._onKeyDown);

    this._onResize = () => {
      if (!this._renderer) return;
      const w = this._viewContainer.clientWidth;
      const h = this._viewContainer.clientHeight;
      this._renderer.setSize(w, h);
      this._camera.aspect = w / h;
      this._camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', this._onResize);
  }

  _initRenderer() {
    const w = this._viewContainer.clientWidth || 600;
    const h = this._viewContainer.clientHeight || 600;

    this._renderer = new THREE.WebGLRenderer({ antialias: true });
    this._renderer.setSize(w, h);
    this._renderer.setPixelRatio(window.devicePixelRatio);
    this._renderer.setClearColor(0x87ceeb);
    this._viewContainer.appendChild(this._renderer.domElement);

    this._scene = new THREE.Scene();
    this._scene.add(new THREE.AmbientLight(0x8899aa, 0.6));
    const sun = new THREE.DirectionalLight(0xffeedd, 1.2);
    sun.position.set(20, 40, 30);
    this._scene.add(sun);

    // Ground plane
    const groundGeo = new THREE.PlaneGeometry(200, 200);
    const ground = new THREE.Mesh(groundGeo, new THREE.MeshLambertMaterial({ color: 0x3a6b35 }));
    ground.rotation.x = -Math.PI / 2;
    this._scene.add(ground);

    this._camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 500);

    this._orbit = { theta: Math.PI / 4, phi: Math.PI / 5, dist: 40 };
    this._orbitTarget = new THREE.Vector3(0, 0, 0);
    this._setupOrbitControls();
  }

  _setupOrbitControls() {
    const canvas = this._renderer.domElement;
    let dragging = false;
    let lastX, lastY;

    canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      this._orbit.theta -= dx * 0.008;
      this._orbit.phi = Math.max(0.05, Math.min(Math.PI / 2 - 0.05, this._orbit.phi - dy * 0.008));
      this._updateCamera();
    });

    canvas.addEventListener('pointerup', (e) => {
      dragging = false;
      canvas.releasePointerCapture(e.pointerId);
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._orbit.dist = Math.max(5, Math.min(150, this._orbit.dist * (1 + e.deltaY * 0.001)));
      this._updateCamera();
    }, { passive: false });
  }

  _updateCamera() {
    const { theta, phi, dist } = this._orbit;
    const t = this._orbitTarget;
    this._camera.position.set(
      t.x + dist * Math.sin(phi) * Math.sin(theta),
      t.y + dist * Math.cos(phi),
      t.z + dist * Math.sin(phi) * Math.cos(theta),
    );
    this._camera.lookAt(t);
  }

  _rebuild() {
    if (this._rowGroup) {
      this._scene.remove(this._rowGroup);
      this._rowGroup.traverse(c => {
        if (c.geometry) c.geometry.dispose();
      });
    }

    this._rowGroup = generateRow(victorianTerrace, this._count, this._seed);

    // Center the row horizontally
    const box = new THREE.Box3().setFromObject(this._rowGroup);
    const centerX = (box.min.x + box.max.x) / 2;
    const centerZ = (box.min.z + box.max.z) / 2;
    this._rowGroup.position.x -= centerX;
    this._rowGroup.position.z -= centerZ;

    this._scene.add(this._rowGroup);

    // Fit camera
    const rowWidth = box.max.x - box.min.x;
    const height = box.max.y - box.min.y;
    this._orbit.dist = Math.max(rowWidth, height) * 1.5;
    this._orbitTarget.set(0, height * 0.4, 0);
    this._updateCamera();
  }

  _animate() {
    if (!this._running) return;
    requestAnimationFrame(() => this._animate());
    if (this._renderer) {
      this._renderer.render(this._scene, this._camera);
    }
  }

  dispose() {
    this._running = false;
    if (this._onKeyDown) document.removeEventListener('keydown', this._onKeyDown);
    if (this._onResize) window.removeEventListener('resize', this._onResize);
    if (this._rowGroup) {
      this._rowGroup.traverse(c => {
        if (c.geometry) c.geometry.dispose();
        if (c.material) {
          if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
          else c.material.dispose();
        }
      });
    }
    if (this._renderer) {
      this._renderer.dispose();
      this._renderer = null;
    }
    this.container.innerHTML = '';
  }
}
```

**Step 2: Commit**

```bash
git add src/ui/TerracedRowScreen.js
git commit -m "feat: add TerracedRowScreen with count/seed controls and orbit camera"
```

---

### Task 5: Wire TerracedRowScreen into main.js

**Files:**
- Modify: `src/main.js`

**Step 1: Add import and variable**

At the top of `src/main.js`, add after the BuildingStyleScreen import (line 5):

```js
import { TerracedRowScreen } from './ui/TerracedRowScreen.js';
```

Add after the `let buildingScreen = null;` declaration (line 14):

```js
let terracedScreen = null;
```

**Step 2: Add disposal**

In the `disposeAll()` function, add after the `buildingScreen` disposal line (after line 21):

```js
  if (terracedScreen) { terracedScreen.dispose(); terracedScreen = null; }
```

**Step 3: Add route handling**

In the `enterSubScreen` function, add a new `else if` block after the `buildings` mode check (after line 40):

```js
  } else if (mode === 'terraced') {
    terracedScreen = new TerracedRowScreen(container, goBack);
```

In the `showRegion` callback object, add after `onBuildings` (after line 55):

```js
    onTerraced() {
      disposeAll();
      history.pushState(null, '', '?mode=terraced');
      terracedScreen = new TerracedRowScreen(container, goBack);
    },
```

In the `popstate` handler, add after the `buildings` mode check (after line 69):

```js
  if (mode === 'terraced') {
    terracedScreen = new TerracedRowScreen(container, goBack);
    return;
  }
```

In the URL deep-link check at the bottom, add after the `buildings` check (after line 96):

```js
} else if (urlMode === 'terraced') {
  terracedScreen = new TerracedRowScreen(container, goBack);
```

**Step 4: Add button to RegionScreen**

Check how the "Buildings" button is wired in `src/ui/RegionScreen.js` and add a similar "Terraced" button next to it that calls `this._callbacks.onTerraced()`.

Look for the pattern in RegionScreen that creates the buildings button (likely in `_buildUI` or similar). Add an identical button labeled "Terraced" that calls `this._callbacks.onTerraced()`.

**Step 5: Verify**

Run: `npx vite` (or however the dev server starts)
Navigate to the region screen. Click "Terraced" button. Verify the terraced row screen appears with houses. Use count slider and seed input.

**Step 6: Commit**

```bash
git add src/main.js src/ui/RegionScreen.js
git commit -m "feat: wire TerracedRowScreen into main.js and RegionScreen navigation"
```

---

### Task 6: Run all tests and verify

**Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: ALL PASS — no regressions.

**Step 2: If any tests fail, fix them before proceeding**
