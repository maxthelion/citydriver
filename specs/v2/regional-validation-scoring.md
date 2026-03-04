# Regional Generation Validation & Scoring Specification

## Overview

This specification provides automated validation for regional-scale generation — the 100km² map containing terrain, coastlines, water systems, settlements, and road networks. It uses the same three-tier structure as the city validation spec: hard validity checks, scored structural checks, and soft quality metrics.

Regional generation has different concerns from city generation. The main failure modes are: roads ignoring terrain, coastlines looking artificial, settlements placed without geographic logic, and road networks that don't form a sensible hierarchy. The checks below target these specific problems.

---

## Tier 1 — Validity Checks (Hard Constraints)

### V1. Roads on Land

No road segment occupies a water cell (sea, river, lake). Road-river crossings must have a bridge entity. Road-coast intersections are invalid.

**Test:** For each road segment, rasterize its path and check all cells against the water mask. Assert no road cell is water unless a bridge is present.

### V2. Settlements on Land

No settlement center point is in water or on impassable terrain (cliff face, very steep slope above 30°, river channel).

**Test:** For each settlement point, assert the cell is land with slope below the impassable threshold.

### V3. Road Network Connectivity

All settlements must be reachable from all other settlements via the road network. An isolated settlement with no road connection is a generation failure — settlements exist because of connections.

**Test:** Build the road graph. For each settlement, find the nearest road node. Run connectivity check (BFS/flood fill) across all settlement-linked nodes. Assert all are in the same connected component.

### V4. River Flow Consistency

Rivers must flow consistently downhill. No river segment should flow uphill. River paths should not form closed loops.

**Test:** Walk each river from source to mouth. Assert elevation is monotonically non-increasing along the path. Assert the river graph is acyclic (a DAG from sources to mouths/coast).

### V5. River Termination

Every river must terminate at either the coast, a lake, or (in arid regions) a designated sink. Rivers should not dead-end in the middle of land.

**Test:** For each river endpoint (final downstream node), assert it is adjacent to a water body (sea or lake) or at a designated endorheic sink.

### V6. Settlement Minimum Spacing

No two settlements of the same tier should be closer than a minimum distance. Two cities 3km apart would in reality be one city. Two towns 1km apart would be one town.

**Test:** For each pair of same-tier settlements, assert distance exceeds the minimum:
- Cities: 25km minimum
- Towns: 8km minimum
- Villages: 2km minimum

Different tiers can be close (a village near a city is fine — it's a satellite settlement).

### V7. River Terrain Obedience

Rivers must follow the terrain — they should flow through valleys, not across ridges or through high ground. For each river segment, check that the river path sits at or near a local elevation minimum in the cross-section perpendicular to the flow direction. A river crossing a ridge or flowing along a hillside rather than the valley floor is physically impossible.

**Test:** At sample points along each river, take a terrain cross-section perpendicular to the flow direction (width: 500m–2km depending on scale). Assert the river position is within 20% of the cross-section width from the lowest point. Rivers that are consistently high on valley walls or crossing ridgelines fail.

### V8. River Network Convergence (Dendritic Structure)

Rivers in the same watershed must converge, not run parallel. Water flows downhill and merges — two streams in the same valley will join, they won't flow side by side to the sea. The river network should form a tree (dendritic pattern) where tributaries join main channels, with flow accumulating downstream.

**Test:**
1. For each pair of rivers, check if they run roughly parallel (within 30° of the same direction) for a sustained distance (more than 5km) at close range (within 3km of each other).
2. If parallel rivers exist, check whether they are separated by a ridge or drainage divide. Parallel rivers in separate valleys (one either side of a ridge) are valid. Parallel rivers in the same valley or on the same slope are invalid.
3. Assert that the overall river network is tree-structured — every tributary joins a larger channel exactly once, with no parallel duplication.

### V9. River Source Logic

Rivers must originate from plausible sources — high ground, springs at geological boundaries, or lakes. A river that starts in a lowland with no elevation or geological reason is invalid.

**Test:** For each river source (upstream-most point), check that it satisfies at least one condition:
- It is above the 50th percentile of regional elevation (highland source)
- It is at a boundary between permeable and impermeable rock types (spring line)
- It flows out of a lake
- It is at the map edge (implying the river continues beyond the generated region)

---

## Tier 2 — Structural Checks (Scored Proportions)

### S1. Road-Terrain Gradient Agreement (threshold: 0.85)

Roads should respect terrain. At regional scale, major roads (the thick dark lines connecting settlements) should avoid steep gradients. Measure the gradient along each road segment and check against limits appropriate to road importance.

| Road type | Maximum gradient |
|---|---|
| Major trunk road | 6% |
| Regional connecting road | 8% |
| Local track / minor road | 12% |

**Score:** `road_length_within_gradient_limit / total_road_length`

Weight by road importance — a trunk road with a 10% gradient is a much worse violation than a minor track.

### S2. Road-Terrain Efficiency (threshold: 0.70)

Roads should follow the path of least resistance through terrain, not cut straight through highlands. For each road connecting two settlements, compare its actual path cost (sum of distance + elevation change penalties along its route) to the optimal terrain-weighted path (A* with proper elevation penalties).

**Score:** `mean(optimal_path_cost / actual_path_cost) across all roads`

A score of 1.0 means roads perfectly follow optimal terrain paths. A score below 0.70 means roads are frequently ignoring terrain — cutting through hills where valleys are available, or traversing ridges where passes exist.

This is the check that catches the problem visible in the screenshot: major roads crossing highland areas when they should be routing around or through passes.

### S3. Road Hierarchy Coherence (threshold: 0.80)

The road network should have a clear hierarchy. Major trunk roads connect cities and major towns. Regional roads connect smaller towns to the trunk network. Minor roads connect villages to regional roads. 

Check that:
- Every city is on a trunk road
- Every town is within one hop of a trunk or regional road
- Every village is connected (possibly via minor roads) to the wider network
- Trunk roads generally connect larger settlements to each other, not village to village
- Road width/importance correlates with the settlement sizes at each end

**Score:** Proportion of roads where the road importance matches the settlements it connects (trunk roads between cities, minor roads to villages, etc.).

### S4. Settlement-Geography Agreement (threshold: 0.80)

Settlements should be in geographically sensible locations. Score each settlement against site quality factors:

- **River/water access:** Settlements near rivers or coast score well. A settlement on a dry hilltop far from water scores poorly (historically unrealistic unless there's a spring or defensive reason).
- **Terrain buildability:** Settlements on reasonably flat ground score well. Settlements on steep slopes score poorly.
- **Route convergence:** Settlements where multiple roads naturally converge (valley junctions, river crossings, pass exits) score well. Settlements in locations with no natural route convergence score poorly.
- **Port validity:** Settlements labeled as ports must be on a coastline with adequate shelter (bay, inlet, estuary) and water depth. A port on an exposed cliff coast or a dead straight shoreline is invalid.

**Score:** `mean(site_quality) across all settlements`

### S5. Port Spacing and Differentiation (threshold: 0.75)

Ports should be spaced to serve distinct hinterlands. Two ports close together compete for the same trade catchment, which is historically unrealistic — one would dominate and the other would decline or never develop.

For each pair of ports, check that either:
- They are separated by enough distance that their catchment areas don't substantially overlap (minimum 30–40km by road)
- OR they are separated by a terrain barrier (a highland range, a major river estuary) that makes them serve genuinely different hinterlands even if geographically close
- OR they are different types (one harbor for fishing boats, one deep-water port for trade — though this may not be modeled at regional scale)

**Score:** Proportion of port pairs that satisfy at least one of these conditions.

### S6. River-Road Crossing Logic (threshold: 0.85)

Roads should cross rivers at specific, logical points — narrow sections, hard rock banks, historically viable fording or bridging locations. Roads should not cross rivers at their widest or deepest points.

For each road-river crossing:
- Check that the river width at the crossing point is at or near the local minimum within a reasonable search radius (say 2km upstream and downstream)
- Check that the crossing is at a point where both banks have manageable slopes (the road can approach the bridge without extreme gradients)

**Score:** `crossings_at_sensible_points / total_crossings`

### S7. Coastline-Geology Agreement (threshold: 0.75)

If a geology layer exists, the coastline should reflect it. Hard rock zones should produce headlands and cliffs. Soft rock zones should produce bays and gentle shores. River mouths should produce estuaries.

Check each section of coastline:
- On hard rock: coastline should be convex (headland) or at least straight, with steep terrain at the shore edge
- On soft rock: coastline should be concave (bay) or indented, with gentle terrain at the shore edge
- At river mouths: coastline should widen and flatten, with the river broadening as it meets the sea

**Score:** Proportion of coastline sections where the shape matches the expected geology-driven behavior.

### S8. Highland Road Avoidance (threshold: 0.75)

Major roads should preferentially avoid highlands. Measure the proportion of major trunk road length that crosses terrain above the regional median elevation. In most landscapes, trunk roads follow lowland corridors (river valleys, coastal plains, passes between ranges) and only enter highlands when there's no alternative.

**Score:** `trunk_road_length_in_lowlands / total_trunk_road_length`

Where "lowlands" is defined as terrain below the 60th percentile of regional elevation. Adjust the percentile based on the overall hilliness parameter — in a very mountainous region, roads inevitably cross higher ground and the threshold should be more forgiving.

### S9. River Sinuosity (threshold: 0.80)

Rivers should meander, not run in straight lines. Straight rivers are physically unrealistic — even in steep terrain, rivers develop some curvature as they respond to variations in rock hardness, bank material, and flow dynamics. In flat terrain, rivers become highly sinuous.

For each river segment, compute the sinuosity: actual path length divided by straight-line distance between the segment endpoints.

| Terrain context | Expected sinuosity |
|---|---|
| Steep mountain valley | 1.05–1.3 (relatively direct but not straight) |
| Moderate hills | 1.2–1.6 |
| Gentle lowlands | 1.4–2.5 (strong meandering) |
| Flat floodplain | 1.8–3.0+ (highly sinuous, ox-bows) |

**Score:** Proportion of river segments whose sinuosity falls within the expected range for their terrain context. A sinuosity of 1.0 (perfectly straight) in any terrain context is a failure.

Critical diagnostic note: if most rivers score near 1.0, the river generation is almost certainly using direct point-to-point connections rather than terrain-responsive pathfinding. This indicates a fundamental generation method problem, not a parameter tuning issue.

### S10. River Width Variation (threshold: 0.75)

Rivers should widen downstream as they accumulate flow from tributaries. A river should be narrowest near its source and widest at its mouth. Uniform width throughout is unrealistic.

For each river from source to mouth, check that width is non-decreasing (with some local variation allowed). Also check that width correlates with upstream catchment area — rivers draining large areas should be wider than those draining small areas.

**Score:** Proportion of rivers where width increases monotonically from source to mouth (allowing ±15% local variation). Combined with correlation between width and upstream catchment area across all river segments.

Additionally, at confluences (where two rivers join), the downstream river should be wider than either upstream tributary.

### S11. River-Valley Consistency (threshold: 0.80)

Rivers should have associated valley landforms. A river flowing through the landscape should sit in a valley — the terrain on both sides should rise away from the river. The valley width and depth should be proportional to the river's size and the surrounding terrain.

**Detection method:**
1. At sample points along each river, take terrain cross-sections perpendicular to flow.
2. Check that elevation rises on both sides of the river channel (forming a valley profile).
3. For larger rivers in soft terrain, the valley should be wide and gentle (broad floodplain).
4. For rivers in hard terrain, the valley should be narrower and steeper (V-shaped or gorge).

**Score:** Proportion of sample points where a valid valley profile is detected — terrain rises on both sides of the river within a reasonable width.

A low score indicates the rivers were placed on the terrain without carving valleys, which makes them look like blue lines painted on a surface rather than water features that shaped the landscape.

### S12. Drainage Basin Coherence (threshold: 0.75)

The regional map should have clearly defined drainage basins (watersheds) — areas of land where all water flows to the same river mouth. Adjacent rivers should be separated by drainage divides (ridges or high ground). No two river systems should share the same valley or lowland without merging.

**Detection method:**
1. Compute the drainage basin for each river mouth using flow accumulation on the heightmap.
2. Check that basin boundaries follow topographic ridges or high points.
3. Check that each basin is contiguous (no fragmented basins).
4. Check that basins don't overlap (every land cell belongs to exactly one basin).

**Score:** Proportion of basin boundary length that follows identifiable ridgelines or high ground, combined with the proportion of land area assigned to a coherent basin.

---

## Tier 3 — Quality Metrics (Soft Heuristics)

### Q1. Coastline Fractal Quality

Real coastlines have fractal self-similarity — large bays contain smaller indentations, headlands have sub-headlands. Artificial coastlines often have uniform-scale noise (all bumps the same size) or are too smooth.

Measure the coastline at multiple scales:
- At coarse scale (5km segments): are there 2–5 major bays and headlands? (Too few = too smooth, too many = too noisy)
- At medium scale (500m segments): do the major features contain sub-features?
- Compute the fractal dimension of the coastline. Real coastlines have a fractal dimension of roughly 1.1–1.3 (Richardson's measurement). Below 1.05 is too smooth, above 1.4 is too jagged.

**Score:** How close the fractal dimension is to the 1.15–1.25 sweet spot, using a Gaussian penalty.

### Q1b. Coastline Directional Bias (Axis Alignment)

Coastal features should not align to the grid axes. When noise functions are poorly configured, they produce indentations that run vertically or horizontally rather than in natural directions, creating obviously artificial shapes.

Walk along the coastline and for each indentation (bay or inlet), measure the aspect ratio and orientation of its bounding box. Natural bays are roughly as wide as they are deep, and their long axis can point in any direction. Axis-aligned artifacts produce features that are much taller than they are wide (or vice versa), with their long axis at 0° or 90°.

**Detection method:**
1. Identify all concave coastal features (bays, inlets) by segmenting the coastline at inflection points.
2. For each feature, compute the orientation of its longest axis.
3. Build a histogram of feature orientations.
4. Check for spikes at 0° and 90° — these indicate axis-aligned noise artifacts.
5. Also check the aspect ratio of each feature. Ratios above 3:1 are suspicious for smaller features (a long narrow inlet is realistic at fjord scale but not for a small bay).

**Score:** Uniformity of the orientation histogram, measured as 1 minus the normalized peak height. A perfectly uniform distribution scores 1.0. A distribution with a strong spike at 90° (vertical artifacts) scores poorly.

### Q1c. Coastline Smoothness Near River Mouths

Where rivers meet the coast, the shoreline should be smooth and gently curved. Rivers deposit sediment as they approach the sea, building broad estuaries, deltas, and tidal flats. High-frequency coastal noise near river mouths is physically wrong — sediment deposition dampens coastal irregularity.

**Detection method:**
1. For each river mouth, define a smoothing zone — a radius of 1–3km around the point where the river meets the coast.
2. Within this zone, measure coastline roughness: the ratio of actual coastline length to the straight-line distance between the zone's entry and exit points on the coast. A smooth shore has a ratio near 1.0. A noisy shore has a much higher ratio.
3. Compare this roughness to the coastline roughness outside river mouth zones.

**Score:** For each river mouth, score the local roughness. Roughness below 1.2 within the smoothing zone is good. Roughness above 1.5 indicates the coast is too noisy near the river. Average across all river mouths.

Additionally check that the coastline within the river mouth zone is predominantly concave (opening outward) — estuaries are wide, open shapes, not jagged inlets.

### Q1d. Coastline Noise Scale Appropriateness

Coastal noise should operate at appropriate scales relative to the overall coastline length. Very small, high-frequency bumps on a long straight coast look like rendering artifacts rather than geology. Noise features should have a minimum size proportional to the local coastal context.

**Detection method:**
1. Measure the wavelength of coastal features — the distance between successive convex points (headlands) along the coast.
2. Compute the standard deviation of feature wavelengths.
3. A natural coast has a wide spread of feature sizes (fractal character). An artificial coast often has a very narrow spread (all bumps the same size).
4. Also check that the smallest features are not below a minimum plausible size. At regional scale (100km map), coastal features below about 100–200m wavelength are implausibly small and likely noise artifacts.

**Score:** Coefficient of variation of feature wavelengths (higher is better — more natural size variation), combined with a penalty for features below the minimum plausible size.

### Q2. Road Network Hierarchy Ratio

A well-structured road network has much more minor road length than major road length, forming a branching tree-like hierarchy. Measure the ratio of road lengths by tier:

- Trunk roads should be roughly 10–20% of total road length
- Regional roads roughly 30–40%
- Minor/local roads roughly 40–60%

**Score:** How close the actual ratios are to these targets. A network that's all trunk roads or all minor roads scores poorly.

### Q3. Settlement Size-Rank Distribution

Real settlement systems follow a roughly Zipfian distribution — the largest city is about twice the size of the second largest, three times the third, etc. This emerges naturally from central place theory. Check whether the generated settlement hierarchy approximates this.

**Score:** Correlation between log(rank) and log(size) of settlements. A strong negative linear correlation (r² > 0.7) indicates a realistic distribution.

### Q4. Hinterland Coverage

Every point of productive land (farmable lowland, forested areas) should be within the catchment of some settlement. Land that's far from any settlement is economically unused, which is unrealistic if it's good land. Conversely, settlements in unproductive terrain (bare rock, marshland) with no productive hinterland have no economic basis.

**Score (coverage):** Proportion of productive land cells within a reasonable distance (10–15km) of at least one settlement.

**Score (basis):** Proportion of settlements that have meaningful productive land within their catchment.

Combined score is the mean of both.

### Q5. Road Directness

Regional roads should be reasonably direct between the settlements they connect. Some curvature for terrain avoidance is expected, but roads that wander excessively are unrealistic — real roads are built with purpose.

For each road connecting settlement A to settlement B, compute the ratio of actual road length to straight-line distance (the sinuosity or detour index). Typical values for real regional roads:
- Flat terrain: 1.1–1.3 (fairly direct)
- Hilly terrain: 1.3–1.8 (moderate detours for terrain)
- Mountainous terrain: 1.8–2.5 (significant detours through passes)

**Score:** Proportion of roads whose detour index falls within the expected range for their terrain context. Roads that are too direct (cutting through mountains) or too indirect (wandering across flat land) both score poorly.

### Q6. Valley and Pass Utilization

Roads through hilly terrain should preferentially use valleys and passes — the natural corridors through elevated terrain. Identify valleys (local elevation minima along a cross-section perpendicular to the valley axis) and passes (local elevation minima along a ridge).

For each road segment crossing terrain above the regional median:
- Check whether it passes through an identifiable valley or pass
- Or whether it climbs over a ridge/highland unnecessarily (a viable valley or pass existed within a reasonable detour)

**Score:** Proportion of highland road segments that use valleys or passes vs those that climb over ridges where an alternative existed.

### Q7. River Network Density by Geology

If a geology layer exists, the density of surface water features should correlate with rock permeability. Impermeable rock (clay, igneous) should have dense stream networks. Permeable rock (limestone, chalk) should have sparse surface water with dry valleys.

**Score:** Correlation between rock impermeability and stream density across the map. Positive correlation = geologically coherent. No correlation = water network ignores geology.

### Q8. Settlement Clustering Along Routes

Real settlements tend to cluster along major transport corridors (river valleys, trunk roads, coastlines) rather than being uniformly distributed. Measure the proportion of settlements within a buffer distance of either a major road, a navigable river, or the coast.

**Score:** `settlements_on_corridors / total_settlements`

Expect 70–85% of settlements to be on corridors. Below 60% suggests settlements are being placed without regard to transport access. Above 95% suggests an unrealistic absence of inland/off-route settlements.

### Q9. Terrain Transition Quality

The heightmap should show appropriate transitions between terrain types. Highlands should not abruptly meet lowlands (unless there's a geological reason like an escarpment). Valleys should have smooth cross-profiles. Ridges should have consistent character along their length.

Measure the maximum elevation gradient at each point. Score penalizes:
- Very high gradients outside of designated cliff/escarpment zones (terrain is unrealistically spiky)
- Perfectly uniform gradients everywhere (terrain is unrealistically smooth — no crags, bluffs, or breaks in slope)

**Score:** Proportion of the map where terrain gradients fall within a natural-feeling range, with allowances for designated geological features.

### Q10. River-Settlement Relationship

Most significant settlements should have a relationship with a water body — they should be on a river, at a confluence, on a lake, or on the coast. Settlements far from any water source are historically unusual for anything larger than a small village (and even those typically had a well or spring).

**Score:** Proportion of towns and cities (not villages) within 2km of a river, lake, or coast. Villages are scored more leniently — within 5km.

---

## Composite Scoring

### Regional Validity Gate

```
valid = all(V1, V2, V3, V4, V5, V6, V7, V8, V9)
if not valid: reject region, report which checks failed
```

### Structural Score

```
structural = weighted_mean(S1 through S12)

Suggested weights:
  S1  (road gradient):           0.10
  S2  (road terrain efficiency): 0.15  — most impactful on visual quality
  S3  (road hierarchy):          0.10
  S4  (settlement geography):    0.10
  S5  (port spacing):            0.04
  S6  (river crossing logic):    0.06
  S7  (coastline geology):       0.06
  S8  (highland road avoidance): 0.07
  S9  (river sinuosity):         0.10  — straight rivers are immediately noticeable
  S10 (river width variation):   0.06
  S11 (river-valley consistency):0.08
  S12 (drainage basin coherence):0.08
```

### Quality Score

```
quality = weighted_mean(Q1 through Q10 including Q1b, Q1c, Q1d)

Suggested weights:
  Q1  (coastline fractal):       0.06
  Q1b (coastline axis bias):     0.06  — catches noise function alignment bugs
  Q1c (river mouth smoothness):  0.06  — catches noise applied where sediment should smooth
  Q1d (noise scale):             0.04  — catches uniform-frequency noise artifacts
  Q2  (road hierarchy ratio):    0.08
  Q3  (settlement distribution): 0.05
  Q4  (hinterland coverage):     0.08
  Q5  (road directness):         0.13
  Q6  (valley/pass utilization): 0.13
  Q7  (river density geology):   0.05
  Q8  (settlement clustering):   0.08
  Q9  (terrain transitions):     0.08
  Q10 (river-settlement):        0.10
```

### Overall Regional Score

```
overall = (structural * 0.6) + (quality * 0.4)
```

---

## Diagnostic Application to Common Problems

The following table maps common visual problems in generated regions to the specific checks that would catch them:

| Visual problem | Primary check | Secondary checks |
|---|---|---|
| Roads cutting straight through mountains | S2 (terrain efficiency), S8 (highland avoidance) | Q6 (valley/pass use), S1 (gradient) |
| Coastline looks like uniform noise | Q1 (fractal quality), Q1d (noise scale) | S7 (geology agreement) |
| Coastline has vertical/horizontal artifacts | Q1b (axis bias) | Q1d (noise scale) |
| Noisy coastline at river mouths | Q1c (river mouth smoothness) | Q1 (fractal quality) |
| Two ports right next to each other | S5 (port spacing) | V6 (settlement spacing) |
| Settlement in the middle of nowhere with no water | S4 (settlement geography) | Q10 (river-settlement), Q4 (hinterland) |
| Roads wandering aimlessly through hills | Q5 (road directness), S2 (terrain efficiency) | Q6 (valley/pass use) |
| All roads the same visual weight | S3 (hierarchy coherence) | Q2 (hierarchy ratio) |
| River flowing uphill in places | V4 (flow consistency) | — |
| Settlements uniformly scattered like salt | Q8 (corridor clustering) | Q3 (size-rank distribution) |
| Terrain has abrupt height changes | Q9 (terrain transitions) | — |
| River appears/disappears randomly | V5 (river termination) | Q7 (density by geology) |
| Rivers are straight lines | S9 (sinuosity) | V7 (terrain obedience), S11 (valley consistency) |
| Rivers run parallel without merging | V8 (dendritic structure) | S12 (drainage basin coherence) |
| River same width from source to mouth | S10 (width variation) | S6 (crossing logic) |
| Rivers cross ridges or high ground | V7 (terrain obedience) | S11 (valley consistency) |
| Rivers have no visible valleys | S11 (valley consistency) | S9 (sinuosity) |
| River starts in a flat lowland | V9 (source logic) | S12 (drainage coherence) |
| Flat terrain has the same road pattern as hills | S1 (gradient), Q5 (directness) | S2 (terrain efficiency) |
| No settlements near the obvious harbor | S4 (settlement geography) | Q4 (hinterland coverage) |

---

## Usage Notes

### Applying to the Screenshot

The screenshot in question would likely score poorly on:

1. **S2 (road terrain efficiency)** — the major east-west road appears to cross high ground when lower routes exist to the south
2. **S8 (highland road avoidance)** — trunk roads traverse the highland area rather than skirting it
3. **Q1 (coastline fractal quality)** — the southern coastline has uniform-scale noise without multi-scale bay/headland structure
4. **S5 (port spacing)** — two ports on the east coast appear to be very close together without clear differentiation
5. **Q6 (valley/pass utilization)** — roads through the highland area don't appear to seek passes or valleys
6. **S3 (road hierarchy coherence)** — the network of thin roads in the northwest doesn't show clear hierarchy connecting down to the trunk network

### Repair Strategies

When a regional map scores poorly, targeted repairs are possible:

- **Poor S2/S8/Q6:** Re-route trunk roads using A* with stronger elevation penalties. Identify passes (saddle points along ridgelines) and force trunk roads through them.
- **Poor Q1:** Re-run coastline generation with multi-octave noise instead of single-frequency. Apply differential erosion based on a geology layer.
- **Poor S5:** Merge nearby ports into a single larger settlement, or demote one to a non-port town.
- **Poor S4:** Re-score all settlement locations and relocate the worst-scoring settlements to nearby better sites (river crossings, valley junctions).
- **Poor S3:** Assign road hierarchy top-down. Find the shortest trunk route between cities first, then connect towns to the trunk, then connect villages to the nearest town road.
