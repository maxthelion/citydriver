---
title: "Incremental Street Layout"
category: "algorithms"
tags: [streets, ribbons, contour, layout, algorithm, parcels, incremental]
summary: "Next-generation street layout that builds streets one at a time with per-street validation, creating parcels as it goes. Replaces batch generation with post-processing."
last-modified-by: user
---

## Core Principles

**Lay one street, check it, create the parcel, then lay the next.** Problems are caught and corrected before they become the foundation for future streets.

**Adapt, don't reject.** When a street hits an obstacle, truncate it there. When it crosses a road, form a T-junction. Only skip a street entirely if the truncated version is too short (< 20m). The old algorithm rejected violating streets and left gaps. This algorithm shortens them and keeps the coverage.

This replaces the [[contour-street-algorithm|current approach]] which generates all streets in a batch, then post-processes to remove violations. Batch-then-filter creates gaps and leaves quality issues that are hard to fix after the fact. Incremental construction produces streets that are correct by design.

## Why Incremental?

The current algorithm has a fundamental problem: it makes all decisions up front (where to place junctions, which to connect) and only checks afterward. By then, fixing a bad connection means removing streets that downstream streets depend on.

Real cities aren't built like that. A developer looks at the existing roads, finds a good place for the next street, checks it makes sense (deep enough for houses, connects to the network, doesn't cross a river), then builds it. The next street takes the first into account.

The incremental approach mirrors this:

| Batch (current) | Incremental (proposed) |
|-----------------|----------------------|
| Generate all cross streets | Lay construction lines connected to anchor roads |
| Generate all junctions | Start from a corner |
| Connect all junctions | Lay one street, validate, create parcel |
| Post-process: remove violations | Repeat, each street checked against the last |
| Gaps where streets were removed | No gaps — streets are correct by construction |

## The Algorithm

### Phase 1: Construction Lines

Before laying any parallel streets, establish the **construction lines** — the cross streets that will structure the zone.

1. **Determine the contour direction** from the zone's terrain (average gradient → contour is perpendicular)
2. **Find anchor roads** — the existing roads at the zone's edges that construction lines will connect to
3. **Lay construction lines** from anchor road across the zone to the opposite boundary (or opposite road), running approximately uphill/downhill. Space them at ~90m intervals along each anchor edge.
4. **Validate each construction line:**
   - Must not cross water or unbuildable terrain (in the zone interior — road cells at the origin don't count, since the line starts at a road)
   - Must not run within 5m of another construction line
   - If validation fails, adjust or skip

Construction lines must **span the zone**. A line that starts at an anchor road and stops after a few cells is useless — it needs to reach the opposite boundary to form a corridor that parallel streets can fill. After routing lines from anchor edges, supplement with gradient-direction lines in any areas not yet covered.

**Pairing construction lines:** two construction lines form a corridor if they travel in roughly the same direction and are spatially adjacent. Sort all lines with similar travel direction by their position along the perpendicular axis — neighbours in this sorted order are pairs. Lines from different anchor edges along the same road should pair naturally.

Construction lines define the **cross street grid** — the scaffold that parallel streets will fill.

### Phase 2: Incremental Parallel Streets

Starting from a corner of the zone (where a construction line meets the zone boundary or an anchor road), lay parallel streets one at a time.

For each new street:

**2a. Choose the placement**

The new street runs roughly perpendicular to the construction lines (±30°). The distance from the previous parallel street (or zone boundary for the first one) is calculated:

```
baseDistance = target plot depth (e.g. 15m for each row of houses × 2 rows + road = ~35m)
angleAdjustment = baseDistance / cos(angleFromPerpendicular)
```

The more acute the angle relative to the construction lines, the further apart the streets need to be to maintain the target plot depth between them. This keeps plots consistently deep even when streets aren't perfectly parallel.

**2b. Choose the far endpoint**

The street starts from one construction line and ends at the adjacent one. The far endpoint is chosen to make the new street approximately parallel to the previous one — not rigidly, but aiming for consistent parcel depth.

**2c. Validate the street**

Before accepting this street:

| Check | Rule | If fails |
|-------|------|----------|
| Angle | Within ±30° of perpendicular to construction lines | Adjust endpoint to improve angle |
| Separation | At least `baseDistance` from previous parallel | Move further out |
| Water/terrain | No cells along the street are water or unbuildable | Truncate at the obstacle |
| Existing roads | Doesn't cross another road without a junction | Truncate at the crossing, form T-junction |
| Minimum length | At least 20m long | Skip — zone is filled |

If the street can't be placed validly, the zone is filled — stop.

**2d. Create the parcel**

The space between this street and the previous one (or zone boundary) is immediately a [[spatial-concepts|parcel]]:

```
Parcel {
  boundary: [previous street, construction line A, new street, construction line B]
  frontage edges: previous street + new street (both are roads)
  depth: distance between the two parallel streets
  width: distance between the two construction lines
}
```

**2e. Validate the parcel**

| Check | Rule | If fails |
|-------|------|----------|
| Depth | > 15m (enough for two rows of plots back-to-back) | Street was too close — adjust distance |
| Frontage | Both long edges are road frontage | Should always be true by construction |
| Width-to-depth ratio | Between 0.5 and 5.0 (not a sliver, not a square) | Acceptable range for residential blocks |
| Contains water | Parcel area doesn't include water cells | Split parcel at water, or flag for open space |
| Connected | Both frontage edges connect to construction lines | Should always be true by construction |

If the parcel fails validation, adjust the street position and re-check. The key: we haven't laid the next street yet, so we can still move this one.

**2f. Repeat**

Lay the next parallel street, referencing this one as the baseline. Continue until the zone is filled or no valid placement exists.

### Phase 3: Plot Subdivision

After all streets are laid and all parcels created, cut [[plots]] from each parcel. Walk along each frontage edge at regular intervals (plot width), cut perpendicular to create rectangular lots.

Plot validation:
- Minimum depth: 10m
- Minimum frontage: 5m
- Frontage-to-depth ratio: between 0.3 and 1.5
- Road access: every plot has at least one frontage edge

## What This Produces

At the end of the process, every zone has:

- **Construction lines** connected to anchor roads (the zone's cross streets)
- **Parallel streets** laid incrementally between construction lines (the contour-following residential streets)
- **Parcels** between each pair of parallel streets, with validated dimensions
- **Plots** cut from parcels with guaranteed frontage

Every street was validated when it was laid. Every parcel was validated when it was created. No post-processing needed. A well-shaped zone should achieve < 40% waste on buildable area; if waste is much higher, construction lines aren't spanning the zone or streets are being rejected instead of truncated.

## Perpendicular Junctions with Anchor Roads

Streets should meet skeleton/anchor roads at close to 90°. A street joining a main road at 30° is ugly and creates unusable acute-angled parcels in the corners.

This was the focus of experiments 007l through 007s. The key finding from 007p (smooth curve): streets approach anchor roads perpendicularly, then bend to follow contours deeper in. This is how real hillside cities work — a clean junction with the high street, curving away into terraced housing.

### How this works in incremental layout

**Construction lines** originate from anchor road junctions at close to perpendicular. They start straight (perpendicular to the anchor road) then gradually curve to follow the terrain gradient as they move into the zone interior. The blend distance depends on the zone size — a small zone might stay grid-like throughout, a large zone bends within the first 100-200m.

**Parallel streets** near anchor roads are also approximately perpendicular to the construction lines — which means they run approximately parallel to the anchor road. This creates a grid-like block structure near the main road, transitioning to contour-following deeper in.

**The last street** meeting the far anchor road poses a special problem. If the natural contour-following direction would create a bad junction angle, the street's far endpoint can be adjusted to improve it. This makes the final parcel slightly non-rectangular, which is acceptable — real city blocks aren't perfect rectangles.

### Blend function

The perpendicularity constraint should relax with distance from anchor roads:

```
At anchor road (distance = 0):     street angle = perpendicular to anchor ±5°
At blend distance (~100-200m):     street angle = follow terrain contour
Between:                           linear blend of the two directions
```

This produces the experiment 007p smooth curve effect: grid near roads, organic in the interior, smooth transition between.

## Parameters

| Parameter | Value | Meaning |
|-----------|-------|---------|
| Target plot depth | ~15m | Depth of one row of plots (house + garden) |
| Target parcel depth | ~35m | Two plot rows back-to-back + road |
| Construction line spacing | ~90m | Distance between cross streets |
| Angle tolerance | ±30° | How far parallel streets can deviate from perpendicular |
| Anchor perpendicularity | ±5° | How close streets must be to 90° at anchor roads |
| Blend distance | 100-200m | Distance over which perpendicular → contour transition happens |
| Min street length | 20m | Don't create tiny stub streets |
| Min parcel depth | 15m | Reject slivers |
| Min frontage | 5m | Every plot needs meaningful road access |

## Working Around Existing Reservations

Street layout doesn't operate on a raw zone — it operates on what's **left** after earlier allocations. Commercial may have claimed anchor road frontage. A church or park site may have been reserved. The residential street layout must work around these.

### Order of operations

```
1. Zone extracted (full buildable area)
2. Commercial allocator claims anchor road frontage → reservationGrid updated
3. Civic allocator reserves church/park/school sites → reservationGrid updated
4. Street layout runs on remaining available area
5. Residential parcels created in the street-defined blocks
6. Plots cut from residential parcels
```

### How it works

Build a `blockedGrid` from cells that are water, road, or already reserved (any non-NONE value in `reservationGrid`). The street layout algorithm treats blocked cells the same way it treats water:

- **Construction lines** stop at blocked cells in the zone interior (water, reservations). Road cells at the line's origin are traversed — the line starts at a road and must clear it.
- **Parallel streets** are truncated at blocked cells (same adapt-don't-reject principle)
- **Parcels** are created in the gaps between streets and blocked areas
- **Waste** is computed against available area (zone minus water minus roads minus reservations), not raw zone area

This doesn't require polygon boolean operations — the bitmap approach works. Reserved parcels appear as obstacles in the cell grid, and the incremental street algorithm already validates each street against the grid cell by cell.

### Implications

- A zone with a park reserved in the middle gets streets that wrap around the park
- Commercial frontage along an anchor road pushes the first parallel street further in
- A church plot causes construction lines to split around it, creating smaller blocks either side
- The waste metric measures coverage of the *available* area, not the raw zone — a zone with 30% reserved for commercial and a park should still achieve low waste on the remaining 70%

## How This Differs from the Current Algorithm

| Aspect | [[contour-street-algorithm|Current]] | Incremental |
|--------|---------|-------------|
| Street generation | All at once per face | One at a time |
| Validation | Post-process batch | Per-street before continuing |
| Parcel creation | After growth phase | Immediately when street is laid |
| Gap handling | Remove violating streets → gaps | No violations → no gaps |
| Angle control | None (cross streets define angle) | ±30° from perpendicular, adjusted |
| Spacing control | Fixed PARALLEL_SPACING | Dynamic, based on angle to maintain depth |
| Obstacle handling | Post-clip at roads/water | Pre-check, truncate or skip |
| Face boundaries | Streets from different faces can cross | Each street checked against all existing |

## Relationship to Petri Loop

This algorithm has tunable parameters (angles, distances, ratios) and quality checks that the [[experiment-loop|petri loop]] can iterate on. The invariant tests become the petri loop's tier 2 checks — any mutation that violates a per-street or per-parcel rule is instantly rejected.

The visual judge (tier 3) evaluates the overall look: do the streets form a coherent neighbourhood? Does the pattern change naturally with terrain? Are the blocks a good size for buildings?

## Related

- [[contour-street-algorithm]] — the current batch approach this replaces
- [[terrain-face-streets]] — the original design intent for per-face layout
- [[spatial-concepts]] — the zone → parcel → plot hierarchy
- [[plots]] — cut from parcels after streets are laid
- [[world-state-invariants]] — rules checked per-street and per-parcel
- [[polygons-vs-cells]] — streets and parcels are polygons (source of truth), cells are derived
