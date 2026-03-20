# Fixing zones-refine: Plan

## Status: Plan — 2026-03-20

## Background

The pipeline refactoring (March 12–20) made three major architectural changes:

1. **Road Network Abstraction** (`781b7e5`) — `RoadNetwork` owns roads, graph, and roadGrid as a single synchronized structure. Adding a road via `roadNetwork.add()` automatically stamps the grid and updates the planar graph.

2. **Zones as Graph Faces** (`d86c386`) — `extractZones` now uses `graph.facesWithEdges()` as its primary source. Each bounded face in the planar graph becomes a development zone. Zones have explicit `boundingEdgeIds` and `boundingNodeIds` referencing the roads that form their boundaries.

3. **Zone Re-extraction Loop** (`e04c83a`) — After initial zone extraction, `zone-boundary` adds collector roads along zone polygon edges, then `zones-refine` re-runs `extractZones` so the graph faces reflect the new secondary roads.

These are good architectural decisions. The problem is that `zones-refine` destroys zones instead of subdividing them.

---

## The Bug

After `zone-boundary` adds roads and `zones-refine` re-extracts:

| Seed | zones step | zones-refine step |
|------|-----------|-------------------|
| 884469 | 37 zones (108k top) | 2 zones (163 top) |
| 400 | 58 zones (138k top) | 3 zones (1.5k top) |
| 42 | 3 zones (32k top) | 2 zones (31k top) |

Seeds with many zones are decimated. Seeds with few zones survive by luck.

---

## Root Cause Analysis

`extractZones` calls `graph.facesWithEdges()` to enumerate bounded regions. For this to produce useful zones, the graph edges must form **closed faces** — cycles that bound a region.

### Hypothesis 1: Zone boundary roads create dangling edges

`zoneBoundaryRoads.js` traces zone polygon edges, clips them, and adds them as roads. If a boundary road segment doesn't connect at both ends to existing graph nodes, it creates a **dangling edge** — an edge that sticks into a face without closing it. Dangling edges don't create new bounded faces; they break the existing face into fragments that `facesWithEdges()` can't enumerate as closed polygons.

**To verify:** After `zone-boundary`, count graph edges that have a degree-1 node at one end (dangling). Compare to the number of edges added.

### Hypothesis 2: Skeleton-walk merge creates topological inconsistencies

The skeleton-walk merge in `zoneBoundaryRoads.js` splits skeleton edges and merges boundary nodes into the split points. If the merge doesn't properly reconnect the boundary road to the split node in the graph, the resulting topology has gaps — edges that should connect to form faces but don't.

**To verify:** After `zone-boundary`, check for graph nodes with unexpected degree (especially degree-1 nodes that should be degree-3 at T-junctions).

### Hypothesis 3: Road stamping makes face interiors non-contiguous

When boundary roads are stamped onto `roadGrid`, the cells they occupy are excluded from zone rasterization. If a boundary road runs through the middle of what was a face interior, the rasterized cell set for that face becomes fragmented. The face polygon might still be valid geometrically, but the rasterized cells don't fill it properly.

**To verify:** After `zones-refine`, check whether zone polygons have reasonable areas but very few cells (would indicate rasterization exclusion by roadGrid).

### Hypothesis 4: Face enumeration produces different faces than expected

`facesWithEdges()` is a planar graph operation. If zone-boundary roads don't partition existing faces cleanly (e.g., they create multi-connected regions, or they cross existing edges without proper node insertion), the face enumeration can produce unexpected results — extremely small faces, or the outer face absorbing what should be interior faces.

**To verify:** Compare the number and areas of faces before and after zone-boundary. Log which faces are being filtered out by the min-area and max-area thresholds.

---

## Investigation Steps

These should be done before writing code. Each produces diagnostic output.

### Step 1: Instrument extractZones with face-level logging

Add temporary logging to `extractZones` (behind a flag or console.log) that reports:
- Total faces from `facesWithEdges()`
- For each face: polygon area, cell count, whether it passes each filter (min area, max area, water, land value)
- How many faces pass vs fail each filter, and the distribution of polygon areas

Run for seed 884469 at both the `zones` and `zones-refine` steps. Compare the face distributions.

### Step 2: Check graph topology after zone-boundary

After `zone-boundary` runs, log:
- Number of nodes, edges
- Number of degree-1 nodes (dangling endpoints)
- Number of degree-2 nodes (pass-through, could indicate unsplit crossings)
- Whether every added boundary road connects to the graph at both endpoints

### Step 3: Compare polygon area vs cell count

After `zones-refine`, for each surviving and filtered-out zone, log:
- Polygon area (geometric)
- Number of rasterized cells
- Ratio (cells * cellSize² / polygon area) — should be close to 1.0
- If ratio is very low, it means roadGrid exclusion is eating the interior

### Step 4: Visualize the graph edges

Create a diagnostic render that draws:
- Skeleton edges (white)
- Zone-boundary edges (yellow)
- Dangling edges (red) — edges where one node has degree 1
- Face centroids of surviving zones (green dots)
- Face centroids of filtered-out zones (red dots)

This will show whether the boundary roads are forming proper face boundaries or just dangling into existing faces.

---

## Likely Fix Directions

Based on the above, the fix will likely be one of:

### A: Ensure boundary roads form closed faces

The zone boundary is a polygon — it's already closed. If the boundary road traces the polygon faithfully and connects back to itself (or to skeleton nodes at both ends), it should create a proper face subdivision. The fix would be in `zoneBoundaryRoads.js`:

- Ensure each boundary road segment starts and ends at a graph node (not dangling)
- When a segment endpoint doesn't reach a skeleton node, extend it to the nearest existing node or create a connection
- After all segments are added, verify that every new node has degree ≥ 2

### B: Use face subdivision instead of full re-extraction

Instead of re-running `extractZones` from scratch (which enumerates all graph faces), subdivide the existing zones. For each zone, check which boundary roads cross it and split it along those roads. This preserves zones that aren't crossed by new roads and only refines zones that are.

This is a bigger change but more robust — it doesn't depend on `facesWithEdges()` producing the right result after arbitrary edge additions.

### C: Tune face extraction to handle incomplete boundaries

Add tolerance for faces that are almost-closed (e.g., edges that come within a few meters of connecting). Or post-process the graph to close small gaps before face enumeration.

---

## Experiment Integration

The k3/s7 experiment render scripts (`render-ribbon-dist-index.js`, `render-ribbon-overlay-v5.js`) run:

```js
runToStep(strategy, 'spatial');        // runs zones → zone-boundary → zones-refine → spatial
createZoneBoundaryRoads(map);          // runs zone-boundary AGAIN
subdivideLargeZones(map);              // additional subdivision
extractZones(map);                     // extracts zones a THIRD time
```

This was written before the pipeline included `zone-boundary` and `zones-refine`. Now the scripts double-apply zone-boundary roads. Once the pipeline's `zones-refine` works correctly:

- The scripts should either stop at `zones` (before the re-extraction loop) and do their own zone-boundary + extraction, OR
- Stop at `spatial` and skip the manual zone-boundary/extraction calls (the pipeline already did it)
- The simplest fix: change `runToStep(strategy, 'spatial')` to `runToStep(strategy, 'zones')` so they get the coarse zones and do their own refinement

But this is a workaround. The real fix is making `zones-refine` work correctly, after which the experiments can run the full pipeline and get properly subdivided zones.

---

## Missing invariant: noZoneOnRoad

The spec in `next-steps.md` § Step 2 lists `noZoneOnRoad` (`zoneGrid ∩ roadGrid = ∅`) as a bitmap invariant, but it was never implemented in `bitmapInvariants.js`. The current bitmap invariants check water/road, water/zone, water/rail, etc. but not zone/road overlap.

This invariant would detect whether zone-boundary road stamping is eating zone interior cells. It should be added to `checkAllBitmapInvariants` as part of the investigation:

```js
// Zone cells must not overlap road cells
if (inZone && isRoad) counts.noZoneOnRoad++;
```

Note: the existing `cellOverlaps` check in `blockInvariants.js` (zone-vs-zone overlap) is CPU-based — it builds a `Set` of cell indices and checks for duplicates.

A GPU bitmap invariant checker already exists at `src/city/invariants/bitmapInvariantsGPU.js` — a WGSL compute shader with atomic counters (workgroup size 256), same 5-invariant interface as the CPU version. Both CPU and GPU versions are missing `noZoneOnRoad`. Adding it requires:

- **CPU** (`bitmapInvariants.js`): add `if (inZone && isRoad) counts.noZoneOnRoad++`
- **GPU** (`bitmapInvariantsGPU.js`): add a 6th `atomic<u32>` to the `Counts` struct, add `if (inZone && isRoad) { atomicAdd(&counts.noZoneOnRoad, 1u); }` to the shader, increase readback buffer and result parsing

Running `noZoneOnRoad` as a pipeline hook at both the `zones` and `zones-refine` steps would show whether the zone-boundary roads are incorrectly overlapping with zone cells after re-extraction.

---

## Files to investigate

| File | Why |
|------|-----|
| `src/city/pipeline/extractZones.js` | Zone extraction logic, face enumeration, filtering |
| `src/city/pipeline/zoneBoundaryRoads.js` | Boundary road creation, skeleton merge |
| `src/core/PlanarGraph.js` | `facesWithEdges()` implementation — are dangling edges handled? |
| `src/core/RoadNetwork.js` | `add()` method — how are graph nodes created for new roads? |
| `src/city/pipeline/cityPipeline.js` | Step ordering, conditional zones-refine |

## Success criteria

1. Seed 884469 produces ≥20 zones after `zones-refine` (was 37 before, refinement should produce more, not fewer)
2. Seed 400 produces ≥40 zones after `zones-refine`
3. No zone's cell count drops by more than 50% from `zones` to `zones-refine` (unless it was properly bisected)
4. All existing tests continue to pass

### Key acceptance test: recreate k3 on seed 884469

The definitive test is reproducing experiment 007k3 (distance-indexed junctions) on its original seed:

```bash
bun scripts/run-experiment.js --experiment 007k5 --script render-ribbon-dist-index.js --seeds "884469:27:95"
```

This must produce a zone with terrain faces and distance-indexed streets comparable to the original k3 output at `experiments/007k3-output/ribbon-zone-zoomed-seed884469.png`. If seed 884469 can find a suitable zone (>2000 cells, with slope data and boundary), the fix is working.
