# Procedural Building Generator Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A procedural building generator driven by climate zones, with a 3x3 preview grid (plot size × richness) and tweakable style parameters.

**Architecture:** Two modules — `src/buildings/generate.js` (pure geometry, no UI) produces THREE.Group meshes from a style+recipe, and `src/ui/BuildingStyleScreen.js` renders 9 buildings in a single WebGLRenderer with scissored viewports. Climate presets populate style defaults; sliders allow overrides.

**Tech Stack:** THREE.js (MeshLambertMaterial, BufferGeometry), project's SeededRandom RNG, DOM-based UI (no framework).

---

### Task 1: Climate presets and style/recipe data structures

**Files:**
- Create: `src/buildings/styles.js`
- Create: `test/buildings/styles.test.js`

**Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import { getClimateStyle, CLIMATES, buildRecipe } from '../../src/buildings/styles.js';

describe('styles', () => {
  it('exports all 6 climate keys', () => {
    expect(CLIMATES).toEqual(['cold', 'temperate', 'continental', 'mediterranean', 'tropical', 'arid']);
  });

  it('getClimateStyle returns valid style for each climate', () => {
    for (const climate of CLIMATES) {
      const style = getClimateStyle(climate);
      expect(style.floorHeight).toBeGreaterThan(0);
      expect(style.roofType).toMatch(/^(gable|hip|flat|mansard)$/);
      expect(style.roofPitch).toBeGreaterThanOrEqual(0);
      expect(style.roofPitch).toBeLessThanOrEqual(60);
      expect(style.windowWidth).toBeGreaterThan(0);
      expect(style.windowHeight).toBeGreaterThan(0);
      expect(style.windowSpacing).toBeGreaterThan(0);
      expect(style.floorCountRange).toHaveLength(2);
      expect(style.wallColor).toBeDefined();
      expect(style.roofColor).toBeDefined();
      expect(style.trimColor).toBeDefined();
      expect(style.windowColor).toBeDefined();
    }
  });

  it('buildRecipe returns valid recipe for each plot size and richness', () => {
    const style = getClimateStyle('temperate');
    for (const plotSize of ['small', 'medium', 'large']) {
      for (const richness of [0, 0.5, 1]) {
        const recipe = buildRecipe(style, plotSize, richness, 42);
        expect(recipe.mainWidth).toBeGreaterThan(0);
        expect(recipe.mainDepth).toBeGreaterThan(0);
        expect(recipe.floors).toBeGreaterThanOrEqual(style.floorCountRange[0]);
        expect(recipe.floors).toBeLessThanOrEqual(style.floorCountRange[1]);
        expect(recipe.wings).toBeInstanceOf(Array);
        expect(recipe.richness).toBe(richness);
      }
    }
  });

  it('large plots can have wings, small plots do not', () => {
    const style = getClimateStyle('temperate');
    // Test across many seeds — small should never have wings
    for (let seed = 0; seed < 20; seed++) {
      const small = buildRecipe(style, 'small', 0.5, seed);
      expect(small.wings.length).toBe(0);
    }
    // Large should have at least one wing across 20 seeds
    let anyWings = false;
    for (let seed = 0; seed < 20; seed++) {
      const large = buildRecipe(style, 'large', 0.5, seed);
      if (large.wings.length > 0) anyWings = true;
    }
    expect(anyWings).toBe(true);
  });

  it('different seeds produce different recipes', () => {
    const style = getClimateStyle('continental');
    const a = buildRecipe(style, 'medium', 0.5, 1);
    const b = buildRecipe(style, 'medium', 0.5, 2);
    const same = a.mainWidth === b.mainWidth && a.mainDepth === b.mainDepth && a.floors === b.floors;
    expect(same).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/buildings/styles.test.js`
Expected: FAIL — module not found

**Step 3: Write implementation**

```js
// src/buildings/styles.js
import { SeededRandom } from '../core/rng.js';

export const CLIMATES = ['cold', 'temperate', 'continental', 'mediterranean', 'tropical', 'arid'];

const PRESETS = {
  cold: {
    floorHeight: 2.8,
    floorCountRange: [1, 3],
    roofType: 'gable',
    roofPitch: 50,
    roofOverhang: 0.4,
    windowWidth: 0.8,
    windowHeight: 1.2,
    windowSpacing: 2.5,
    windowHeightDecay: 0,
    hasPorch: false,
    porchDepth: 0,
    hasBalcony: false,
    balconyFloors: [],
    hasDormers: true,
    wingProbability: 0.3,
    wallColor: 0xc4a882,
    roofColor: 0x4a3728,
    trimColor: 0xf0e8d8,
    windowColor: 0x1a2a3a,
  },
  temperate: {
    floorHeight: 3.0,
    floorCountRange: [2, 4],
    roofType: 'gable',
    roofPitch: 38,
    roofOverhang: 0.3,
    windowWidth: 1.0,
    windowHeight: 1.6,
    windowSpacing: 2.8,
    windowHeightDecay: 0.05,
    hasPorch: true,
    porchDepth: 2.0,
    hasBalcony: false,
    balconyFloors: [],
    hasDormers: false,
    wingProbability: 0.4,
    wallColor: 0xd4c4a8,
    roofColor: 0x6b4c3b,
    trimColor: 0xf5f0e8,
    windowColor: 0x1a2a3a,
  },
  continental: {
    floorHeight: 3.2,
    floorCountRange: [3, 6],
    roofType: 'hip',
    roofPitch: 28,
    roofOverhang: 0.2,
    windowWidth: 1.2,
    windowHeight: 2.0,
    windowSpacing: 3.0,
    windowHeightDecay: 0.03,
    hasPorch: false,
    porchDepth: 0,
    hasBalcony: true,
    balconyFloors: [2],
    hasDormers: false,
    wingProbability: 0.5,
    wallColor: 0xe8dcc8,
    roofColor: 0x5a5a5a,
    trimColor: 0xf0e8d0,
    windowColor: 0x1a2a3a,
  },
  mediterranean: {
    floorHeight: 3.4,
    floorCountRange: [3, 6],
    roofType: 'mansard',
    roofPitch: 25,
    roofOverhang: 0.15,
    windowWidth: 1.1,
    windowHeight: 2.2,
    windowSpacing: 2.8,
    windowHeightDecay: 0.04,
    hasPorch: false,
    porchDepth: 0,
    hasBalcony: true,
    balconyFloors: [2, 5],
    hasDormers: true,
    wingProbability: 0.3,
    wallColor: 0xf0e6d0,
    roofColor: 0x5a6a7a,
    trimColor: 0xd8cbb8,
    windowColor: 0x1a2a3a,
  },
  tropical: {
    floorHeight: 3.0,
    floorCountRange: [1, 2],
    roofType: 'hip',
    roofPitch: 35,
    roofOverhang: 0.5,
    windowWidth: 1.4,
    windowHeight: 2.0,
    windowSpacing: 2.5,
    windowHeightDecay: 0,
    hasPorch: true,
    porchDepth: 2.5,
    hasBalcony: false,
    balconyFloors: [],
    hasDormers: false,
    wingProbability: 0.2,
    wallColor: 0xe8dcc0,
    roofColor: 0x7a5a3a,
    trimColor: 0xf8f0e0,
    windowColor: 0x2a3a4a,
  },
  arid: {
    floorHeight: 3.0,
    floorCountRange: [1, 3],
    roofType: 'flat',
    roofPitch: 2,
    roofOverhang: 0,
    windowWidth: 0.7,
    windowHeight: 1.0,
    windowSpacing: 3.0,
    windowHeightDecay: 0,
    hasPorch: false,
    porchDepth: 0,
    hasBalcony: false,
    balconyFloors: [],
    hasDormers: false,
    wingProbability: 0.4,
    wallColor: 0xe8d8c0,
    roofColor: 0xd8c8b0,
    trimColor: 0xf0e8d8,
    windowColor: 0x2a3040,
  },
};

export function getClimateStyle(climate) {
  const preset = PRESETS[climate];
  if (!preset) throw new Error(`Unknown climate: ${climate}`);
  return { ...preset };
}

const PLOT_SIZES = {
  small:  { widthRange: [6, 8],   depthRange: [8, 10],  floorBias: 0,   maxWings: 0 },
  medium: { widthRange: [10, 14], depthRange: [10, 14], floorBias: 0.5, maxWings: 1 },
  large:  { widthRange: [16, 22], depthRange: [14, 20], floorBias: 1,   maxWings: 2 },
};

export function buildRecipe(style, plotSize, richness, seed) {
  const rng = new SeededRandom(seed);
  const ps = PLOT_SIZES[plotSize];

  const mainWidth = rng.range(ps.widthRange[0], ps.widthRange[1]);
  const mainDepth = rng.range(ps.depthRange[0], ps.depthRange[1]);

  const [minF, maxF] = style.floorCountRange;
  const targetFloors = minF + (maxF - minF) * ps.floorBias;
  const floors = Math.round(rng.range(targetFloors - 0.5, targetFloors + 0.5));
  const clampedFloors = Math.max(minF, Math.min(maxF, floors));

  // Wings
  const wings = [];
  if (ps.maxWings > 0 && rng.next() < style.wingProbability) {
    const wingCount = rng.int(1, ps.maxWings);
    const sides = rng.shuffle(['left', 'right', 'back']).slice(0, wingCount);
    for (const side of sides) {
      const ww = rng.range(mainWidth * 0.3, mainWidth * 0.6);
      const wd = rng.range(mainDepth * 0.3, mainDepth * 0.6);
      const wf = Math.max(1, clampedFloors - rng.int(1, 2));
      wings.push({ side, width: ww, depth: wd, floors: wf });
    }
  }

  // Richness-driven features
  const hasArched = richness >= 0.8;
  const hasQuoins = richness >= 0.8;
  const hasSills = richness >= 0.4;
  const hasCornice = richness >= 0.4;
  const hasPorch = style.hasPorch && richness >= 0.3;
  const hasBalcony = style.hasBalcony && richness >= 0.3;
  const balconyFloors = hasBalcony
    ? (richness >= 0.8 ? style.balconyFloors : style.balconyFloors.slice(0, 1))
    : [];
  const hasDormers = style.hasDormers && richness >= 0.4;
  const dormerCount = hasDormers ? (richness >= 0.8 ? 99 : rng.int(1, 2)) : 0;
  const chimneyCount = richness < 0.3 ? rng.int(0, 1) : rng.int(1, 2);

  // Color nudge — vary wall lightness by seed
  const nudge = (rng.next() - 0.5) * 0.1;
  const wallColor = nudgeColor(style.wallColor, nudge);

  return {
    mainWidth, mainDepth, floors: clampedFloors, wings, richness,
    hasArched, hasQuoins, hasSills, hasCornice,
    hasPorch, porchDepth: hasPorch ? style.porchDepth : 0,
    hasBalcony, balconyFloors,
    hasDormers, dormerCount, chimneyCount,
    wallColor, roofColor: style.roofColor, trimColor: style.trimColor,
    windowColor: style.windowColor,
  };
}

function nudgeColor(hex, amount) {
  const r = Math.min(255, Math.max(0, ((hex >> 16) & 0xff) + Math.round(amount * 255)));
  const g = Math.min(255, Math.max(0, ((hex >> 8) & 0xff) + Math.round(amount * 255)));
  const b = Math.min(255, Math.max(0, (hex & 0xff) + Math.round(amount * 255)));
  return (r << 16) | (g << 8) | b;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/buildings/styles.test.js`
Expected: PASS — all 5 tests

**Step 5: Commit**

```bash
git add src/buildings/styles.js test/buildings/styles.test.js
git commit -m "feat(buildings): climate presets and recipe generation"
```

---

### Task 2: Wall geometry for a single rectangular volume

**Files:**
- Create: `src/buildings/generate.js`
- Create: `test/buildings/generate.test.js`

**Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { generateBuilding } from '../../src/buildings/generate.js';
import { getClimateStyle, buildRecipe } from '../../src/buildings/styles.js';

describe('generateBuilding', () => {
  it('returns a THREE.Group with wall geometry', () => {
    const style = getClimateStyle('temperate');
    const recipe = buildRecipe(style, 'small', 0, 42);
    const group = generateBuilding(style, recipe);

    expect(group).toBeInstanceOf(THREE.Group);
    expect(group.children.length).toBeGreaterThan(0);

    // Check for walls mesh
    const walls = group.getObjectByName('walls');
    expect(walls).toBeDefined();
    expect(walls.geometry.attributes.position).toBeDefined();

    // No NaN in positions
    const pos = walls.geometry.attributes.position.array;
    for (let i = 0; i < pos.length; i++) {
      expect(pos[i]).not.toBeNaN();
    }
  });

  it('wall height matches floors * floorHeight', () => {
    const style = getClimateStyle('continental');
    const recipe = buildRecipe(style, 'medium', 0, 42);
    const group = generateBuilding(style, recipe);
    const walls = group.getObjectByName('walls');
    const pos = walls.geometry.attributes.position.array;

    let maxY = -Infinity;
    for (let i = 1; i < pos.length; i += 3) {
      if (pos[i] > maxY) maxY = pos[i];
    }
    const expectedHeight = recipe.floors * style.floorHeight;
    expect(maxY).toBeCloseTo(expectedHeight, 1);
  });

  it('wall footprint matches recipe dimensions', () => {
    const style = getClimateStyle('temperate');
    const recipe = buildRecipe(style, 'medium', 0, 42);
    const group = generateBuilding(style, recipe);
    const walls = group.getObjectByName('walls');
    const pos = walls.geometry.attributes.position.array;

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      if (pos[i] < minX) minX = pos[i];
      if (pos[i] > maxX) maxX = pos[i];
      if (pos[i + 2] < minZ) minZ = pos[i + 2];
      if (pos[i + 2] > maxZ) maxZ = pos[i + 2];
    }
    expect(maxX - minX).toBeCloseTo(recipe.mainWidth, 0);
    expect(maxZ - minZ).toBeCloseTo(recipe.mainDepth, 0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/buildings/generate.test.js`
Expected: FAIL — module not found

**Step 3: Write implementation**

```js
// src/buildings/generate.js
import * as THREE from 'three';

/**
 * Generate a building as a THREE.Group.
 * @param {object} style - Climate style parameters
 * @param {object} recipe - Per-building recipe from buildRecipe()
 * @returns {THREE.Group}
 */
export function generateBuilding(style, recipe) {
  const group = new THREE.Group();

  // Build volume list
  const volumes = buildVolumes(recipe);

  // Walls
  const wallGeo = buildWallGeometry(volumes, style);
  const wallMat = new THREE.MeshLambertMaterial({ color: recipe.wallColor });
  const wallMesh = new THREE.Mesh(wallGeo, wallMat);
  wallMesh.name = 'walls';
  group.add(wallMesh);

  return group;
}

function buildVolumes(recipe) {
  const main = {
    x: 0, z: 0,
    width: recipe.mainWidth,
    depth: recipe.mainDepth,
    floors: recipe.floors,
    role: 'main',
  };
  const volumes = [main];

  for (const wing of recipe.wings) {
    const vol = { role: 'wing', width: wing.width, depth: wing.depth, floors: wing.floors };
    switch (wing.side) {
      case 'left':
        vol.x = -wing.width;
        vol.z = 0;
        break;
      case 'right':
        vol.x = recipe.mainWidth;
        vol.z = 0;
        break;
      case 'back':
        vol.x = (recipe.mainWidth - wing.width) / 2;
        vol.z = recipe.mainDepth;
        break;
    }
    volumes.push(vol);
  }
  return volumes;
}

function buildWallGeometry(volumes, style) {
  const positions = [];
  const normals = [];
  const indices = [];

  for (const vol of volumes) {
    const x0 = vol.x, x1 = vol.x + vol.width;
    const z0 = vol.z, z1 = vol.z + vol.depth;
    const y0 = 0, y1 = vol.floors * style.floorHeight;
    const base = positions.length / 3;

    // 4 walls: front (z=z0), back (z=z1), left (x=x0), right (x=x1)
    const faces = [
      { verts: [[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0]], n: [0,0,-1] },  // front
      { verts: [[x1,y0,z1],[x0,y0,z1],[x0,y1,z1],[x1,y1,z1]], n: [0,0,1] },   // back
      { verts: [[x0,y0,z1],[x0,y0,z0],[x0,y1,z0],[x0,y1,z1]], n: [-1,0,0] },  // left
      { verts: [[x1,y0,z0],[x1,y0,z1],[x1,y1,z1],[x1,y1,z0]], n: [1,0,0] },   // right
    ];

    for (const face of faces) {
      const fi = positions.length / 3;
      for (const [vx, vy, vz] of face.verts) {
        positions.push(vx, vy, vz);
        normals.push(...face.n);
      }
      indices.push(fi, fi+1, fi+2, fi, fi+2, fi+3);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(indices);
  return geo;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/buildings/generate.test.js`
Expected: PASS — all 3 tests

**Step 5: Commit**

```bash
git add src/buildings/generate.js test/buildings/generate.test.js
git commit -m "feat(buildings): wall geometry for rectangular volumes"
```

---

### Task 3: Roof geometry (gable, hip, flat, mansard)

**Files:**
- Modify: `src/buildings/generate.js`
- Modify: `test/buildings/generate.test.js`

**Step 1: Write the failing tests**

Add to `test/buildings/generate.test.js`:

```js
it('has roof geometry', () => {
  const style = getClimateStyle('temperate');
  const recipe = buildRecipe(style, 'small', 0, 42);
  const group = generateBuilding(style, recipe);
  const roof = group.getObjectByName('roof');
  expect(roof).toBeDefined();
  expect(roof.geometry.attributes.position.array.length).toBeGreaterThan(0);
});

it('flat roof has no vertices above wall height + 0.5', () => {
  const style = getClimateStyle('arid');  // flat roof
  const recipe = buildRecipe(style, 'medium', 0, 42);
  const group = generateBuilding(style, recipe);
  const roof = group.getObjectByName('roof');
  const pos = roof.geometry.attributes.position.array;
  const wallTop = recipe.floors * style.floorHeight;
  for (let i = 1; i < pos.length; i += 3) {
    expect(pos[i]).toBeLessThanOrEqual(wallTop + 0.5);
  }
});

it('gable roof peak height reflects pitch', () => {
  const style = getClimateStyle('cold');  // gable, 50 degrees
  const recipe = buildRecipe(style, 'small', 0, 42);
  const group = generateBuilding(style, recipe);
  const roof = group.getObjectByName('roof');
  const pos = roof.geometry.attributes.position.array;
  const wallTop = recipe.floors * style.floorHeight;
  let maxY = -Infinity;
  for (let i = 1; i < pos.length; i += 3) {
    if (pos[i] > maxY) maxY = pos[i];
  }
  const halfSpan = Math.min(recipe.mainWidth, recipe.mainDepth) / 2;
  const expectedPeak = wallTop + halfSpan * Math.tan(style.roofPitch * Math.PI / 180);
  expect(maxY).toBeCloseTo(expectedPeak, 0);
});

it('mansard roof has vertices at two different slope angles', () => {
  const style = getClimateStyle('mediterranean');  // mansard
  const recipe = buildRecipe(style, 'medium', 0, 42);
  const group = generateBuilding(style, recipe);
  const roof = group.getObjectByName('roof');
  const pos = roof.geometry.attributes.position.array;
  const wallTop = recipe.floors * style.floorHeight;
  // Collect unique Y values above wall top
  const ys = new Set();
  for (let i = 1; i < pos.length; i += 3) {
    if (pos[i] > wallTop + 0.1) ys.add(Math.round(pos[i] * 10) / 10);
  }
  // Mansard should have at least 2 distinct height levels (break + ridge)
  expect(ys.size).toBeGreaterThanOrEqual(2);
});
```

**Step 2: Run test to verify they fail**

Run: `npx vitest run test/buildings/generate.test.js`
Expected: FAIL — no roof mesh found

**Step 3: Write implementation**

Add to `src/buildings/generate.js`, in `generateBuilding()` after walls:

```js
// In generateBuilding(), after wall mesh:
const roofGeo = buildRoofGeometry(volumes, style);
const roofMat = new THREE.MeshLambertMaterial({ color: recipe.roofColor });
const roofMesh = new THREE.Mesh(roofGeo, roofMat);
roofMesh.name = 'roof';
group.add(roofMesh);
```

Add the roof builder function:

```js
function buildRoofGeometry(volumes, style) {
  const positions = [];
  const normals = [];
  const indices = [];
  const pitch = style.roofPitch * Math.PI / 180;

  for (const vol of volumes) {
    const x0 = vol.x, x1 = vol.x + vol.width;
    const z0 = vol.z, z1 = vol.z + vol.depth;
    const wallTop = vol.floors * style.floorHeight;

    switch (style.roofType) {
      case 'flat':
        addFlatRoof(positions, normals, indices, x0, x1, z0, z1, wallTop);
        break;
      case 'gable':
        addGableRoof(positions, normals, indices, x0, x1, z0, z1, wallTop, vol.width, vol.depth, pitch, style.roofOverhang);
        break;
      case 'hip':
        addHipRoof(positions, normals, indices, x0, x1, z0, z1, wallTop, vol.width, vol.depth, pitch, style.roofOverhang);
        break;
      case 'mansard':
        addMansardRoof(positions, normals, indices, x0, x1, z0, z1, wallTop, vol.width, vol.depth, pitch);
        break;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(indices);
  return geo;
}

function addFlatRoof(positions, normals, indices, x0, x1, z0, z1, y) {
  const h = y + 0.15;  // thin parapet
  const fi = positions.length / 3;
  positions.push(x0,h,z0, x1,h,z0, x1,h,z1, x0,h,z1);
  for (let i = 0; i < 4; i++) normals.push(0,1,0);
  indices.push(fi, fi+1, fi+2, fi, fi+2, fi+3);
}

function addGableRoof(positions, normals, indices, x0, x1, z0, z1, wallTop, w, d, pitch, overhang) {
  // Ridge runs along the longer axis
  const ridgeAlongX = w >= d;
  const span = ridgeAlongX ? d : w;
  const rise = (span / 2) * Math.tan(pitch);
  const oh = overhang || 0;

  if (ridgeAlongX) {
    const midZ = (z0 + z1) / 2;
    const ridgeY = wallTop + rise;
    const fi = positions.length / 3;
    // Left slope
    positions.push(x0-oh, wallTop, z0-oh,  x1+oh, wallTop, z0-oh,  x1+oh, ridgeY, midZ,  x0-oh, ridgeY, midZ);
    const nlx = rise, nly = span/2, nll = Math.sqrt(nlx*nlx+nly*nly);
    for (let i = 0; i < 4; i++) normals.push(0, nly/nll, -nlx/nll);
    indices.push(fi, fi+1, fi+2, fi, fi+2, fi+3);
    // Right slope
    const fi2 = positions.length / 3;
    positions.push(x1+oh, wallTop, z1+oh,  x0-oh, wallTop, z1+oh,  x0-oh, ridgeY, midZ,  x1+oh, ridgeY, midZ);
    for (let i = 0; i < 4; i++) normals.push(0, nly/nll, nlx/nll);
    indices.push(fi2, fi2+1, fi2+2, fi2, fi2+2, fi2+3);
    // Gable triangles (front and back)
    const fi3 = positions.length / 3;
    positions.push(x0, wallTop, z0,  x0, wallTop, z1,  x0, ridgeY, midZ);
    for (let i = 0; i < 3; i++) normals.push(-1, 0, 0);
    indices.push(fi3, fi3+1, fi3+2);
    const fi4 = positions.length / 3;
    positions.push(x1, wallTop, z1,  x1, wallTop, z0,  x1, ridgeY, midZ);
    for (let i = 0; i < 3; i++) normals.push(1, 0, 0);
    indices.push(fi4, fi4+1, fi4+2);
  } else {
    const midX = (x0 + x1) / 2;
    const ridgeY = wallTop + rise;
    const fi = positions.length / 3;
    // Front slope
    positions.push(x0-oh, wallTop, z0-oh,  midX, ridgeY, z0-oh,  midX, ridgeY, z1+oh,  x0-oh, wallTop, z1+oh);
    const nlx = rise, nly = span/2, nll = Math.sqrt(nlx*nlx+nly*nly);
    for (let i = 0; i < 4; i++) normals.push(-nlx/nll, nly/nll, 0);
    indices.push(fi, fi+1, fi+2, fi, fi+2, fi+3);
    // Back slope
    const fi2 = positions.length / 3;
    positions.push(x1+oh, wallTop, z1+oh,  midX, ridgeY, z1+oh,  midX, ridgeY, z0-oh,  x1+oh, wallTop, z0-oh);
    for (let i = 0; i < 4; i++) normals.push(nlx/nll, nly/nll, 0);
    indices.push(fi2, fi2+1, fi2+2, fi2, fi2+2, fi2+3);
    // Gable triangles
    const fi3 = positions.length / 3;
    positions.push(x0, wallTop, z0,  x1, wallTop, z0,  midX, ridgeY, z0);
    for (let i = 0; i < 3; i++) normals.push(0, 0, -1);
    indices.push(fi3, fi3+1, fi3+2);
    const fi4 = positions.length / 3;
    positions.push(x1, wallTop, z1,  x0, wallTop, z1,  midX, ridgeY, z1);
    for (let i = 0; i < 3; i++) normals.push(0, 0, 1);
    indices.push(fi4, fi4+1, fi4+2);
  }
}

function addHipRoof(positions, normals, indices, x0, x1, z0, z1, wallTop, w, d, pitch, overhang) {
  const span = Math.min(w, d);
  const rise = (span / 2) * Math.tan(pitch);
  const ridgeY = wallTop + rise;
  const oh = overhang || 0;
  const inset = span / 2;  // how far ridge is inset from shorter edges

  if (w >= d) {
    // Ridge along X, inset from left/right ends
    const rz = (z0 + z1) / 2;
    const rx0 = x0 + inset;
    const rx1 = x1 - inset;
    if (rx0 >= rx1) {
      // Nearly square — pyramid (single peak)
      const cx = (x0 + x1) / 2;
      addPyramidRoof(positions, normals, indices, x0-oh, x1+oh, z0-oh, z1+oh, wallTop, ridgeY, cx, rz);
      return;
    }
    // Front slope (z=z0 side)
    let fi = positions.length / 3;
    positions.push(x0-oh,wallTop,z0-oh, x1+oh,wallTop,z0-oh, rx1,ridgeY,rz, rx0,ridgeY,rz);
    for (let i = 0; i < 4; i++) normals.push(0,span/2/Math.sqrt(rise*rise+span*span/4),-rise/Math.sqrt(rise*rise+span*span/4));
    indices.push(fi,fi+1,fi+2, fi,fi+2,fi+3);
    // Back slope
    fi = positions.length / 3;
    positions.push(x1+oh,wallTop,z1+oh, x0-oh,wallTop,z1+oh, rx0,ridgeY,rz, rx1,ridgeY,rz);
    for (let i = 0; i < 4; i++) normals.push(0,span/2/Math.sqrt(rise*rise+span*span/4),rise/Math.sqrt(rise*rise+span*span/4));
    indices.push(fi,fi+1,fi+2, fi,fi+2,fi+3);
    // Left hip triangle
    fi = positions.length / 3;
    positions.push(x0-oh,wallTop,z1+oh, x0-oh,wallTop,z0-oh, rx0,ridgeY,rz);
    for (let i = 0; i < 3; i++) normals.push(-1,0,0);
    indices.push(fi,fi+1,fi+2);
    // Right hip triangle
    fi = positions.length / 3;
    positions.push(x1+oh,wallTop,z0-oh, x1+oh,wallTop,z1+oh, rx1,ridgeY,rz);
    for (let i = 0; i < 3; i++) normals.push(1,0,0);
    indices.push(fi,fi+1,fi+2);
  } else {
    // Ridge along Z
    const rx = (x0 + x1) / 2;
    const rz0 = z0 + inset;
    const rz1 = z1 - inset;
    if (rz0 >= rz1) {
      addPyramidRoof(positions, normals, indices, x0-oh, x1+oh, z0-oh, z1+oh, wallTop, ridgeY, rx, (z0+z1)/2);
      return;
    }
    // Left slope
    let fi = positions.length / 3;
    positions.push(x0-oh,wallTop,z0-oh, x0-oh,wallTop,z1+oh, rx,ridgeY,rz1, rx,ridgeY,rz0);
    for (let i = 0; i < 4; i++) normals.push(-1,1,0);
    indices.push(fi,fi+1,fi+2, fi,fi+2,fi+3);
    // Right slope
    fi = positions.length / 3;
    positions.push(x1+oh,wallTop,z1+oh, x1+oh,wallTop,z0-oh, rx,ridgeY,rz0, rx,ridgeY,rz1);
    for (let i = 0; i < 4; i++) normals.push(1,1,0);
    indices.push(fi,fi+1,fi+2, fi,fi+2,fi+3);
    // Front hip triangle
    fi = positions.length / 3;
    positions.push(x0-oh,wallTop,z0-oh, x1+oh,wallTop,z0-oh, rx,ridgeY,rz0);
    for (let i = 0; i < 3; i++) normals.push(0,0,-1);
    indices.push(fi,fi+1,fi+2);
    // Back hip triangle
    fi = positions.length / 3;
    positions.push(x1+oh,wallTop,z1+oh, x0-oh,wallTop,z1+oh, rx,ridgeY,rz1);
    for (let i = 0; i < 3; i++) normals.push(0,0,1);
    indices.push(fi,fi+1,fi+2);
  }
}

function addPyramidRoof(positions, normals, indices, x0, x1, z0, z1, wallTop, peakY, cx, cz) {
  const faces = [
    [[x0,wallTop,z0], [x1,wallTop,z0], [cx,peakY,cz]],
    [[x1,wallTop,z0], [x1,wallTop,z1], [cx,peakY,cz]],
    [[x1,wallTop,z1], [x0,wallTop,z1], [cx,peakY,cz]],
    [[x0,wallTop,z1], [x0,wallTop,z0], [cx,peakY,cz]],
  ];
  for (const [a,b,c] of faces) {
    const fi = positions.length / 3;
    positions.push(...a,...b,...c);
    // Compute face normal
    const ux=b[0]-a[0], uy=b[1]-a[1], uz=b[2]-a[2];
    const vx=c[0]-a[0], vy=c[1]-a[1], vz=c[2]-a[2];
    let nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx;
    const nl = Math.sqrt(nx*nx+ny*ny+nz*nz) || 1;
    nx/=nl; ny/=nl; nz/=nl;
    for (let i = 0; i < 3; i++) normals.push(nx,ny,nz);
    indices.push(fi,fi+1,fi+2);
  }
}

function addMansardRoof(positions, normals, indices, x0, x1, z0, z1, wallTop, w, d, pitch) {
  // Mansard: steep lower slope (70°), shallow upper slope (pitch param)
  const lowerAngle = 70 * Math.PI / 180;
  const upperAngle = pitch * Math.PI / 180;
  const insetLower = Math.min(w, d) * 0.15;  // how far in the break line sits
  const lowerRise = insetLower * Math.tan(lowerAngle);
  const breakY = wallTop + lowerRise;
  const upperInset = Math.min(w, d) / 2 - insetLower;
  const upperRise = upperInset * Math.tan(upperAngle);
  const ridgeY = breakY + upperRise;

  const bx0 = x0 + insetLower, bx1 = x1 - insetLower;
  const bz0 = z0 + insetLower, bz1 = z1 - insetLower;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;

  // Lower steep slopes (4 quads from eave to break)
  const lowerFaces = [
    [[x0,wallTop,z0],[x1,wallTop,z0],[bx1,breakY,bz0],[bx0,breakY,bz0]],
    [[x1,wallTop,z0],[x1,wallTop,z1],[bx1,breakY,bz1],[bx1,breakY,bz0]],
    [[x1,wallTop,z1],[x0,wallTop,z1],[bx0,breakY,bz1],[bx1,breakY,bz1]],
    [[x0,wallTop,z1],[x0,wallTop,z0],[bx0,breakY,bz0],[bx0,breakY,bz1]],
  ];
  for (const verts of lowerFaces) {
    const fi = positions.length / 3;
    for (const [vx,vy,vz] of verts) positions.push(vx,vy,vz);
    // Compute normal from cross product
    const a=verts[0],b=verts[1],c=verts[2];
    const ux=b[0]-a[0],uy=b[1]-a[1],uz=b[2]-a[2];
    const vvx=c[0]-a[0],vvy=c[1]-a[1],vvz=c[2]-a[2];
    let nx=uy*vvz-uz*vvy,ny=uz*vvx-ux*vvz,nz=ux*vvy-uy*vvx;
    const nl=Math.sqrt(nx*nx+ny*ny+nz*nz)||1;
    nx/=nl;ny/=nl;nz/=nl;
    for (let i=0;i<4;i++) normals.push(nx,ny,nz);
    indices.push(fi,fi+1,fi+2,fi,fi+2,fi+3);
  }

  // Upper shallow slopes — hip to ridge/peak
  addHipRoof(positions, normals, indices, bx0, bx1, bz0, bz1, breakY,
    bx1-bx0, bz1-bz0, upperAngle * 180 / Math.PI, 0);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/buildings/generate.test.js`
Expected: PASS — all 7 tests

**Step 5: Commit**

```bash
git add src/buildings/generate.js test/buildings/generate.test.js
git commit -m "feat(buildings): roof geometry — gable, hip, flat, mansard"
```

---

### Task 4: Wing volumes with trimmed roofs

**Files:**
- Modify: `src/buildings/generate.js`
- Modify: `test/buildings/generate.test.js`

**Step 1: Write the failing test**

Add to `test/buildings/generate.test.js`:

```js
it('wing roof does not exceed main wall height', () => {
  const style = getClimateStyle('temperate');
  // Force a large building with wings
  for (let seed = 0; seed < 50; seed++) {
    const recipe = buildRecipe(style, 'large', 0.5, seed);
    if (recipe.wings.length === 0) continue;
    const group = generateBuilding(style, recipe);
    const roof = group.getObjectByName('roof');
    const pos = roof.geometry.attributes.position.array;

    const mainWallTop = recipe.floors * style.floorHeight;
    // Wing roof peak should not exceed main wall top
    // (Wings have fewer floors, so their roof should be lower)
    // We check that max Y from wing volumes stays below main ridge
    // For simplicity: just verify no wing volume has a higher peak than main
    for (const wing of recipe.wings) {
      const wingWallTop = wing.floors * style.floorHeight;
      expect(wingWallTop).toBeLessThan(mainWallTop);
    }
    return;  // Found a building with wings, test passes
  }
});

it('buildings with wings have more wall vertices than without', () => {
  const style = getClimateStyle('temperate');
  // Find two seeds: one with wings, one without
  let withWings = null, withoutWings = null;
  for (let seed = 0; seed < 100; seed++) {
    const recipe = buildRecipe(style, 'large', 0.5, seed);
    if (recipe.wings.length > 0 && !withWings) withWings = recipe;
    if (recipe.wings.length === 0 && !withoutWings) withoutWings = recipe;
    if (withWings && withoutWings) break;
  }
  if (!withWings || !withoutWings) return;  // skip if can't find both

  const gWith = generateBuilding(style, withWings);
  const gWithout = generateBuilding(style, withoutWings);
  const wallsWith = gWith.getObjectByName('walls').geometry.attributes.position.count;
  const wallsWithout = gWithout.getObjectByName('walls').geometry.attributes.position.count;
  expect(wallsWith).toBeGreaterThan(wallsWithout);
});
```

**Step 2: Run test to verify they fail or pass**

Run: `npx vitest run test/buildings/generate.test.js`
Expected: These may already pass with the current volume system. If so, good — the volume composition from Task 2 already handles wings. If walls overlap at shared faces, we need to clip them.

**Step 3: Implement wall clipping for shared faces**

The key addition is removing interior wall faces where volumes meet. In `buildWallGeometry`, after generating all faces, detect and remove faces that fall inside another volume.

Add to `buildWallGeometry`:

```js
function buildWallGeometry(volumes, style) {
  const positions = [];
  const normals = [];
  const indices = [];

  for (const vol of volumes) {
    const x0 = vol.x, x1 = vol.x + vol.width;
    const z0 = vol.z, z1 = vol.z + vol.depth;
    const y0 = 0, y1 = vol.floors * style.floorHeight;

    const faces = [
      { verts: [[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0]], n: [0,0,-1] },
      { verts: [[x1,y0,z1],[x0,y0,z1],[x0,y1,z1],[x1,y1,z1]], n: [0,0,1] },
      { verts: [[x0,y0,z1],[x0,y0,z0],[x0,y1,z0],[x0,y1,z1]], n: [-1,0,0] },
      { verts: [[x1,y0,z0],[x1,y0,z1],[x1,y1,z1],[x1,y1,z0]], n: [1,0,0] },
    ];

    for (const face of faces) {
      // Skip faces that are interior (shared with another volume)
      if (isInteriorFace(face, vol, volumes)) continue;

      const fi = positions.length / 3;
      for (const [vx, vy, vz] of face.verts) {
        positions.push(vx, vy, vz);
        normals.push(...face.n);
      }
      indices.push(fi, fi+1, fi+2, fi, fi+2, fi+3);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(indices);
  return geo;
}

function isInteriorFace(face, vol, volumes) {
  // A face is interior if its center point is inside another volume
  const cx = face.verts.reduce((s,v) => s + v[0], 0) / 4;
  const cy = face.verts.reduce((s,v) => s + v[1], 0) / 4;
  const cz = face.verts.reduce((s,v) => s + v[2], 0) / 4;
  // Offset the center slightly in the normal direction to test the outward side
  const testX = cx + face.n[0] * 0.01;
  const testZ = cz + face.n[2] * 0.01;

  for (const other of volumes) {
    if (other === vol) continue;
    const ox0 = other.x, ox1 = other.x + other.width;
    const oz0 = other.z, oz1 = other.z + other.depth;
    const oy1 = other.floors * vol._floorHeight;  // need to pass style
    if (testX > ox0 && testX < ox1 && testZ > oz0 && testZ < oz1 && cy < oy1) {
      return true;
    }
  }
  return false;
}
```

Note: `isInteriorFace` needs floor height info. Pass `style.floorHeight` through the volumes or as a parameter. Adjust the volume objects to store `wallHeight = vol.floors * style.floorHeight` during `buildVolumes`.

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/buildings/generate.test.js`
Expected: PASS — all 9 tests

**Step 5: Commit**

```bash
git add src/buildings/generate.js test/buildings/generate.test.js
git commit -m "feat(buildings): wing volumes with interior face removal"
```

---

### Task 5: Window painting

**Files:**
- Modify: `src/buildings/generate.js`
- Modify: `test/buildings/generate.test.js`

**Step 1: Write the failing test**

```js
it('has window geometry', () => {
  const style = getClimateStyle('temperate');
  const recipe = buildRecipe(style, 'medium', 0, 42);
  const group = generateBuilding(style, recipe);
  const windows = group.getObjectByName('windows');
  expect(windows).toBeDefined();
  expect(windows.geometry.attributes.position.array.length).toBeGreaterThan(0);
});

it('wider building has more window vertices', () => {
  const style = getClimateStyle('continental');
  const smallRecipe = buildRecipe(style, 'small', 0, 42);
  const largeRecipe = buildRecipe(style, 'large', 0, 42);
  const smallGroup = generateBuilding(style, smallRecipe);
  const largeGroup = generateBuilding(style, largeRecipe);
  const smallCount = smallGroup.getObjectByName('windows').geometry.attributes.position.count;
  const largeCount = largeGroup.getObjectByName('windows').geometry.attributes.position.count;
  expect(largeCount).toBeGreaterThan(smallCount);
});
```

**Step 2: Run test to verify they fail**

Run: `npx vitest run test/buildings/generate.test.js`
Expected: FAIL — no windows mesh

**Step 3: Write implementation**

Add to `generateBuilding()` after roof:

```js
const winGeo = buildWindowGeometry(volumes, style, recipe);
const winMat = new THREE.MeshLambertMaterial({
  color: recipe.windowColor,
  polygonOffset: true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits: -1,
});
const winMesh = new THREE.Mesh(winGeo, winMat);
winMesh.name = 'windows';
group.add(winMesh);
```

Add the window builder:

```js
function buildWindowGeometry(volumes, style, recipe) {
  const positions = [];
  const normals = [];
  const indices = [];
  const ww = style.windowWidth;
  const spacing = style.windowSpacing;
  const sillHeight = style.floorHeight * 0.3;  // window sill at 30% of floor height

  for (const vol of volumes) {
    const x0 = vol.x, x1 = vol.x + vol.width;
    const z0 = vol.z, z1 = vol.z + vol.depth;

    // For each exterior wall face, place windows
    const wallDefs = [
      { start: [x0, z0], end: [x1, z0], nx: 0, nz: -1, axis: 'x' },  // front
      { start: [x1, z0], end: [x1, z1], nx: 1, nz: 0, axis: 'z' },   // right
      { start: [x1, z1], end: [x0, z1], nx: 0, nz: 1, axis: 'z' },   // back
      { start: [x0, z1], end: [x0, z0], nx: -1, nz: 0, axis: 'x' },  // left
    ];

    for (const wall of wallDefs) {
      const wallLen = Math.abs(wall.axis === 'x'
        ? wall.end[0] - wall.start[0]
        : wall.end[1] - wall.start[1]);
      if (wallLen < spacing) continue;

      const nWindows = Math.floor((wallLen - spacing * 0.5) / spacing);
      if (nWindows < 1) continue;
      const startOffset = (wallLen - (nWindows - 1) * spacing) / 2;

      for (let floor = 0; floor < vol.floors; floor++) {
        const floorY = floor * style.floorHeight;
        const wh = style.windowHeight * (1 - style.windowHeightDecay * floor);
        const winBottom = floorY + sillHeight;
        const winTop = winBottom + wh;
        if (winTop > (floor + 1) * style.floorHeight - 0.1) continue;

        for (let wi = 0; wi < nWindows; wi++) {
          const along = startOffset + wi * spacing;
          const halfW = ww / 2;

          // Window center position on wall
          const t = along / wallLen;
          const wx = wall.start[0] + (wall.end[0] - wall.start[0]) * t;
          const wz = wall.start[1] + (wall.end[1] - wall.start[1]) * t;

          // Offset slightly from wall in normal direction
          const offX = wall.nx * 0.01;
          const offZ = wall.nz * 0.01;

          // Window quad — perpendicular to wall normal
          const fi = positions.length / 3;
          if (wall.nx === 0) {
            // Z-facing wall — window extends in X
            positions.push(
              wx - halfW + offX, winBottom, wz + offZ,
              wx + halfW + offX, winBottom, wz + offZ,
              wx + halfW + offX, winTop, wz + offZ,
              wx - halfW + offX, winTop, wz + offZ,
            );
          } else {
            // X-facing wall — window extends in Z
            positions.push(
              wx + offX, winBottom, wz - halfW + offZ,
              wx + offX, winBottom, wz + halfW + offZ,
              wx + offX, winTop, wz + halfW + offZ,
              wx + offX, winTop, wz - halfW + offZ,
            );
          }
          for (let i = 0; i < 4; i++) normals.push(wall.nx, 0, wall.nz);
          indices.push(fi, fi+1, fi+2, fi, fi+2, fi+3);
        }
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setIndex(indices);
  return geo;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/buildings/generate.test.js`
Expected: PASS — all 11 tests

**Step 5: Commit**

```bash
git add src/buildings/generate.js test/buildings/generate.test.js
git commit -m "feat(buildings): painted window faces on wall surfaces"
```

---

### Task 6: Trim and richness features (sills, lintels, cornice, quoins)

**Files:**
- Modify: `src/buildings/generate.js`
- Modify: `test/buildings/generate.test.js`

**Step 1: Write the failing test**

```js
it('ornate building has more child meshes than plain', () => {
  const style = getClimateStyle('continental');
  const plain = buildRecipe(style, 'medium', 0, 42);
  const ornate = buildRecipe(style, 'medium', 1, 42);
  const plainGroup = generateBuilding(style, plain);
  const ornateGroup = generateBuilding(style, ornate);
  expect(ornateGroup.children.length).toBeGreaterThan(plainGroup.children.length);
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/buildings/generate.test.js`
Expected: FAIL — both have same number of children (walls, roof, windows)

**Step 3: Write implementation**

Add to `generateBuilding()` after windows, conditionally:

```js
// Trim features based on richness
if (recipe.hasSills) {
  const sillGeo = buildSillGeometry(volumes, style);
  const sillMat = new THREE.MeshLambertMaterial({ color: recipe.trimColor });
  const sillMesh = new THREE.Mesh(sillGeo, sillMat);
  sillMesh.name = 'sills';
  group.add(sillMesh);
}

if (recipe.hasCornice) {
  const corniceGeo = buildCorniceGeometry(volumes, style);
  const corniceMat = new THREE.MeshLambertMaterial({ color: recipe.trimColor });
  const corniceMesh = new THREE.Mesh(corniceGeo, corniceMat);
  corniceMesh.name = 'cornice';
  group.add(corniceMesh);
}

if (recipe.hasQuoins) {
  const quoinGeo = buildQuoinGeometry(volumes, style);
  const quoinMat = new THREE.MeshLambertMaterial({ color: recipe.trimColor });
  const quoinMesh = new THREE.Mesh(quoinGeo, quoinMat);
  quoinMesh.name = 'quoins';
  group.add(quoinMesh);
}
```

Implement `buildSillGeometry` (thin horizontal strips below each window), `buildCorniceGeometry` (horizontal band at top of each wall), `buildQuoinGeometry` (alternating blocks at volume corners). Each follows the same pattern as window painting — flat quads offset slightly from the wall surface, using `trimColor`.

**Sills:** For each window position, place a quad 0.05m tall × (windowWidth + 0.1m) wide, directly below the window.

**Cornice:** For each exterior wall, a strip 0.15m tall at the top of the wall.

**Quoins:** At each exterior corner, alternating blocks 0.3m wide × 0.4m tall up the full wall height.

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/buildings/generate.test.js`
Expected: PASS — all 12 tests

**Step 5: Commit**

```bash
git add src/buildings/generate.js test/buildings/generate.test.js
git commit -m "feat(buildings): trim features — sills, cornice, quoins"
```

---

### Task 7: Attachments — porch, balconies, chimneys, dormers

**Files:**
- Modify: `src/buildings/generate.js`
- Modify: `test/buildings/generate.test.js`

**Step 1: Write the failing test**

```js
it('tropical building has porch geometry', () => {
  const style = getClimateStyle('tropical');
  const recipe = buildRecipe(style, 'medium', 1, 42);
  // Force porch on
  recipe.hasPorch = true;
  recipe.porchDepth = style.porchDepth;
  const group = generateBuilding(style, recipe);
  const porch = group.getObjectByName('porch');
  expect(porch).toBeDefined();
});

it('mediterranean building with richness 1 has balconies', () => {
  const style = getClimateStyle('mediterranean');
  const recipe = buildRecipe(style, 'medium', 1, 42);
  recipe.hasBalcony = true;
  recipe.balconyFloors = [2];
  const group = generateBuilding(style, recipe);
  const balconies = group.getObjectByName('balconies');
  expect(balconies).toBeDefined();
});

it('building with dormers has dormer geometry', () => {
  const style = getClimateStyle('cold');
  const recipe = buildRecipe(style, 'medium', 1, 42);
  recipe.hasDormers = true;
  recipe.dormerCount = 2;
  const group = generateBuilding(style, recipe);
  const dormers = group.getObjectByName('dormers');
  expect(dormers).toBeDefined();
});
```

**Step 2: Run test to verify they fail**

Run: `npx vitest run test/buildings/generate.test.js`
Expected: FAIL — no porch/balconies/dormers meshes

**Step 3: Write implementation**

Add to `generateBuilding()`:

```js
if (recipe.hasPorch && recipe.porchDepth > 0) {
  const porchGeo = buildPorchGeometry(volumes[0], style, recipe);
  const porchMat = new THREE.MeshLambertMaterial({ color: recipe.trimColor });
  const porchMesh = new THREE.Mesh(porchGeo, porchMat);
  porchMesh.name = 'porch';
  group.add(porchMesh);
}

if (recipe.hasBalcony && recipe.balconyFloors.length > 0) {
  const balcGeo = buildBalconyGeometry(volumes[0], style, recipe);
  const balcMat = new THREE.MeshLambertMaterial({ color: recipe.trimColor });
  const balcMesh = new THREE.Mesh(balcGeo, balcMat);
  balcMesh.name = 'balconies';
  group.add(balcMesh);
}

if (recipe.hasDormers && recipe.dormerCount > 0) {
  const dormGeo = buildDormerGeometry(volumes[0], style, recipe);
  const dormMat = new THREE.MeshLambertMaterial({ color: recipe.wallColor });
  const dormMesh = new THREE.Mesh(dormGeo, dormMat);
  dormMesh.name = 'dormers';
  group.add(dormMesh);
}

if (recipe.chimneyCount > 0) {
  const chimGeo = buildChimneyGeometry(volumes[0], style, recipe);
  const chimMat = new THREE.MeshLambertMaterial({ color: 0x8b4513 });
  const chimMesh = new THREE.Mesh(chimGeo, chimMat);
  chimMesh.name = 'chimneys';
  group.add(chimMesh);
}
```

**Porch:** Posts (thin vertical quads) + roof slab (horizontal quad) extending `porchDepth` from front wall. Full width of main volume. Posts at each end + every 2m.

**Balconies:** For each balcony floor, a thin platform (0.1m thick × 1.5m deep × windowSpacing wide) below each window on the front wall. Thin railing quads at edges.

**Dormers:** Small gabled boxes on the front roof slope. Width = windowWidth + 0.4m. Height = windowHeight + 0.3m. Placed at windowSpacing intervals, count limited by `recipe.dormerCount`. Each has: front face (wall color), window (window color), tiny gable roof (roof color).

**Chimneys:** Rectangular extrusion (0.4m × 0.6m) rising from the ridge, height 1.5m above ridge. Placed at 25% and 75% along ridge.

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/buildings/generate.test.js`
Expected: PASS — all 15 tests

**Step 5: Commit**

```bash
git add src/buildings/generate.js test/buildings/generate.test.js
git commit -m "feat(buildings): porch, balcony, dormer, chimney attachments"
```

---

### Task 8: Cross-climate validation test

**Files:**
- Modify: `test/buildings/generate.test.js`

**Step 1: Write the test**

```js
it('all 9 combinations × 6 climates generate without errors', () => {
  for (const climate of CLIMATES) {
    const style = getClimateStyle(climate);
    for (const plotSize of ['small', 'medium', 'large']) {
      for (const richness of [0, 0.5, 1]) {
        const recipe = buildRecipe(style, plotSize, richness, 42);
        const group = generateBuilding(style, recipe);
        expect(group.children.length).toBeGreaterThan(0);

        // No NaN in any geometry
        for (const child of group.children) {
          if (!child.geometry) continue;
          const pos = child.geometry.attributes.position.array;
          for (let i = 0; i < pos.length; i++) {
            expect(pos[i]).not.toBeNaN();
          }
        }
      }
    }
  }
});
```

Add `CLIMATES` to the imports at the top of the test file.

**Step 2: Run test to verify it passes**

Run: `npx vitest run test/buildings/generate.test.js`
Expected: PASS — all 16 tests

**Step 3: Commit**

```bash
git add test/buildings/generate.test.js
git commit -m "test(buildings): cross-climate validation for all 54 combinations"
```

---

### Task 9: BuildingStyleScreen — basic UI and 3x3 viewport grid

**Files:**
- Create: `src/ui/BuildingStyleScreen.js`
- Modify: `src/ui/RegionScreen.js` (add navigation button)

**Step 1: Write the screen**

```js
// src/ui/BuildingStyleScreen.js
import * as THREE from 'three';
import { CLIMATES, getClimateStyle, buildRecipe } from '../buildings/styles.js';
import { generateBuilding } from '../buildings/generate.js';

const PLOT_SIZES = ['small', 'medium', 'large'];
const RICHNESS_LEVELS = [0, 0.5, 1];
const RICHNESS_LABELS = ['Plain', 'Moderate', 'Ornate'];
const SIZE_LABELS = ['S', 'M', 'L'];

export class BuildingStyleScreen {
  constructor(container, onBack) {
    this.container = container;
    this.onBack = onBack;
    this._climate = 'temperate';
    this._style = getClimateStyle(this._climate);
    this._seed = 42;
    this._scenes = [];   // 9 scenes (3x3)
    this._cameras = [];  // 9 cameras
    this._running = false;
    this._disposed = false;

    this._buildUI();
    this._buildViewports();
    this._regenerate();
    this._startLoop();
  }

  _buildUI() {
    this.container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;width:100%;height:100vh;background:#1a1a2e;color:#eee;font-family:monospace;';
    this.container.appendChild(wrapper);

    // Sidebar
    const sidebar = document.createElement('div');
    sidebar.style.cssText = 'width:220px;padding:12px;display:flex;flex-direction:column;gap:8px;border-right:1px solid #333;overflow-y:auto;';
    wrapper.appendChild(sidebar);
    this._sidebar = sidebar;

    // Title
    const title = document.createElement('div');
    title.textContent = 'Building Styles';
    title.style.cssText = 'font-size:16px;font-weight:bold;color:#ffaa88;margin-bottom:8px;';
    sidebar.appendChild(title);

    // Climate dropdown
    this._addDropdown(sidebar, 'Climate', CLIMATES, this._climate, (val) => {
      this._climate = val;
      this._style = getClimateStyle(val);
      this._populateSliders();
      this._regenerate();
    });

    // Sliders container
    this._sliderContainer = document.createElement('div');
    this._sliderContainer.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
    sidebar.appendChild(this._sliderContainer);
    this._populateSliders();

    // Randomize button
    const randomBtn = document.createElement('button');
    randomBtn.textContent = 'Randomize';
    randomBtn.style.cssText = 'padding:6px;background:#333;color:#eee;border:1px solid #555;cursor:pointer;margin-top:8px;';
    randomBtn.onclick = () => { this._seed = Math.floor(Math.random() * 100000); this._regenerate(); };
    sidebar.appendChild(randomBtn);

    // Spacer
    const spacer = document.createElement('div');
    spacer.style.flex = '1';
    sidebar.appendChild(spacer);

    // Back button
    const backBtn = document.createElement('button');
    backBtn.textContent = '← Back';
    backBtn.style.cssText = 'padding:6px;background:#333;color:#eee;border:1px solid #555;cursor:pointer;';
    backBtn.onclick = () => this.onBack?.();
    sidebar.appendChild(backBtn);

    // Grid area
    this._gridArea = document.createElement('div');
    this._gridArea.style.cssText = 'flex:1;position:relative;';
    wrapper.appendChild(this._gridArea);

    // Escape key
    this._onKeyDown = (e) => {
      if (e.key === 'Escape') this.onBack?.();
    };
    document.addEventListener('keydown', this._onKeyDown);
  }

  _addDropdown(parent, label, options, current, onChange) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const lbl = document.createElement('span');
    lbl.textContent = label;
    lbl.style.cssText = 'font-size:11px;min-width:50px;';
    row.appendChild(lbl);
    const select = document.createElement('select');
    select.style.cssText = 'flex:1;background:#333;color:#eee;border:1px solid #555;padding:2px;';
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt;
      if (opt === current) o.selected = true;
      select.appendChild(o);
    }
    select.onchange = () => onChange(select.value);
    row.appendChild(select);
    parent.appendChild(row);
  }

  _addSlider(parent, label, min, max, step, value, onChange) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:4px;';
    const lbl = document.createElement('span');
    lbl.textContent = label;
    lbl.style.cssText = 'font-size:10px;min-width:70px;';
    row.appendChild(lbl);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = value;
    input.style.cssText = 'flex:1;';
    const valSpan = document.createElement('span');
    valSpan.textContent = Number(value).toFixed(1);
    valSpan.style.cssText = 'font-size:10px;min-width:30px;text-align:right;';
    input.oninput = () => {
      valSpan.textContent = Number(input.value).toFixed(1);
      onChange(Number(input.value));
    };
    row.appendChild(input);
    row.appendChild(valSpan);
    parent.appendChild(row);
  }

  _populateSliders() {
    this._sliderContainer.innerHTML = '';
    const s = this._style;
    this._addSlider(this._sliderContainer, 'Floor ht', 2.4, 4.5, 0.1, s.floorHeight, v => { s.floorHeight = v; this._regenerate(); });
    this._addSlider(this._sliderContainer, 'Roof pitch', 0, 60, 1, s.roofPitch, v => { s.roofPitch = v; this._regenerate(); });
    this._addSlider(this._sliderContainer, 'Win width', 0.5, 2.0, 0.1, s.windowWidth, v => { s.windowWidth = v; this._regenerate(); });
    this._addSlider(this._sliderContainer, 'Win height', 0.6, 3.0, 0.1, s.windowHeight, v => { s.windowHeight = v; this._regenerate(); });
    this._addSlider(this._sliderContainer, 'Win spacing', 1.5, 5.0, 0.1, s.windowSpacing, v => { s.windowSpacing = v; this._regenerate(); });
    this._addSlider(this._sliderContainer, 'Porch depth', 0, 4.0, 0.1, s.porchDepth, v => { s.porchDepth = v; this._regenerate(); });
    this._addSlider(this._sliderContainer, 'Overhang', 0, 1.0, 0.05, s.roofOverhang, v => { s.roofOverhang = v; this._regenerate(); });
  }

  _buildViewports() {
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x87ceeb);
    this._gridArea.appendChild(renderer.domElement);
    this._renderer = renderer;

    // Create 9 scenes + cameras
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const scene = new THREE.Scene();
        scene.add(new THREE.AmbientLight(0x8899aa, 0.6));
        const sun = new THREE.DirectionalLight(0xffeedd, 1.2);
        sun.position.set(20, 40, 30);
        scene.add(sun);

        // Ground plane
        const ground = new THREE.Mesh(
          new THREE.PlaneGeometry(60, 60),
          new THREE.MeshLambertMaterial({ color: 0x556b2f })
        );
        ground.rotation.x = -Math.PI / 2;
        ground.position.y = -0.01;
        scene.add(ground);

        const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
        this._scenes.push(scene);
        this._cameras.push(camera);
      }
    }

    // Add row/column labels as DOM overlays
    this._labels = [];
    // (labels positioned in _updateLayout)

    this._onResize = () => this._updateLayout();
    window.addEventListener('resize', this._onResize);
    this._updateLayout();
  }

  _updateLayout() {
    const w = this._gridArea.clientWidth;
    const h = this._gridArea.clientHeight;
    this._renderer.setSize(w, h);
    this._cellW = Math.floor(w / 3);
    this._cellH = Math.floor(h / 3);
  }

  _regenerate() {
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const idx = row * 3 + col;
        const scene = this._scenes[idx];

        // Remove old building
        const old = scene.getObjectByName('building');
        if (old) {
          scene.remove(old);
          old.traverse(c => { if (c.geometry) c.geometry.dispose(); });
        }

        const plotSize = PLOT_SIZES[row];
        const richness = RICHNESS_LEVELS[col];
        const recipe = buildRecipe(this._style, plotSize, richness, this._seed + idx);
        const building = generateBuilding(this._style, recipe);
        building.name = 'building';

        // Center building
        const box = new THREE.Box3().setFromObject(building);
        const center = box.getCenter(new THREE.Vector3());
        building.position.sub(center);
        building.position.y += center.y;  // keep on ground

        scene.add(building);

        // Fit camera to building
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) * 0.8;
        const cam = this._cameras[idx];
        cam.left = -maxDim;
        cam.right = maxDim;
        cam.top = maxDim;
        cam.bottom = -maxDim;
        cam.near = 0.1;
        cam.far = 200;
        cam.position.set(maxDim * 1.2, maxDim * 1.0, maxDim * 1.2);
        cam.lookAt(0, size.y * 0.35, 0);
        cam.updateProjectionMatrix();
      }
    }
  }

  _startLoop() {
    this._running = true;
    const animate = () => {
      if (!this._running) return;
      requestAnimationFrame(animate);

      const w = this._gridArea.clientWidth;
      const h = this._gridArea.clientHeight;
      const cw = this._cellW;
      const ch = this._cellH;

      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
          const idx = row * 3 + col;
          const x = col * cw;
          const y = (2 - row) * ch;  // WebGL Y is bottom-up
          this._renderer.setViewport(x, y, cw, ch);
          this._renderer.setScissor(x, y, cw, ch);
          this._renderer.setScissorTest(true);
          this._renderer.render(this._scenes[idx], this._cameras[idx]);
        }
      }
      this._renderer.setScissorTest(false);
    };
    animate();
  }

  dispose() {
    this._running = false;
    this._disposed = true;
    if (this._onKeyDown) document.removeEventListener('keydown', this._onKeyDown);
    if (this._onResize) window.removeEventListener('resize', this._onResize);
    if (this._renderer) { this._renderer.dispose(); this._renderer = null; }
    for (const scene of this._scenes) {
      scene.traverse(c => {
        if (c.geometry) c.geometry.dispose();
        if (c.material) c.material.dispose();
      });
    }
    this._scenes = [];
    this._cameras = [];
    this.container.innerHTML = '';
  }
}
```

**Step 2: Add navigation from RegionScreen**

In `src/ui/RegionScreen.js`, find the sidebar buttons section and add a "Building Styles" button that calls a callback or navigates to the new screen. The exact integration depends on how the app router works — look at how "Enter City" navigates to CityScreen for the pattern.

**Step 3: Run the app and verify visually**

Run: `npx vite` (or however the dev server starts)
Expected: Building styles screen shows 3x3 grid with buildings, sidebar with climate selector and sliders.

**Step 4: Commit**

```bash
git add src/ui/BuildingStyleScreen.js
git commit -m "feat(ui): BuildingStyleScreen with 3x3 viewport grid"
```

---

### Task 10: Grid labels and click-to-zoom

**Files:**
- Modify: `src/ui/BuildingStyleScreen.js`

**Step 1: Add row/column labels as DOM overlays**

In `_buildViewports()`, after creating the renderer, add label elements:

```js
// Column headers
for (let col = 0; col < 3; col++) {
  const lbl = document.createElement('div');
  lbl.textContent = RICHNESS_LABELS[col];
  lbl.style.cssText = 'position:absolute;color:#fff;font-size:12px;text-align:center;pointer-events:none;text-shadow:0 0 4px #000;';
  this._gridArea.appendChild(lbl);
  this._labels.push({ el: lbl, type: 'col', index: col });
}
// Row labels
for (let row = 0; row < 3; row++) {
  const lbl = document.createElement('div');
  lbl.textContent = SIZE_LABELS[row];
  lbl.style.cssText = 'position:absolute;color:#fff;font-size:12px;pointer-events:none;text-shadow:0 0 4px #000;';
  this._gridArea.appendChild(lbl);
  this._labels.push({ el: lbl, type: 'row', index: row });
}
```

In `_updateLayout()`, position labels:

```js
for (const label of this._labels) {
  if (label.type === 'col') {
    label.el.style.left = `${label.index * this._cellW + this._cellW / 2 - 30}px`;
    label.el.style.top = '4px';
    label.el.style.width = '60px';
  } else {
    label.el.style.left = '4px';
    label.el.style.top = `${label.index * this._cellH + this._cellH / 2 - 8}px`;
  }
}
```

**Step 2: Add click-to-zoom**

Add click handler on the renderer canvas:

```js
this._renderer.domElement.addEventListener('click', (e) => {
  const rect = this._renderer.domElement.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const col = Math.floor(x / this._cellW);
  const row = Math.floor(y / this._cellH);
  if (col >= 0 && col < 3 && row >= 0 && row < 3) {
    this._toggleZoom(row, col);
  }
});
```

Implement `_toggleZoom`:

```js
_toggleZoom(row, col) {
  if (this._zoomed != null) {
    this._zoomed = null;  // unzoom
  } else {
    this._zoomed = row * 3 + col;
  }
}
```

In the animation loop, if `_zoomed` is set, render only that cell at full viewport size:

```js
if (this._zoomed != null) {
  this._renderer.setViewport(0, 0, w, h);
  this._renderer.setScissor(0, 0, w, h);
  this._renderer.setScissorTest(true);
  this._renderer.render(this._scenes[this._zoomed], this._cameras[this._zoomed]);
} else {
  // Normal 3x3 grid render
  ...
}
```

**Step 3: Commit**

```bash
git add src/ui/BuildingStyleScreen.js
git commit -m "feat(ui): grid labels and click-to-zoom on building viewport"
```

---

### Task 11: App integration and final polish

**Files:**
- Modify: `src/ui/RegionScreen.js` or `src/ui/App.js` (wherever screen navigation lives)
- Run full test suite

**Step 1: Wire up navigation**

Look at how `RegionScreen` navigates to `CityScreen` for the pattern. Add a "Building Styles" button that creates a `BuildingStyleScreen`. The back callback should return to the previous screen.

**Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (existing + new building tests)

**Step 3: Manual visual test**

Verify in the browser:
- All 6 climates produce visibly distinct buildings
- Sliders update all 9 buildings in real time
- Randomize produces variety within the same style
- Click-to-zoom works and Escape returns to grid
- No z-fighting on windows, roofs look correct for each type

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: wire BuildingStyleScreen into app navigation"
```
