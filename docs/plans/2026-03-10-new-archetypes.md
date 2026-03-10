# New Archetypes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add 4 new building archetypes (Parisian Haussmann, German townhouse, suburban detached, low-rise apartments) and wire them into the TerracedRowScreen via a dropdown selector.

**Architecture:** New archetype objects follow the existing `shared`/`perHouse` pattern. `generateRow` gains conditional calls for porch, balcony, dormer, and extension based on archetype fields. A `sideGap` perHouse field creates spacing for detached houses. TerracedRowScreen gets an archetype `<select>` dropdown.

**Tech Stack:** THREE.js, Vitest, composable building API (`src/buildings/generate.js`)

---

### Task 1: Add new archetype data objects

**Files:**
- Modify: `src/buildings/archetypes.js:42-69`
- Test: `test/buildings/archetypes.test.js`

**Step 1: Write the failing tests**

Add to `test/buildings/archetypes.test.js`. First update the import:

```js
import {
  sample, hashPosition, victorianTerrace, parisianHaussmann,
  germanTownhouse, suburbanDetached, lowRiseApartments, generateRow,
} from '../../src/buildings/archetypes.js';
```

Then add these test blocks after the `victorianTerrace` describe:

```js
describe('parisianHaussmann', () => {
  it('has required archetype fields', () => {
    expect(parisianHaussmann.typology).toBe('terraced');
    expect(parisianHaussmann.partyWalls).toEqual(['left', 'right']);
    expect(parisianHaussmann.shared.floors).toEqual([5, 6]);
    expect(parisianHaussmann.shared.roofDirection).toBe('mansard');
    expect(parisianHaussmann.shared.balcony).toBeDefined();
    expect(parisianHaussmann.shared.dormers).toBeDefined();
    expect(parisianHaussmann.shared.balcony.style).toBe('full');
  });
});

describe('germanTownhouse', () => {
  it('has required archetype fields', () => {
    expect(germanTownhouse.typology).toBe('terraced');
    expect(germanTownhouse.shared.floors).toEqual([3, 4]);
    expect(germanTownhouse.shared.roofDirection).toBe('sides');
    expect(germanTownhouse.shared.dormers).toBeDefined();
    expect(germanTownhouse.shared.porch).toBeDefined();
    expect(germanTownhouse.shared.porch.roofStyle).toBe('gable');
  });
});

describe('suburbanDetached', () => {
  it('has required archetype fields', () => {
    expect(suburbanDetached.typology).toBe('detached');
    expect(suburbanDetached.partyWalls).toEqual([]);
    expect(suburbanDetached.shared.floors).toBe(2);
    expect(suburbanDetached.shared.roofDirection).toBe('all');
    expect(suburbanDetached.shared.porch).toBeDefined();
    expect(suburbanDetached.shared.extension).toBeDefined();
    expect(suburbanDetached.perHouse.sideGap).toEqual([1, 2]);
  });
});

describe('lowRiseApartments', () => {
  it('has required archetype fields', () => {
    expect(lowRiseApartments.typology).toBe('terraced');
    expect(lowRiseApartments.shared.floors).toEqual([4, 5]);
    expect(lowRiseApartments.shared.roofPitch).toBe(0);
    expect(lowRiseApartments.shared.balcony).toBeDefined();
    expect(lowRiseApartments.shared.balcony.style).toBe('full');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/buildings/archetypes.test.js`
Expected: FAIL — imports don't exist.

**Step 3: Add the archetype objects**

Add after `victorianTerrace` (after line 69) in `src/buildings/archetypes.js`:

```js
export const parisianHaussmann = {
  typology: 'terraced',
  partyWalls: ['left', 'right'],

  shared: {
    floors: [5, 6],
    floorHeight: [3.0, 3.4],
    roofPitch: [60, 70],
    roofDirection: 'mansard',
    roofOverhang: 0.15,
    depth: [10, 12],
    door: 'center',
    bay: null,
    balcony: { style: 'full', floors: [2, 3] },
    dormers: { style: 'window', count: [2, 3] },
    porch: null,
    extension: null,
    windowSpacing: [2.4, 2.8],
    windowHeight: [2.0, 2.4],
    groundHeight: [0.5, 0.8],
    sills: { protrusion: 0.08 },
    roofColor: 0x4a4a4a,
  },

  perHouse: {
    plotWidth: [5, 7],
    wallColor: 0xe8dcc8,
    colorVariation: 0.04,
  },
};

export const germanTownhouse = {
  typology: 'terraced',
  partyWalls: ['left', 'right'],

  shared: {
    floors: [3, 4],
    floorHeight: [2.8, 3.2],
    roofPitch: [45, 55],
    roofDirection: 'sides',
    roofOverhang: 0.3,
    depth: [9, 11],
    door: 'center',
    bay: null,
    balcony: null,
    dormers: { style: 'window', count: [1, 2] },
    porch: { face: 'front', porchDepth: 1.5, roofStyle: 'gable' },
    extension: null,
    windowSpacing: [2.2, 2.6],
    windowHeight: [1.4, 1.8],
    groundHeight: [0.3, 0.5],
    sills: { protrusion: 0.08 },
    roofColor: 0x8b4513,
  },

  perHouse: {
    plotWidth: [5, 6.5],
    wallColor: 0xc0b8a8,
    colorVariation: 0.05,
  },
};

export const suburbanDetached = {
  typology: 'detached',
  partyWalls: [],

  shared: {
    floors: 2,
    floorHeight: [2.6, 2.8],
    roofPitch: [25, 30],
    roofDirection: 'all',
    roofOverhang: 0.4,
    depth: [8, 10],
    door: 'center',
    bay: null,
    balcony: null,
    dormers: null,
    porch: { face: 'front', porchDepth: 1.8, roofStyle: 'slope' },
    extension: { widthFrac: 0.5, extDepth: 3, floors: 1, side: 'left' },
    windowSpacing: [2.0, 2.4],
    windowHeight: [1.3, 1.5],
    groundHeight: [0.2, 0.3],
    sills: null,
    roofColor: 0x6b4e37,
  },

  perHouse: {
    plotWidth: [8, 12],
    wallColor: 0xd8d0c0,
    colorVariation: 0.08,
    sideGap: [1, 2],
  },
};

export const lowRiseApartments = {
  typology: 'terraced',
  partyWalls: ['left', 'right'],

  shared: {
    floors: [4, 5],
    floorHeight: [2.8, 3.0],
    roofPitch: 0,
    roofDirection: 'sides',
    roofOverhang: 0.1,
    depth: [12, 15],
    door: 'center',
    bay: null,
    balcony: { style: 'full', floors: [1, 5] },
    dormers: null,
    porch: null,
    extension: null,
    windowSpacing: [2.2, 2.6],
    windowHeight: [1.5, 1.8],
    groundHeight: [0.3, 0.5],
    sills: null,
    roofColor: 0x888888,
  },

  perHouse: {
    plotWidth: [6, 8],
    wallColor: 0xe0ddd8,
    colorVariation: 0.03,
  },
};
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/buildings/archetypes.test.js`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/buildings/archetypes.js test/buildings/archetypes.test.js
git commit -m "feat: add 4 new building archetypes (Haussmann, German, suburban, apartments)

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 2: Wire new operations into generateRow

**Files:**
- Modify: `src/buildings/archetypes.js:3-7,85-180`
- Test: `test/buildings/archetypes.test.js`

**Step 1: Write the failing tests**

Add to the `generateRow` describe block in `test/buildings/archetypes.test.js`:

```js
  it('generates Haussmann row with balconies and dormers', () => {
    const group = generateRow(parisianHaussmann, 3, 42);
    expect(group.children.length).toBe(3);
    const house = group.children[1];
    let hasBalcony = false;
    let hasDormer = false;
    house.traverse(c => {
      if (c.name && c.name.startsWith('balcony_')) hasBalcony = true;
      if (c.name && c.name.startsWith('dormer')) hasDormer = true;
    });
    expect(hasBalcony).toBe(true);
    expect(hasDormer).toBe(true);
  });

  it('generates German townhouse row with porch and dormers', () => {
    const group = generateRow(germanTownhouse, 3, 42);
    expect(group.children.length).toBe(3);
    const house = group.children[1];
    let hasPorch = false;
    let hasDormer = false;
    house.traverse(c => {
      if (c.name === 'porch') hasPorch = true;
      if (c.name && c.name.startsWith('dormer')) hasDormer = true;
    });
    expect(hasPorch).toBe(true);
    expect(hasDormer).toBe(true);
  });

  it('generates suburban detached with gaps between houses', () => {
    const group = generateRow(suburbanDetached, 3, 42);
    expect(group.children.length).toBe(3);
    // House width should be less than plot spacing
    const h0 = group.children[0];
    const h1 = group.children[1];
    // Find actual house box width by inspecting geometry
    let houseWidth = 0;
    h0.traverse(c => {
      if (c.name === 'wallBox' && c.geometry) {
        c.geometry.computeBoundingBox();
        houseWidth = c.geometry.boundingBox.max.x - c.geometry.boundingBox.min.x;
      }
    });
    const plotSpacing = h1.position.x - h0.position.x;
    expect(houseWidth).toBeLessThan(plotSpacing);
  });

  it('generates suburban detached with porch and extension', () => {
    const group = generateRow(suburbanDetached, 2, 42);
    const house = group.children[0];
    let hasPorch = false;
    let hasExtension = false;
    house.traverse(c => {
      if (c.name === 'porch') hasPorch = true;
      if (c.name === 'extension') hasExtension = true;
    });
    expect(hasPorch).toBe(true);
    expect(hasExtension).toBe(true);
  });

  it('generates apartment row with balconies on every floor', () => {
    const group = generateRow(lowRiseApartments, 3, 42);
    const house = group.children[1];
    let balconyCount = 0;
    house.traverse(c => {
      if (c.name && c.name.startsWith('balcony_')) balconyCount++;
    });
    // Apartments have 4-5 floors, balconies on floors 1 through floors-1
    expect(balconyCount).toBeGreaterThanOrEqual(3);
  });

  it('generates apartment row with flat roof', () => {
    const group = generateRow(lowRiseApartments, 2, 42);
    const house = group.children[0];
    let hasRoof = false;
    house.traverse(c => {
      if (c.name === 'roof') hasRoof = true;
    });
    // Flat roof (pitch 0) should still have a roof group
    expect(hasRoof).toBe(true);
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/buildings/archetypes.test.js`
Expected: FAIL — generateRow doesn't call the new operations.

**Step 3: Update generateRow**

First, update the import at the top of `src/buildings/archetypes.js` (lines 3-7):

```js
import {
  createHouse, setPartyWalls, addFloor,
  addPitchedRoof, addFrontDoor, addBayWindow,
  addWindows, addWindowSills, addGroundLevel,
  addPorch, addBalcony, addDormer, addExtension,
} from './generate.js';
```

Then replace the `generateRow` function body (lines 85-180). Key changes:

1. Sample `bay` fields only if `s.bay` is not null
2. Sample `sideGap` from perHouse (default 0)
3. Create house with `width - sideGap * 2`, offset by `sideGap`
4. Add conditional porch/balcony/dormer/extension calls
5. Dormer count sampled at row level, positions evenly spaced

```js
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

  // Optional shared features — sample only if defined
  const bayFloors = s.bay ? Math.round(sample(rowRng, s.bay.floors)) : 0;
  const bayDepth = s.bay ? sample(rowRng, s.bay.depth) : 0;
  const dormerCount = s.dormers ? Math.round(sample(rowRng, s.dormers.count)) : 0;

  let xOffset = 0;

  for (let i = 0; i < count; i++) {
    // Per-house values from position-based seed
    const houseSeed = hashPosition(seed, xOffset, 0);
    const rng = new SeededRandom(houseSeed);

    const plotWidth = sample(rng, p.plotWidth);
    const sideGap = p.sideGap ? sample(rng, p.sideGap) : 0;
    const houseWidth = plotWidth - sideGap * 2;
    const wallColor = nudgeColor(p.wallColor, p.colorVariation, rng);

    // Terrain heights at house position
    const centerX = xOffset + plotWidth / 2;
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
    const house = createHouse(houseWidth, depth, floorHeight, wallColor);
    house._winSpacing = winSpacing;
    house._groundHeight = groundLevel;
    house.roofColor = s.roofColor;

    setPartyWalls(house, partyWalls);
    for (let f = 1; f < floors; f++) addFloor(house);
    addPitchedRoof(house, roofPitch, s.roofDirection, s.roofOverhang);
    addFrontDoor(house, s.door);

    if (s.bay) {
      addBayWindow(house, {
        style: s.bay.style,
        span: s.bay.span,
        floors: Math.min(bayFloors, floors),
        depth: bayDepth,
      });
    }

    if (s.porch) {
      addPorch(house, {
        face: s.porch.face || 'front',
        porchDepth: s.porch.porchDepth || 1.8,
        roofStyle: s.porch.roofStyle || 'slope',
      });
    }

    if (s.extension) {
      addExtension(house, {
        widthFrac: s.extension.widthFrac || 0.5,
        extDepth: s.extension.extDepth || s.extension.depth || 3,
        floors: s.extension.floors || 1,
        side: s.extension.side || 'left',
      });
    }

    addWindows(house, { spacing: winSpacing, height: winHeight });

    if (s.balcony) {
      const balcStart = Array.isArray(s.balcony.floors) ? s.balcony.floors[0] : 1;
      const balcEnd = Array.isArray(s.balcony.floors) ? s.balcony.floors[1] : floors;
      for (let bf = balcStart; bf <= Math.min(balcEnd, floors - 1); bf++) {
        addBalcony(house, bf, s.balcony.style);
      }
    }

    if (s.sills) {
      addWindowSills(house, { protrusion: s.sills.protrusion });
    }

    if (s.dormers) {
      for (let d = 0; d < dormerCount; d++) {
        const pos = (d + 0.5) / dormerCount;
        addDormer(house, { position: pos, style: s.dormers.style });
      }
    }

    if (groundLevel > 0.05) {
      addGroundLevel(house, groundLevel);
    }

    // Rear foundation wall: if terrain drops behind the house
    const rearDrop = terrainFront - terrainRear;
    if (rearDrop > 0.05) {
      const rearWall = new THREE.Mesh(
        new THREE.BoxGeometry(houseWidth + 0.1, rearDrop, 0.15),
        new THREE.MeshLambertMaterial({ color: house.wallColor }),
      );
      rearWall.position.set(houseWidth / 2, -rearDrop / 2, depth + 0.05);
      rearWall.name = 'rearFoundation';
      house.group.add(rearWall);
    }

    // Position in row: X along plot, Y at terrain height, Z at setback
    house.group.position.x = xOffset + sideGap;
    house.group.position.y += terrainFront;
    house.group.position.z = frontZ;
    group.add(house.group);
    xOffset += plotWidth;
  }

  return group;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/buildings/archetypes.test.js`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/buildings/archetypes.js test/buildings/archetypes.test.js
git commit -m "feat: generateRow supports porch, balcony, dormer, extension, sideGap

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 3: Add archetype selector to TerracedRowScreen

**Files:**
- Modify: `src/ui/TerracedRowScreen.js`

This is UI-only — no unit tests, verify visually.

**Step 1: Update imports**

At the top of `src/ui/TerracedRowScreen.js`, change the import:

```js
import {
  generateRow, victorianTerrace, parisianHaussmann, germanTownhouse,
  suburbanDetached, lowRiseApartments, ROAD_HALF_WIDTH, SIDEWALK_WIDTH, HOUSE_Z,
} from '../buildings/archetypes.js';
```

**Step 2: Add archetype list constant**

Below the `PRESETS` array and `ROW_SPACING`, add:

```js
const ARCHETYPES = [
  { label: 'Victorian Terrace', value: victorianTerrace },
  { label: 'Parisian Haussmann', value: parisianHaussmann },
  { label: 'German Townhouse', value: germanTownhouse },
  { label: 'Suburban Detached', value: suburbanDetached },
  { label: 'Low-rise Apartments', value: lowRiseApartments },
];
```

**Step 3: Add archetype state and dropdown**

In the constructor, add `this._archetype = victorianTerrace;` alongside the existing `this._count` and `this._seed`.

In `_buildUI`, add a dropdown above the count slider. After the title element and before `countRow`:

```js
    // Archetype selector
    const archRow = document.createElement('div');
    archRow.style.cssText = 'display:flex;flex-direction:column;gap:1px;margin-bottom:8px';
    const archLbl = document.createElement('span');
    archLbl.textContent = 'Archetype';
    archLbl.style.cssText = 'color:#aaa;font-family:monospace;font-size:11px';
    const archSelect = document.createElement('select');
    archSelect.style.cssText = 'width:100%;padding:4px;background:#333;color:#eee;border:1px solid #666;font-family:monospace;font-size:13px;border-radius:4px';
    ARCHETYPES.forEach((a, idx) => {
      const opt = document.createElement('option');
      opt.value = idx;
      opt.textContent = a.label;
      archSelect.appendChild(opt);
    });
    archSelect.addEventListener('change', () => {
      this._archetype = ARCHETYPES[parseInt(archSelect.value)].value;
      this._rebuild();
    });
    archRow.appendChild(archLbl);
    archRow.appendChild(archSelect);
    sidebar.appendChild(archRow);
```

**Step 4: Update _rebuild to use selected archetype**

In `_rebuild`, change the `generateRow` call and `avgPlotWidth` to use `this._archetype` instead of hardcoded `victorianTerrace`:

```js
    const avgPlotWidth = (this._archetype.perHouse.plotWidth[0] + this._archetype.perHouse.plotWidth[1]) / 2;
    const rowLength = avgPlotWidth * this._count;
```

And inside the preset loop:

```js
      const row = generateRow(this._archetype, this._count, this._seed, heightFn);
```

**Step 5: Commit**

```bash
git add src/ui/TerracedRowScreen.js
git commit -m "feat: TerracedRowScreen archetype selector dropdown

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 4: Run all tests and verify

**Step 1: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS — no regressions.

**Step 2: Visual verification**

Run the dev server, navigate to `?mode=terraced`. Cycle through all 5 archetypes in the dropdown:

- **Victorian Terrace** — bay windows, sills, 2-3 floors, party walls
- **Parisian Haussmann** — 5-6 floors, mansard roof, balconies on floors 2-3, dormers
- **German Townhouse** — 3-4 floors, steep roof, gable porch, dormers
- **Suburban Detached** — 2 floors, hip roof, gaps between houses, porch, rear extension
- **Low-rise Apartments** — 4-5 floors, flat roof, balconies every floor

Verify slopes still work correctly across all archetypes.
