---
title: "Incremental Street Layout"
category: "algorithms"
tags: [streets, ribbons, contour, layout, algorithm, parcels, incremental]
summary: "Overview of the two-phase street layout approach: cross streets first, then ribbons between them. Each phase is described on its own page."
last-modified-by: user
---

## Overview

Street layout within a zone happens in two phases, each described on its own page:

1. **[[laying-zone-cross-streets]]** — lay cross streets that traverse the zone uphill, forming the scaffold
2. **Laying ribbons** (parallel streets between cross streets) — *needs its own page; design in progress*

The key principle across both phases: **lay one street, check it, then lay the next.** Problems are caught and corrected before they become the foundation for future streets. This replaces the [[contour-street-algorithm|batch approach]] which generates all streets at once and post-processes to remove violations.

## Core Principles

**Adapt, don't reject.** When a street hits an obstacle, truncate it there. When it crosses a road, form a T-junction. Only skip a street entirely if the truncated version is too short (< 20m). The old algorithm rejected violating streets and left gaps. This algorithm shortens them and keeps the coverage.

**Cross streets first.** Getting the cross street scaffold right is a prerequisite for good ribbons. Mixing both phases makes it hard to diagnose whether a problem is in the cross streets or the ribbons. The cross street algorithm should be solid before ribbons are attempted.

**All streets are roads.** Every street produced — cross street or ribbon — must satisfy the general [[world-state-invariants]] and [[road-network-invariants]]. These aren't optional extras; they're constraints that the algorithm must respect during construction, not just audit after the fact.

## Phase 1: Cross Streets

See **[[laying-zone-cross-streets]]** for the full algorithm.

Cross streets run uphill through the zone using a vector-march approach. They start from the bottom edge, advance step by step blending the zone's gradient direction with skeleton road perpendicularity, and terminate at the top edge or an anchor road.

The output is a set of curved polylines spanning the zone — the scaffold that ribbons will fill.

## Phase 2: Ribbons (Parallel Streets)

*This phase needs further design and its own wiki page.*

The broad approach: given cross streets as the scaffold, lay parallel streets between adjacent pairs. Each ribbon connects a point on one cross street to the corresponding point on the adjacent cross street, running roughly along the contour.

Key design questions still open:

- **Junction positions on cross streets belong to the line, not the corridor.** Two corridors sharing a cross street must use the same junction points. Junction positions should be at fixed arc-length intervals along the cross street, computed once.
- **Junction sharing.** When a ribbon from corridor (A,B) terminates at point P on cross street B, the ribbon from corridor (B,C) must start from the same point P — not a nearby-but-different point.
- **Parcel creation.** The space between consecutive accepted ribbons in a corridor is immediately a parcel. Parcels are validated for depth, aspect ratio, and water content.
- **Plot subdivision.** After all ribbons and parcels, cut plots from each parcel by walking along frontage edges at regular intervals.

## What This Produces

At the end of both phases, every zone has:

- **Cross streets** spanning the zone uphill (the scaffold)
- **Ribbons** connecting adjacent cross streets along the contour (the residential streets)
- **Parcels** between each pair of ribbons, with validated dimensions
- **Plots** cut from parcels with guaranteed frontage

## Invariants and Quality Metrics

All streets produced by this algorithm must satisfy the general road invariants. These apply to both cross streets and ribbons:

| Invariant | Source | What it means here |
|-----------|--------|--------------------|
| Minimum road separation (5m) | [[road-network-invariants]] | No two streets should run within 5m of each other. Cross streets that converge must be pruned. |
| No unresolved crossings | [[road-network-invariants]] | Two streets crossing without a junction is impossible. Cross streets may cross ribbons (they form junctions by design), but two ribbons must not cross each other. |
| No water crossings | [[world-state-invariants]] | Enforced during construction by truncation, audited post-hoc. |
| No streets on reserved land | [[world-state-invariants]] | Reserved cells (commercial, civic) are treated as obstacles — streets truncate at them. |
| Dead-end minimum length (15m) | [[road-network-invariants]] | A truncated street shorter than 15m should be skipped. |

### Layout-specific metrics

| Metric | Target | What it measures |
|--------|--------|-----------------|
| Waste ratio | < 40% on well-shaped zones | Fraction of buildable area not covered by parcels. |
| Cross street convergence | 0 violations | Pairs of cross streets approaching within 5m. |
| Junction sharing | 0 duplicate junctions | Near-but-different junction pairs (0.5m–5m apart) on shared cross streets. |
| Parcel aspect ratio | 0.5–5.0 | Slivers or extreme shapes indicate spacing problems. |

### When to check

- **During construction**: per-street validation (obstacle truncation, angle check, minimum length) prevents local problems.
- **After construction**: post-hoc invariant audit catches emergent problems (convergence, overall waste, pattern quality). These correspond to the [[experiment-loop|petri loop]]'s tier 2 heuristics.

## Working Around Existing Reservations

Street layout operates on what's **left** after earlier allocations. Build a blocked grid from cells that are water, road, or reserved. Streets treat blocked cells as obstacles — truncating at them per the adapt-don't-reject principle.

- A zone with a park reserved in the middle gets streets that wrap around the park
- Commercial frontage along an anchor road pushes the first ribbon further in
- Waste is computed against *available* area (zone minus water minus roads minus reservations)

## Parameters

| Parameter | Value | Meaning |
|-----------|-------|---------|
| Cross street spacing | ~90m | Distance between cross streets along the bottom edge |
| Target parcel depth | ~35m | Distance between ribbons (two plot rows + road) |
| Target plot depth | ~15m | Depth of one row of plots |
| Min street length | 20m | Don't create tiny stub streets |
| Min parcel depth | 15m | Reject slivers |
| Min frontage | 5m | Every plot needs meaningful road access |

## Related

- [[laying-zone-cross-streets]] — Phase 1 algorithm (cross streets)
- [[contour-street-algorithm]] — the batch approach this replaces
- [[spatial-concepts]] — the zone → parcel → plot hierarchy
- [[plots]] — cut from parcels after streets are laid
- [[world-state-invariants]] — rules all streets must satisfy
- [[road-network-invariants]] — geometry and topology constraints
