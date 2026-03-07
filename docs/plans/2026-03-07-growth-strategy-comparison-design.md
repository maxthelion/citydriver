# Growth Strategy Comparison View

## Problem

We need to fill city areas with streets that look organic. The skeleton gives arterial roads connecting nuclei, but the space between them is empty. Previous attempts at infill produced either parallel roads without cross streets, or spaghetti. We need to prototype multiple approaches and compare them visually.

## Design

### Strategy Interface

4 strategy classes in `src/city/strategies/`, each with the same contract:

```js
constructor(map)  // receives clone of post-tick-0 FeatureMap (terrain + water + rivers + nuclei)
tick()            // mutates map via addFeature(), returns true if more work to do
```

Each strategy owns the entire pipeline from tick 1 onward: skeleton road building AND growth. They share tick 0 (terrain, water, rivers, nuclei).

### The 4 Strategies

1. **FaceSubdivision** (`faceSubdivision.js`) — Build skeleton from nuclei. Extract faces from PlanarGraph. Merge adjacent triangles into quads. Recursively split oversized faces by connecting midpoints of opposing edges (A* pathfound for terrain response). Stop when faces reach block size (~40-80m).

2. **OffsetInfill** (`offsetInfill.js`) — Build skeleton from nuclei. Generate parallel offset curves from each skeleton road at plot-depth intervals (~30-50m). Where offset curves from different parent roads approach each other, connect them with perpendicular cross streets. Offset curves inherit parent road curvature.

3. **FrontagePressure** (`frontagePressure.js`) — Build skeleton from nuclei. Place plots along road frontage. When frontage fills: depth pressure creates back lanes behind filled plots, block-length pressure inserts cross streets when rows get too long. New roads create new frontage; cycle repeats.

4. **TriangleMergeSubdiv** (`triangleMergeSubdiv.js`) — Build skeleton from nuclei. Extract faces. For triangular faces, merge adjacent pairs into quads (remove shared edge). Then subdivide quads by connecting midpoints of the two longest edges. Different from FaceSubdivision in that it explicitly converts the triangle topology before subdividing.

### Nucleus Placement Moves to Tick 0

`setupCity()` gains nucleus placement (extracted from `buildSkeleton`). All strategies share the same nuclei. Each strategy builds its own skeleton connections and growth from those shared nuclei.

### FeatureMap.clone()

New method on FeatureMap. Deep-copies all grids, features, graph, and nuclei. Each comparison panel gets an independent copy after tick 0.

### CompareScreen

New file: `src/ui/CompareScreen.js`

**Access:** Button in region view navigates to `?mode=compare&seed=X&gx=Y&gz=Z`.

**Layout:**
```
[sidebar] | Strategy A (macro) | Strategy B (macro) | Strategy C (macro) | Strategy D (macro) |
          | Strategy A (micro) | Strategy B (micro) | Strategy C (micro) | Strategy D (micro) |
```

- 8 canvases: 4 macro (overview) + 4 micro (detail)
- Each macro renders at `map.width x map.height`
- Each micro renders a selected cell at DETAIL_SCALE (4x)
- Click any macro cell -> all 4 micros zoom to that cell
- Strategy name label on each macro panel

**Sidebar controls:**
- Seed input + reset
- Layer selector (applies to all 8 panels, reuses LAYERS from debugLayers.js)
- "Step" button (runs one tick on all 4 strategies)
- Info (tick count, features per strategy)

**Auto-run:** On construction, runs tick 0 (shared setup), clones 4 maps, then auto-runs ticks 1-4 on each strategy.

### Rendering

Reuses existing `debugLayers.js` renderers. Each canvas gets its own offscreen rendering pass using the strategy's FeatureMap. All 8 canvases re-render when layer selection or zoom cell changes.

### File Structure

```
src/city/strategies/
  faceSubdivision.js
  offsetInfill.js
  frontagePressure.js
  triangleMergeSubdiv.js
src/ui/CompareScreen.js
```

Modified files:
- `src/city/setup.js` — add nucleus placement
- `src/city/skeleton.js` — extract nucleus placement, skeleton becomes a utility function
- `src/core/FeatureMap.js` — add clone() method
- `src/ui/App.js` — route `?mode=compare` to CompareScreen
- `src/rendering/mapRenderer.js` — add "Compare Growth" button to region view
