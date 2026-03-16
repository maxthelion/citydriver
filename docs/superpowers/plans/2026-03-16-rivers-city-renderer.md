# Rivers City + Renderer Implementation Plan (Plan B)

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update city setup and renderer to consume the river tree as single source of truth, eliminating dual bitmap/polyline desynchronization.

**Architecture:** City setup derives sea and river grids from the river tree (same approach as regional pipeline). Removes `classifyWater()`, `carveChannels()`, and `enforceWaterDepth()`. Renderer uses water grids for coloring instead of `elev < seaLevel`. Perlin noise skips river channel cells.

**Tech Stack:** JavaScript, Grid2D, THREE.js, vitest

**Spec:** `docs/superpowers/specs/2026-03-16-rivers-design.md`

**Depends on:** Plan A (regional river tree) must be complete.

---

## Task 1: Update city setup to use river tree

Replace the old water pipeline (seed waterMask from elevation, import polylines, classifyWater, carveChannels, enforceWaterDepth) with river-tree-based derivation.

**Files:**
- Modify: `src/city/setup.js`

- [ ] **Step 1: Add imports**

Add import for `computeSeaGrid`:

```javascript
import { computeSeaGrid } from '../regional/seaGrid.js';
```

- [ ] **Step 2: Replace waterMask seeding + river import + classify + carve block**

Replace lines 119-162 (from "Seed waterMask from sea level" through "enforceWaterDepth") with:

```javascript
  // --- Water grids derived from river tree + sea flood fill ---

  // Get river tree from regional data
  const riverSystems = layers.getData('riverSystems');

  // Stamp river grid at city resolution from river tree
  const riverGrid = new Grid2D(cityGridW, cityGridH, {
    type: 'uint8',
    cellSize: cityCellSize,
    originX,
    originZ,
  });
  if (riverSystems) {
    for (const sys of riverSystems) {
      sys.stampOntoGrid(riverGrid, cityCellSize);
    }
  }

  // Sea grid: flood fill from edges through cells below sea level
  const seaGrid = computeSeaGrid(elevation, seaLevel);

  // Skip Perlin noise on river channel cells (prevent noise from
  // pushing river beds above/below intended elevation).
  // Re-apply elevation for river cells from the interpolated value
  // before noise was added. We do this by re-interpolating just those cells.
  for (let gz = 0; gz < cityGridH; gz++) {
    for (let gx = 0; gx < cityGridW; gx++) {
      if (riverGrid.get(gx, gz) > 0) {
        const wx = originX + gx * cityCellSize;
        const wz = originZ + gz * cityCellSize;
        const rgx = wx / regionalCellSize;
        const rgz = wz / regionalCellSize;
        elevation.set(gx, gz, regionalElevation.sample(rgx, rgz));
      }
    }
  }

  // Combined water mask: sea OR river
  const waterMask = new Grid2D(cityGridW, cityGridH, {
    type: 'uint8',
    cellSize: cityCellSize,
    originX,
    originZ,
  });
  for (let i = 0; i < cityGridW * cityGridH; i++) {
    waterMask.data[i] = seaGrid.data[i] | riverGrid.data[i];
  }
```

Note: The Perlin noise was already applied (lines 83-96), so we undo it on river cells by re-interpolating from regional elevation. This is simpler than restructuring the noise loop.

- [ ] **Step 3: Update FeatureMap creation to use derived waterMask**

After the new water grid code, the existing FeatureMap creation needs the waterMask. Replace the line that creates the FeatureMap and sets waterMask:

```javascript
  // Create FeatureMap with derived water mask
  const map = new FeatureMap(cityGridW, cityGridH, cityCellSize, { originX, originZ });
  // Copy derived waterMask into FeatureMap
  for (let i = 0; i < cityGridW * cityGridH; i++) {
    map.waterMask.data[i] = waterMask.data[i];
  }
```

- [ ] **Step 4: Keep river import for rendering (polylines for ribbon meshes)**

The city still needs river polylines for rendering ribbon meshes. Keep the `inheritRivers` import but don't use it for water identity:

```javascript
  // Import rivers as features (for rendering ribbon meshes only — water identity
  // comes from riverGrid, not from these polyline features)
  const riverPaths = layers.getData('riverPaths');
  if (riverPaths) {
    const bounds = {
      minX: originX,
      minZ: originZ,
      maxX: originX + cityGridW * cityCellSize,
      maxZ: originZ + cityGridH * cityCellSize,
    };
    const cityRivers = inheritRivers(riverPaths, bounds, {
      chaikinPasses: 1,
      margin: cityCellSize,
    });
    for (const river of cityRivers) {
      map.addFeature('river', { polyline: river.polyline, systemId: river.systemId });
    }
  }
```

- [ ] **Step 5: Remove classifyWater, carveChannels, enforceWaterDepth calls**

Remove these three calls (they were at lines 155, 158, 162):

```javascript
  // REMOVE: map.classifyWater(seaLevel);
  // REMOVE: map.carveChannels();
  // REMOVE: enforceWaterDepth(elevation, map.waterMask, seaLevel);
```

Keep `map.setTerrain(elevation, slope)` and `map.seaLevel = seaLevel`.

- [ ] **Step 6: Store water grids as layers**

After setting terrain, add the water grid layers:

```javascript
  map.setLayer('seaGrid', seaGrid);
  map.setLayer('riverGrid', riverGrid);
```

The existing `map.setLayer('waterMask', map.waterMask)` line (around line 173) stays.

- [ ] **Step 7: Remove the enforceWaterDepth function**

Delete the `enforceWaterDepth` function definition (lines 225-235) and its associated constants/comments (lines 215-235). It's no longer needed.

- [ ] **Step 8: Run tests**

Run: `npx vitest run --reporter=verbose`

Some tests may need adjustment if they depend on `classifyWater` or `carveChannels` behavior. Fix as needed.

- [ ] **Step 9: Commit**

```bash
git add src/city/setup.js
git commit -m "feat: city setup uses river tree for water grids, removes old carve/classify"
```

---

## Task 2: Fix renderer to use water grids

Change `terrainMesh.js` to use water grids (`waterMask`, `seaGrid`, `riverGrid`) for coloring instead of `elev < seaLevel`.

**Files:**
- Modify: `src/rendering/terrainMesh.js`

- [ ] **Step 1: Update buildCityTerrainMesh to use water grids**

In `src/rendering/terrainMesh.js`, get the waterMask from cityLayers:

```javascript
  const waterMask = cityLayers.getGrid('waterMask');
```

Replace line 36-37:

```javascript
// OLD:
      if (elev < seaLevel) {
        r = 0.1; g = 0.25; b = 0.5;

// NEW:
      if (waterMask && waterMask.get(gx, gz) > 0) {
        r = 0.1; g = 0.25; b = 0.5;
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add src/rendering/terrainMesh.js
git commit -m "fix: renderer uses waterMask instead of elevation for water coloring"
```

---

## Task 3: Run full test suite and verify

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 2: Commit any test fixes if needed**
