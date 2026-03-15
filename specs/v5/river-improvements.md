# River Improvements Spec

## Problems

### 1. Rivers don't wear away the landscape enough
Regional carving was intentionally reduced (0.3–1.2m depth) to avoid
coarse-grid artifacts at city resolution. The side effect: rivers sit
*on top of* the terrain rather than *in* it. There's no visible valley
around a river — just a narrow trench. Real rivers sit in broad valleys
that they've carved over millennia.

### 2. Rivers don't bend enough on flat terrain
Meandering is driven by adding 0.8m of high-frequency noise to the
flow-routing elevation. This produces mild wiggles but not the dramatic
oxbow-style bends that real lowland rivers have. The D8 flow algorithm
also forces grid-aligned steps, and Chaikin smoothing can only polish
what's fundamentally a staircase path.

### 3. Rivers aren't wide enough
`riverHalfWidth = clamp(sqrt(acc) / 8, 1.5, 25)` caps at 50m total
width. At 12.8km region scale most rivers accumulate 1000–5000 cells,
giving 4–9m half-width (8–18m total). Real rivers at this landscape
scale are often 30–80m wide approaching the coast. The accumulation
values are too low because the catchment area is small.

### 4. The region isn't big enough for rivers to form naturally
At 256×256 cells × 50m = 12.8km, the largest possible catchment is
~65k cells. A real river draining a 13km-wide landscape would have
tributaries arriving from far beyond the map boundary. Rivers that
cross a region this size are almost always *passing through*, not
originating within it.

### 5. Valleys through coastal mountain ranges
Tectonic ridges near the coast create mountain barriers. Currently
rivers that form on the inland side of these ridges can't cut through
them convincingly — the D8 router finds a path but the terrain isn't
carved to match. Real rivers cut through mountain ranges via antecedent
drainage (the river predates the uplift) or headward erosion. Either
way, the result is a steep-sided valley (gorge/canyon) through the
ridge.

### 6. Floodplain flattening near the coast
Low-gradient river sections near the coast should have broad, flat
floodplains. Currently the terrain around river mouths has the same
topography as anywhere else — the river doesn't flatten its
surroundings.

## Design

### A. External rivers entering at region boundaries

Rivers shouldn't all originate within the 13km region. The dominant
rivers should arrive from beyond the map, already at significant scale.

**Algorithm:**
1. After terrain generation but before flow accumulation, identify
   candidate entry points on non-coastal map edges.
2. Score edge cells by: low elevation, presence of a valley (concavity
   in the edge elevation profile), distance from corners.
3. Select 0–3 entry points probabilistically (more on larger/wetter
   maps).
4. Each incoming river carries a *synthetic accumulation* value
   representing its upstream catchment beyond the map (e.g. 2000–10000
   cells equivalent). This sets its initial width and erosive power.
5. Route the incoming river inward using the existing D8 flow from its
   entry point. Its accumulation adds to local flow accumulation.

**Entry river scale:**
- Small feeder (synthetic acc ~2000): 12m wide at entry, modest valley
- Regional river (synthetic acc ~5000): 20m wide, clear valley
- Major river (synthetic acc ~10000): 30m+ wide, broad floodplain

**Probability and placement:**
- Each non-coastal edge gets 0–1 entry rivers. Probability driven by
  edge length, terrain concavity, and a seed-based roll.
- Entry points prefer natural valleys in the edge elevation profile.
- Coastal edges never receive entry rivers (rivers flow *to* coast).

### B. Wider rivers

Increase the width formula to produce more realistic scales:

```
riverHalfWidth(acc) = clamp(sqrt(acc) / 5, 2, 40)
```

This gives:
- acc=100: 2m half (4m total) — stream
- acc=1000: 6.3m half (12.6m) — small river
- acc=5000: 14m half (28m) — river
- acc=10000: 20m half (40m) — large river
- acc=25000+: 40m half (80m) — major river, capped

Combined with external rivers bringing acc=5000–10000 at entry, the
main watercourse through the region will be 30–60m wide approaching
the coast, which is realistic for a landscape this size.

### C. Valley carving (terrain-scale erosion)

Rivers should sit in valleys, not trenches. Add a valley-carving pass
*after* flow accumulation that modifies the actual terrain elevation.

**Valley profile:**
```
valleyHalfWidth(acc) = clamp(sqrt(acc) * 1.5, 30, 500)  // meters
valleyDepth(acc)     = clamp(sqrt(acc) / 20, 1, 15)      // meters
```

This produces:
- Stream (acc=100): 15m wide valley (clamped to 30), 0.5m deep (clamped to 1)
- River (acc=1000): 47m wide valley, 1.6m deep
- Large river (acc=5000): 106m valley, 3.5m deep
- Major river (acc=10000): 150m valley, 5m deep

**Cross-section:**
```
valleyProfile(normalizedDist):
  nd < 0.3:   1.0  (flat floodplain floor)
  nd 0.3–0.8: smooth ramp from 1.0 to 0.3 (valley sides)
  nd 0.8–1.0: smooth ramp from 0.3 to 0.0 (blending to natural terrain)
```

**Geology interaction:**
- Hard rock (granite): valley width × 0.5, depth × 1.3 (narrow gorge)
- Soft rock (clay/chalk): valley width × 1.5, depth × 0.7 (broad shallow valley)

**Implementation:**
Walk each river vector path. At each sample point, carve the valley
profile into terrain cells within valleyHalfWidth. Use `min(existing,
carved)` — never raise terrain, only lower it. Apply after flow
accumulation so the carved valleys are visible but don't alter the
drainage network.

### D. Coastal floodplain flattening

Rivers approaching the coast should create flat, low-lying land.

**Algorithm:**
For each river path point within 500m of the coastline:
1. Compute a *floodplain radius* that widens as the river approaches
   sea level: `radius = valleyHalfWidth * (1 + 2 * coastProximity)`
   where `coastProximity` goes from 0 (500m inland) to 1 (at coast).
2. Flatten terrain within this radius toward the river's elevation
   (which is near sea level). Use a smooth blend, not hard clamp.
3. The result: broad flat land at river mouths — exactly where cities
   develop in the real world.

**Constraints:**
- Only flatten below a height threshold (e.g. river elevation + 5m).
  Don't flatten hilltops that happen to be near the coast.
- Respect geology: hard rock coasts resist flattening (rocky estuary),
  soft rock coasts flatten easily (wide estuary/delta).

### E. Better meandering on flat terrain

Replace the current noise-injection approach with curvature-driven
meandering applied as a post-process to river vector paths.

**Algorithm:**
For each river vector path, after extraction and smoothing:
1. Compute local slope at each path vertex.
2. Where slope < 0.03 (flat terrain), apply sinusoidal displacement
   perpendicular to flow direction.
3. Meander amplitude scales with river width:
   `amplitude = halfWidth * 3` (a river meanders ~3× its width).
4. Meander wavelength scales similarly:
   `wavelength = halfWidth * 12` (one full S-curve per ~12 widths).
5. On soft rock (clay), increase amplitude × 1.5 (rivers meander more
   on erodible substrate).
6. On hard rock, reduce amplitude × 0.3 (constrained channels).

**Transition:** Between steep and flat terrain, blend smoothly from
straight to meandering over a slope range of 0.03–0.08.

This replaces the current micro-noise injection in `generateHydrology`
(which adds 0.8m noise to the flow-routing grid). The new approach
operates on the vector path directly, producing much more visible
bends.

### F. Mountain-range gorges

When a river path crosses terrain that rises significantly above the
river's elevation (i.e. cutting through a ridge), create a gorge.

**Detection:**
Walk each river path. If terrain on both sides of the river rises
more than 10m above river elevation within 200m, flag as gorge section.

**Gorge carving:**
- Narrow the valley (width × 0.3) but deepen it (depth × 2).
- Steepen the valley walls (profile ramps from 1.0 to 0.0 over
  nd = 0.7–1.0 instead of 0.3–1.0).
- On hard rock, walls are near-vertical (cliff faces).
- On soft rock, walls are steep but not vertical (V-shaped valley).

**Terrain modification:**
The gorge carving cuts a narrow, deep notch through the ridge. This
makes the river path through mountain ranges look deliberate rather
than accidental.

## Pipeline changes

```
REGIONAL (50m cells)
  1. generateTerrain()           — elevation, geology
  2. generateCoastline()         — sea level, coastal erosion
  3. placeExternalRivers()       — NEW: inject entry rivers at edges
  4. generateHydrology()
     a. fillSinks
     b. D8 flow directions
     c. Flow accumulation (including external river contributions)
     d. extractStreams
     e. smoothRiverPaths          — MODIFIED: stronger meandering
     f. segmentsToVectorPaths
     g. carveValleys()            — NEW: terrain-scale valley carving
     h. flattenCoastalFloodplains() — NEW: estuary flattening
     i. carveGorges()             — NEW: ridge-cutting gorge carving
     j. carveFloodplains()        — existing mild channel carving
     k. paintPathsOntoWaterMask
```

## New files

| File | Purpose |
|------|---------|
| `src/regional/placeExternalRivers.js` | Edge analysis, entry point selection, synthetic accumulation |
| `src/regional/carveValleys.js` | Valley profile carving, gorge detection, coastal flattening |

## Modified files

| File | Changes |
|------|---------|
| `src/core/riverGeometry.js` | Updated `riverHalfWidth` formula; new `valleyHalfWidth`, `valleyDepth`, `valleyProfile` functions |
| `src/core/flowAccumulation.js` | Accept external accumulation seeds; updated meander parameters |
| `src/regional/generateHydrology.js` | Integrate external rivers; call valley carving; revised meander pass |

## Constants

| Parameter | Current | Proposed |
|-----------|---------|----------|
| `riverHalfWidth` divisor | 8 | 5 |
| `riverHalfWidth` max | 25m | 40m |
| `riverHalfWidth` min | 1.5m | 2m |
| Meander amplitude | 0.8m noise | halfWidth × 3 |
| Meander wavelength | freq=40 noise | halfWidth × 12 |
| Valley half-width | none | sqrt(acc) × 1.5, clamped 30–500m |
| Valley depth | none | sqrt(acc) / 20, clamped 1–15m |
| External river count | 0 | 0–3 per map |
| External synthetic acc | n/a | 2000–10000 |
| Coastal floodplain range | none | 500m from coast |

## Open questions

1. **Should external rivers have predetermined courses?** Currently
   they'd follow D8 routing from the entry point, which may produce
   unnatural paths. An alternative: lay down a rough polyline from
   entry to coast, then carve the terrain to match, rather than
   deriving the path from terrain.

2. **Endorheic basins:** Rivers that don't reach the sea (draining
   into inland depressions). Currently deferred — `fillSinks` routes
   everything to edges. Worth revisiting if the valley carving makes
   inland lakes more plausible.

3. **River deltas:** Where a major river meets the coast, should it
   split into distributaries? Complex to model but visually striking.
   Probably deferred.

4. **Interaction with city development zones:** Wider rivers and
   flatter floodplains will change which land is developable. The
   existing buildability gradient should handle this, but the
   development pressure model may need tuning — floodplain land is
   flat and accessible but flood-prone.
