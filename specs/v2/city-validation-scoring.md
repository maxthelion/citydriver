# City Generation Validation & Scoring Specification

## Framing

A well-generated city satisfies a hierarchy of constraints. At the bottom are hard rules — things that must never happen (roads in the sea). Above those are structural rules — properties that should hold everywhere unless there's a specific reason they don't (every building fronts a road). At the top are quality heuristics — soft measures of how natural, efficient, and coherent the city feels (land is used efficiently given terrain constraints).

These three tiers map naturally to an automated scoring system:

- **Tier 1 — Validity checks** → Boolean pass/fail. Any failure means the generation is broken and should be rejected or repaired.
- **Tier 2 — Structural checks** → Scored 0.0–1.0 per check. Measures what proportion of elements satisfy the rule. A score below a threshold indicates a problem.
- **Tier 3 — Quality metrics** → Scored 0.0–1.0. Holistic measures of how good the city feels. Used for tuning and comparison, not hard rejection.

The overall city score is a weighted combination of Tier 2 and Tier 3 scores, gated by Tier 1 validity. If any Tier 1 check fails, the city is invalid regardless of other scores.

---

## Tier 1 — Validity Checks (Hard Constraints)

These are physical impossibilities or logical contradictions. Every check is boolean: pass or fail.

### V1. Land Use Exclusion

No built structure (road, building, wall) occupies a cell classified as water (sea, river channel, lake). Check by testing every occupied cell against the water mask.

**Test:** `for each built cell: assert cell not in water_mask`

### V2. Road Continuity

The road network must be a single connected graph. Every road segment must be reachable from every other road segment. Disconnected road fragments serve no purpose and indicate a generation bug.

**Test:** Run flood fill or BFS from any road node. Assert all road nodes are visited.

### V3. Building Integrity

No building footprint overlaps another building footprint. No building footprint overlaps a road. No building footprint extends outside the map boundary or into water.

**Test:** Rasterize all footprints and roads. Assert no cell is claimed by more than one entity.

### V4. Road-Road Clearance

Road edges must maintain a minimum clearance from other roads except at designated junction nodes. Two roads running close together without connecting is a generation error — it wastes space and looks wrong.

**Test:** For each road segment edge, measure distance to nearest non-connected road segment edge. Assert distance is either zero (they share a junction node) or above a minimum threshold (e.g., one building plot width, typically 5–8m).

### V5. No Duplicate Connections

No two roads should connect the same pair of junction nodes. Parallel roads linking the same two intersections serve no topological purpose and indicate redundant generation.

**Test:** Build adjacency list from road graph. Assert no duplicate edges between any node pair.

### V6. Bridge Validity

Any road crossing water must have a bridge structure placed. Roads cannot implicitly float over rivers.

**Test:** For each road segment, check if its path crosses any water cell. If so, assert a bridge entity exists at the crossing point.

---

## Tier 2 — Structural Checks (Scored Proportions)

Each check measures what fraction of relevant elements satisfy a rule. Scored 0.0–1.0 where 1.0 means perfect compliance. Set a threshold per check (suggested defaults below) — below the threshold indicates a problem worth investigating.

### S1. Building Road Access (threshold: 0.95)

Every building must front a road. A building "fronts" a road if at least one face of its footprint is adjacent to (within 2m of) a road edge. Buildings without road access are unreachable and wouldn't exist in a real city.

**Score:** `buildings_with_road_access / total_buildings`

**Exceptions:** Some outbuildings or garden structures behind a main building are acceptable, but the main building on each plot must have frontage. If the generation explicitly marks ancillary structures, exclude them from this check.

### S2. Plot Road Frontage (threshold: 0.95)

Every plot should have at least one edge along a road. Landlocked plots with no street frontage are unbuildable in practice.

**Score:** `plots_with_frontage / total_plots`

### S3. Through-Connectivity (threshold: 0.95)

Roads should connect through to other roads at both ends. Dead ends should essentially not exist in the generated city. Real urban streets form continuous networks of loops and through-routes — every street connects at both ends to another street, creating a mesh that allows multiple routes between any two points. This is how cities work: it provides redundant access, allows traffic to flow, and means every building can be approached from more than one direction.

The only acceptable dead ends are:

- **Map edge terminations** — roads that leave the city boundary toward regional destinations. These aren't true dead ends, they're connections to the wider world.
- **Terrain-forced terminations** — a road that reaches a cliff edge, waterfront, or impassable slope where continuing is physically impossible. Even these should be rare, as the road generator shouldn't extend roads toward impassable terrain in the first place.
- **Era-specific cul-de-sacs** — only if the city style parameter explicitly includes a modern suburban component. Even then, cul-de-sacs should be infrequent and deliberate, not a generation artifact.

**Score:** `through_connected_road_ends / total_road_ends`

Where a "road end" is any node in the road graph with degree 1 (only one road segment connects to it). Map edge terminations are excluded from both numerator and denominator.

A score below 0.95 strongly indicates the road generation algorithm is failing to close loops. The most common fix is a connection pass after initial road generation: for every dead end, search for the nearest road segment within a reasonable distance and extend a connecting road to it.

### S4. Terrain-Road Agreement (threshold: 0.90)

Roads should respect terrain. Measure the gradient along each road segment. Roads with excessively steep gradients (above ~8% for main roads, ~12% for local roads, ~15% for access lanes) are unrealistic.

**Score:** `road_segments_within_gradient_limit / total_road_segments`

Weight by road hierarchy — a steep arterial is a worse violation than a steep back lane.

### S5. Building-Terrain Agreement (threshold: 0.90)

Buildings should sit on reasonably flat ground. For each building footprint, measure the elevation range across the footprint. If it exceeds a threshold (e.g., 2m for a small house, 4m for a larger building), the building is perched on a slope it couldn't realistically occupy without major earthworks.

**Score:** `buildings_on_suitable_terrain / total_buildings`

### S6. Zoning Coherence (threshold: 0.85)

Buildings of the same type should cluster. Measure this by checking each building against its neighbors within a radius. A residential building surrounded by other residential buildings is coherent. A house dropped in the middle of an industrial zone is incoherent. Use a simple same-type-neighbor ratio.

**Score:** `mean(same_type_neighbors / total_neighbors) across all buildings`

Allow for natural mixed-use zones — a shop on a residential street is fine, so weight mixed-use buildings as compatible with both commercial and residential neighbors.

### S7. Amenity Coverage (threshold: 0.80)

Residential areas should be within catchment distance of key amenities. For each residential building, check whether it's within the appropriate distance of: a primary school (800m), a local shop/commercial frontage (400m), and a park or open space (400m).

**Score:** `residential_buildings_within_all_catchments / total_residential_buildings`

### S8. Road Hierarchy Consistency (threshold: 0.85)

Local streets should connect to collectors, collectors to arterials. A local street directly joining an arterial without an intermediate collector is a minor issue. A local street that only connects to other local streets and never reaches a collector is a bigger problem — it's a road network that doesn't drain traffic upward through the hierarchy properly.

**Score:** For each local street segment, trace outward through the network. Assert that within a small number of hops (3–5 segments), a higher-hierarchy road is reached. Score is the proportion that satisfy this.

---

## Tier 3 — Quality Metrics (Soft Heuristics)

These measure how good the city feels, not whether it's structurally broken. They're continuous scores for comparison and tuning.

### Q1. Land Use Efficiency

In buildable areas (flat, not water, not parkland, within the city boundary), what proportion of land is purposefully used — occupied by buildings, roads, gardens, plazas, or designated open space? Empty, unassigned gaps in otherwise dense areas indicate the generator failed to fill space effectively.

**Score:** `purposefully_used_area / total_buildable_area`

This should be density-dependent — in the city center, expect 0.85+. In suburban fringes, 0.5–0.7 is fine. Score each district relative to its target density from the density field.

**Score (refined):** `mean(actual_density / target_density) across districts, capped at 1.0`

### Q2. Street Pattern Regularity (where appropriate)

In areas designated as grid or planned, measure how regular the street pattern actually is. Compute the angles at which streets meet — in a perfect grid, all intersections are 90°. Allow the organic-vs-grid parameter to set expectations: a fully organic city should not be penalized for irregular angles.

**Score:** Weighted by the organic-vs-grid parameter. For grid-biased areas, score the mean deviation of intersection angles from 90° (lower deviation = higher score). For organic areas, penalize only very acute angles (below 30°) which create impractically sharp blocks.

### Q3. Frontage Continuity

Along commercial and dense residential streets, the building line should be relatively continuous — few gaps, consistent setback. Measure the proportion of street frontage that has a building face within the expected setback distance.

**Score:** `frontage_length_with_buildings / total_street_frontage_length` (for streets in dense zones)

Gaps are acceptable at intersections, plazas, and designated open spaces. Penalize only unplanned gaps.

### Q4. Parallel Terrace Efficiency

In residential areas on flat terrain, terraced housing in parallel rows is the most space-efficient layout. Measure how well the generator achieves this where terrain permits. For residential blocks on terrain with less than 3% slope, check whether buildings are arranged in roughly parallel rows with consistent spacing.

**Score:** For qualifying blocks, compute the dominant building orientation (using the modal orientation of building long axes). Score the proportion of buildings within ±15° of the dominant orientation, weighted by the consistency of spacing between rows.

A low score here doesn't mean the city is invalid — it means the generator is leaving space on the table in areas where terraces would be more efficient.

### Q5. Garden and Open Space Distribution

Buildings should have associated private outdoor space (front or back gardens) proportional to their type and density zone:

- Dense urban: minimal or no private gardens, compensated by public parks and squares
- Medium density: rear gardens expected (60–80% of residential plots)
- Low density: front and rear gardens expected (90%+ of plots)

**Score:** For each density zone, measure the proportion of residential plots with appropriately sized outdoor space. Average across zones.

### Q6. View and Orientation Quality

Prestige buildings (civic, religious, landmark) should occupy prominent positions — hilltops, plaza frontages, street terminations (visible at the end of a straight road). Measure whether landmark buildings are actually in landmark locations.

**Score:** For each landmark building, check: is it on a local high point? Does any straight road segment terminate with a view of it? Does it face a plaza or open space? Score each landmark 0–1 based on how many of these conditions it satisfies, then average.

### Q7. Terrain-Adaptive Road Pattern

On hilly terrain, roads should contour (follow roughly constant elevation) rather than going straight up slopes. On flat terrain, more direct routes are fine. Measure the correlation between terrain slope and road curvature — on steep terrain, roads should be curving more.

**Score:** For road segments on slopes above 5%, measure the angle between the road direction and the slope direction. Roads going across the slope (contouring) score well. Roads going straight uphill score poorly. Weight by slope severity.

### Q8. Network Efficiency

The road network should balance coverage with economy — enough roads to serve all buildings, but not so many that the city is more road than building. Compute the ratio of road area to total built-up area. Real cities typically have road areas of 25–35% of total urban area.

**Score:** Gaussian penalty centered on the target ratio (e.g., 0.30). Score drops as the ratio moves away from the target in either direction — too few roads means poor access, too many means wasted land.

### Q9. Block Shape Quality

City blocks should be reasonably convex and regular. Very elongated, very narrow, or highly concave blocks are difficult to subdivide into useful plots. Measure the compactness of each block (area / area of minimum bounding rectangle — closer to 1.0 is more compact).

**Score:** `mean(block_compactness) across all blocks`

Exclude triangular blocks at arterial junctions (these are expected) and waterfront blocks (these are naturally irregular).

### Q10. Waterfront Utilization

If the city has a river or coastline, the waterfront should be actively used — docks, commercial frontage, public promenades, or parks rather than the backs of buildings or dead space. Measure what proportion of the buildable waterfront (excluding cliffs, marshland, etc.) has purposeful development facing the water.

**Score:** `developed_waterfront_length / total_buildable_waterfront_length`

---

## Composite Scoring

### City Validity Gate

```
valid = all(V1, V2, V3, V4, V5, V6)
if not valid: reject city, report which checks failed
```

### Structural Score

```
structural = weighted_mean(S1 through S8)

Suggested weights:
  S1 (building access):      0.20  — most critical structural property
  S2 (plot frontage):         0.15
  S3 (network purpose):      0.10
  S4 (terrain-road):         0.15
  S5 (building-terrain):     0.10
  S6 (zoning coherence):     0.10
  S7 (amenity coverage):     0.10
  S8 (road hierarchy):       0.10
```

### Quality Score

```
quality = weighted_mean(Q1 through Q10)

Suggested weights:
  Q1 (land use efficiency):  0.15
  Q2 (street regularity):    0.05
  Q3 (frontage continuity):  0.15
  Q4 (terrace efficiency):   0.10
  Q5 (gardens):              0.10
  Q6 (view quality):         0.05
  Q7 (terrain-adaptive):     0.10
  Q8 (network efficiency):   0.10
  Q9 (block shape):          0.10
  Q10 (waterfront):          0.10
```

### Overall Score

```
overall = (structural * 0.6) + (quality * 0.4)
```

The 60/40 weighting reflects that structural correctness matters more than aesthetic quality — a city that's structurally sound but aesthetically average is much better than a beautiful city where half the buildings can't be reached.

---

## Usage Modes

### Mode 1: Reject and Regenerate

Generate a city, run the full scoring pipeline. If validity fails or structural score is below threshold (e.g., 0.75), discard and regenerate with a different seed. Simple but wasteful.

### Mode 2: Generate and Repair

Generate a city, run scoring, then use failures as repair targets:

- V1 failures (buildings in water) → delete the offending buildings
- S1 failures (buildings without access) → extend a road spur to reach them, or delete the building
- S3 failures (purposeless road stubs) → extend the stub to connect to something, or remove it
- Q4 failures (poor terrace layout) → re-run plot subdivision on the affected block with tighter alignment constraints

This is more efficient but requires repair logic for each check.

### Mode 3: Continuous Fitness During Generation

Instead of scoring after the fact, integrate checks into the generation pipeline as constraints:

- During road generation (Phase 2–5 of city plan): check V4 and V5 in real time, reject road placements that violate them
- During plot subdivision (Phase 6): check S2 as plots are created, adjust subdivision if a plot would lack frontage
- During building placement (Phase 7): check V3, S1, S5 as buildings are placed, skip or adjust placements that fail

This front-loads the quality but adds complexity to each generation phase. It's the most robust approach — problems are prevented rather than detected after the fact.

### Recommended Approach

Use Mode 3 for Tier 1 checks (never allow invalid states to be created) and Mode 2 for Tier 2 and 3 (generate, score, repair the worst problems, accept when good enough). This balances generation speed with output quality.

---

## Diagnostic Output

When scoring a city, produce a diagnostic report showing:

1. **Pass/fail summary** for all Tier 1 checks, with locations of any failures
2. **Score breakdown** for all Tier 2 and 3 checks
3. **Heatmap overlays** showing spatial distribution of problems:
   - Red cells where buildings lack road access
   - Orange cells where terrain-road gradient is excessive
   - Blue cells where land use efficiency is low relative to density target
4. **Worst offenders list** — the 10 individual elements (buildings, road segments, blocks) with the lowest scores, for targeted debugging

This lets you visually identify where the generator is struggling — maybe it consistently fails on steep north-facing slopes, or always leaves gaps near river bends — and fix the underlying generation logic rather than just patching individual cities.
