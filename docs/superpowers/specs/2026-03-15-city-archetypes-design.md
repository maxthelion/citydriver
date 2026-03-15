# City Archetypes: Reservation-Based Land Use

## Goal

Implement archetype-driven land reservation so that cities have distinct
character — commercial streets, industrial zones, parks, civic centres —
instead of uniform residential infill. The reservation pass paints cells
on the `reservationGrid` before `layoutRibbons` runs, shaping the
residential fabric by controlling where it isn't.

## Scope

- Define 5 archetype data objects with land budget shares and placement
  preferences
- Compute 4 spatial layers (centrality, waterfrontness, edgeness,
  roadFrontage) as reusable Grid2D fields
- Implement `reserveLandUse` to paint contiguous reservation zones using
  two growth modes (radial and directional)
- Score settlements against archetypes to determine fit
- Render reservation bitmaps in the existing debug viewer

## Non-Goals

- Building anything in reserved zones (warehouses, parks, civic buildings)
- Commercial street designation or shop placement
- Archetype blending
- Plot grain or density profile changes

---

## Archetype Data

Five archetype objects. Each has land budget shares and per-use-type
placement preferences expressed as weights against spatial layers.

```js
const ARCHETYPES = {
  marketTown: {
    id: 'marketTown',
    name: 'Organic Market Town',
    shares: { commercial: 0.12, industrial: 0.08, civic: 0.05, openSpace: 0.08 },
    reservationOrder: ['civic', 'openSpace', 'industrial', 'commercial'],
    placement: {
      commercial: { centrality: 0.8, roadFrontage: 0.6 },
      industrial: { downwindness: 0.7, edgeness: 0.5 },
      civic:      { centrality: 1.0 },
      openSpace:  { centrality: 0.7 },
    },
    growthMode: {
      commercial: 'directional',  // along road corridor
      industrial: 'directional',  // from edge inward
      civic:      'radial',       // blob from centre
      openSpace:  'radial',       // central square
    },
  },

  portCity: {
    id: 'portCity',
    name: 'Port and Waterfront City',
    shares: { commercial: 0.15, industrial: 0.14, civic: 0.05, openSpace: 0.06 },
    reservationOrder: ['industrial', 'commercial', 'openSpace', 'civic'],
    placement: {
      commercial: { waterfrontness: 0.7, roadFrontage: 0.4 },
      industrial: { waterfrontness: 0.6, downwindness: 0.4, edgeness: 0.3 },
      civic:      { centrality: 0.8, waterfrontness: 0.3 },
      openSpace:  { waterfrontness: 0.9 },  // waterfront promenade
    },
    growthMode: {
      commercial: 'directional',  // parallel to waterfront
      industrial: 'directional',  // waterfront flank
      civic:      'radial',
      openSpace:  'directional',  // promenade strip along water
    },
  },

  gridTown: {
    id: 'gridTown',
    name: 'Planned Grid Town',
    shares: { commercial: 0.14, industrial: 0.12, civic: 0.06, openSpace: 0.08 },
    reservationOrder: ['civic', 'commercial', 'industrial', 'openSpace'],
    placement: {
      commercial: { centrality: 0.9, roadFrontage: 0.5 },
      industrial: { edgeness: 0.7, downwindness: 0.5 },
      civic:      { centrality: 1.0 },
      openSpace:  { centrality: 0.6 },
    },
    growthMode: {
      commercial: 'directional',  // main street grid
      industrial: 'directional',  // edge strip
      civic:      'radial',       // central plaza
      openSpace:  'radial',
    },
  },

  industrialTown: {
    id: 'industrialTown',
    name: 'Industrial Town',
    shares: { commercial: 0.08, industrial: 0.22, civic: 0.04, openSpace: 0.05 },
    reservationOrder: ['industrial', 'civic', 'commercial', 'openSpace'],
    placement: {
      commercial: { centrality: 0.5, roadFrontage: 0.7 },
      industrial: { waterfrontness: 0.4, downwindness: 0.3, centrality: 0.3 },
      civic:      { centrality: 0.6 },
      openSpace:  { edgeness: 0.8 },
    },
    growthMode: {
      commercial: 'directional',
      industrial: 'radial',       // large dominant blob
      civic:      'radial',
      openSpace:  'radial',
    },
  },

  civicCentre: {
    id: 'civicCentre',
    name: 'Civic and Administrative Centre',
    shares: { commercial: 0.10, industrial: 0.04, civic: 0.18, openSpace: 0.14 },
    reservationOrder: ['civic', 'openSpace', 'commercial', 'industrial'],
    placement: {
      commercial: { centrality: 0.5, roadFrontage: 0.6 },
      industrial: { downwindness: 0.8, edgeness: 0.5 },
      civic:      { centrality: 1.0 },
      openSpace:  { centrality: 0.6, waterfrontness: 0.3 },
    },
    growthMode: {
      commercial: 'directional',
      industrial: 'directional',
      civic:      'radial',       // large institutional blob
      openSpace:  'radial',       // multiple distributed parks
    },
  },
};
```

Key design choices:
- `reservationOrder` controls which use type gets first pick. Industrial
  town reserves its works first; civic centre reserves institutions first.
- `placement` weights are multiplied against spatial layer values to score
  each cell. Negative weights repel (industrial avoids waterfront in
  market town).
- `growthMode` determines whether reserved zones grow as radial blobs or
  directional strips.

---

## Spatial Layers

Five new float32 Grid2D layers, computed by a new pipeline step
`computeSpatialLayers(map)` that runs after `extractZones` and before
`reserveLandUse`.

### centrality

How central a cell is relative to the city nuclei.

```
raw = 1 / (1 + dist_to_nearest_nucleus / falloff)
centrality = raw * terrainSuitability  (mask unbuildable)
```

Uses the existing nucleus positions. Falloff parameter controls how
quickly centrality drops — could be tuned per archetype later, but a
single value (e.g. 300m) works for now. Already similar to the proximity
term in land value but computed as its own normalised layer.

### waterfrontness

How "waterfront" a cell is.

```
raw = max(0, 1 - waterDist / range)   where range ~= 100m
waterfrontness = raw * terrainSuitability
```

Uses the existing `waterDist` layer. High near water, zero far from it.
Masked by terrain suitability so water cells themselves and unbuildable
land score 0.

### edgeness

How peripheral a cell is.

```
edgeness = (1 - centrality) * terrainSuitability
```

Simple inverse of centrality. High at the fringe of buildable land.

### roadFrontage

Proximity to skeleton roads.

```
raw = roadGrid blurred with small radius (~3-5 cells)
roadFrontage = normalise(raw) * terrainSuitability
```

Uses the existing `roadGrid` layer. A box blur or distance transform
gives cells near roads higher values. Normalised to 0-1.

### downwindness

How downwind a cell is from the city centre, given prevailing wind.

```
dot = (cellPos - centrePos) · windDirection
downwindness = normalise(dot, 0-1) * terrainSuitability
```

Wind direction comes from `map.prevailingWindAngle` (radians, 0 = +x).
If not set, derived from seed (or defaults to prevailing westerlies).
Used primarily for industrial placement — noxious industries were
historically pushed downwind of the residential core.

All five layers are set via `map.setLayer()` and available to the
reservation logic and debug renderers.

---

## Reservation Logic

`reserveLandUse(map, archetype)` fills the `reservationGrid`:

### Step 1: Compute cell budget

Count all cells across all development zones. Multiply by each share:

```
totalZoneCells = sum of zone.cells.length for all zones
commercialBudget = round(totalZoneCells * archetype.shares.commercial)
industrialBudget = round(totalZoneCells * archetype.shares.industrial)
// etc.
```

### Step 2: Score cells per use type

For each use type, score every zone cell:

```
score(gx, gz, useType) = sum over layers:
    weight * spatialLayer.get(gx, gz)
```

Where weights come from `archetype.placement[useType]`. Negative weights
subtract (industrial avoids waterfront). Cells already reserved by a
prior use type score -Infinity.

### Step 3: Grow contiguous zones

For each use type in `archetype.reservationOrder`:

**Radial growth:**
1. Find the highest-scoring unreserved cell as seed
2. BFS outward from seed, visiting neighbours in score order
3. Claim cells until budget is met
4. Result: a roughly circular blob centred on the best location

**Directional growth:**
1. Find the highest-scoring unreserved cell as seed
2. Determine the growth axis from the dominant spatial layer:
   - If `roadFrontage` is the strongest weight: axis = local road tangent
   - If `waterfrontness` is strongest: axis = local water edge tangent
   - If `edgeness` is strongest: axis = tangent to city boundary
3. Extend along the axis first (prioritise neighbours along-axis over
   perpendicular), then fill perpendicular to a limited depth
4. Result: a strip aligned to a road, coastline, or edge

The axis determination doesn't need to be perfect — the gradient of the
dominant spatial layer at the seed point gives a reasonable direction.

### Step 4: Write to grid

Each claimed cell gets its `RESERVATION` enum value on the
`reservationGrid` layer. The zones are also stored as objects on the map
(with cells, centroid, use type) for future use by renderers and
building placement.

---

## Archetype Scoring

For each settlement, compute a fit score (0-1) per archetype plus
contributing factors.

### Inputs

Available from the map after setup:
- `waterDist` layer — presence and extent of water
- `nuclei` — count and types
- `skeleton roads` — count of connections entering the city
- `terrainSuitability` — average flatness
- `settlement.tier` — from regional pipeline

### Scoring rules

**Port City:**
- Requires waterfront cells > 10% of buildable area (hard gate)
- Score = waterfront fraction × coastal quality
- Reason if rejected: "No significant waterfront"

**Market Town:**
- Default for inland settlements
- Score = road connection count / 4 (normalised to ~1.0 for 4+ roads)
- Boosted if nucleus type includes 'market'
- Reason if rejected: never rejected (always viable as fallback)

**Grid Town:**
- Favours flat terrain
- Score = average terrain suitability across buildable area
- Penalised by high slope variance (irregular terrain resists grids)
- Reason if rejected: "Terrain too varied for planned grid"

**Industrial Town:**
- Requires river or flat valley
- Score = river presence (0.5) + flat area fraction (0.5)
- Reason if rejected: "No river or suitable flat land for works"

**Civic Centre:**
- Favours high tier and connectivity
- Score = (tier ≤ 2 ? 0.8 : 0.3) + road connections / 8
- Reason if rejected: "Settlement tier too low for regional capital"

Each score function returns `{ score: number, factors: string[] }`.
Factors are human-readable strings like "4 road connections",
"35% waterfront cells", "average flatness 0.82".

---

## Pipeline Integration

The pipeline becomes:

```
buildSkeletonRoads → computeLandValue → extractZones →
computeSpatialLayers → reserveLandUse → layoutRibbons →
connectToNetwork
```

`LandFirstDevelopment` sequencer gains tick 4 (`computeSpatialLayers`)
and tick 5 (`reserveLandUse`), pushing `layoutRibbons` to tick 6 and
`connectToNetwork` to tick 7.

### Debug rendering

The existing `renderReservations` debug layer (added in the pipeline
refactor) renders reservation zones by type. Add four more debug layers
for the spatial fields (centrality, waterfrontness, edgeness,
roadFrontage) — each is a heatmap render, trivial given the existing
pattern.

### Archetype comparison view

A function that takes a map (post zone-extraction) and returns an array
of `{ archetype, score, factors, reservationGrid }` for all 5
archetypes. The UI can render these side-by-side. This is a diagnostic
tool, not a pipeline step — it runs each archetype's reservation logic
on a copy of the map and collects the results.

---

## File Structure

```
src/city/archetypes.js           — archetype data objects, ARCHETYPES map
src/city/archetypeScoring.js     — scoreSettlement(map) → scored archetype list
src/city/pipeline/computeSpatialLayers.js  — new pipeline step
src/city/pipeline/reserveLandUse.js        — existing stub, filled in
test/city/archetypes.test.js
test/city/archetypeScoring.test.js
test/city/pipeline/computeSpatialLayers.test.js
test/city/pipeline/reserveLandUse.test.js  — existing, extended
```
