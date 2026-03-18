# Railway Rendering Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render railways on the regional map (3D orbit + 2D panel) and inherit railway features into city generation so they appear in the city view.

**Architecture:** Regional rendering follows the existing road pattern — `buildRegionRailways` for 3D lines, `drawRailways` for 2D canvas. City inheritance follows the river pattern — clip world-coordinate polylines to city bounds, add as features on the FeatureMap, render as ribbon meshes alongside roads.

**Tech Stack:** Three.js (3D lines), Canvas 2D, existing clipPolyline/chaikinSmooth utilities.

---

## File Structure

| File | Responsibility |
|------|---------------|
| **Modify:** `src/rendering/regionPreview3D.js` | Add `buildRegionRailways()` — 3D lines for railway paths on terrain |
| **Modify:** `src/rendering/mapRenderer.js` | Add `drawRailways()` — 2D canvas lines for railway paths |
| **Modify:** `src/ui/RegionScreen.js` | Call `buildRegionRailways` and `drawRailways` alongside existing road rendering |
| **Create:** `src/core/inheritRailways.js` | Clip regional railway polylines to city bounds (follows `inheritRivers` pattern) |
| **Create:** `test/core/inheritRailways.test.js` | Tests for railway inheritance |
| **Modify:** `src/city/setup.js` | Import railways into city FeatureMap during tick 0 setup |
| **Modify:** `src/ui/CityScreen.js` | Render railway ribbon meshes in city 3D view |

---

## Chunk 1: Regional Map Rendering

### Task 1: 3D Railway Lines on Region Preview

**Files:**
- Modify: `src/rendering/regionPreview3D.js`
- Modify: `src/ui/RegionScreen.js`

Add a `buildRegionRailways` function following the exact pattern of `buildRegionRoads` (line 174-207 of regionPreview3D.js). Railways use different colours to distinguish them from roads.

- [ ] **Step 1: Add `buildRegionRailways` to regionPreview3D.js**

Add this function after `buildRegionRoads`:

```javascript
/**
 * Build 3D line meshes for railway network.
 */
export function buildRegionRailways(layers) {
  const railways = layers.getData('railways');
  const elevation = layers.getGrid('elevation');
  if (!railways || !elevation) return new THREE.Group();

  const group = new THREE.Group();
  const cs = elevation.cellSize;
  const halfW = (elevation.width - 1) * cs / 2;
  const halfH = (elevation.height - 1) * cs / 2;

  const hierarchyColors = { trunk: 0x222222, main: 0x444444, branch: 0x666666 };

  for (const rail of railways) {
    const pathData = rail.rawPath || rail.path;
    if (!pathData || pathData.length < 2) continue;

    const color = hierarchyColors[rail.hierarchy] || 0x444444;
    const points = pathData.map(p => {
      const elev = elevation.get(p.gx, p.gz);
      return new THREE.Vector3(
        p.gx * cs - halfW,
        elev + 3,  // slightly above roads (+2)
        p.gz * cs - halfH,
      );
    });

    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({ color, linewidth: 2 });
    group.add(new THREE.Line(geometry, material));
  }

  return group;
}
```

- [ ] **Step 2: Wire into RegionScreen**

In `src/ui/RegionScreen.js`, add import of `buildRegionRailways` alongside the existing imports from `regionPreview3D.js`:

```javascript
import { buildRegionTerrain, buildWaterPlane, buildSettlementMarkers, buildRegionRoads, buildRegionRailways, buildRegionRiverMeshes, buildCityBoundary } from '../rendering/regionPreview3D.js';
```

In the `_build3D` method, after `worldGroup.add(roadLines)`, add:

```javascript
    const railwayLines = buildRegionRailways(this._layers);
    worldGroup.add(railwayLines);
```

- [ ] **Step 3: Test manually — regenerate region and check 3D preview shows dark railway lines**

- [ ] **Step 4: Commit**

```bash
git add src/rendering/regionPreview3D.js src/ui/RegionScreen.js
git commit -m "feat: render railways on 3D region preview"
```

---

### Task 2: 2D Railway Lines on Region Map

**Files:**
- Modify: `src/rendering/mapRenderer.js`
- Modify: `src/ui/RegionScreen.js`

Add a `drawRailways` function following the pattern of `drawRoads` (line 96-118 of mapRenderer.js). Use dashed dark lines to distinguish from solid brown road lines.

- [ ] **Step 1: Add `drawRailways` to mapRenderer.js**

Add after `drawRoads`:

```javascript
/**
 * Draw railway lines on the map.
 */
export function drawRailways(layers, ctx) {
  const railways = layers.getData('railways');
  if (!railways) return;

  const hierarchyStyles = {
    trunk:  { color: '#222222', width: 2 },
    main:   { color: '#444444', width: 1.5 },
    branch: { color: '#777777', width: 1 },
  };

  for (const rail of railways) {
    if (!rail.path || rail.path.length < 2) continue;
    const style = hierarchyStyles[rail.hierarchy] || hierarchyStyles.branch;

    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.width;
    ctx.setLineDash([3, 2]);
    ctx.beginPath();
    for (let i = 0; i < rail.path.length; i++) {
      const p = rail.path[i];
      if (i === 0) ctx.moveTo(p.gx, p.gz);
      else ctx.lineTo(p.gx, p.gz);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
```

- [ ] **Step 2: Wire into RegionScreen**

In `src/ui/RegionScreen.js`, update the import from mapRenderer:

```javascript
import { renderMap, drawSettlements, drawRivers, drawRoads, drawRailways } from '../rendering/mapRenderer.js';
```

In the `_render2D` method, after `drawRoads(this._layers, ctx)`, add:

```javascript
    drawRailways(this._layers, ctx);
```

- [ ] **Step 3: Test manually — check 2D map panel shows dashed railway lines**

- [ ] **Step 4: Commit**

```bash
git add src/rendering/mapRenderer.js src/ui/RegionScreen.js
git commit -m "feat: render railways on 2D region map"
```

---

## Chunk 2: City Inheritance

### Task 3: Railway Inheritance Module

**Files:**
- Create: `src/core/inheritRailways.js`
- Create: `test/core/inheritRailways.test.js`

Follows the `inheritRivers` pattern: clip railway polylines to city bounds, smooth for higher resolution, return as feature data. Railways use world-coordinate polylines (from `buildRoadNetwork` output), unlike rivers which use a segment tree.

- [ ] **Step 1: Write the failing test**

```javascript
// test/core/inheritRailways.test.js
import { describe, it, expect } from 'vitest';
import { inheritRailways } from '../../src/core/inheritRailways.js';

describe('inheritRailways', () => {
  const bounds = { minX: 100, minZ: 100, maxX: 500, maxZ: 500 };

  it('clips railway polylines to city bounds', () => {
    const railways = [{
      polyline: [
        { x: 50, z: 300 },   // outside left
        { x: 200, z: 300 },  // inside
        { x: 400, z: 300 },  // inside
        { x: 600, z: 300 },  // outside right
      ],
      hierarchy: 'trunk',
      phase: 1,
    }];

    const result = inheritRailways(railways, bounds);
    expect(result.length).toBe(1);
    // Clipped polyline should start near x=100 and end near x=500
    expect(result[0].polyline[0].x).toBeGreaterThanOrEqual(95);
    expect(result[0].polyline[result[0].polyline.length - 1].x).toBeLessThanOrEqual(505);
  });

  it('discards railways entirely outside bounds', () => {
    const railways = [{
      polyline: [{ x: 600, z: 600 }, { x: 700, z: 700 }],
      hierarchy: 'branch',
      phase: 3,
    }];
    const result = inheritRailways(railways, bounds);
    expect(result.length).toBe(0);
  });

  it('preserves hierarchy metadata', () => {
    const railways = [{
      polyline: [{ x: 200, z: 200 }, { x: 400, z: 400 }],
      hierarchy: 'trunk',
      phase: 1,
    }];
    const result = inheritRailways(railways, bounds);
    expect(result[0].hierarchy).toBe('trunk');
    expect(result[0].phase).toBe(1);
  });

  it('returns empty for no railways', () => {
    expect(inheritRailways([], bounds)).toEqual([]);
    expect(inheritRailways(null, bounds)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/core/inheritRailways.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```javascript
// src/core/inheritRailways.js
/**
 * Inherit regional railway lines into a city by clipping polylines to city bounds.
 * Follows the inheritRivers pattern but operates on flat polyline arrays
 * rather than segment trees.
 */

import { clipPolylineToBounds } from './clipPolyline.js';
import { chaikinSmooth } from './math.js';

/**
 * @param {Array|null} railways - Regional railway data from LayerStack
 * @param {object} bounds - { minX, minZ, maxX, maxZ } in world coordinates
 * @param {object} [options]
 * @param {number} [options.chaikinPasses=2] - Smoothing iterations
 * @param {number} [options.margin=0] - Extra margin around bounds
 * @returns {Array<{ polyline: Array<{x, z}>, hierarchy: string, phase: number }>}
 */
export function inheritRailways(railways, bounds, options = {}) {
  if (!railways || railways.length === 0) return [];

  const { chaikinPasses = 2, margin = 0 } = options;
  const expandedBounds = {
    minX: bounds.minX - margin,
    minZ: bounds.minZ - margin,
    maxX: bounds.maxX + margin,
    maxZ: bounds.maxZ + margin,
  };

  const result = [];

  for (const rail of railways) {
    if (!rail.polyline || rail.polyline.length < 2) continue;

    const clipped = clipPolylineToBounds(rail.polyline, expandedBounds);
    if (!clipped || clipped.clipped.length < 2) continue;

    let smoothed = clipped.clipped.map(p => ({ x: p.x, z: p.z }));
    for (let i = 0; i < chaikinPasses; i++) {
      smoothed = chaikinSmooth(smoothed);
    }

    result.push({
      polyline: smoothed,
      hierarchy: rail.hierarchy || 'branch',
      phase: rail.phase || 1,
    });
  }

  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/core/inheritRailways.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/inheritRailways.js test/core/inheritRailways.test.js
git commit -m "feat: add railway inheritance for city generation"
```

---

### Task 4: Wire Railway Inheritance into City Setup

**Files:**
- Modify: `src/city/setup.js`

Add railway import alongside the existing river import in `setupCity`. Railways are stored as features on the FeatureMap.

- [ ] **Step 1: Add import**

At the top of `src/city/setup.js`, add:
```javascript
import { inheritRailways } from '../core/inheritRailways.js';
```

- [ ] **Step 2: Add railway inheritance after river inheritance**

After the river import block (after `map.addFeature('river', ...)`), add:

```javascript
  // Import railways as features
  const railways = layers.getData('railways');
  if (railways) {
    const cityRailways = inheritRailways(railways, bounds, {
      chaikinPasses: 2,
      margin: cityCellSize,
    });
    for (const rail of cityRailways) {
      map.addFeature('railway', {
        polyline: rail.polyline,
        hierarchy: rail.hierarchy,
        phase: rail.phase,
      });
    }
  }
```

- [ ] **Step 3: Run existing tests**

Run: `npx vitest run`
Expected: All existing tests pass (no regressions)

- [ ] **Step 4: Commit**

```bash
git add src/city/setup.js
git commit -m "feat: inherit regional railways into city setup"
```

---

### Task 5: Render Railways in City 3D View

**Files:**
- Modify: `src/ui/CityScreen.js`

Add railway rendering in the city view. Railways are rendered as ribbon meshes similar to roads but with a distinct dark colour, slightly narrower width, and drawn on top of the terrain.

- [ ] **Step 1: Read CityScreen.js to find where `_buildRoads` is called**

Find the method that calls `_buildRoads()` and adds the result to the scene. Add railway building after it.

- [ ] **Step 2: Add `_buildRailways` method**

Add a method to CityScreen that extracts railway features and renders them as ribbon meshes. Follow the `_buildRoads` pattern but simpler — single batch, single colour:

```javascript
  _buildRailways() {
    const group = new THREE.Group();
    const railFeatures = this._map.getFeatures('railway');
    if (!railFeatures || railFeatures.length === 0) return group;

    const vertices = [];
    const indices = [];
    const halfWidth = 2; // 2m half-width (4m total — narrower than roads)

    for (const rail of railFeatures) {
      const pts = rail.polyline;
      if (!pts || pts.length < 2) continue;

      const baseVertex = vertices.length / 3;

      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        // Convert world coords to local coords (relative to map origin)
        const lx = p.x - this._map.originX;
        const lz = p.z - this._map.originZ;

        // Sample elevation at this position
        const gx = Math.round(lx / this._map.cellSize);
        const gz = Math.round(lz / this._map.cellSize);
        const y = (gx >= 0 && gx < this._map.width && gz >= 0 && gz < this._map.height)
          ? this._map.elevation.get(gx, gz) + 0.3
          : 0;

        // Perpendicular for ribbon width
        let perpX, perpZ;
        if (i === 0) {
          const dx = pts[1].x - p.x, dz = pts[1].z - p.z;
          const len = Math.sqrt(dx * dx + dz * dz) || 1;
          perpX = -dz / len; perpZ = dx / len;
        } else if (i === pts.length - 1) {
          const dx = p.x - pts[i - 1].x, dz = p.z - pts[i - 1].z;
          const len = Math.sqrt(dx * dx + dz * dz) || 1;
          perpX = -dz / len; perpZ = dx / len;
        } else {
          const dx0 = p.x - pts[i - 1].x, dz0 = p.z - pts[i - 1].z;
          const len0 = Math.sqrt(dx0 * dx0 + dz0 * dz0) || 1;
          const px0 = -dz0 / len0, pz0 = dx0 / len0;
          const dx1 = pts[i + 1].x - p.x, dz1 = pts[i + 1].z - p.z;
          const len1 = Math.sqrt(dx1 * dx1 + dz1 * dz1) || 1;
          const px1 = -dz1 / len1, pz1 = dx1 / len1;
          const ax = px0 + px1, az = pz0 + pz1;
          const alen = Math.sqrt(ax * ax + az * az) || 1;
          perpX = ax / alen; perpZ = az / alen;
        }

        vertices.push(lx + perpX * halfWidth, y, lz + perpZ * halfWidth);
        vertices.push(lx - perpX * halfWidth, y, lz - perpZ * halfWidth);

        if (i > 0) {
          const b = baseVertex + (i - 1) * 2;
          indices.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
        }
      }
    }

    if (vertices.length < 6) return group;

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();

    const material = new THREE.MeshStandardMaterial({
      color: 0x333333,
      roughness: 0.8,
      metalness: 0.1,
    });

    group.add(new THREE.Mesh(geom, material));
    return group;
  }
```

- [ ] **Step 3: Call `_buildRailways` alongside `_buildRoads` in the scene assembly**

Find where `_buildRoads()` is called and add after it:

```javascript
    const railwayMeshes = this._buildRailways();
    this._scene.add(railwayMeshes);
```

- [ ] **Step 4: Test manually — enter a city from the region view and check for dark railway lines cutting through**

- [ ] **Step 5: Commit**

```bash
git add src/ui/CityScreen.js
git commit -m "feat: render railway lines in city 3D view"
```
