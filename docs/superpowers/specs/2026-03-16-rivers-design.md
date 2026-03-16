# Rivers: Single Source of Truth

## Problem

The current river system uses two independent representations — bitmap grids (`waterMask`) and polyline features — that are never properly synchronized. The bitmap is seeded from `elevation < seaLevel`, river polylines are stamped on top, channels are carved into elevation after classification, and the renderer checks raw elevation instead of the water grids. This creates disconnected pools, duplicate carving passes, and contradictory water identity across the pipeline.

## Key Design Decision

**The river tree is the single source of truth.** A river is a directed tree of segments (tributaries merging toward a drain). It carries position, elevation, width, depth, and accumulation at every point. Bitmaps and polylines are derived from it, never authoritative.

**Sea and river are separate grids.** They behave differently and are determined differently — sea by flood fill from coastal edges, rivers by stamping from the river tree. A combined water grid is derived from both.

**Valleys are baked into regional elevation.** The city receives terrain with river valleys already carved. No city-level carving step.

## Non-Goals

- Lakes (endorheic basins, river-fed lakes) — noted for future
- River deltas (distributary branching)
- Seasonal flow variation
- Erosion simulation

---

## The River Tree Data Structure

A `RiverSystem` is a directed tree: tributaries flow into larger segments, merging at confluences, terminating at a drain (the sea).

```
RiverSystem {
  id: number,
  drainType: 'sea',
  root: Segment,  // trunk segment (reaches drain)
}

Segment {
  points: [{ x, z, elevation, width, depth, accumulation }, ...],
  children: Segment[],  // upstream tributaries joining at this segment's head
}
```

Confluences are implicit — where a segment's `children` join it. The nested structure supports natural recursive tree-walks for carving, stamping, and rendering.

**Points** are in world coordinates (meters), densely sampled (~every 25-50m). Properties at each point:

| Property | Source | Notes |
|----------|--------|-------|
| x, z | Flow routing / corridor path | World-space position |
| elevation | Terrain at point, decreasing downstream | Below sea level near coast |
| width | `clamp(sqrt(acc) / 5, 2, 40)` | Half-width in meters |
| depth | `clamp(sqrt(acc) / 25, 0.5, 8)` + coast modulation | Below sea level at mouth |
| accumulation | Summed at confluences | Upstream catchment area |

**Derived outputs** (methods on the data structure):
- `toPolylines()` — extract polyline paths for rendering ribbon meshes
- `stampOntoGrid(grid, cellSize)` — stamp river presence/width/depth onto a bitmap at any resolution
- `getChannelProfile(x, z)` — return elevation, width, depth at a world position (for city refinement). Implementation note: at city scale (~400×400 cells), this needs a pre-stamped grid or spatial index rather than per-cell geometry queries.

The tree uses nested structure (segments with `children` arrays) rather than flat-with-IDs, matching existing recursive tree-walk patterns in the codebase.

Multiple `RiverSystem` instances can exist on a single map (separate drainage basins).

---

## Regional Pipeline

Four phases. The key change: river valleys are baked into the elevation grid before anything downstream consumes it.

### Phase 1: Base Terrain (existing, mostly unchanged)

```
Tectonics → coast edges, plate angle, intensity
Corridor planning → edge-entry river paths with synthetic accumulation
  (existing system; now produces initial river tree segments)
Geology → rock types, resistance, permeability
Terrain generation → elevation, slope
  (ridge suppression along corridors — existing)
```

### Phase 2: River Routing → Build River Tree

1. **Flow routing** on base terrain (fill sinks, flow directions, accumulation). Geology modulates accumulation (impermeable rock = more runoff).

2. **Extract stream network** where accumulation exceeds threshold. Tributaries emerge naturally from the terrain.

3. **Build river tree**: corridor segments become trunks (with their synthetic accumulation from off-map catchment). Flow-routed streams join as tributary branches at confluences.

4. **Compute properties** at each point along every segment:
   - Accumulation: summed at confluences
   - Width: from accumulation formula
   - Elevation: from terrain, must be monotonically decreasing downstream
   - Depth: `clamp(sqrt(acc) / 25, 0.5, 8)` meters. Near coast, river bed descends below sea level: small rivers -1 to -2m at mouth, large rivers -3 to -5m

5. **Apply meandering**: displace points perpendicular to flow direction on flat terrain.
   - Amplitude: ~3× river width
   - Wavelength: ~12× river width
   - Only where slope < 0.03, transition over 0.03-0.08
   - Geology modulation: soft rock = more meandering, hard rock = less

### Phase 3: Carve Into Elevation

Walk the river tree. At each point, carve a valley profile into the elevation grid.

- **Valley dimensions**: width and depth from the river tree point data, modulated by geology
  - Hard rock (resistance > 0.6): narrow gorge (width × 0.5, depth × 1.3)
  - Soft rock (resistance < 0.3): broad valley (width × 1.5, depth × 0.7)

- **Valley cross-section profile**:
  - nd < 0.3: flat floodplain floor (depth = 1.0)
  - nd 0.3-0.8: smooth ramp to 0.3
  - nd 0.8-1.0: blend to natural terrain (0.3 → 0.0)
  - Gorge variant for hard rock with steep terrain on both sides

- **Coastal floodplains**: near coast, valley widens (radius × (1 + 2 × coastProximity)), terrain flattens toward sea level. Geology modulation (hard rock = rocky estuary, soft rock = wide estuary).

- **This is the permanent elevation.** After carving, recompute slope. No separate "valley depth layer."

### Phase 4: Derive Water Grids

Three grids, all derived (not authoritative):

**Sea grid** (uint8): Flood fill from coastal edges through cells where `elevation < seaLevel`. Only cells connected to the coast via other below-sea-level cells are sea. Inland depressions below sea level are NOT sea.

**River grid** (uint8): Stamped from the river tree at regional resolution using `riverTree.stampOntoGrid()`. Marks cells that contain river channel.

**Combined water grid**: `sea OR river`. Used by downstream consumers (settlements, roads, buildability).

**Sea floor plunge**: Applied to sea grid cells only (not river cells — rivers keep their carved elevation). This is a behavioral change from the current implementation which operates on the combined waterMask. Pushes sea floor steeply below sea level, modulated by rock hardness.

**Flood zone**: Computed from elevation + water distance. (Existing implementation.)

---

## City Level

The city receives from the regional level:
- Final elevation grid (valleys baked in)
- The river tree data structure
- Sea grid, river grid

### Setup (tick 0)

1. **Interpolate** regional elevation to 5m grid (bilinear). Valleys are already present.

2. **Add terrain detail**: Perlin noise for micro-terrain. Skip cells within the valley footprint (pre-stamp a temporary valley mask from the river tree at 5m, then skip noise for those cells). This prevents noise from creating bumps in the carved valley profile.

3. **Refine river channels**: Use `riverTree.getChannelProfile(x, z)` to sharpen the channel cross-section at 5m resolution. The 50m regional carving is coarse — the city refines within the already-carved valley. This refinement can only lower elevation, never raise it.

4. **Stamp river grid** at 5m resolution from the river tree.

5. **Stamp sea grid** at 5m: flood fill from edges through `elevation < seaLevel` cells (same algorithm as regional, finer resolution).

6. **Classify water**: river grid + sea grid. No ambiguous "lake" category for disconnected pools. If it's not in the river tree and not connected to the coast, it's not water.

7. **Compute buildability** from elevation, slope, flood zone, water grids.

### Rendering

- **Terrain mesh**: uses river grid + sea grid for water coloring. NOT `elevation < seaLevel`. Land cells get land colors, water cells get water colors.
- **River ribbons**: derived from `riverTree.toPolylines()`, rendered at the refined elevation.
- **Sea plane**: flat plane at sea level over sea grid cells.

---

## What This Replaces

### Removed / replaced

| Current | Replacement |
|---------|-------------|
| `waterMask` seeded from `elevation < seaLevel` | Separate sea grid (flood fill) + river grid (stamped from tree) |
| City-level `carveChannels()` in FeatureMap | Channel refinement from river tree (lower only, no independent carving) |
| City-level `classifyWater()` merging bitmap + polylines | Direct derivation from river tree + sea grid |
| `enforceWaterDepth()` | Unnecessary — elevation is authoritative from regional carve |
| `terrainMesh.js` checking `elev < seaLevel` | Uses river grid + sea grid |
| Dual representation (waterMask + river polyline features) | River tree is single source; grids are derived |
| `inheritRivers.js` (city river import) | City reads river tree directly, clips to bounds |
| `_stampRiver()` in FeatureMap | `riverTree.stampOntoGrid()` |
| `carveFloodplains()` in generateHydrology | Subsumed by Phase 3 valley carving from river tree |

### Kept / incorporated

| Current | How used |
|---------|----------|
| Corridor planning | Becomes edge-entry segments in river tree |
| Flow routing + accumulation | Builds the river tree |
| Valley carving logic | Applied to elevation from river tree data, baked in permanently |
| Sea floor plunge pass | Operates on sea grid cells |
| Flood zone computation | Uses sea + river grids |
| Meandering | Applied to river tree points before carving |
| `smoothRiverPaths()` in generateHydrology | Incorporated into river tree meandering step |

---

## Testing

- **River tree construction**: unit test — verify segments connect at confluences, accumulation sums correctly, elevation is monotonically decreasing
- **Sea grid flood fill**: unit test — verify inland depressions below sea level are NOT marked as sea; coastal-connected cells are
- **River grid stamping**: unit test — verify river cells match river tree paths at correct widths
- **Valley carving**: unit test — elevation is lowered along river tree, geology modulates profile
- **City refinement**: unit test — refinement only lowers elevation, never raises; noise skips river channels
- **Rendering**: verify terrain mesh uses water grids, not elevation, for water coloring
- **Integration**: generate full region → city, verify no disconnected pools, rivers flow continuously to sea
