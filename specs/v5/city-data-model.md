# V5: City Data Model — Feature Representations and Import

## The Problem

Each geographic feature (rivers, roads, coastline, terrain) exists in multiple representations — regional grids, vector paths, city grids, graph structures, 3D meshes — and the conversions between them are ad-hoc. This leads to:

- Rivers as zigzag fixed-width lines (grid-cell paths rendered at city zoom)
- Water boundaries that are blocky or smooth depending on which representation you look at
- Roads that exist as a graph but aren't reflected in the bitmaps they were pathfound on
- Terrain fields computed from grids that may not match the vector features

The pattern: **every feature needs to exist as both a city-resolution bitmap and a smooth vector path, computed once at import time, and both representations should be authoritative.**

## Current Data Flow

### Elevation / Terrain

| Stage | Representation | File |
|-------|---------------|------|
| Regional | Grid2D float32, 50m cells | `generateTerrain.js` |
| Import | Bilinear interpolation → 10m cells | `extractCityContext.js` |
| Refine | +Perlin detail (2m amplitude), recompute slope | `refineTerrain.js` |
| Refine | Carve river channels (1-3m depth from waterMask) | `refineTerrain.js` |
| Derived | Gradient field, water distance, terrain attraction | `terrainFields.js` |

**Status: OK.** Bilinear upsampling + Perlin detail is the right approach. Slope recomputed from refined elevation. The channel carving step uses the waterMask grid, which is the right dependency.

### Water / Coastline

| Stage | Representation | File |
|-------|---------------|------|
| Regional | `waterMask` Grid2D uint8, 50m cells | `generateHydrology.js` |
| Regional | `elevation < seaLevel` defines additional water | implicit |
| Import | Bilinear sample + threshold at 0.5 → 10m binary grid | `extractCityContext.js` |
| Process | Marching squares → smooth closed polylines (Douglas-Peucker + Chaikin) | `extractWaterPolygons.js` |
| 3D | Flat blue plane at seaLevel (ignores polygons entirely) | `waterMesh.js` |
| Debug | Renders waterMask grid cells as blue overlay | `layerRenderers.js` |

**Status: Mostly OK.** The bilinear+threshold import produces smooth boundaries. Water polygons are extracted properly. Gap: the 3D renderer ignores the polygons and just draws a flat plane.

### Rivers

| Stage | Representation | File |
|-------|---------------|------|
| Regional | Tree of segments: `{cells: [{gx, gz, accumulation}], children}` | `generateHydrology.js` |
| Regional | Contributes to `waterMask` grid (50m cells) | `generateHydrology.js` |
| Import | `waterMask` bilinear-sampled to 10m grid | `extractCityContext.js` |
| Import | River tree copied by reference (still 50m grid coords) | `extractCityContext.js` |
| Refine | Channel carved into elevation using waterMask | `refineTerrain.js` |
| 3D | Chaikin-smoothed ribbon mesh, width from `sqrt(accumulation)/8` | `waterMesh.js` |
| Debug | Fixed-width straight segments between 50m grid points | `layerRenderers.js` |

**Status: Broken.** Two problems:

1. **No city-resolution river paths.** The river tree stays at 50m regional coords. The waterMask gets resampled to 10m, but the vector paths don't. The 3D renderer smooths them with Chaikin (good), but the 2D debug renderer draws raw grid-cell segments (bad).

2. **No width in 2D.** The 3D renderer uses accumulation for width. The 2D renderer draws fixed 2px lines. River width should be part of the data model, not a rendering decision.

**What's needed:** At import time, convert regional river paths to city-resolution smoothed polylines with per-vertex width derived from accumulation. Store these as the authoritative city river paths. Both 2D and 3D renderers consume the same path data.

### Roads

| Stage | Representation | File |
|-------|---------------|------|
| Regional | Array of `{path: [{gx,gz}], hierarchy, from, to}` at 50m | `generateRoads.js` |
| Import | Filtered to city bounds, stored as `regionalRoads` | `extractCityContext.js` |
| Anchor routes | Re-pathfound at city resolution (10m), shared usage grid | `generateAnchorRoutes.js` |
| Anchor routes | Junction detection, segment tracing, graph construction | `generateAnchorRoutes.js` |
| Graph | PlanarGraph with nodes (junctions) + edges (polylines + hierarchy + width) | `generateAnchorRoutes.js` |
| Occupancy | Stamped onto occupancy grid (3m resolution) | `roadOccupancy.js` |
| Growth | New edges added to same graph via A* pathfinding | `growCity.js` |
| 3D | Ribbon mesh from edge polylines, elevation-sampled | `roadMesh.js` |
| Debug | Thick colored lines from edge polylines | `layerRenderers.js` |

**Status: OK for anchor routes.** The re-pathfinding at city resolution is the right approach — it converts 50m grid paths to smooth 10m paths. The graph is the authoritative representation; occupancy grid and renderers derive from it.

**Gap:** Growth roads (from `growCity.js`) are added to the same graph but via a different pathfinding mechanism. The quality difference between anchor routes and growth roads is visible.

## The Pattern

The features that work well (elevation, anchor roads) share a pattern:

1. **Import** regional data at city resolution (interpolate, re-pathfind)
2. **Store** an authoritative city-level representation (grid or graph with smooth paths)
3. **Derive** everything else from that (occupancy stamps, terrain fields, render data)

The features that are broken (rivers, growth roads) skip step 1 — they carry regional-resolution data forward and let each renderer improvise its own conversion.

## Proposed: Water Body Classification

Currently there's a single binary `waterMask` — every water cell is the same. There's no distinction between sea, lake, and river. This matters because:

- **Sea** is the unbounded body connected to the coast edge. Buildings face it (waterfronts, promenades). It defines the city's orientation.
- **Lakes** are enclosed bodies not connected to the coast edge. Parks surround them. Different character than sea-facing waterfront.
- **Rivers** are narrow linear features connecting to sea/lakes. They have flow direction, accumulation, width. They create crossings (bridges), divide neighborhoods.

### What to compute at import

Flood-fill from the coast edge to identify **sea cells** (connected component touching map boundary below seaLevel + waterMask). Remaining water cells are either **lake** (connected component not touching boundary) or **river** (painted from river path data with width).

Store as a classified water grid at city resolution:

```
waterType: Grid2D uint8 — 0=land, 1=sea, 2=lake, 3=river
```

This replaces the binary waterMask. All downstream consumers (terrain carving, distance fields, occupancy, rendering) can then distinguish water types. The growth algorithm can prefer waterfront along sea, parks along lakes, bridges across rivers.

### Topology: what connects to what

The classified water grid implicitly captures topology — connected components of type 1 are the sea, each connected component of type 2 is a distinct lake. River segments connect them.

For the growth algorithm, the key topological facts are:
- Which nuclei face sea vs lake vs river vs nothing
- Which river segments separate which neighborhoods (bridge placement)
- Which coastline segments are accessible (not cliff, not too steep)

These can be derived from the classified grid + river paths rather than stored explicitly.

## Proposed: River Import Pipeline

Rivers should follow the same pattern as anchor routes: re-derive at city resolution during import.

### Step 1: Convert river paths to city coords

For each river segment, convert `{gx, gz, accumulation}` cells from regional grid coords to city world coords. This is a coordinate transform, not interpolation.

### Step 2: Smooth with Chaikin subdivision

Apply 2-3 rounds of Chaikin corner-cutting (same as `waterMesh.js` already does). This converts the staircase of 50m grid cells into a smooth curve. Accumulation values interpolate along with position.

### Step 3: Compute per-vertex width

Width = `max(minWidth, min(maxWidth, sqrt(accumulation) * scaleFactor))`. The scale factor needs to work in city grid pixels for 2D and world units for 3D. Store width on each vertex.

### Step 4: Store as city river paths

```
cityLayers.setData('riverPaths', [{
  points: [{x, z, width}],  // city world coords, smoothed
  children: [...]            // same tree structure
}])
```

### Step 5: Paint onto waterMask

Instead of bilinear-sampling the regional waterMask for river areas, paint the smoothed river paths onto the city waterMask using their computed widths. This ensures the raster and vector representations agree perfectly.

Coastline/sea water still uses bilinear sampling. Only river channels use the painted approach.

### Where this goes

A new function `importRivers(cityLayers, regionalLayers)` called during city setup, after `extractCityContext` but before `refineTerrain` (since refineTerrain carves channels based on waterMask).

### What consumes it

| Consumer | Currently uses | Should use |
|----------|---------------|------------|
| `refineTerrain.js` channel carving | waterMask grid | waterMask grid (now painted from smooth paths) |
| `terrainFields.js` water distance | waterMask grid | waterMask grid (same) |
| `layerRenderers.js` rivers layer | regional river tree + waterMask | `riverPaths` (smooth, variable width) |
| `waterMesh.js` 3D rivers | regional river tree (self-smoothed) | `riverPaths` (pre-smoothed) |
| `riverCrossings.js` bridge detection | waterMask + regional rivers | waterMask + `riverPaths` |

## Summary of Feature Status

| Feature | Regional → City Import | City Representation | 2D Render | 3D Render |
|---------|----------------------|--------------------|-----------|-----------|
| Elevation | Bilinear + Perlin detail | Grid2D float32 10m | OK | OK |
| Slope | Recomputed from elevation | Grid2D float32 10m | OK | N/A |
| Water (sea/coast) | Bilinear + threshold | Binary grid + smooth polygons | OK | Flat plane (gap) |
| Water classification | **Not done** | **No sea/lake/river distinction** | **All same blue** | **All same blue** |
| Rivers | **Not converted** | Regional tree (50m) | **Zigzag, fixed width** | Smoothed (ad-hoc) |
| Anchor roads | Re-pathfound at 10m | PlanarGraph | OK | OK |
| Growth roads | Pathfound at 10m | Same graph | OK | OK |
| Terrain fields | Computed from city grids | Grid2D float32 | OK | N/A |

## Implementation Order

The import pipeline should run in this order (dependencies flow downward):

1. **Extract city context** — bilinear-sample elevation, slope, landCover to 10m (existing)
2. **Import rivers** — smooth paths, compute widths, paint onto waterMask (new)
3. **Classify water** — flood-fill to label sea/lake/river cells (new)
4. **Refine terrain** — Perlin detail, recompute slope, carve channels (existing, now uses classified grid)
5. **Extract water polygons** — marching squares on classified grid, per-type (existing, enhanced)
6. **Anchor routes** — re-pathfind regional roads at city resolution (existing)
7. **Terrain fields** — gradient, water distance, attraction (existing, now water-type-aware)
