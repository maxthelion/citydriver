# Urban Economics and Connectivity

## Problems

Three related issues with the current land-first development output:

### 1. Disconnected streets

Ribbon streets within zones are added to the planar graph, but many are effectively disconnected from the skeleton road network. The connection phase (tick 5) only connects each zone's **spine** endpoints to the nearest skeleton node. Individual parallel streets and cross streets have no guaranteed path to the network. A cross street may connect two parallel streets, but if neither parallel connects to the spine, the whole cluster is unreachable.

Additionally, cross streets don't form proper T-junctions with the parallel streets they connect. The cross street endpoints land *near* the parallel street but aren't split into the parallel's graph edge, so the graph treats them as separate disconnected segments.

### 2. Uniform plot size

`plotWidthForDensity` uses distance from nucleus as sole input:
- < 100m → 5m (terraced)
- 100–300m → 8m (semi-detached)
- \> 300m → 12m (detached)

This produces monotonous rows of identical housing. Real cities have variation driven by economics:
- **Narrow terraced** plots in the center (high land value, maximise frontage per meter of road)
- **Wider apartment** plots where a developer aggregates 3–4 terrace widths into one building with higher density per hectare
- **Semi-detached** and **detached** in suburbs where land is cheaper
- **Plot width variation** within a street — not every house is identical width

There is no economic model. Building type is a pure function of distance, with no consideration of land value, zone priority, or achievable density.

### 3. Slope penalty too harsh in valuable areas

Zone extraction excludes any cell with slope ≥ 0.2 (`ZONE_SLOPE_MAX`). The land value formula weights flatness at 60%. Together, these ensure steep areas near the city center are never developed — even gentle hills within 100m of a nucleus get excluded if a few cells exceed 0.2.

Real developers grade hillsides when the land is valuable enough to justify the cost. A 15% slope 50m from the town center is prime development land; the same slope 500m out might not be worth grading.

## Design

### Street connectivity

**Goal**: every local street within a zone must be reachable from the skeleton network through the graph.

#### Within-zone connections (tick 4, during ribbon layout)

When cross streets are placed between adjacent parallel streets, they must form proper T-junctions:

1. **Cross street endpoints snap to parallel streets**: When a cross street endpoint is placed on a parallel street, find the nearest graph edge representing that parallel. Call `graph.splitEdge(edgeId, x, z)` to insert a new node at the intersection point. Connect the cross street to this new node.

2. **Parallel-to-spine connections**: The first and last cross street in each zone should connect to the spine if they don't already. This ensures every parallel street has a path to the spine, and thus to the skeleton network.

#### Zone-to-skeleton connections (tick 5, connection phase)

Current approach connects only spine endpoints. Extend to:

1. **Connect parallel street endpoints** that are closest to the skeleton network. For each zone, identify the parallel streets whose endpoints are nearest to any skeleton road. Connect the closest one (beyond the spine) as a secondary collector if the spine connection alone leaves streets > 200m walk from the skeleton.

2. **Multiple connection points for large zones**: If a zone has more than 6 parallel streets, add a second connection from the far end of the zone to the skeleton. This prevents long cul-de-sac patterns.

#### Graph invariant

After tick 5, verify: for every graph node, there exists a path through the graph to at least one skeleton road node. Log a warning for any disconnected components (don't fail — some zones may be genuinely isolated by water/terrain).

### Economic model for plot density

**Goal**: land value drives building typology, not just distance. Introduce a simple economic model without full market simulation.

#### Development pressure

Each zone gets a **development pressure** score (0–1) combining land value and proximity:

```
pressure = clamp(zone.avgLandValue * 1.5, 0, 1) * 0.6
          + clamp(1 - zone.distFromNucleus / 400, 0, 1) * 0.4
```

Where `avgLandValue` = mean of `map.landValue` across zone cells.

This replaces the current distance-only thresholds.

#### Building typology from pressure

| Pressure | Typology | Plot width | Floors | Street spacing |
|---|---|---|---|---|
| > 0.75 | Dense urban (terraced + apartments) | 4.5–6m terraced, 15–20m apartment | 3–6 | 25–30m |
| 0.5–0.75 | Mid-density (terraced + semi) | 5–8m | 2–3 | 30–40m |
| 0.25–0.5 | Suburban (semi + detached) | 8–12m | 2 | 40–50m |
| < 0.25 | Rural edge (detached) | 12–15m | 1–2 | 50–60m |

#### Apartment blocks

In high-pressure zones (> 0.75), some plots are aggregated into apartment blocks:

- Walk the street placing terraced-width plots (4.5–6m)
- Every 3rd–5th plot (stochastic, seeded), aggregate the next 3–4 plots into one apartment block
- Apartment block: 15–20m wide, 12–15m deep, 4–6 floors
- Probability of apartment vs terraced: `(pressure - 0.75) * 4` clamped to 0–0.5
- This gives a natural mix — mostly terraced with occasional apartment buildings

#### Plot width variation

Within a typology band, plot width varies stochastically:

```
baseWidth = typologyWidth(pressure)
variation = baseWidth * 0.15  // ±15%
plotWidth = baseWidth + seededRandom(-variation, +variation)
```

This breaks up the uniformity of identical-width plots.

#### Ribbon spacing follows pressure

Replace `ribbonSpacing(distFromNucleus)` with `ribbonSpacing(pressure)`:

```javascript
function ribbonSpacing(pressure) {
  if (pressure > 0.75) return 25;
  if (pressure > 0.5) return 35;
  if (pressure > 0.25) return 45;
  return 55;
}
```

### Slope tolerance for high-value land

**Goal**: allow development on moderately sloped land when land value justifies grading costs.

#### Adaptive slope threshold

Replace the fixed `ZONE_SLOPE_MAX = 0.2` with an adaptive threshold that increases with land value:

```
effectiveSlopeMax = ZONE_SLOPE_BASE + landValue * ZONE_SLOPE_LV_BONUS
```

Where:
- `ZONE_SLOPE_BASE = 0.15` — minimum slope threshold (slightly stricter than current 0.2 for low-value land)
- `ZONE_SLOPE_LV_BONUS = 0.15` — maximum additional tolerance from land value
- At `landValue = 1.0`: effective max slope = 0.30 (steep but gradeable)
- At `landValue = 0.3` (zone threshold): effective max slope = 0.195 (about the same as current)

This means:
- Near the nucleus (high LV ≈ 0.7–0.9): slopes up to 0.25–0.28 are included
- Far suburbs (low LV ≈ 0.3–0.4): slopes up to 0.19–0.21 are included (roughly unchanged)

#### Land value formula adjustment

Reduce the flatness weight in the land value formula for cells near the nucleus:

```
flatnessWeight = LV_FLATNESS_WEIGHT * (1 - proximity * 0.3)
proximityWeight = 1 - flatnessWeight
```

At the nucleus (proximity ≈ 1.0): flatness drops from 60% to 42%, proximity rises to 58%.
At 200m out (proximity ≈ 0.5): flatness drops from 60% to 51%.
At 400m+ (proximity < 0.33): flatness stays near 54%.

This ensures sloped land near the center still scores well enough to pass the zone extraction threshold.

#### Grading cost in zone priority

Zones with higher average slope on valuable land should develop, but with a cost penalty in priority ordering:

```
gradingCost = avgSlope > 0.15 ? (avgSlope - 0.15) * 2 : 0
priority = totalLandValue / max(1, distFromNucleus) * (1 - gradingCost)
```

A zone at slope 0.25 gets a 20% priority penalty — it develops, but after flatter zones of similar value.

## Integration

### Files changed

| File | Change |
|---|---|
| `ribbonLayout.js` | `ribbonSpacing` takes pressure instead of distance; export for use by strategy |
| `landFirstDevelopment.js` | Compute pressure per zone; pass to ribbon layout and plot placement; extended connection phase; within-zone junction splitting |
| `zoneExtraction.js` | Adaptive slope threshold using land value; add `avgLandValue` to zone metadata |
| `FeatureMap.js` | Adjusted flatness weight near nucleus in `computeLandValue` |
| `placeBuildings.js` | `plotWidthForDensity` replaced with pressure-based typology; apartment aggregation; width variation |
| `constants.js` | New constants: `ZONE_SLOPE_BASE`, `ZONE_SLOPE_LV_BONUS` |
| `archetypes.js` | New apartment archetype (wider, taller) |

### What stays the same

- Skeleton road building (tick 1)
- Zone extraction pipeline structure (threshold → morph close → flood fill)
- Ribbon layout geometry (spine + parallels + cross streets)
- Contour adjustment for sloped zones
- Occupancy-bitmap collision detection for plots
- Debug layers (zone boundaries, priority colours)
- Building generation system (`createHouse`, `addFloor`, etc.)

### New debug layer

**Development Pressure** — zones coloured by pressure score (red = high, blue = low). Useful for verifying the economic model produces sensible gradients.

### Testing

Extend `plotPlacement.test.js`:
- Apartment blocks don't overlap roads or water
- High-pressure zones produce more plots per hectare than low-pressure zones
- Plot width variation stays within typology bounds
- Graph connectivity: all local road nodes reachable from skeleton

Extend `zoneExtraction.test.js`:
- High land value cells with slope 0.2–0.3 are included in zones near nucleus
- Low land value cells with slope 0.2–0.3 are excluded
- Zone `avgLandValue` metadata is correct

New `connectivity.test.js`:
- Cross street T-junctions exist in graph (node at intersection point)
- Every local road node has a path to a skeleton node
- Large zones have ≥ 2 connections to skeleton
