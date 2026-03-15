# River Improvements: Corridors-First Approach

## Goal

Make rivers realistic — wider, sitting in valleys, meandering on flat
terrain, cutting through mountain ranges via pre-planned corridors.
Rivers are a primary terrain constraint, not an afterthought of flow
routing.

## Key Insight

Major rivers predate the current terrain. Tectonic uplift is slow;
rivers maintain their course through rising mountains (antecedent
drainage). The generator should plan river corridors before terrain
detail, then let terrain respect those corridors.

## Scope

- Plan 1-3 major river corridors after tectonics, before terrain
- Suppress ridge amplitude along corridors so terrain has natural gaps
- Widen the river width formula for realistic scales
- Carve valleys alongside rivers, modulated by geology
- Flatten coastal floodplains at river mouths
- Improve meandering on flat, soft-rock terrain

## Non-Goals

- River deltas (distributary branching)
- Endorheic basins (inland drainage)
- Seasonal flow variation
- Erosion simulation over time

---

## Revised Pipeline

```
A0:  Tectonics (plate angle, intensity, coast edges)
A0b: River Corridor Planning  ← NEW
A1:  Geology
A2:  Terrain (ridges suppressed along corridors)  ← MODIFIED
A4:  Coastline
A3:  Hydrology  ← MODIFIED (valley carving, meandering, floodplains)
```

---

## River Corridor Planning (A0b)

New step between tectonics and geology. Plans major drainage paths
across the map.

### Inputs

- `coastEdges` — which map edges are coast (from tectonics)
- `plateAngle` — compression direction (ridges perpendicular to this)
- `intensity` — tectonic intensity (higher = more mountains to cut through)
- Seed for randomisation

### Algorithm

1. **Count corridors**: 0-3 based on map size and seed. Higher intensity
   = more likely to have rivers cutting through mountains (more dramatic
   terrain needs drainage).
   - `count = floor(seed_random * 3)` weighted by intensity

2. **Pick entry points**: on non-coastal edges.
   - Prefer edges perpendicular to coast (rivers flow toward coast)
   - Position along edge: seeded random, avoid corners and clustering

3. **Pick exit points**: on coastal edges.
   - Each corridor flows toward the nearest coast
   - Exit position: roughly opposite the entry, with some lateral offset

4. **Generate corridor polyline**: 3-5 control points between entry and
   exit, with lateral noise for natural curves. Smooth with Chaikin.

5. **Assign synthetic accumulation**: each corridor carries upstream
   catchment from beyond the map.
   - Small feeder: acc ~2000 (12m wide at entry)
   - Regional river: acc ~5000 (20m wide)
   - Major river: acc ~10000 (30m+ wide)
   - Accumulation increases along the corridor as local drainage joins

### Output

`riverCorridors` data on LayerStack:
```js
[{
  polyline: [{gx, gz}, ...],    // grid coordinates
  entryAccumulation: number,    // synthetic acc at entry
  importance: number,           // 0-1, determines valley width
}]
```

### Corridor-to-grid: distance field

Compute a `corridorDist` grid (float32) — distance from each cell to
the nearest corridor polyline, in cells. This is used by terrain
generation to suppress ridges.

---

## Terrain Modification (A2)

### Ridge suppression along corridors

In `generateTerrain`, where ridge amplitude is applied, multiply by a
suppression factor:

```
corridorSuppress = 1 - gaussianFalloff(corridorDist, corridorWidth)
ridgeContribution *= corridorSuppress
```

Where `corridorWidth` scales with corridor importance:
- Small feeder: 8 cells (~400m valley gap)
- Regional river: 15 cells (~750m)
- Major river: 25 cells (~1250m)

The Gaussian falloff means ridges are fully suppressed at the corridor
centreline, gradually returning to full height at the edges. The result:
a natural-looking mountain pass where the river flows, with terrain
rising on both sides.

### Elevation depression along corridors

In addition to suppressing ridges, slightly lower the base elevation
along corridors:

```
elevDepression = corridorImportance * 15 * gaussianFalloff(corridorDist, corridorWidth)
elevation -= elevDepression
```

This ensures the corridor is lower than surrounding terrain even in
areas without ridges, so flow accumulation naturally follows it.

---

## Wider Rivers

Update `riverHalfWidth` in `riverGeometry.js`:

```
Current:  clamp(sqrt(acc) / 8, 1.5, 25)   → 8-50m total for typical rivers
Proposed: clamp(sqrt(acc) / 5, 2, 40)      → 12-80m total
```

| Accumulation | Current width | Proposed width |
|-------------|---------------|----------------|
| 100 (stream) | 3m | 4m |
| 1000 (river) | 8m | 13m |
| 5000 (large) | 18m | 28m |
| 10000 (major) | 25m (capped) | 40m |
| 25000+ | 50m (capped) | 80m (capped) |

---

## Valley Carving (new step in hydrology)

After flow accumulation and stream extraction, before water mask
painting. Walks each river vector path and carves a valley profile into
the terrain.

### Valley dimensions

```
valleyHalfWidth(acc) = clamp(sqrt(acc) * 1.5, 30, 500)  meters
valleyDepth(acc)     = clamp(sqrt(acc) / 20, 1, 15)      meters
```

### Geology modulation

Read `erosionResistance` at each river point:
- Hard rock (resist > 0.6): width × 0.5, depth × 1.3 (narrow gorge)
- Medium rock (0.3-0.6): no modifier
- Soft rock (resist < 0.3): width × 1.5, depth × 0.7 (broad valley)

### Valley cross-section profile

```
valleyProfile(nd):  // nd = normalised distance from centreline
  nd < 0.3:   1.0           (flat floodplain floor)
  nd 0.3-0.8: smooth ramp 1.0 → 0.3  (valley sides)
  nd 0.8-1.0: smooth ramp 0.3 → 0.0  (blend to natural terrain)
```

### Gorge detection

When terrain on both sides of the river rises > 10m above river
elevation within 200m, switch to gorge profile:
- Width × 0.3, depth × 2
- Steeper walls (ramp from 1.0 to 0.0 over nd 0.7-1.0)
- Hard rock: near-vertical. Soft rock: V-shaped.

### Implementation

Walk each river path. At each sample point, carve valley profile into
terrain cells within valleyHalfWidth. Use `min(existing, carved)` —
never raise terrain. Apply after flow accumulation so drainage network
is unaffected.

---

## Coastal Floodplain Flattening

For river points within 500m of coastline:

```
floodplainRadius = valleyHalfWidth × (1 + 2 × coastProximity)
```

Where `coastProximity` goes from 0 (500m inland) to 1 (at coast).
Flatten terrain within this radius toward the river's elevation (near
sea level). Smooth blend, not hard clamp.

Geology modulation:
- Hard rock coast: reduce flattening (rocky estuary)
- Soft rock coast: increase flattening (wide estuary/delta)

---

## Better Meandering

Replace the current noise-injection meander approach with
curvature-driven displacement applied to river vector paths.

### Algorithm

For each river vector path, after extraction and smoothing:
1. Compute local slope at each vertex
2. Where slope < 0.03: apply sinusoidal displacement perpendicular to
   flow direction
3. Amplitude = halfWidth × 3 (river meanders ~3× its width)
4. Wavelength = halfWidth × 12 (one S-curve per ~12 widths)
5. Transition: blend straight→meandering over slope 0.03-0.08

### Geology modulation
- Soft rock (clay, chalk): amplitude × 1.5
- Hard rock (granite): amplitude × 0.3

### Replaces
Current noise injection in `generateHydrology` (0.8m noise added to
flow-routing grid). The new approach operates on vector paths directly.

---

## File Structure

```
src/regional/planRiverCorridors.js      — NEW: corridor planning (A0b)
src/regional/carveValleys.js            — NEW: valley carving + floodplains
src/regional/generateTerrain.js         — MODIFIED: ridge suppression
src/regional/generateHydrology.js       — MODIFIED: integrate corridors,
                                           call valley carving, new meanders
src/core/riverGeometry.js               — MODIFIED: wider rivers, valley
                                           profile functions
src/regional/pipeline.js                — MODIFIED: insert A0b step
```

---

## Testing Strategy

- **Corridor planning**: unit test with mock tectonic params, verify
  polylines cross from non-coast to coast edge
- **Ridge suppression**: unit test that terrain along corridor is lower
  than terrain at same ridge position away from corridor
- **Valley carving**: unit test that elevation is lowered alongside
  rivers, with width/depth scaling with accumulation
- **Width formula**: simple assertion on new constants
- **Meandering**: verify displacement amplitude scales with width and
  geology, only on flat terrain
- **Integration**: generate a full region, verify rivers have valleys,
  flow reaches coast, no terrain artifacts
