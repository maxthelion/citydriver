# V5 Migration Plan

## Principle

Start fresh with the learnings, not the messy code. The specs (statement-of-intent, technical-reference, feature-map-architecture) capture everything worth keeping. The new code should be written from scratch, consulting the specs for proven constants and algorithms.

## What to keep (don't delete)

### Core utilities
These are generic, well-tested, and have no city-pipeline debt:

- `src/core/Grid2D.js` — grid data structure
- `src/core/LayerStack.js` — layer management
- `src/core/PlanarGraph.js` — road graph (face extraction, split edge, Dijkstra)
- `src/core/UnionFind.js` — connectivity
- `src/core/noise.js` — Perlin noise
- `src/core/math.js` — distance, lerp, clamp
- `src/core/rng.js` — seeded random
- `src/core/pathfinding.js` — A* (generic, useful for any routing)
- `src/core/riverGeometry.js` — shared river formulas (width, depth, profile, Chaikin, painting)
- `src/core/flowAccumulation.js` — drainage computation

### Regional pipeline
Stable, no changes needed:

- `src/regional/` — entire directory (pipeline.js, generateGeology.js, generateTerrain.js, generateHydrology.js, generateCoastline.js, generateSettlements.js, generateRoads.js, generateFarms.js, generateMarketTowns.js, growSettlements.js, generateLandCover.js, validators.js)

### UI shell
The screen structure and routing:

- `src/ui/App.js` — route between screens
- `src/ui/RegionScreen.js` — region viewer + settlement selection
- `src/ui/FlyCamera.js` — camera controls
- `src/ui/LoadingOverlay.js` — loading indicator
- `src/ui/regionHelper.js` — region utilities
- `src/ui/ScorePanel.js` — validation display

### 3D rendering (region level)
- `src/rendering/regionPreview3D.js` — 3D region viewer
- `src/rendering/terrainMesh.js` — terrain rendering
- `src/rendering/waterMesh.js` — water rendering
- `src/rendering/materials.js` — shared materials

### Validators
- `src/validators/framework.js` — validation framework

### Entry point
- `src/main.js` — app entry

## What to delete

### City pipeline (all of it)
Every file in `src/city/` will be rewritten from scratch. The current code has accumulated too much coordination debt (manual bitmap updates, resolution mismatches, fragile pipeline ordering).

```
DELETE src/city/blockSubdivision.js
DELETE src/city/buildability.js
DELETE src/city/classifyWater.js
DELETE src/city/closeLoops.js
DELETE src/city/connectNuclei.js
DELETE src/city/extractCityContext.js
DELETE src/city/extractWaterPolygons.js
DELETE src/city/generateAmenities.js
DELETE src/city/generateAnchorRoutes.js
DELETE src/city/generateBuildings.js
DELETE src/city/generateInstitutionalPlots.js
DELETE src/city/generateLandCover.js
DELETE src/city/generateStreetsAndPlots.js
DELETE src/city/growCity.js
DELETE src/city/importRivers.js
DELETE src/city/interactivePipeline.js
DELETE src/city/neighborhoodInfluence.js
DELETE src/city/pathCost.js
DELETE src/city/pipeline.js
DELETE src/city/pipelineDebug.js
DELETE src/city/placeNeighborhoods.js
DELETE src/city/refineTerrain.js
DELETE src/city/riverCrossings.js
DELETE src/city/roadNetwork.js
DELETE src/city/roadOccupancy.js
DELETE src/city/seedNuclei.js
DELETE src/city/terrainFields.js
```

The algorithms worth preserving (buildability scoring, pathCost presets, nucleus placement, water classification, marching squares, channel carving, anchor route import, Union-Find MST) are documented in `specs/v5/technical-reference.md`. They'll be reimplemented inside the new FeatureMap architecture.

### City-specific rendering
```
DELETE src/rendering/buildingMesh.js
DELETE src/rendering/roadMesh.js
DELETE src/rendering/parkMesh.js
DELETE src/rendering/schematicRenderer.js
```
These depend on the old city data model (plots, buildings, amenities). Will be rewritten when the new growth algorithm produces output.

### City-specific debug rendering
```
DELETE src/rendering/debugTiles.js
DELETE src/rendering/layerRenderers.js
```
The debug viewer concept is kept but rendering functions need to match the new FeatureMap data model.

### City UI screens
```
DELETE src/ui/CityScreen.js
DELETE src/ui/DebugScreen.js
```
Will be rewritten to work with the new interactive pipeline and FeatureMap.

### City validators
```
DELETE src/validators/cityValidators.js
```
Will be rewritten for the new data model.

### Obsolete core
```
DELETE src/core/mergeRoadPaths.js
```
Road merging was fragile. New architecture should avoid the need for it.

## What to build (new files)

### Phase 1: FeatureMap + Debug Viewer
Build the map class and debug viewer first. This is the foundation everything else builds on.

```
NEW src/core/FeatureMap.js        — features + derived layers, addFeature()
NEW src/city/setup.js             — tick 0: extract context, refine terrain, import water/rivers
NEW src/city/skeleton.js          — tick 1: place nuclei, connect to road network
NEW src/ui/DebugScreen.js         — tick-by-tick viewer with layer composition
NEW src/rendering/debugLayers.js  — layer renderers reading from FeatureMap
```

### Phase 2: Growth Algorithm
Prototype growth approaches using the debug viewer for evaluation.

```
NEW src/city/growth.js            — tick 2+: the growth algorithm (TBD)
NEW src/city/plots.js             — plot placement along road frontage
```

### Phase 3: Finishing
Once growth produces good results:

```
NEW src/city/buildings.js         — building placement on plots
NEW src/city/amenities.js         — schools, parks, commercial
NEW src/ui/CityScreen.js          — 3D city view
NEW src/rendering/cityMeshes.js   — road/building/park rendering
```

## Spec files

### Keep and update
- `specs/v5/statement-of-intent.md` — the v5 vision
- `specs/v5/technical-reference.md` — proven constants and algorithms
- `specs/v5/feature-map-architecture.md` — FeatureMap design

### Archive (move to specs/v4/)
All existing v5 specs that describe the old system:
```
ARCHIVE specs/v5/bitmap-pipeline.md → specs/v4/archive/
ARCHIVE specs/v5/city-data-model.md → specs/v4/archive/
ARCHIVE specs/v5/interactive-debug-viewer.md → specs/v4/archive/
ARCHIVE specs/v5/nucleus-connectivity.md → specs/v4/archive/
ARCHIVE specs/v5/observations.md → specs/v4/archive/
```

## Order of operations

1. Archive old v5 specs → `specs/v4/archive/`
2. Delete `src/city/` entirely
3. Delete city-specific rendering, UI, and validators
4. Delete `src/core/mergeRoadPaths.js`
5. Commit: "V5: clean slate — delete city pipeline, keep regional + core"
6. Build Phase 1 (FeatureMap + debug viewer)
7. Build Phase 2 (growth algorithm exploration)
8. Build Phase 3 (finishing)
