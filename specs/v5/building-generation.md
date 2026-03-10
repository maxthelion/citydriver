# Building Generation System

## Philosophy

**Composability over configuration.** Buildings are constructed by chaining small, focused operations. Each operation does one thing — add a floor, add a roof, add windows. Complex buildings emerge from combining simple operations, not from complex configuration objects.

**The plot decides the building's size, not the building.** Land value drives plot parameters, plots determine footprints, and buildings fill the allocated space. This inverts the current approach where buildings pick their own random dimensions.

**Child features inherit from parents.** Porch roofs match the main roof pitch. Dormer roofs match the main roof pitch. Extension roofs inherit style. This creates visual coherence without explicit configuration.

**Deterministic generation enables LOD.** Given the same `(seed, typology, archetype, plot)`, the same building is produced every time. Geometry can be discarded and rebuilt at different detail levels as the camera moves. A city of 10,000 buildings stores ~50 bytes of recipe each and only materialises the nearest few hundred at full detail.

**Archetypes control _which_ operations; the composable API handles _how_.** The style system (archetypes, typologies) is a separate concern from the geometry system (the composable operations). This keeps both layers simple.

---

## Composable API — What's Built

All functions take a `house` object and return it (mutation + return for chaining).

### Core

| Function | Purpose |
|----------|---------|
| `createHouse(width, depth, floorHeight, color)` | Creates a one-storey box. Returns the house object with `group`, dimensions, state. |
| `addFloor(house)` | Adds a storey. Rebuilds walls, moves roof up if present. |
| `removeFloor(house)` | Removes top storey (min 1). Rebuilds walls, moves roof. |

### Roof

| Function | Purpose |
|----------|---------|
| `addPitchedRoof(house, pitch, direction, overhang)` | Pitched roof. Direction: `'sides'` (gable), `'frontback'` (gable), `'all'` (hip), `'mansard'`. Overhang extends eaves. Gable triangles extend with overhang. |

Roof is stored as `house._roofPitch` and `house._roofDirection` so child features can inherit.

Internal builders: `_gableRoofSides`, `_gableRoofFrontBack`, `_hipRoof`, `_mansardRoof` — all share `_quad`/`_tri` primitives for BufferGeometry construction.

### Doors

| Function | Purpose |
|----------|---------|
| `addFrontDoor(house, placement)` | Front door. Placement: `'left'`, `'center'`, `'right'`. Snaps to window grid via `_doorPositionOnGrid`. |
| `addBackDoor(house, placement)` | Back door at z=depth. Same placement options. |

Door positions stored as `house._doorX`, `house._doorW` (front) and `house._backDoorX`, `house._backDoorW` (back) for window skip logic.

### Windows

| Function | Purpose |
|----------|---------|
| `addWindows(house, { width, height, spacing, color })` | Windows on all 4 walls, all floors. Skips positions overlapping doors and bay windows. |
| `addWindowSills(house, { protrusion, thickness, color })` | Sills below every window. Iterates the windows group, places a box below each, offset outward by the wall rotation. |

### Porch

| Function | Purpose |
|----------|---------|
| `addPorch(house, { face, porchDepth, porchWidth, porchCenter, roofStyle })` | Covered porch on front or back. Floor slab, two posts, pitched roof. Roof styles: `'slope'` (lean-to), `'hip'` (3-sided), `'gable'` (side-pitched). Roof pitch inherited from main roof. `porchCenter` enables narrow porch centred on door. Stores porch info for `addGroundLevel`. |

### Bay Window

| Function | Purpose |
|----------|---------|
| `addBayWindow(house, { floors, style, span, depth, position })` | Front bay. Style: `'box'` (rectangular) or `'angled'` (canted sides). Span = window grid slots wide. Multi-storey. Lean-to pitched roof. Extends to ground when house is raised. Front wall windows skip bay footprint. |

### Balcony

| Function | Purpose |
|----------|---------|
| `addBalcony(house, floor, style)` | Per-floor balcony on front wall. Floor is 1-indexed (1 = first above ground). Style: `'full'` (full width, slab + railings + brackets) or `'window'` (individual balconies at each window position). |

### Dormer

| Function | Purpose |
|----------|---------|
| `addDormer(house, { position, width, height, depth, slopeFrac, style })` | Dormer on roof slope. Position 0–1 along ridge. Style: `'window'` (small window) or `'balcony'` (taller, door opening + protruding balcony with railings). Gable roof inherits main pitch. |

### Extension

| Function | Purpose |
|----------|---------|
| `addExtension(house, { widthFrac, extDepth, floors, side, roofDirection, roofPitch })` | Rear extension. Width as fraction of house (0.5 = half). Side: `'left'`, `'right'`, `'center'`. Own roof (reuses roof builders). Roof extends 1m back into main house to close gap. Windows on back and exposed side walls. |

### Ground Level

| Function | Purpose |
|----------|---------|
| `addGroundLevel(house, height)` | Raises house, adds foundation wall and cascading platform steps. If porch exists, steps come from porch front edge and posts extend to ground. Bay windows extend to ground. |

### Legacy

| Function | Purpose |
|----------|---------|
| `generateBuilding(style, recipe)` | Adapter bridging old `buildRecipe` output to composable API. |

---

## Style System — What's Built

In `src/buildings/styles.js`:

- 6 climate presets: cold, temperate, continental, mediterranean, tropical, arid
- `getClimateStyle(climate)` — returns architectural parameters (floor height, window proportions, roof type, colours, feature flags)
- `buildRecipe(style, plotSize, richness, seed)` — samples concrete values from style ranges using `SeededRandom`. Outputs a flat recipe object.
- `nudgeColor(hex, amount, rng)` — shifts RGB components randomly for per-building colour variation

---

## Building Lab UI

`src/ui/BuildingStyleScreen.js` — interactive single-house viewer with sidebar controls:

- Floor +/-, roof direction cycle, door placement cycle
- Porch on/off with width (full/door), roof style (slope/hip/gable), depth slider
- Back door cycle, back porch
- Bay window on/off with style, position, span, floors
- Extension on/off with width, side, floors, roof type
- Balcony style (off/full/window)
- Dormers +/- with style (window/balcony)
- Sliders: width, depth, floor height, roof pitch, eaves, window dimensions, porch depth, dormer width, sill depth, ground floor height
- Orbit camera: drag to rotate, scroll to zoom

---

## Observations & Future Directions

### Window Textures
Windows should show pane dividers as bitmap textures. Generate a sprite sheet procedurally on a canvas — mullion patterns (2x2, 2x3, Georgian multi-pane, arched) as lines on glass-coloured background. Select pattern based on window aspect ratio and climate style.

### Operation Validation
Many operations can produce degenerate results (dormers on flat roofs, bays wider than the house, balconies on removed floors). Approach: precondition checks in each function (safe no-ops with `house._warnings`), `canAdd()` predicates for the UI, reactive cleanup on mutations like `addFloor`/`removeFloor`.

### Irregular Quad Foundations
Real city plots are irregular quads, especially on curved streets. Pragmatic approach: build rectangular with the composable API, apply a 2D affine shear transform to fit the plot quad. Distortion is small on gentle curves and all existing operations work unchanged.

### Archetype System
Replace the flat climate/size/richness matrix with a hierarchical style system: Climate → District archetype → Street variation → Per-building randomisation. An archetype is a recipe template with parameter ranges. A typology determines which operations are applied. `instantiateHouse(typology, archetype, plot, seed)` is the single entry point.

### Building Typologies
Distinct types: detached, semi-detached, terraced (single/double-fronted), apartment block, commercial/mixed-use, corner building. Each is a preset controlling which operations apply and which walls are public. Key new primitive: `setPartyWalls(house, sides)` to suppress windows/features on party walls.

### Plot Density & Land Value
Land value drives plot subdivision, building footprint, and garden/setback allocation. High value = small plots, full coverage, tall buildings, no front garden. Low value = large plots, low coverage, front + back gardens. The building fills the plot footprint, it doesn't choose its own size.

### LOD Through Deterministic Regeneration
Buildings store only a lightweight recipe (~50 bytes). Geometry is regenerated on demand at the appropriate LOD level. LOD0 = extruded box. LOD1 = walls + roof shape. LOD2 = full detail. LOD3 = textures. Regenerate a few buildings per frame as camera moves. Batch distant buildings into merged geometry.

---

## Implementation Plan

### Phase 1: Complete the Composable Toolkit

| Task | Description |
|------|-------------|
| **Party walls** | `setPartyWalls(house, sides)` — suppress windows/features on specified sides. Trivial filter in `addWindows`. Unlocks terraced/semi-detached/apartment. |
| **Shop front** | `addShopFront(house, opts)` — large plate glass + recessed entrance on ground floor. Enables mixed-use commercial. |
| **Validation** | Precondition checks + `canAdd()` queries. Start with: dormer min pitch, bay max span, balcony floor range. |
| **Window textures** | Canvas-generated sprite sheet. Independent of other work. |

### Phase 2: Typology + Archetype Layer

| Task | Description |
|------|-------------|
| **Typologies** | Functions mapping `(footprint, seed)` → composable API call sequence. Start with: `victorianTerrace`, `detachedSuburban`, `hausmmannApartment`. |
| **Archetypes** | Named style templates with parameter ranges. Start with: Victorian, Georgian, Haussmann, Modernist. |
| **Street variation** | Per-road archetype + typology selection. Adjacent buildings share style, vary within ranges. |
| **`instantiateHouse`** | Single entry point replacing `buildRecipe` + `generateBuilding`. |

### Phase 3: Plot Pipeline

| Task | Description |
|------|-------------|
| **Density from land value** | Continuous mapping: `landValue → { plotWidth, setback, maxFloors, typologyWeights, ... }` |
| **Block-to-plot subdivision** | Walk road frontage, divide into plot-width intervals, project to block interior. Output: plot quads with shared party-wall edges. |
| **Footprint from plot** | Inset by setback/garden/sideGap → building footprint. |
| **Garden treatment** | Grass planes, paths, fence/wall boundaries in leftover space. |

### Phase 4: Geometry & Performance

| Task | Description |
|------|-------------|
| **Shear transform** | Affine transform from rectangle to plot quad. Applied post-generation. |
| **LOD system** | Recipe storage, LOD thresholds, per-frame regeneration budget, distant batching. |

### Parallelism

| Now | Next | Later |
|-----|------|-------|
| Party walls | Typology + archetype definitions | Block-to-plot subdivision |
| Validation | Street variation + instantiate | Footprint + gardens |
| Window textures | Density from land value | Shear transform + LOD |
| Shop front | | |

### First concrete milestone
Implement `setPartyWalls` + a `generateTerracedRow` function that produces a row of Victorian terraced houses. This validates the full concept: party walls, shared style with per-building variation, plot-width spacing, the composable API driving it all.
