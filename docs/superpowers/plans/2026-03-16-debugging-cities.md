# Debugging Cities Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make debug screen state URL-linkable and build a compare-archetypes screen for side-by-side archetype comparison.

**Architecture:** Add layer slug mapping utility to `debugLayers.js`. Update `DebugScreen` to read/write archetype, tick, and lens URL params. Create a new `CompareArchetypesScreen` that clones a base FeatureMap per archetype and renders debug layers in a CSS grid. Wire everything through `main.js` and `RegionScreen`.

**Tech Stack:** Vanilla JS, Canvas 2D, URL SearchParams, existing FeatureMap/LAYERS/LandFirstDevelopment infrastructure.

---

## Chunk 1: Layer Slug Mapping

### Task 1: Add layer slug utilities to debugLayers.js

**Files:**
- Modify: `src/rendering/debugLayers.js:652-696` (after LAYERS array)
- Test: `test/rendering/debugLayers.test.js` (create)

- [ ] **Step 1: Write the failing test**

```js
// test/rendering/debugLayers.test.js
import { describe, it, expect } from 'vitest';
import { layerSlug, layerIndexFromSlug, LAYERS } from '../src/rendering/debugLayers.js';

describe('layerSlug', () => {
  it('converts simple names', () => {
    expect(layerSlug('Land Value')).toBe('land-value');
    expect(layerSlug('Composite')).toBe('composite');
  });

  it('strips parentheses', () => {
    expect(layerSlug('Path Cost (growth)')).toBe('path-cost-growth');
    expect(layerSlug('Path Cost (nucleus)')).toBe('path-cost-nucleus');
  });

  it('strips colons', () => {
    expect(layerSlug('Coverage: Water')).toBe('coverage-water');
    expect(layerSlug('Coverage: Road')).toBe('coverage-road');
    expect(layerSlug('Coverage: Land Cover')).toBe('coverage-land-cover');
  });

  it('handles multi-word names', () => {
    expect(layerSlug('Development Pressure')).toBe('development-pressure');
    expect(layerSlug('Terrain Suitability')).toBe('terrain-suitability');
  });
});

describe('layerIndexFromSlug', () => {
  it('returns index for valid slug', () => {
    expect(layerIndexFromSlug('composite')).toBe(0);
    expect(layerIndexFromSlug('land-value')).toBe(LAYERS.findIndex(l => l.name === 'Land Value'));
  });

  it('returns -1 for unknown slug', () => {
    expect(layerIndexFromSlug('nonexistent')).toBe(-1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/rendering/debugLayers.test.js`
Expected: FAIL — `layerSlug` and `layerIndexFromSlug` not exported

- [ ] **Step 3: Write the implementation**

Add to the end of `src/rendering/debugLayers.js`:

```js
/**
 * Convert a layer display name to a URL-safe kebab-case slug.
 * Strips parentheses, colons, and other special characters.
 */
export function layerSlug(name) {
  return name
    .toLowerCase()
    .replace(/[():]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Find a LAYERS index by its kebab-case slug. Returns -1 if not found.
 */
export function layerIndexFromSlug(slug) {
  return LAYERS.findIndex(l => layerSlug(l.name) === slug);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/rendering/debugLayers.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/rendering/debugLayers.js test/rendering/debugLayers.test.js
git commit -m "feat: add layer slug mapping utilities for URL-driven debug views"
```

---

## Chunk 2: Debug Screen URL Params

### Task 2: Read URL params on DebugScreen init

**Files:**
- Modify: `src/ui/DebugScreen.js:26-48` (constructor), `src/ui/DebugScreen.js:225-248` (`_generate`)

- [ ] **Step 1: Update constructor to read URL params**

In the `DebugScreen` constructor, after setting initial state and before `_buildUI()`, read URL params:

```js
// In constructor, after this.currentLayerIndex = 0; (line 34)
// Read URL params for initial state
const params = new URLSearchParams(location.search);
this._initialArchetype = params.get('archetype') || 'auto';
this._initialTick = Math.min(7, parseInt(params.get('tick')) || 0);
this._initialLens = params.get('lens') || null;
```

- [ ] **Step 2: Apply archetype param to selector in _buildUI**

After `this.archSelect.value = 'auto';` (line 112), override with the URL param:

```js
if (this._initialArchetype === 'none') {
  this.archSelect.value = '';
} else if (this._initialArchetype && this._initialArchetype !== 'auto') {
  this.archSelect.value = this._initialArchetype;
} else {
  this.archSelect.value = 'auto';
}
```

- [ ] **Step 3: Apply lens param to layer index in _buildUI**

After `this._updateLayerButtons();` (line 188), apply lens from URL:

```js
if (this._initialLens) {
  const idx = layerIndexFromSlug(this._initialLens);
  if (idx >= 0) {
    this.currentLayerIndex = idx;
    this._updateLayerButtons();
  }
}
```

Add import at the top of the file:
```js
import { LAYERS, layerSlug, layerIndexFromSlug } from '../rendering/debugLayers.js';
```
(Replace the existing `import { LAYERS } from '../rendering/debugLayers.js';`)

- [ ] **Step 4: Auto-advance to tick on generate**

At the end of `_generate()`, after `this._render()` (line 247), auto-advance to the requested tick:

```js
// Auto-advance to URL-requested tick
if (this._initialTick > 0) {
  const target = this._initialTick;
  this._initialTick = 0; // only on first generate
  for (let i = 0; i < target && this._strategy; i++) {
    this._strategy.tick();
    this.currentTick++;
  }
  const label = TICK_LABELS[this.currentTick] || 'done';
  this.tickLabel.textContent = `Tick: ${this.currentTick} (${label})`;
  this._updateInfo();
  this._render();
}
```

- [ ] **Step 5: Verify manually**

Run: `npx vite` and open `?seed=42&mode=debug&gx=3&gz=5&archetype=marketTown&tick=5&lens=reservations`
Expected: Debug screen loads with marketTown selected, advanced to tick 5, showing reservations layer

- [ ] **Step 6: Commit**

```bash
git add src/ui/DebugScreen.js
git commit -m "feat: read archetype, tick, lens URL params on debug screen init"
```

### Task 3: Write URL params on DebugScreen state changes

**Files:**
- Modify: `src/ui/DebugScreen.js:305-318` (`_updateURL`), layer button click handlers, tick handlers, archetype handler

- [ ] **Step 1: Extend _updateURL to include archetype, tick, and lens**

Replace the `_updateURL()` method (lines 305-318):

```js
_updateURL() {
  const url = new URL(location.href);
  url.searchParams.set('seed', this.seed);
  url.searchParams.set('mode', 'debug');
  url.searchParams.set('gx', this.settlement.gx);
  url.searchParams.set('gz', this.settlement.gz);

  // Archetype
  const archVal = this.archSelect.value;
  if (archVal === '') {
    url.searchParams.set('archetype', 'none');
  } else if (archVal) {
    url.searchParams.set('archetype', archVal);
  }

  // Tick
  url.searchParams.set('tick', this.currentTick);

  // Lens
  const currentLayer = LAYERS[this.currentLayerIndex];
  if (currentLayer) {
    url.searchParams.set('lens', layerSlug(currentLayer.name));
  }

  // Cell detail
  if (this._selectedCell) {
    url.searchParams.set('col', this._selectedCell.col);
    url.searchParams.set('row', this._selectedCell.row);
  } else {
    url.searchParams.delete('col');
    url.searchParams.delete('row');
  }
  history.replaceState(null, '', url);
}
```

- [ ] **Step 2: Call _updateURL from layer button clicks**

In `_buildUI()`, update the layer button onclick (around line 156-159):

```js
btn.onclick = () => {
  this.currentLayerIndex = i;
  this._updateLayerButtons();
  this._updateURL();
  this._render();
};
```

- [ ] **Step 3: Call _updateURL from tick changes**

In `_nextTick()`, add `this._updateURL();` after updating the tick label (after line 257).

- [ ] **Step 4: Call _updateURL from archetype changes**

Add an onchange handler to `this.archSelect` in `_buildUI()`, after appending all options (after line 114):

```js
this.archSelect.onchange = () => {
  this._generate(); // _generate() calls _updateURL() internally
};
```

- [ ] **Step 5: Also update URL in _generate**

In `_generate()`, replace the existing URL update block (lines 237-242) with a call to `this._updateURL();`

- [ ] **Step 6: Verify manually**

Run: `npx vite`, open debug screen, change archetype/tick/layer and verify URL updates in the address bar. Copy URL, paste in new tab, verify same state loads.

- [ ] **Step 7: Commit**

```bash
git add src/ui/DebugScreen.js
git commit -m "feat: sync archetype, tick, lens to URL on debug screen state changes"
```

---

## Chunk 3: Compare Archetypes Screen

### Task 4: Create CompareArchetypesScreen

**Files:**
- Create: `src/ui/CompareArchetypesScreen.js`
- Reference: `src/ui/CompareScreen.js` (existing pattern to follow)

- [ ] **Step 1: Create the screen file**

Create `src/ui/CompareArchetypesScreen.js`:

```js
import { setupCity } from '../city/setup.js';
import { LAYERS, layerSlug, layerIndexFromSlug } from '../rendering/debugLayers.js';
import { ARCHETYPES } from '../city/archetypes.js';
import { LandFirstDevelopment } from '../city/strategies/landFirstDevelopment.js';
import { SeededRandom } from '../core/rng.js';

const ARCHETYPE_KEYS = Object.keys(ARCHETYPES);

const TICK_LABELS = [
  'setup', 'skeleton', 'land value', 'zones',
  'spatial layers', 'reservations', 'ribbons', 'connections',
];

export class CompareArchetypesScreen {
  constructor(container, layers, settlement, seed, onBack) {
    this.container = container;
    this.layers = layers;
    this.settlement = settlement;
    this.seed = seed;
    this.onBack = onBack;
    this._disposed = false;

    // Read URL params
    const params = new URLSearchParams(location.search);
    const archParam = params.get('archetypes');
    this.selectedArchetypes = archParam
      ? archParam.split(',').filter(k => ARCHETYPES[k])
      : [...ARCHETYPE_KEYS];
    this.currentTick = Math.min(7, parseInt(params.get('tick')) || 0);
    const lensParam = params.get('lens');
    this.currentLayerIndex = (lensParam && layerIndexFromSlug(lensParam) >= 0)
      ? layerIndexFromSlug(lensParam)
      : 0;

    this.maps = {};       // archetype key → FeatureMap
    this.strategies = {};  // archetype key → LandFirstDevelopment

    this._buildUI();
    this._generate();
  }

  _buildUI() {
    this.container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex; flex-direction:column; height:100vh; background:#1a1a2e; color:#eee; font-family:monospace;';

    // Top controls bar
    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex; gap:12px; align-items:center; padding:8px 12px; border-bottom:1px solid #333; flex-wrap:wrap;';

    // Title
    const title = document.createElement('span');
    title.textContent = 'Compare Archetypes';
    title.style.cssText = 'font-size:14px; font-weight:bold; color:#88aaff;';
    controls.appendChild(title);

    // Tick controls
    const tickRow = document.createElement('span');
    tickRow.style.cssText = 'display:flex; gap:4px; align-items:center;';
    this.tickLabel = document.createElement('span');
    this.tickLabel.style.cssText = 'font-size:12px; min-width:90px;';
    tickRow.appendChild(this.tickLabel);

    const prevBtn = document.createElement('button');
    prevBtn.textContent = '◀';
    prevBtn.style.cssText = 'background:#335; color:#eee; border:1px solid #557; padding:2px 8px; cursor:pointer; font-family:monospace;';
    prevBtn.onclick = () => this._setTick(Math.max(0, this.currentTick - 1));
    tickRow.appendChild(prevBtn);

    const nextBtn = document.createElement('button');
    nextBtn.textContent = '▶';
    nextBtn.style.cssText = 'background:#335; color:#eee; border:1px solid #557; padding:2px 8px; cursor:pointer; font-family:monospace;';
    nextBtn.onclick = () => this._setTick(Math.min(7, this.currentTick + 1));
    tickRow.appendChild(nextBtn);
    controls.appendChild(tickRow);

    // Lens dropdown
    this.lensSelect = document.createElement('select');
    this.lensSelect.style.cssText = 'background:#2a2a3e; color:#eee; border:1px solid #555; padding:3px; font-family:monospace; font-size:11px;';
    for (let i = 0; i < LAYERS.length; i++) {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = LAYERS[i].name;
      this.lensSelect.appendChild(opt);
    }
    this.lensSelect.value = this.currentLayerIndex;
    this.lensSelect.onchange = () => {
      this.currentLayerIndex = parseInt(this.lensSelect.value);
      this._updateURL();
      this._renderAll();
    };
    controls.appendChild(this.lensSelect);

    // Archetype checkboxes
    const archRow = document.createElement('span');
    archRow.style.cssText = 'display:flex; gap:8px; align-items:center;';
    this._archCheckboxes = {};
    for (const key of ARCHETYPE_KEYS) {
      const label = document.createElement('label');
      label.style.cssText = 'font-size:11px; display:flex; align-items:center; gap:2px; cursor:pointer;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = this.selectedArchetypes.includes(key);
      cb.onchange = () => {
        this.selectedArchetypes = ARCHETYPE_KEYS.filter(k => this._archCheckboxes[k].checked);
        if (this.selectedArchetypes.length === 0) {
          cb.checked = true;
          this.selectedArchetypes = [key];
        }
        this._updateURL();
        this._rebuildGrid();
        this._generate();
      };
      this._archCheckboxes[key] = cb;
      label.appendChild(cb);
      label.appendChild(document.createTextNode(ARCHETYPES[key].name));
      archRow.appendChild(label);
    }
    controls.appendChild(archRow);

    // Back button
    const backBtn = document.createElement('button');
    backBtn.textContent = 'Back';
    backBtn.style.cssText = 'background:#444; color:#eee; border:1px solid #666; padding:3px 10px; cursor:pointer; font-family:monospace; font-size:11px; margin-left:auto;';
    backBtn.onclick = () => this.onBack();
    controls.appendChild(backBtn);

    wrapper.appendChild(controls);

    // Grid area
    this._gridArea = document.createElement('div');
    this._gridArea.style.cssText = 'flex:1; overflow:hidden; padding:4px;';
    wrapper.appendChild(this._gridArea);

    this.container.appendChild(wrapper);

    // Keyboard shortcut
    this._onKeyDown = (e) => {
      if (e.key === 'ArrowRight') this._setTick(Math.min(7, this.currentTick + 1));
      if (e.key === 'ArrowLeft') this._setTick(Math.max(0, this.currentTick - 1));
    };
    document.addEventListener('keydown', this._onKeyDown);

    this._rebuildGrid();
  }

  _rebuildGrid() {
    this._gridArea.innerHTML = '';
    const count = this.selectedArchetypes.length;
    const cols = count <= 2 ? count : count <= 4 ? 2 : 3;
    this._gridArea.style.display = 'grid';
    this._gridArea.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    this._gridArea.style.gap = '4px';

    this._panels = {};
    for (const key of this.selectedArchetypes) {
      const cell = document.createElement('div');
      cell.style.cssText = 'display:flex; flex-direction:column; min-height:0; overflow:hidden;';

      const label = document.createElement('div');
      label.style.cssText = 'font-size:11px; color:#88aaff; text-align:center; padding:2px 0; flex-shrink:0;';
      label.textContent = ARCHETYPES[key].name;
      cell.appendChild(label);

      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'flex:1; width:100%; image-rendering:pixelated; cursor:pointer; object-fit:contain;';
      canvas.onclick = () => {
        // Navigate to debug screen for this archetype
        const url = new URL(location.href);
        url.searchParams.set('mode', 'debug');
        url.searchParams.set('archetype', key);
        url.searchParams.set('tick', this.currentTick);
        url.searchParams.set('lens', layerSlug(LAYERS[this.currentLayerIndex].name));
        url.searchParams.delete('archetypes');
        location.href = url.toString();
      };
      cell.appendChild(canvas);

      this._gridArea.appendChild(cell);
      this._panels[key] = canvas;
    }
  }

  _generate() {
    const rng = new SeededRandom(this.seed);
    const baseMap = setupCity(this.layers, this.settlement, rng.fork('city'));

    for (const key of this.selectedArchetypes) {
      const map = baseMap.clone();
      const strategy = new LandFirstDevelopment(map, { archetype: ARCHETYPES[key] });

      // Advance to current tick
      for (let t = 0; t < this.currentTick; t++) {
        strategy.tick();
      }

      this.maps[key] = map;
      this.strategies[key] = strategy;
    }

    this._updateTickLabel();
    this._updateURL();
    this._renderAll();
  }

  _setTick(tick) {
    if (tick === this.currentTick) return;
    this.currentTick = tick;
    this._generate();
  }

  _updateTickLabel() {
    const label = TICK_LABELS[this.currentTick] || 'done';
    this.tickLabel.textContent = `Tick: ${this.currentTick} (${label})`;
  }

  _updateURL() {
    const url = new URL(location.href);
    url.searchParams.set('seed', this.seed);
    url.searchParams.set('mode', 'compare-archetypes');
    url.searchParams.set('gx', this.settlement.gx);
    url.searchParams.set('gz', this.settlement.gz);
    url.searchParams.set('tick', this.currentTick);
    url.searchParams.set('lens', layerSlug(LAYERS[this.currentLayerIndex].name));

    if (this.selectedArchetypes.length < ARCHETYPE_KEYS.length) {
      url.searchParams.set('archetypes', this.selectedArchetypes.join(','));
    } else {
      url.searchParams.delete('archetypes');
    }

    history.replaceState(null, '', url);
  }

  _renderAll() {
    if (this._disposed) return;
    const layer = LAYERS[this.currentLayerIndex];
    if (!layer || !layer.render) return;

    for (const key of this.selectedArchetypes) {
      const map = this.maps[key];
      const canvas = this._panels[key];
      if (!map || !canvas) continue;

      canvas.width = map.width;
      canvas.height = map.height;
      const ctx = canvas.getContext('2d');
      layer.render(ctx, map);
    }
  }

  dispose() {
    this._disposed = true;
    if (this._onKeyDown) {
      document.removeEventListener('keydown', this._onKeyDown);
    }
    this.container.innerHTML = '';
  }
}
```

- [ ] **Step 2: Verify file created**

Run: `ls src/ui/CompareArchetypesScreen.js`
Expected: file exists

- [ ] **Step 3: Commit**

```bash
git add src/ui/CompareArchetypesScreen.js
git commit -m "feat: add CompareArchetypesScreen for side-by-side archetype comparison"
```

---

## Chunk 4: Wiring

### Task 5: Wire CompareArchetypesScreen into main.js

**Files:**
- Modify: `src/main.js:1-8` (imports), `src/main.js:14-16` (state), `src/main.js:18-26` (disposeAll), `src/main.js:32-49` (enterSubScreen), `src/main.js:70-103` (popstate), `src/main.js:106-137` (deep-link)

- [ ] **Step 1: Add import**

Add after line 4 (`import { CompareScreen }`):

```js
import { CompareArchetypesScreen } from './ui/CompareArchetypesScreen.js';
```

- [ ] **Step 2: Add state variable**

Add after line 14 (`let compareScreen = null;`):

```js
let compareArchetypesScreen = null;
```

- [ ] **Step 3: Update disposeAll**

In `disposeAll()`, add after the `compareScreen` disposal (after line 22):

```js
if (compareArchetypesScreen) { compareArchetypesScreen.dispose(); compareArchetypesScreen = null; }
```

- [ ] **Step 4: Update enterSubScreen**

In `enterSubScreen()`, add a case for `compare-archetypes` after the `compare` case (after line 41):

```js
} else if (mode === 'compare-archetypes') {
  compareArchetypesScreen = new CompareArchetypesScreen(container, layers, settlement, seed, goBack);
```

- [ ] **Step 5: Update popstate handler**

In the popstate handler, after the `compare` case (after line 95), add:

```js
} else if (mode === 'compare-archetypes') {
  compareArchetypesScreen = new CompareArchetypesScreen(container, layers, settlement, seed, goBack);
```

- [ ] **Step 6: Update deep-link check**

In the deep-link section (line 114), add `'compare-archetypes'` to the mode check:

```js
if ((urlMode === 'debug' || urlMode === 'city' || urlMode === 'compare' || urlMode === 'compare-archetypes') && urlSeed != null) {
```

**Important:** The deep-link pushState at line 122 reconstructs the URL from scratch, dropping extra params like `archetype`, `tick`, `lens`, and `archetypes`. Fix this to preserve the full original URL:

```js
// Replace lines 121-122:
history.replaceState(null, '', `?seed=${urlSeed}`);
history.pushState(null, '', location.search);
```

Change to:

```js
const fullSearch = location.search;
history.replaceState(null, '', `?seed=${urlSeed}`);
history.pushState(null, '', fullSearch);
```

And add a case in the if/else chain (after line 128):

```js
} else if (urlMode === 'compare-archetypes') {
  compareArchetypesScreen = new CompareArchetypesScreen(container, layers, settlement, urlSeed, goBack);
```

- [ ] **Step 7: Commit**

```bash
git add src/main.js
git commit -m "feat: wire CompareArchetypesScreen into main.js routing"
```

### Task 6: Add navigation button to RegionScreen

**Files:**
- Modify: `src/ui/RegionScreen.js` (add onCompareArchetypes callback and button)
- Modify: `src/main.js:51-67` (showRegion — add callback)

- [ ] **Step 1: Add callback to showRegion in main.js**

In `showRegion()`, add a new callback after `onCompare` (after line 55):

```js
onCompareArchetypes(layers, settlement, seed) { enterSubScreen('compare-archetypes', layers, settlement, seed); },
```

- [ ] **Step 2: Add button to RegionScreen**

In `RegionScreen.js`, store the callback in the constructor (alongside existing callbacks like `this.onCompare`):

```js
this.onCompareArchetypes = callbacks.onCompareArchetypes || null;
```

In `_buildUI()`, add a button after the "Compare Growth" button block (following the same pattern as `_compareBtn`):

```js
if (this.onCompareArchetypes) {
  this._compareArchetypesBtn = this._makeBtn('Compare Archetypes', () => {
    if (this._layers && this._selectedSettlement && this.onCompareArchetypes) {
      this.onCompareArchetypes(this._layers, this._selectedSettlement, this._seed);
    }
  });
  this._compareArchetypesBtn.style.opacity = '0.5';
  this._compareArchetypesBtn.style.background = '#353';
  btnRow.appendChild(this._compareArchetypesBtn);
}
```

In `_selectSettlement()`, add opacity/disabled handling alongside the existing button updates:

```js
if (this._compareArchetypesBtn) {
  this._compareArchetypesBtn.style.opacity = settlement ? '1' : '0.5';
  this._compareArchetypesBtn.disabled = !settlement;
}
```

- [ ] **Step 3: Add "Compare Archetypes" button to DebugScreen**

In `DebugScreen._buildUI()`, add a button before the "Back to Region" button (before line 171):

```js
const compareBtn = document.createElement('button');
compareBtn.textContent = 'Compare Archetypes';
compareBtn.style.cssText = 'background:#446; color:#eee; border:1px solid #668; padding:6px 12px; cursor:pointer; font-family:monospace; margin-top:8px;';
compareBtn.onclick = () => {
  const url = new URL(location.href);
  url.searchParams.set('mode', 'compare-archetypes');
  url.searchParams.delete('archetype');
  url.searchParams.delete('col');
  url.searchParams.delete('row');
  url.searchParams.set('tick', this.currentTick);
  url.searchParams.set('lens', layerSlug(LAYERS[this.currentLayerIndex].name));
  location.href = url.toString();
};
panel.appendChild(compareBtn);
```

- [ ] **Step 4: Verify manually**

Run: `npx vite`
- From region screen, click "Compare Archetypes" button → should open compare-archetypes screen with all 5 archetypes
- From debug screen, click "Compare Archetypes" → should open compare screen preserving current tick and lens
- Click a panel → should navigate to debug screen for that archetype
- Use browser back → should return to previous view
- Paste a deep-link URL → should load correct state

- [ ] **Step 5: Commit**

```bash
git add src/main.js src/ui/RegionScreen.js src/ui/DebugScreen.js
git commit -m "feat: wire Compare Archetypes navigation from region and debug screens"
```
