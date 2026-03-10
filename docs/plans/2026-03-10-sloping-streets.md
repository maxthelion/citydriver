# Sloping Streets Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show terraced house rows on sloping terrain with road/sidewalk geometry, adapting house foundations to terrain height. Six preset slope scenarios displayed simultaneously.

**Architecture:** `generateRow` accepts an optional `heightFn(x, z) → y` to query terrain. Each house is positioned at terrain height and gets a foundation computed from the front-to-road height difference. Rear foundation walls extend down where terrain drops behind. The `TerracedRowScreen` builds 6 preset rows stacked in Z, each with road/sidewalk strips following the same height function.

**Tech Stack:** THREE.js, Vitest, composable building API, `SeededRandom`

---

### Task 1: Add heightFn support to generateRow

**Files:**
- Modify: `src/buildings/archetypes.js:78-147`
- Test: `test/buildings/archetypes.test.js`

**Step 1: Write the failing tests**

Add these tests to the `generateRow` describe block in `test/buildings/archetypes.test.js`:

```js
  it('accepts a heightFn and positions houses at terrain height', () => {
    const heightFn = (x, _z) => x * 0.1; // 10% uphill slope
    const group = generateRow(victorianTerrace, 3, 42, heightFn);
    // Each house should have Y > 0 (except possibly first at x=0)
    const lastHouse = group.children[2];
    expect(lastHouse.position.y).toBeGreaterThan(0);
  });

  it('houses on a slope have increasing Y positions', () => {
    const heightFn = (x, _z) => x * 0.05;
    const group = generateRow(victorianTerrace, 4, 42, heightFn);
    for (let i = 1; i < group.children.length; i++) {
      expect(group.children[i].position.y).toBeGreaterThan(group.children[i - 1].position.y);
    }
  });

  it('flat heightFn produces same result as no heightFn', () => {
    const flat = generateRow(victorianTerrace, 3, 42, () => 0);
    const none = generateRow(victorianTerrace, 3, 42);
    for (let i = 0; i < 3; i++) {
      expect(flat.children[i].position.y).toBeCloseTo(none.children[i].position.y, 3);
    }
  });

  it('adds rear foundation wall when terrain drops behind house', () => {
    // Cross-slope: terrain rises with z, so back of house is higher — no rear wall needed
    // Negative cross-slope: terrain falls with z, back is lower — rear wall needed
    const heightFn = (_x, z) => -z * 0.1; // terrain drops toward back
    const group = generateRow(victorianTerrace, 2, 42, heightFn);
    const house = group.children[0];
    let hasRearFoundation = false;
    house.traverse(c => { if (c.name === 'rearFoundation') hasRearFoundation = true; });
    expect(hasRearFoundation).toBe(true);
  });
```

**Step 2: Run test to verify they fail**

Run: `npx vitest run test/buildings/archetypes.test.js`
Expected: FAIL — `generateRow` ignores the 4th argument.

**Step 3: Implement heightFn support**

In `src/buildings/archetypes.js`, modify `generateRow`:

1. Add `heightFn` parameter with default.
2. Add layout constants for road/sidewalk/setback.
3. In the per-house loop, query terrain height, compute ground level, position house, and add rear foundation.

Replace the `generateRow` function (lines 71-147) with:

```js
// Layout constants
const ROAD_HALF_WIDTH = 3;
const SIDEWALK_WIDTH = 1.5;
const SETBACK = 2;
const HOUSE_Z = ROAD_HALF_WIDTH + SIDEWALK_WIDTH + SETBACK;

/**
 * Generate a row of terraced houses from an archetype.
 * @param {object} archetype - Archetype with parameter ranges
 * @param {number} count - Number of houses
 * @param {number} seed - Master seed for deterministic generation
 * @param {function} [heightFn] - Terrain height query: (x, z) => y. Defaults to flat.
 * @returns {THREE.Group} Group containing all houses positioned side by side
 */
export function generateRow(archetype, count, seed, heightFn = () => 0) {
  const group = new THREE.Group();
  const s = archetype.shared;
  const p = archetype.perHouse;

  // Sample shared values once at row level
  const rowRng = new SeededRandom(seed);
  const floors = Math.round(sample(rowRng, s.floors));
  const floorHeight = sample(rowRng, s.floorHeight);
  const roofPitch = sample(rowRng, s.roofPitch);
  const depth = sample(rowRng, s.depth);
  const winSpacing = sample(rowRng, s.windowSpacing);
  const winHeight = sample(rowRng, s.windowHeight);
  const baseGroundHeight = sample(rowRng, s.groundHeight);
  const bayFloors = Math.round(sample(rowRng, s.bay.floors));
  const bayDepth = sample(rowRng, s.bay.depth);

  let xOffset = 0;

  for (let i = 0; i < count; i++) {
    // Per-house values from position-based seed
    const houseSeed = hashPosition(seed, xOffset, 0);
    const rng = new SeededRandom(houseSeed);

    const width = sample(rng, p.plotWidth);
    const wallColor = nudgeColor(p.wallColor, p.colorVariation, rng);

    // Terrain heights at house position
    const centerX = xOffset + width / 2;
    const frontZ = HOUSE_Z;
    const backZ = HOUSE_Z + depth;
    const terrainFront = heightFn(centerX, frontZ);
    const roadY = heightFn(centerX, 0);
    const terrainRear = heightFn(centerX, backZ);

    // Ground level = how much to raise house above road
    const groundLevel = Math.max(baseGroundHeight, terrainFront - roadY);

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
    house._groundHeight = groundLevel;
    house.roofColor = s.roofColor;

    setPartyWalls(house, partyWalls);
    for (let f = 1; f < floors; f++) addFloor(house);
    addPitchedRoof(house, roofPitch, s.roofDirection, s.roofOverhang);
    addFrontDoor(house, s.door);
    addBayWindow(house, {
      style: s.bay.style,
      span: s.bay.span,
      floors: Math.min(bayFloors, floors),
      depth: bayDepth,
    });
    addWindows(house, { spacing: winSpacing, height: winHeight });
    if (s.sills) {
      addWindowSills(house, { protrusion: s.sills.protrusion });
    }
    if (groundLevel > 0.05) {
      addGroundLevel(house, groundLevel);
    }

    // Rear foundation wall: if terrain drops behind the house
    const rearDrop = terrainFront - terrainRear;
    if (rearDrop > 0.05) {
      const rearWall = new THREE.Mesh(
        new THREE.BoxGeometry(width + 0.1, rearDrop, 0.15),
        new THREE.MeshLambertMaterial({ color: house.wallColor }),
      );
      // Position at back of house, extending downward
      rearWall.position.set(width / 2, -rearDrop / 2, depth + 0.05);
      rearWall.name = 'rearFoundation';
      house.group.add(rearWall);
    }

    // Position in row: X along row, Y at terrain height, Z at setback from road
    house.group.position.x = xOffset;
    house.group.position.y = terrainFront;
    house.group.position.z = frontZ;
    group.add(house.group);
    xOffset += width;
  }

  return group;
}
```

**Important note:** This changes the Z position of houses — they are now placed at `HOUSE_Z` (6.5m) instead of 0. The existing tests that check window positions don't inspect `group.position.z`, so they should still pass. The test for "flat heightFn produces same result as no heightFn" verifies Y position compatibility.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/buildings/archetypes.test.js`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/buildings/archetypes.js test/buildings/archetypes.test.js
git commit -m "feat: generateRow accepts heightFn for terrain-aware house placement

Houses are positioned at terrain height, with foundation level computed from
front-to-road height difference. Rear foundation walls extend down where
terrain drops behind the house.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 2: Rewrite TerracedRowScreen with 6 preset rows and road/sidewalk

**Files:**
- Modify: `src/ui/TerracedRowScreen.js`

This is a UI-only task — no unit tests, verify visually.

**Step 1: Rewrite TerracedRowScreen**

Replace the entire contents of `src/ui/TerracedRowScreen.js` with:

```js
import * as THREE from 'three';
import { generateRow, victorianTerrace, HOUSE_Z, ROAD_HALF_WIDTH, SIDEWALK_WIDTH } from '../buildings/archetypes.js';

const PRESETS = [
  { label: 'Flat',           streetSlope: 0,    crossSlope: 0 },
  { label: '5% uphill',      streetSlope: 0.05, crossSlope: 0 },
  { label: '12% uphill',     streetSlope: 0.12, crossSlope: 0 },
  { label: 'Hillside up',    streetSlope: 0,    crossSlope: 0.08 },
  { label: 'Hillside down',  streetSlope: 0,    crossSlope: -0.08 },
  { label: '6% + cross',     streetSlope: 0.06, crossSlope: 0.05 },
];

const ROW_SPACING = 35; // Z distance between preset rows

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
    title.textContent = 'Sloping Streets';
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
    const groundGeo = new THREE.PlaneGeometry(400, 400);
    const ground = new THREE.Mesh(groundGeo, new THREE.MeshLambertMaterial({ color: 0x3a6b35 }));
    ground.rotation.x = -Math.PI / 2;
    this._scene.add(ground);

    this._camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 800);

    this._orbit = { theta: Math.PI / 4, phi: Math.PI / 5, dist: 100 };
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
      this._orbit.dist = Math.max(10, Math.min(300, this._orbit.dist * (1 + e.deltaY * 0.001)));
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

  /**
   * Build a road + sidewalk strip for one preset row.
   * Returns a THREE.Group with road and sidewalk meshes.
   */
  _buildStreet(heightFn, rowLength, zOffset) {
    const street = new THREE.Group();
    const roadW = ROAD_HALF_WIDTH * 2;
    const swW = SIDEWALK_WIDTH;

    const roadMat = new THREE.MeshLambertMaterial({ color: 0x555555 });
    const swMat = new THREE.MeshLambertMaterial({ color: 0x999999 });

    // Helper: build a strip as a quad with corners at terrain height
    const buildStrip = (z0, z1, mat) => {
      const geo = new THREE.BufferGeometry();
      const x0 = 0, x1 = rowLength;
      const positions = new Float32Array([
        x0, heightFn(x0, z0), z0 + zOffset,
        x1, heightFn(x1, z0), z0 + zOffset,
        x1, heightFn(x1, z1), z1 + zOffset,
        x0, heightFn(x0, z1), z1 + zOffset,
      ]);
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setIndex([0, 1, 2, 0, 2, 3]);
      geo.computeVertexNormals();
      street.add(new THREE.Mesh(geo, mat));
    };

    // Road (centered on z=0)
    buildStrip(-ROAD_HALF_WIDTH, ROAD_HALF_WIDTH, roadMat);
    // Near sidewalk (between road and houses)
    buildStrip(ROAD_HALF_WIDTH, ROAD_HALF_WIDTH + swW, swMat);
    // Far sidewalk (other side of road)
    buildStrip(-ROAD_HALF_WIDTH - swW, -ROAD_HALF_WIDTH, swMat);

    return street;
  }

  /**
   * Create a text label sprite.
   */
  _makeLabel(text) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 32px monospace';
    ctx.fillText(text, 10, 42);

    const texture = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: texture, transparent: true });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(8, 1, 1);
    return sprite;
  }

  _rebuild() {
    // Remove old scene content (except ground, lights)
    if (this._sceneGroup) {
      this._scene.remove(this._sceneGroup);
      this._sceneGroup.traverse(c => {
        if (c.geometry) c.geometry.dispose();
        if (c.material) {
          if (c.material.map) c.material.map.dispose();
          if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
          else c.material.dispose();
        }
      });
    }

    this._sceneGroup = new THREE.Group();

    // Estimate row length for street geometry
    // Average plot width * count gives approximate row length
    const avgPlotWidth = (victorianTerrace.perHouse.plotWidth[0] + victorianTerrace.perHouse.plotWidth[1]) / 2;
    const rowLength = avgPlotWidth * this._count;

    for (let p = 0; p < PRESETS.length; p++) {
      const preset = PRESETS[p];
      const zOffset = p * ROW_SPACING;

      const heightFn = (x, z) => x * preset.streetSlope + z * preset.crossSlope;

      // Generate houses
      const row = generateRow(victorianTerrace, this._count, this._seed, heightFn);
      row.position.z += zOffset;
      this._sceneGroup.add(row);

      // Build road/sidewalk
      const street = this._buildStreet(heightFn, rowLength, zOffset);
      this._sceneGroup.add(street);

      // Label
      const label = this._makeLabel(preset.label);
      label.position.set(-3, heightFn(0, 0) + 5, zOffset);
      this._sceneGroup.add(label);
    }

    // Center the whole scene
    const box = new THREE.Box3().setFromObject(this._sceneGroup);
    const cx = (box.min.x + box.max.x) / 2;
    const cz = (box.min.z + box.max.z) / 2;
    this._sceneGroup.position.x -= cx;
    this._sceneGroup.position.z -= cz;

    this._scene.add(this._sceneGroup);

    // Fit camera to see all rows
    const sceneWidth = box.max.x - box.min.x;
    const sceneDepth = box.max.z - box.min.z;
    this._orbit.dist = Math.max(sceneWidth, sceneDepth) * 1.2;
    this._orbitTarget.set(0, 5, 0);
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
    if (this._sceneGroup) {
      this._sceneGroup.traverse(c => {
        if (c.geometry) c.geometry.dispose();
        if (c.material) {
          if (c.material.map) c.material.map.dispose();
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

**Important:** This imports `HOUSE_Z`, `ROAD_HALF_WIDTH`, and `SIDEWALK_WIDTH` from archetypes.js. These are the layout constants exported in Task 1. Make sure they are exported.

**Step 2: Export layout constants from archetypes.js**

In `src/buildings/archetypes.js`, the layout constants (`ROAD_HALF_WIDTH`, `SIDEWALK_WIDTH`, `SETBACK`, `HOUSE_Z`) defined in Task 1 need to be exported. Change:

```js
const ROAD_HALF_WIDTH = 3;
const SIDEWALK_WIDTH = 1.5;
const SETBACK = 2;
const HOUSE_Z = ROAD_HALF_WIDTH + SIDEWALK_WIDTH + SETBACK;
```

to:

```js
export const ROAD_HALF_WIDTH = 3;
export const SIDEWALK_WIDTH = 1.5;
export const SETBACK = 2;
export const HOUSE_Z = ROAD_HALF_WIDTH + SIDEWALK_WIDTH + SETBACK;
```

**Step 3: Verify visually**

Run the dev server and navigate to `?mode=terraced`. You should see 6 rows of houses at different slopes with road/sidewalk strips. Orbit the camera to inspect:
- Flat row: houses at same Y, minimal foundation
- Uphill rows: houses step up along the row, foundations visible on downhill side
- Hillside up: houses raised above road level, tall foundations visible
- Hillside down: houses at road level, rear foundation walls visible
- Combined: both effects

**Step 4: Commit**

```bash
git add src/buildings/archetypes.js src/ui/TerracedRowScreen.js
git commit -m "feat: TerracedRowScreen shows 6 slope presets with road/sidewalk geometry

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 3: Run all tests and verify

**Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: ALL PASS — no regressions.

**Step 2: Fix any failures**

The main risk is existing `generateRow` tests that assumed houses at z=0. Check that the position assertions only check X (which they do — the existing tests check `position.x` and window positions, not `position.z`). The "flat heightFn produces same result as no heightFn" test covers Y-position compatibility.

If the "position-stable" test (`row4.children[0].position.x === row6.children[0].position.x`) fails, it's because the first house now has `position.x = 0` regardless (which was already true).

**Step 3: If all pass, commit any fixes**

```bash
git add -u
git commit -m "fix: test adjustments for heightFn-aware generateRow

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```
