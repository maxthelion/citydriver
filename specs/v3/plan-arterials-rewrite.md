# Plan: Arterials Rewrite (B4)

## Current Problems

See `observations-arterials.md` for the full 7-issue breakdown. In summary:

The current B4 arterials phase finds "gaps" in the arterial network by sampling
high-density cells far from arterial nodes, then connects the top 4 gaps to
the nearest node. This produces short, overlapping spurs that cluster around
the same node rather than building a coherent road framework.

The cross-link code is dead (looks for `type === 'entry'` but anchor routes
create `type === 'inherited'`). Structural roads (waterfront) are invisible.
The phase doesn't consider city tier, shape, or population target.

## What Arterials Should Do

Arterials are the **skeleton** of the city. They should:

1. Form a coarse framework that defines the city's major corridors
2. Connect different parts of the city to each other (not just spurs to one node)
3. Extend the inherited regional roads into and through the populated area
4. Create a network that collectors and local streets will later subdivide
5. Scale with city tier — a tier-1 city needs more arterials than a tier-3 village
6. Respond to terrain — follow ridgelines, valleys, and contours
7. Connect to the waterfront/structural network where relevant

## Proposed Approach: Radial + Ring Framework

Instead of reactive gap-filling, proactively build a framework:

### Phase 1 — Identify the buildable extent

Use the density field to find the approximate boundary of the populated area.
March outward from the city center until density drops below a threshold (0.15).
This gives an irregular polygon representing the "city footprint".

Compute:
- `cityRadius`: approximate radius of the populated area
- `cityCenter`: the seed node position
- `buildableArea`: set of grid cells with density above threshold

### Phase 2 — Radial spokes from center

Create radial arterials from the city center outward to the edge of the
buildable area. The number of spokes scales with tier:

| Tier | Population | Spokes | Approx spacing |
|------|-----------|--------|----------------|
| 1    | 50k       | 6-8    | 45-60 degrees  |
| 2    | 10k       | 4-6    | 60-90 degrees  |
| 3    | 2k        | 2-4    | 90-180 degrees |

**Spoke placement algorithm:**

1. Start with inherited arterials — each road entering the city from the
   boundary already provides a spoke direction. Record these angles.
2. Identify angular gaps between existing spokes.
3. For each gap larger than the target spacing, add a new spoke at the
   midpoint angle.
4. Aim each new spoke from the center outward to the edge of the buildable
   area at that angle, snapped to the nearest buildable cell.
5. A* pathfind each spoke using density-weighted terrain cost.

**Connecting spokes to the existing network:**

- Each spoke starts at the city center node (or nearest existing arterial node)
- Each spoke ends at the edge of the buildable area
- If a spoke crosses an inherited arterial, create a junction node
- If a spoke ends near an inherited road's boundary node, connect to it

### Phase 3 — Ring roads (tier 1-2 only)

For larger cities, add ring roads that cross-connect the radial spokes:

- **Inner ring**: at ~30-40% of city radius, connecting all spokes
- **Outer ring**: at ~70-80% of city radius (tier 1 only)

Ring road algorithm:
1. For each spoke, pick the point at the target radius fraction
2. Connect consecutive ring points with A* pathfinding
3. The ring follows the natural contour of the buildable area (density-weighted cost keeps it in populated territory)

### Phase 4 — Connectivity verification

After placing spokes and rings:
1. Check that all inherited road nodes are reachable from the center
2. Check that the waterfront/structural network has at least one connection to the arterial network
3. Add bridging connections where the network is disconnected

### Phase 5 — Dead-end cleanup

Any arterial that terminates without connecting to another road is either:
- Extended to reach the nearest other arterial (if close)
- Pruned (if it's a very short spur adding no value)

## Implementation Details

### Modified cost function

```js
const arterialCost = (fromGx, fromGz, toGx, toGz) => {
  let c = baseCost(fromGx, fromGz, toGx, toGz);
  if (!isFinite(c)) return c;

  // Prefer populated areas
  const d = density.get(toGx, toGz);
  c *= (1.5 - d);

  // Prefer existing road cells (road sharing)
  if (roadGrid.get(toGx, toGz) > 0) c *= 0.4;

  // Slight preference for staying on contour (reduce cross-slope movement)
  const fromH = elevation.get(fromGx, fromGz);
  const toH = elevation.get(toGx, toGz);
  const heightChange = Math.abs(toH - fromH);
  c += heightChange * 2;

  return c;
};
```

### Road grid for sharing

Build a `roadGrid` from all existing graph edges (inherited + structural) so
new arterials can share cells with existing roads. Same 0.3-0.4x discount as
the regional road generator.

### Spoke angle calculation

```
existingAngles = [angle of each inherited road at city boundary]
targetSpacing = 360 / targetSpokes

For each gap between consecutive existing angles:
  if gap > targetSpacing * 1.5:
    numNew = floor(gap / targetSpacing)
    for i in 1..numNew:
      newAngle = gapStart + gap * i / (numNew + 1)
      add spoke at newAngle
```

### Connecting to the waterfront

After placing radial spokes, check which waterfront/structural nodes are more
than `cityRadius * 0.3` from any arterial node. For each isolated waterfront
node, pathfind to the nearest arterial node and add as a collector-grade link.

### Node types

New arterials create nodes with `type: 'arterialSpoke'` (spoke endpoints) and
`type: 'arterialRing'` (ring intersections). Junctions where spokes cross
inherited roads get `type: 'junction'`.

## Files to Modify

- **`src/city/generateArterials.js`** — Full rewrite
- **`src/city/pipeline.js`** — No structural changes needed (B4 call stays the same)
- **`src/city/pipelineDebug.js`** — May need to update debug rendering for new edge types

## Impact on Downstream Phases

- **B3 density (post-arterials)**: More arterial nodes means denser road-proximity
  bonus in the recomputed density field. This amplifies density along the spoke
  corridors, creating natural building zones.
- **B6 collectors**: More arterial edge midpoints as destinations. Collectors
  will subdivide the wedge-shaped areas between radial spokes.
- **B7 streets**: Denser arterial framework means shorter collector segments,
  which means local streets have smaller blocks to fill.
- **B8 loop closure**: More nodes to connect, more loops to close.

## Risks

- **Over-building**: Too many spokes for a small city could create a road network
  that exceeds the population budget. Mitigate by scaling spoke count with tier
  and checking total road length against a budget.
- **Spoke-through-water**: A radial spoke aimed at an angle where the coastline
  blocks could fail. Mitigate by checking the target endpoint is on buildable
  land, and snapping to the nearest buildable cell.
- **Ring road weirdness**: Ring roads on irregular buildable areas might produce
  strange shapes. The A* density-weighted cost should keep them reasonable, but
  may need visual tuning.

## Execution Order

1. Build a road grid from existing edges
2. Compute buildable extent and city radius
3. Calculate existing spoke angles from inherited roads
4. Fill angular gaps with new spokes
5. Add ring roads (tier 1-2)
6. Verify connectivity (waterfront, inherited nodes)
7. Clean up dead ends
