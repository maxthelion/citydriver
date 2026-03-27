---
title: "Laying Zone Cross Streets"
category: "algorithms"
tags: [streets, zones, cross-streets, vector-march, contour, slope]
summary: "Algorithm for generating cross streets that traverse zones uphill using a vector-march approach with skeleton road anchoring and contour-following."
last-modified-by: user
---

## Problem

Within a [[zone-based-allocation|development zone]], we need construction lines (cross streets) that run uphill from the bottom edge to the top. These should be approximately parallel at a macro level, meet skeleton roads at right angles, and gently fan in or out to respect the zone's shape.

## Approach: Vector March

A point advances step by step through the zone in the gradient (uphill) direction, accumulating steering vectors at each iteration — similar to a 2D space-game movement model.

### Inputs

- The zone polygon and cell set
- The zone's overall contour gradient (uphill direction) and contour direction (perpendicular)
- Skeleton roads bounding the zone
- Spacing interval (~90m)

### Key Parameters

- **Step size**: distance the point moves per iteration (~half a cell)
- **Anchor threshold**: distance at which a skeleton road begins to exert perpendicular pull
- **Influence falloff**: how quickly skeleton road influence diminishes toward the zone centre

## Algorithm

### 1. Contour-axis sweep and gradient scan

Cross street positions are determined by sweeping along the **contour axis** (perpendicular to the gradient) at ~90m intervals. For each contour offset:

1. Compute a target point at the zone centroid offset along the contour axis
2. **Scan the full gradient extent** through that point — from far downhill to far uphill
3. At each scan step, check if the cell is in-zone, water, or road
4. Find all **contiguous in-zone runs** along the scan line. Each run is a potential cross street.

This scan-based approach handles zones split by interior roads: a road cutting through the zone creates two separate runs at the same contour offset, each becoming its own cross street.

**Run boundaries:** A run starts at the first in-zone cell and ends when:
- An adjacent road cell is hit — the road cell is included as the endpoint (forming a junction)
- The zone boundary is reached — the line stops there (dead end)
- Water or reserved land is hit — the line stops

Edge coverage: if the first regular-interval offset is far from the zone's lateral boundary, add extra starting points at the edges to ensure the full width is covered.

### 2. Line direction

Currently: lines follow the **average gradient direction** (straight rays). All lines at the same contour offset are parallel.

**Planned — vector march with skeleton road pull:** Replace straight rays with a step-by-step march that accumulates steering vectors. Near skeleton roads, a perpendicular pull curves lines toward right-angle junctions. In the interior, the gradient dominates. This produces lines that are straight near roads and gently curve with terrain deeper in. See section on outer/inner generation below.

### 3. Generate outer cross streets first (not yet implemented)

The outermost cross streets are anchored to skeleton roads on either side of the zone. The skeleton road influence is strong for outer lines, so they are structurally locked to the roads they border.

Inner cross streets are generated after the outer ones. The skeleton road exerts a parallelising influence that diminishes toward the centre:

- **Near a skeleton road**: the perpendicular constraint dominates, keeping lines aligned with the outer cross streets
- **Toward the centre**: the global contour gradient dominates
- **Fanning**: lines may spread or converge gently where the zone widens or narrows, taking the zone's shape into account

### 3. Termination

Each line ends when it:
- Hits an anchor/skeleton road (ideal — forms a junction)
- Reaches the zone boundary without hitting a road (creates a dead end)
- Hits water or reserved land

Lines that terminate at the zone boundary rather than at a road create dead ends. This happens when the skeleton network has gaps or the zone boundary doesn't sit adjacent to a road. These dead ends are acceptable — the cross street still serves as scaffolding for ribbons within the zone. Fixing skeleton network gaps upstream would naturally reduce dead ends.

## Step Size

The step size controls how far the point advances per iteration — a resolution/fidelity tradeoff.

**Too large**: the path can overshoot skeleton road influence zones entirely (missing the perpendicular pull), produce jagged segments at turns, or exit the zone boundary between checks.

**Too small**: computationally wasteful for minimal smoothness gain.

### Heuristics

- Step size should be small relative to the features it needs to respond to. The tightest constraint is the skeleton road anchor threshold — a step size larger than the threshold would blow right past it.
- **Fraction of anchor threshold**: e.g. 1/4 to 1/3 of the anchor threshold distance
- **Fraction of zone width**: e.g. 1/20th to 1/40th of the zone's narrowest dimension

### Adaptive Stepping

An optional refinement: take larger steps in the middle of the zone where only the contour gradient matters (smooth, predictable), and smaller steps near skeleton roads where precise perpendicular meeting matters. This adds complexity and may not be needed initially.

## Obstacle Handling

Cross streets must respect obstacles in the zone. At each step of the march, the point checks the cell it's about to enter:

| Obstacle | Action |
|----------|--------|
| Water | Stop the line. The segment up to this point is the cross street. |
| Reserved land (commercial, civic, park) | Stop the line. Reserved cells are treated identically to water. |
| Existing road | Stop the line. The endpoint forms a T-junction with the existing road. |
| Zone boundary | Stop the line. This is the normal termination. |

The blocked grid is built from water, road, and reservation layers before the march begins. The march checks this grid at each step — no separate post-processing needed.

## Per-Line Validation

After tracing, each cross street is validated before being accepted:

| Check | Rule | If fails |
|-------|------|----------|
| Minimum length | At least 20m | Discard — too short to be useful |
| Spans the zone | Reaches from bottom edge to top edge (or obstacle) | Keep if > 50% of zone extent; discard stubs |
| Minimum separation | At least 5m from any other accepted cross street at every point | Discard the shorter of the converging pair |
| No water crossings | No point along the line is on a water cell | Should be prevented by march termination, but audited as safety net |

These are construction-time checks. The output must also satisfy the general [[road-network-invariants]] and [[world-state-invariants]] — checked post-hoc as part of [[incremental-street-layout|the overall layout process]].

## Spacing and Coverage

Cross streets are spaced at ~90m intervals along the bottom edge. This matches typical suburban block width.

Edge coverage matters: the outermost cross streets should be close to the zone's lateral boundaries. If the first regular-interval starting point is 40m in from the edge, add an extra starting point at the edge. Otherwise the zone margins have no cross streets and can't receive ribbons.

## Current Implementation Status

What's implemented and working:
- **Contour-axis sweep** at 90m intervals with edge fill — produces even, reliable spacing
- **Gradient-direction scan** finds all in-zone runs per offset — handles road-split zones
- **Road junction termination** — lines end at roads when hit, forming junctions
- **Zone boundary termination** — lines that don't reach a road stop at the zone edge (dead ends)
- **Convergence pruning** — removes lines that come within 5m of each other
- **Water obstacle handling** — lines stop at water cells
- 10 unit tests covering spacing, separation, obstacles, and edge cases

What's described in the spec but not yet implemented:
- **Skeleton road perpendicular pull** — lines should curve near anchor roads to meet them at ~90°. Attempted but per-line steering broke even spacing. Needs a different approach (possibly rotating the entire set uniformly near roads, or outer-first generation).
- **Outer lines first, then inner** — all lines are currently generated equally. Outer lines should be anchored to skeleton roads first, with inner lines filling between them.
- **Reserved land obstacles** — water stops lines but the reservation grid isn't checked yet.
- **Adaptive step size** — smaller steps near roads for precise junction meeting.
- **Zone span check** — discarding stubs that don't cross a meaningful portion of the zone.

These are refinements that can be added incrementally. The current implementation produces correct, evenly-spaced cross streets that span zones and terminate properly.

## Properties

- Even parallelism at 90m spacing, driven by a single contour gradient for the zone
- Lines span from one zone edge to the other in the gradient direction
- Road-split zones get separate cross streets in each lobe
- Dead ends occur where the skeleton network has gaps (upstream issue, not a cross street bug)

## Related

- [[incremental-street-layout]] — the overall layout process (cross streets + ribbons)
- [[terrain-face-streets]] — broader terrain-face street layout strategy that uses cross streets within faces
- [[zone-based-allocation]] — how zones are defined and allocated
- [[world-state-invariants]] — rules cross streets must satisfy
- [[road-network-invariants]] — minimum separation, crossing rules, dead-end constraints
