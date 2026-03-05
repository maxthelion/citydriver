# Plots and Streets: A Revised Approach

## The Problem

The current pipeline treats streets and plots as separate sequential steps:

```
C5. Connect neighborhoods (arterials)
C7. Generate street grids
C8. Loop closure
C9. Generate plots (from graph faces)
C10. Place buildings (on plots)
```

This doesn't work well because:

1. **Plots depend on closed faces**, but the street grid often doesn't
   produce clean closed polygons. Gaps in the grid, snapping artifacts,
   and irregular footprint boundaries leave malformed faces that can't
   be subdivided into plots.

2. **Streets don't know about plots.** The grid is placed mechanically
   at fixed spacing. It doesn't respond to whether the resulting blocks
   are the right size for building plots. A grid might create blocks
   that are too large (wasted interior space), too narrow (unusable
   plots), or too deep (plots can't reach a road).

3. **Plots must have road frontage** — that's what makes them plots
   rather than empty land. The current face-based approach extracts
   polygons bounded by roads, then tries to subdivide them. But this
   means the plot shapes are entirely determined by the road layout,
   with no feedback in the other direction.

4. **Real cities grow plots and streets together.** A road creates
   frontage. Frontage creates plots. When back-land behind plots
   becomes valuable enough, a new road is cut to serve it, creating
   new frontage and new plots. Streets exist *to serve plots*, not
   the other way around.

## How Real Urban Plots Work

### Plot anatomy

```
   Road
   ═══════════════════
   [setback / front yard]
   ┌─────────────────┐
   │  Building        │ ← frontage width
   │                  │
   │                  │ ← plot depth
   │                  │
   └─────────────────┘
   [back yard / garden]
   ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  ← back boundary (often another plot's back)
```

Key dimensions:
- **Frontage width**: how wide the plot is along the road
- **Plot depth**: how deep from road to back boundary
- **Setback**: distance from road edge to building front
- **Building footprint**: the actual structure
- **Garden/yard**: remaining space

### Plot dimensions by type

| Type | Frontage | Depth | Front setback | Back garden | Notes |
|------|----------|-------|---------------|-------------|-------|
| Terraced house | 5-7m | 20-30m | 0-2m | 5-10m | Party walls, continuous building line |
| Semi-detached | 7-10m | 25-35m | 3-5m | 8-15m | Pairs sharing a wall |
| Detached house | 10-20m | 30-45m | 5-8m | 10-20m | Side gaps between houses |
| Shop/commercial | 5-10m | 10-20m | 0m | 0-5m | Full frontage, no setback |
| Warehouse | 15-30m | 25-50m | 2-5m | loading bay | Vehicle access needed |
| Industrial shed | 20-50m | 30-60m | 5-10m | service yard | Large footprint |
| Market stall/row | 3-5m | 5-10m | 0m | 0m | Dense commercial |

### Plot dimensions by neighborhood type

| Neighborhood | Typical plot type | Min frontage | Max depth |
|-------------|-------------------|-------------|-----------|
| Old town | Terraced + shop | 5m | 25m |
| Waterfront | Warehouse + terraced | 8m | 30m |
| Market | Shop + market stall | 4m | 15m |
| Roadside | Shop + semi-detached | 6m | 30m |
| Hilltop | Detached | 12m | 40m |
| Valley | Semi-detached | 8m | 30m |
| Suburban | Detached + semi | 10m | 40m |
| Industrial | Warehouse + shed | 20m | 50m |

### How plots create streets (and vice versa)

In a real town:

1. An arterial road is built. Land on either side is parcelled into
   large strips perpendicular to the road (burgage plots).

2. These plots are deep — 30-50m. Buildings are built at the front,
   with gardens/yards behind.

3. As the town grows, the back-land becomes valuable. A "back lane"
   is cut parallel to the original road, giving access to the rear
   of the plots.

4. New plots face the back lane. Now there are two rows of plots,
   back-to-back.

5. Cross streets connect the front road and back lane, creating
   blocks.

6. Eventually the blocks are fully built up and the town expands
   along the road to the next area.

This means **plot depth determines street spacing**. If terraced
plots are 25m deep, and you have plots on both sides, the block depth
is 50m. Add road widths and you get street spacing of ~55-60m. This
is why terraced neighborhoods have streets every 50-60m — it's driven
by the plots, not by a grid constant.

## Proposed Approach: Frontage-First Plot Generation

Instead of:
```
streets → faces → plots → buildings
```

Do:
```
roads → frontage strips → plots → back-lane streets → more plots → buildings
```

### Algorithm

**Phase 1: Arterial frontage plots**

For each arterial/collector edge in the road graph:
1. Walk along the edge
2. On each side, project outward perpendicular to the road
3. Create a frontage strip: `road edge × plot depth`
4. Subdivide the strip into plots at `frontage width` intervals
5. Plot depth is determined by neighborhood type at that location

This immediately creates plots along all arterials and collectors,
without needing the local street grid at all.

**Phase 2: Back-lane streets**

Where two frontage strips from parallel roads face each other with a
gap between their back boundaries:
1. If the gap is large enough (> min block depth), insert a back lane
2. The back lane creates new frontage
3. Generate plots along the back lane

Where a frontage strip's back boundary has open land behind it:
1. If the density is high enough, add a parallel back lane at
   `2 × plot depth` from the original road
2. This creates back-to-back plot pairs

**Phase 3: Cross streets**

For each pair of parallel roads (original + back lane):
1. Insert cross streets at intervals to create blocks
2. Cross street spacing = desired block length (40-80m depending on
   neighborhood type)
3. Cross streets create new frontage on their sides too

**Phase 4: Infill**

Any remaining road edge that doesn't have plots gets frontage plots.
New local streets added by C7 grid generation also get plots.

### Integration with neighborhood types

The neighborhood type controls:
- **Plot depth**: old town = 20-25m, suburban = 35-45m
- **Frontage width**: old town = 5-7m, suburban = 10-20m
- **Back lane frequency**: old town = always (dense), suburban = rare
- **Cross street spacing**: old town = 40m, suburban = 80m
- **Setbacks**: old town = 0m, suburban = 5-8m
- **Building coverage**: old town = 80-90%, suburban = 30-50%

### Plot data structure

```js
{
  vertices: [{x, z}, ...],    // 4 corners (rectangular)
  frontageEdge: edgeId,       // which road edge this plot faces
  frontageWidth: number,      // width along road (m)
  depth: number,              // depth from road (m)
  setback: number,            // front setback (m)
  neighborhoodIdx: number,    // which neighborhood
  neighborhoodType: string,   // 'oldTown', 'suburban', etc.
  side: 'left' | 'right',    // which side of road
  density: number,            // local density (from influence field)
}
```

## What Changes

### C7 becomes plot-aware

Instead of placing a blind grid, C7 should:
1. Start with arterial/collector edges as skeleton
2. Generate frontage plots along those edges
3. Add back lanes where plots are deep enough
4. Add cross streets to create blocks
5. Generate more frontage plots along new streets
6. Repeat until density is satisfied or terrain is filled

The grid approach could still work as a starting point — it determines
where streets go — but the street spacing should be derived from plot
depth for the local neighborhood type, not from a density-to-spacing
formula.

### C9 plots step simplifies or merges into C7

If plots are generated alongside streets, the separate C9 step becomes
unnecessary. Or it becomes a refinement step: take the frontage plots
from C7, verify they're reasonable, merge/split any that are too
small/large.

### C10 buildings becomes simpler

With well-formed rectangular plots that have known frontage, depth, and
setback, building placement is straightforward:
- Building front aligns with the setback line
- Building width = frontage width minus side gaps
- Building depth = plot depth minus setback minus back yard
- Number of floors from density/neighborhood type

### The face-based approach is abandoned

No more extracting faces from the planar graph to find blocks. Instead,
plots are explicitly generated from road frontage. This is more robust
(no dependency on clean face extraction) and more realistic (plots
always have road access by construction).

## Revised Pipeline

```
C1.  Extract context
C2.  Refine terrain
C3.  Anchor routes
C3b. River crossings
C4.  Place neighborhoods
C5.  Connect neighborhoods (arterials)
C6.  Neighborhood influence (density + districts)
C7.  Streets and plots (merged, frontage-first)
     a. Arterial frontage plots
     b. Back-lane streets (where density warrants)
     c. Cross streets (to create blocks)
     d. Local street frontage plots
     e. Infill plots on remaining edges
C8.  Buildings (on plots, with neighborhood typology)
C9.  Amenities
C10. Land cover
```

The key change: **streets and plots are generated together in C7**,
driven by plot demand, not by grid geometry. Each new street exists
because it creates necessary frontage.

## Implementation Approach

### Option A: Iterative growth

Start with arterials. Generate frontage plots. Where back-land is
available and density warrants, add back lanes. Where blocks are long,
add cross streets. Repeat until the neighborhood is filled.

Pros: most organic, most realistic growth pattern.
Cons: most complex, iterative algorithms are harder to debug.

### Option B: Grid-then-frontage

Keep the current grid approach for street placement (it produces
reasonable layouts quickly), but replace the face-based plot extraction
with frontage-based plot generation. Walk every edge in the graph,
generate plots on both sides.

Pros: simpler to implement, leverages existing grid code.
Cons: streets still don't respond to plot needs, grid spacing is
arbitrary rather than plot-derived.

### Option C: Plot-depth grid

Use the neighborhood's plot dimensions to determine grid spacing.
For terraced neighborhoods with 25m plot depth: grid spacing = 55m
(two plots back-to-back + road). For suburban with 40m depth: spacing
= 85m. Then generate frontage plots along all grid edges.

Pros: grid spacing is motivated by real plot dimensions, simple.
Cons: still a regular grid, doesn't adapt to terrain or irregular
road layouts.

### Recommendation: Start with Option C, evolve toward A

Option C gives us correctly-sized blocks immediately with minimal
changes to the existing grid code. The only change to C7 is making
`densityToSpacing` calculate from plot dimensions instead of an
arbitrary formula. Then replace C9's face-based plots with frontage-
based plot generation along edges.

Once that works end-to-end, we can evolve toward Option A by:
1. Adding back lanes where density is high
2. Letting cross street spacing vary with demand
3. Removing streets that don't create useful frontage

## Open Questions

- Should plots on opposite sides of a road be aligned (like terraces)
  or staggered?
- How do corner plots work? They have frontage on two roads.
- What about plots at T-junctions and road bends?
- Should plots respect terrain slope? A plot on a steep slope might
  need to be wider or shallower.
- How do we handle the transition from one neighborhood type to
  another? Plot sizes change at the boundary.
