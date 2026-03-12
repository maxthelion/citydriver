# Land-First Development

## Core Insight

Real cities don't build roads and then fill the gaps. They find good land and build roads to serve it. The current approach — skeleton roads radiating from nuclei, then parcels along those roads — gets the causality backwards. Development should be driven by **where the best buildable land is**, with roads added to access it.

## Design Decisions

These decisions were made during the brainstorming phase:

- **Skeleton roads stay** as the arterial network (tick 1 unchanged). Land-first replaces local street generation only.
- **Land value drives development priority** (what order zones get built), not street layout. Once zones are identified, terrain analysis drives layout.
- **Hybrid coordinate approach** — grid for analysis (land value, flood fill, morphology), world coordinates for street geometry.
- **Grid resolution increased** from 20m to 5m cells. Current grid is ~75×75; at 5m it becomes ~300×300 = 90k cells. See [Grid Resolution Change](#grid-resolution-change) for cell-count constant audit.
- **Per-nucleus development** — each nucleus runs zone extraction independently, acting as its own growth center. Zones assigned to nearest nucleus.
- **Parallel ribbons** of development, not rectangles. Each ribbon clips to zone boundary independently.
- **Variable ribbon spacing** — ~30m near nucleus (urban), ~50m further out (suburban). Spacing chosen per-zone based on centroid distance to nucleus (not variable within a zone).
- **Slope determines orientation** — contour-following for moderate slopes (0.1–0.2), up/down for gentle (< 0.1), city-center bearing as tiebreaker on flat ground.
- **Morphological close** before flood-fill to smooth over small imperfections (a real developer would grade these flat).

> **Future enhancement**: cost-based grading — treat marginal cells (slope up to ~0.3) as gradeable at a cost if surrounded by good cells. Zone "development cost" feeds into priority ordering. Not needed for v1. Track as backlog item.

## Problems With Current Land Value

The current land value formula paints value sources (town center 1.0, waterfront 0.2, hilltops 0.9, junctions 0.75, bridges 0.85) then Gaussian-blurs with radius 20 cells. In practice:

- **River proximity overwhelms everything** — the 0.2 waterfront paint plus blur creates a wide hot band along rivers, while most inland flat ground reads as low value
- **Hilltop bonus is misleading** — steep hilltops score 0.9 land value but have low buildability (slope penalty). The value map suggests they're desirable but they're actually hard to build on
- **Flat ground near city center is undervalued** — a gently sloping field 200m from the center might score lower than a riverbank 400m away
- **No concept of "developable area"** — a single flat cell surrounded by cliffs scores well, but you can't put a street there

## Pipeline

```
Tick 1: Skeleton roads (unchanged — MST between nuclei, arterial network)

Tick 2: Revised land value
  - Computed at 5m grid resolution
  - Formula: flatness (local avg) + center proximity, water as bonus
  - Per-nucleus: each nucleus is "center" for nearby cells

Tick 3: Zone extraction (per nucleus)
  - Voronoi assignment — each cell belongs to nearest nucleus
  - Threshold: land value > 0.3, buildability > 0.2, slope < 0.2
  - Morphological close (2-cell dilate + erode, ~20m physical)
  - Flood-fill connected components
  - Filter by min size (30 cells = ~750m²), rank by value/distance

Tick 4: Ribbon layout (per zone, in priority order)
  - Compute avg slope direction per zone
  - Choose orientation (contour vs up/down vs center-bearing)
  - Place spine street through centroid
  - Place parallel streets at zone-wide spacing (30–50m based on centroid dist)
  - Clip each street to zone boundary polygon
  - Add cross streets every 80–100m where adjacent parallels overlap
  - All streets added as road features + graph edges + roadGrid

Tick 5: Connect to network
  - A* from each zone's spine endpoint to nearest skeleton road node/edge
  - Connection road added as hierarchy 'collector'
  - Cost function: 'growth' preset; max path length 500m; skip zone if no path

Tick 6: Plot subdivision
  - Parcels = bands between adjacent parallel streets
  - Subdivide along street edge (walk polyline at plot-width intervals)
  - Plot width by density tier (5m terraced / 8m semi / 12m detached)
  - Place buildings using existing archetype system
```

## Revised Land Value Formula

All distances expressed in **meters** and converted to cells at runtime (`meters / cellSize`), so the formula is resolution-independent.

```
For each cell:
  localFlatness = 1.0 - clamp(avgSlopeInRadius(15m) / 0.4, 0, 1)
  centerDist    = distance to owning nucleus (meters)
  proximity     = 1.0 / (1.0 + centerDist / 200)

  base = localFlatness * 0.6 + proximity * 0.4

  waterBonus = (within 50m of water AND buildable) ? 0.15 * (1 - waterDist/50m) : 0

  landValue = base + waterBonus
```

Key differences from current:
- No hilltop source painting (misleading on steep ground)
- No junction/bridge sources (don't exist yet at land-value time)
- Flatness measured over a local area (~15m radius), not per-cell
- Center proximity is the main gradient, not waterfront
- Water is additive bonus only
- Computed per-nucleus (each nucleus is "center" for nearby cells)
- **All radii/distances in meters**, converted to cells dynamically — resolution-independent

## Zone Extraction

1. **Voronoi assignment** — each cell assigned to nearest nucleus by Euclidean distance. Partitions the map so nuclei don't compete for the same land.
2. **Threshold** — within each nucleus's territory, cells must meet ALL of:
   - `landValue > 0.3`
   - `buildability > 0.2`
   - `slope < 0.2` (per-cell check — steep cells excluded before zone formation, not after)
3. **Morphological close** — dilate candidate mask by 2 cells, then erode by 2 cells. At 5m resolution this fills holes up to ~20m across, bridges narrow gaps, doesn't expand overall boundary. Cells added by dilation that fail the slope < 0.2 check are removed after erosion.
4. **Flood-fill** — find connected components within each nucleus's territory. Each component is a development zone.
5. **Filter** — discard zones smaller than 30 cells (~750m²). Too small for a street.
6. **Priority** — zones ranked by `totalLandValue / distanceFromNucleus`. High-value zones close to their nucleus develop first.
7. **Zone boundary polygon** — extract boundary of each zone's cell set using cell-edge tracing (walk the boundary cells, emit world-coordinate vertices at cell corners). Simplify with Douglas-Peucker (tolerance = 1 cell width) to reduce vertex count. Zones with holes: use outer boundary only, holes become unbuildable gaps within the zone (streets clip around them).

## Ribbon Layout

### Orientation

Per zone, compute average gradient vector across all zone cells:
- Average slope > 0.1: **contour-following** — streets perpendicular to gradient (along hillside at constant elevation)
- Average slope ≤ 0.1: **flexible** — streets aligned with bearing from zone centroid toward owning nucleus (radial pattern)

(Note: cells with slope > 0.2 are already excluded during zone extraction, so the zone average slope will always be ≤ 0.2.)

### Placing Streets

1. **Spine street** — line through zone centroid in chosen direction, clipped to zone boundary polygon
2. **Parallel streets** — offset from spine at ribbon spacing. Spacing is **per-zone** based on centroid distance to nucleus (avoids irregular patterns from mid-zone spacing changes):
   - < 100m from nucleus: ~30m (dense urban, terraced houses)
   - 100–300m: ~40m (mid-density)
   - \> 300m: ~50m (suburban, detached houses)
3. **Each street clipped independently** to zone boundary polygon — ribbons naturally have different lengths
4. **Cross streets** — perpendicular connectors every 80–100m. Placed only where two adjacent parallel streets both extend to at least that perpendicular position (i.e., the cross street start and end must both be within the zone boundary). Minimum cross street length: 20m.
5. **Contour adjustment** (sloped zones only, average slope > 0.1):
   - Sample elevation at 5m intervals along each candidate street line
   - Find average elevation — this is the street's "target contour"
   - Walk the line, nudging each point perpendicular to gradient to maintain constant elevation (±1m tolerance)
   - Chaikin smooth (2 passes) — streets curve gently with hillside

### Road Hierarchy

All streets become actual roads in the system:
- **Arterial/trunk** — skeleton roads between nuclei (tick 1, unchanged)
- **Collector** — spine connections from zones to skeleton network (tick 5)
- **Local** — parallel streets and cross streets within zones (tick 4)

Every street is added via `map.addFeature('road', ...)`, added to the planar graph (nodes at endpoints and intersections, edges between), and stamped onto roadGrid.

### Connection to Skeleton Network (Tick 5)

For each zone:
1. Find the **nearest point on any skeleton road edge** to the zone's spine street endpoint. If this point is mid-edge, split the edge and insert a new graph node.
2. Run A* from the spine endpoint to that node using the `'growth'` cost preset.
3. **Maximum path length**: 500m. If no path is found within this budget, skip the zone (it's isolated — likely separated by water or steep terrain).
4. Add the connection road as `hierarchy: 'collector'`, `width: 8`.

## Plot Subdivision

The band between two adjacent parallel streets is a **parcel**. Plot subdivision follows the approach described in `plot-placement.md` — walking the street polyline at regular intervals.

- Two rows of plots per parcel — front row faces one street, back row faces the other, gardens meet in the middle
- Plot width varies by density tier (same per-zone spacing as ribbon selection, based on centroid distance to nucleus):
  - < 100m: 5m (terraced) — party walls, no side gap
  - 100–300m: 7–8m (semi-detached) — shared party wall per pair
  - \> 300m: 10–12m (detached) — side gaps between houses
- For 30m ribbon spacing: ~12m plot depth × 2 rows + 6m shared garden
- For 50m ribbon spacing: same house depth, larger gardens
- **Partial plots**: at the ends of ribbons where remaining street length < plot width, skip (don't place a partial house)
- **Non-parallel streets** (after contour adjustment): plots are placed by walking each street polyline independently. The two rows within a parcel may not align perfectly — this is fine, the back gardens absorb the difference
- Buildings placed using existing archetype system (`createHouse`, `addFloor`, `addPitchedRoof`, etc.)
- Terrain height sampled at plot center
- House rotation aligned to street tangent direction at that point

## Integration With Existing Code

### What Changes

| File | Change |
|---|---|
| `constants.js` | `CITY_CELL_SIZE` from 20 to 5 |
| `FeatureMap.js` | `computeLandValue()` rewritten with new formula; cell-count constants converted to meters (see audit below) |
| `stripDevelopment.js` | Tick 2+ replaced with zone extraction + ribbon layout (or new strategy class) |
| `placeBuildings.js` | `placeTerracedRows()` updated to work from ribbon parcels |

### What Stays The Same

- Skeleton road building (tick 1)
- Nucleus placement in `setup.js`
- A* pathfinding and cost functions
- Building archetype system
- Road rendering, terrain rendering, all 3D scene code
- Chaikin smoothing of road polylines
- All existing debug layers

### New Debug Layers

1. **Revised Land Value** — new formula visualised
2. **Development Zones** — flood-filled zones colored by nucleus ownership, with boundaries
3. **Street Orientation** — zones with arrows showing chosen ribbon direction
4. **Zone Priority** — zones colored by development order (first = bright, last = dim)
5. **Ribbon Layout** — parallel street lines within zones

### Grid Resolution Change

Changing `CITY_CELL_SIZE` from 20 to 5 means the grid goes from ~75×75 to ~300×300 (90k cells). This is a 16× increase in cell count.

**Critical**: any constant expressed in cell counts changes its physical meaning by 4×. All such constants must be converted to meters and divided by `cellSize` at runtime. Here is the audit of affected constants in `FeatureMap.js`:

| Constant / Location | Current (cells) | Physical meaning at 20m | Action |
|---|---|---|---|
| `LV_BLUR_RADIUS = 20` | 20 cells | 400m | **Removed** — new land value formula doesn't use blur |
| Water distance BFS cutoff: 15 | 15 cells | 300m | Convert: `Math.round(300 / cellSize)` |
| Edge margin: 3 cells | 3 cells | 60m | Convert: `Math.round(60 / cellSize)` |
| Edge taper: 3–8 cells | 3–8 cells | 60–160m | Convert: `Math.round(60 / cellSize)` to `Math.round(160 / cellSize)` |
| Hilltop neighborhood: 10 cells | 10 cells | 200m | **Removed** — no hilltop scoring in new formula |
| Waterfront bonus dist: ~10 cells | 10 cells | 200m | Convert to meters in new formula (50m — reduced from 200m as per new design) |
| Road stamp radius (line ~713) | `halfW + 3 * cellSize` | Already in meters | No change needed |

Other files with cell-count constants:
| File | Constant | Action |
|---|---|---|
| `setup.js` | nucleus spacing: 15 cells, suppression: 40 cells, waterfront dist: 6 cells | Convert to meters |
| `stripDevelopment.js` | Mostly replaced, but `snapDist = cellSize * 3` | Already cell-relative, OK |

### Performance Impact

At 300×300 = 90k cells:
- A* pathfinding: 16× more cells but grid is still small (~90k); A* is efficient with the existing binary heap
- Debug layer rendering: 300×300 canvas, still instant
- Terrain mesh: 90k vertices, well within WebGL limits
- Memory: ~10 Grid2D layers × 90k cells × 4 bytes ≈ 3.5MB, negligible
- Morphological close + flood-fill: O(n) operations on 90k cells, sub-millisecond
