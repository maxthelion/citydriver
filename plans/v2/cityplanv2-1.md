# Plan: Rewrite City Generation — 8-Phase Pipeline from cityplan.md

## Context

The current 5-pass city generation pipeline (terrain → roads → blocks → land use → buildings) produces cities that lack proper urban structure — no density gradient, no district differentiation, uniform street grids. The new spec (`specs/v2/cityplan.md`) defines an 8-phase pipeline that produces realistic cities shaped by terrain, density fields, and district character. The user wants all current generation code removed and a fresh implementation.

## What Gets Deleted

All 9 files in `src/generation/`:
- `pipeline.js`, `terrain.js`, `river.js`, `coast.js`, `primaryRoads.js`, `secondaryRoads.js`, `landUse.js`, `buildings.js`, `graph.js`

Old tests: `test/generation/cityPipeline.test.js`, `test/generation/buildings.test.js`

## What's Kept

**Core utilities** (`src/core/`): `heightmap.js`, `rng.js`, `noise.js`, `pathfinding.js`, `math.js` — all unchanged.

**Rendering** (`src/rendering/`): `roadMesh.js`, `buildingMesh.js`, `bridgeMesh.js`, `parkMesh.js` — minor updates for new hierarchy values.

**Regional** (`src/regional/`): `region.js` and `extractCityContext` — unchanged. CityContext is the input to the new pipeline.

## New File Structure

```
src/generation/
  pipeline.js           — Orchestrator (8 phases + feedback loops)
  graph.js              — Graph utilities (ported + new: betweenness, voronoi)
  phase1Terrain.js      — Terrain prep, water, zones, anchors
  phase2Arterials.js    — Primary network via A*, waterfront routes, bridges
  phase3Density.js      — Density field from weighted attractors
  phase4Districts.js    — District division, character, collector roads, plazas
  phase5Streets.js      — Local streets, block subdivision, alleys
  phase6Plots.js        — Plot subdivision per district type
  phase7Buildings.js    — Building footprint & massing, landmarks
  phase8Amenities.js    — Amenity placement, betweenness centrality
```

## Key Data Structures

### TerrainData (Phase 1 → consumed by all later phases)
```js
{
  heightmap: Heightmap,            // Refined + frozen
  seaLevel: number,
  waterCells: Set<number>,         // River channel + coast (grid indices)
  waterExclusion: Set<number>,     // Floodplain + coast buffer
  terrainZones: Uint8Array,        // Per-cell: 0=FLAT_LOW, 1=FLAT_ELEVATED, 2=GENTLE, 3=STEEP, 4=HILLTOP
  slopeMap: Float32Array,          // Per-cell slope magnitude
  anchorPoints: [{x, z, type, score}],  // river_crossing, harbor, hilltop, confluence
  rivers: [{centerline, width, floodplainWidth}],
  coast: {seaLevel, coastCells, shorelinePoints} | null,
}
```

### RoadNetwork (accumulated through phases 2, 4, 5)
```js
Node: { id, x, z, gx, gz, type }  // types: center, entry, intersection, bridge, plaza
Edge: { id, from, to, points, width, hierarchy, districtId }
      // hierarchy: 'primary' | 'secondary' | 'collector' | 'local' | 'alley'
Bridge: { edgeId, startPoint, endPoint, deckHeight, width }
```

### DensityField (Phase 3)
```js
{
  grid: Float32Array,  cellSize: number,  gridWidth: number,
  districtCenters: [{x, z, density, type}],
  targetPopulation: number,
  sampleDensity(wx, wz): number,  // bilinear lookup
}
```

### District (Phase 4), Block (Phase 5), Plot (Phase 6), Building (Phase 7)

Districts have `character`: commercial_core, industrial_docks, mixed_use, dense_residential, suburban_residential, parkland.

Plots carry `flags: Set` with corner, plaza_facing, landmark_site, merged.

Buildings match the existing renderer interface: `{x, z, w, d, h, rotation, floors, style, wallMaterial, roofType, roofMaterial, doorFace, doorPosition}`.

## Phase Implementation Details

### Phase 1: Terrain Preparation (`phase1Terrain.js`)

**Port** from existing code:
- Heightmap refinement (regional bilinear + detail noise) from `terrain.js`
- River centerline + carving from `river.js` (RIVER_CONSTANTS, 3-zone carving)
- Coast depression from `coast.js`

**New:**
- Terrain zone classification: slope thresholds (0.03, 0.15) + elevation relative to water → 5 zone types
- Anchor point detection: river crossing candidates (narrowest + flattest bank), harbor indentations (coast concavity), hilltops (local maxima at radius ~20 cells), confluences
- Water exclusion BFS: expand waterCells outward by buffer distance

### Phase 2: Primary Network (`phase2Arterials.js`)

**Port** from `primaryRoads.js`:
- A* routing with `terrainCostFunction` from `core/pathfinding.js`
- `simplifyPath` + `smoothPath` for road geometry
- `detectBridges` for water crossing detection
- Intersection detection at road crossings

**New:**
- City seed at highest-scoring anchor (not just cityContext.center)
- Waterfront routes: offset river centerline/shoreline by buffer, connect to nearest arterial
- Cross-links: connect arterial pairs within maxDistance that lack connection
- Width assignment: primary 20-30m, secondary 15-20m, narrowing in historic core

### Phase 3: Density Field (`phase3Density.js`)

**Entirely new.** Port the BFS distance-transform concept from `secondaryRoads.js` suitability field.

Five weighted attractors summed per cell:
- Seed distance (0.35): inverse falloff from city center
- Road proximity (0.25): BFS distance from rasterized arterials
- Waterfront (0.15): bonus for desirable waterfront, penalty for industrial
- Terrain (0.15): flat elevated land bonus, steep/floodplain penalty
- Bridge nodes (0.10): local spike at bridge approaches

Peak detection: local maxima at radius ~30 cells → district center candidates.
Normalization: scale so integral ≈ target population (city: 50-200k, town: 5-20k, village: 500-2k).

### Phase 4: Districts + Collectors (`phase4Districts.js`)

**Port** from existing:
- `rasterizeRoads` + `floodFillRegions` + `extractBoundary` from `graph.js` for district boundary extraction
- Grid/organic/mixed road generation concepts from `secondaryRoads.js`

**New:**
- Voronoi subdivision for oversized districts (assign cells to nearest seed, extract boundaries)
- District character from density + terrain: high+central→commercial_core, high+waterfront→industrial, medium-high→mixed_use, medium→dense_residential, low→suburban, steep→parkland
- Collector roads (width 12m) within each district, strategy chosen by terrain
- Plaza placement at district centers (widen intersection)

### Phase 5: Local Streets + Blocks (`phase5Streets.js`)

**Port** from existing:
- Block detection pipeline from `graph.js`
- Road emission helpers from `secondaryRoads.js`

**New:**
- Density-driven street spacing: `lerp(30, 150, 1 - density)` per block
- Back alleys (width 4m) in dense areas (density > 0.7)
- Triangular block detection → tag for park/landmark
- Corner plot identification at road intersections

### Phase 6: Plot Subdivision (`phase6Plots.js`)

**Port** from `landUse.js`:
- Frontage detection and plot-stamping loop
- Setback computation

**New:**
- District-driven dimensions table (from spec: commercial 6-10m frontage, terraced 5-7m, etc.)
- ±10-15% random variation per plot
- Block interior handling (back-to-back in dense, gardens in sparse)
- Plot merging for corners, plazas, landmarks

### Phase 7: Buildings (`phase7Buildings.js`)

**Port** from `buildings.js`:
- Building template functions (terrace, apartment, suburban, commercial, industrial, civic)
- Material and roof type selection
- Rotation from front edge, door positioning

**New:**
- Perimeter block type (wraps block edge, interior courtyard)
- Density-driven height (from density field, not just distance)
- Street consistency: sweep terraces on same street, enforce modal height
- Landmark rules: hilltop→church, plaza→town hall, bridge→inn, corner→pub
- Party wall flags for terraced rows

### Phase 8: Amenities (`phase8Amenities.js`)

**Entirely new.**
- Population from density field integral over residential areas
- Catchment-based placement: parks/400m, schools/5-10k people, clinics, churches, etc.
- Betweenness centrality (Brandes algorithm) on road graph
- Top 15-20% centrality edges → commercial frontage rezoning
- Commercial clusters at density peaks

### Feedback Loops (in pipeline.js)

- **Loop A** (after Phase 3): underserved density peaks get new collector road to nearest arterial
- **Loop B** (after Phase 7): awkward plots merged/flagged as open space, re-run Phase 7 for affected plots
- **Loop C** (after Phase 8): upgrade local streets serving amenities to collector width
- **Loop D** (after Phase 8): rezone high-centrality residential frontages to mixed_use

Each loop runs once (not iterative).

## Rendering Updates

Minor changes only — the new pipeline outputs data compatible with existing renderers:

- **`roadMesh.js`**: Add fallback for `'collector'` and `'local'` hierarchy → use `road_secondary` material
- **`buildingMesh.js`**: Extend industrial window-skip check to include `'warehouse'`
- **`main.js`**: Update park block filter from `b.landUse === 'park'` to `b.districtCharacter === 'parkland'`
- **`materials.js`**: Optionally add `road_collector` and `road_local` materials for visual distinction

## Implementation Stages

Each stage produces a driveable result:

| Stage | Phases | Result |
|-------|--------|--------|
| 1 | 1-2 | Terrain + arterial roads + bridges. Driveable landscape with main roads. |
| 2 | 3 | + density field (invisible data layer, foundation for everything after) |
| 3 | 4 | + districts + collector roads. Visible road network with hierarchy. |
| 4 | 5 | + local streets + blocks. Full street network, density-driven spacing. |
| 5 | 6-7 | + plots + buildings. Buildings matching district character. |
| 6 | 8 + loops | + amenities, commercial frontages, feedback loop polish. |

**Propose starting with Stage 1** (Phases 1-2) as the first implementation task, then proceeding stage by stage.

## Tests

```
test/generation/
  phase1Terrain.test.js     — zones, anchors, water exclusion, river carving
  phase2Arterials.test.js   — routing, bridges, waterfront, seed placement
  phase3Density.test.js     — field correctness, peaks, normalization
  phase4Districts.test.js   — boundaries, character, collectors
  phase5Streets.test.js     — spacing, blocks, alleys
  phase6Plots.test.js       — dimensions, merging, flags
  phase7Buildings.test.js   — data contract, height gradient, landmarks
  phase8Amenities.test.js   — catchment, centrality, commercial
  cityPipeline.test.js      — full integration, determinism
```

## Verification

1. `npx vitest run` — all tests pass at each stage
2. Browser: drive around, verify terrain/roads/buildings match expected urban structure
3. Minimap: shows road hierarchy, district boundaries visible in density
4. Free cam: fly over city to verify district differentiation and density gradient
