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

A point starts on the bottom edge of the zone and advances step by step, accumulating steering vectors at each iteration — similar to a 2D space-game movement model.

### Inputs

- The zone polygon and its bottom edge
- The zone's overall contour gradient (uphill direction)
- Skeleton roads bounding the zone
- Spacing interval for starting points along the bottom edge

### Key Parameters

- **Step size**: distance the point moves per iteration
- **Anchor threshold**: distance at which a skeleton road begins to exert perpendicular pull
- **Influence falloff**: how quickly skeleton road influence diminishes toward the zone centre

## Algorithm

### 1. Generate outer cross streets first

The outermost cross streets are anchored to skeleton roads on either side of the zone. For each outer starting point:

1. **Launch** from a point on the bottom edge of the zone
2. **March loop** — at each step, sum vectors and advance:
   - **Contour gradient vector**: the zone's overall uphill direction, providing the primary direction of travel
   - **Skeleton road vector**: when within the anchor threshold of a skeleton road, add a vector perpendicular to that road, pulling the path toward a right-angle meeting
3. **Terminate** when the point reaches the top edge of the zone or meets another anchor road

The skeleton road influence is strong for outer lines, so they are structurally locked to the roads they border.

### 2. Generate inner cross streets

Inner cross streets are generated after the outer ones. The skeleton road exerts a parallelising influence that diminishes toward the centre:

- **Near a skeleton road**: the perpendicular constraint dominates, keeping lines aligned with the outer cross streets
- **Toward the centre**: the global contour gradient dominates
- **Fanning**: lines may spread or converge gently where the zone widens or narrows, taking the zone's shape into account

### 3. Termination

Each line ends when it:
- Reaches the top edge of the zone
- Meets an anchor road at a right angle

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

## Properties

- Approximate parallelism at a macro level, driven by a single contour gradient for the zone
- Outer lines are structurally locked to skeleton roads
- Inner lines emerge naturally between the outer ones, blending skeleton road influence with the zone's contour gradient
- The zone's shape is respected — gentle fanning where the zone widens or narrows

## Related

- [[terrain-face-streets]] — broader terrain-face street layout strategy that uses cross streets within faces
- [[zone-based-allocation]] — how zones are defined and allocated
