---
title: "Laying Zone Ribbons"
category: "algorithms"
tags: [streets, ribbons, contour, cross-streets, parcels, incremental]
summary: "Algorithm for generating ribbon streets (contour-following parallel streets) between adjacent cross streets, forming corridors that subdivide zones into parcels."
last-modified-by: user
---

## Problem

After [[laying-zone-cross-streets|cross streets]] are laid through a zone (or sector), the space between adjacent cross streets needs to be filled with **ribbon streets** — contour-following roads that run roughly perpendicular to the cross streets. Each ribbon connects a point on one cross street to a point on the adjacent cross street. The space between consecutive ribbons becomes a [[plots|parcel]].

## Core Insight: One Vertex Determined, One Placed

Each ribbon is a line segment connecting two points, one on each of the two bounding cross streets. After the first ribbon in a corridor:

- **One endpoint is already determined** — it continues the road from the previous ribbon's endpoint on that cross street. The ribbon must start here to form a continuous road.
- **The other endpoint must be placed** — at a suitable distance along the adjacent cross street from where the previous ribbon landed, targeting the desired parcel depth (~35m).

This asymmetry is the key constraint. The algorithm doesn't freely choose both endpoints — it inherits one and places the other.

### The first ribbon

The first ribbon in a corridor is special: neither endpoint is predetermined. Both are placed at the starting ends of the two bounding cross streets (the downhill end, or whichever end the layout begins from).

### Walking up the corridor

After the first ribbon, the algorithm walks up the corridor:

1. **Advance on the "determined" cross street** — move a target distance (~35m of arc length) along the cross street from the previous ribbon's endpoint. This is where the next ribbon must start.
2. **Find the corresponding point on the other cross street** — project across to the adjacent cross street and find the point that is approximately the target parcel depth away from the previous ribbon's landing point on that cross street. This placement must also produce a ribbon of reasonable length (not too short, not too long).
3. **Connect the two points** — the ribbon runs from the determined endpoint to the placed endpoint.
4. **Swap roles** — for the *next* ribbon, the endpoint that was just "placed" becomes the "determined" one (it continues the road), and the algorithm places a new point on the other cross street.

This alternating pattern means each ribbon shares one endpoint with the previous ribbon and one with the next, forming a continuous zigzag of road segments up the corridor.

### Why alternating?

If both endpoints always advanced on the same side, ribbons would fan out or converge as cross streets diverge or converge. By alternating which side is determined, each ribbon self-corrects: if the corridor widens, the placed endpoint stretches to compensate; if it narrows, the placed endpoint pulls in.

## Algorithm

### Inputs

- Two adjacent cross streets (polylines), defining the corridor
- Target parcel depth (~35m)
- Minimum ribbon length (20m)
- Minimum parcel depth (15m)

### Steps

#### 1. Orient the cross streets

Both cross streets must be walked in the same direction (e.g. downhill to uphill). If the cross streets run in opposite directions, reverse one so their parameterisations align.

Compute arc-length parameterisations for both cross streets so we can find points at specific distances along them.

#### 2. Lay the first ribbon

Place the first ribbon connecting the starting points (arc length 0) of both cross streets. Validate that the resulting line doesn't cross water, reserved land, or other roads. If it does, truncate or skip.

#### 3. Walk the corridor

Starting from the first ribbon, repeat:

1. **Determined side**: advance along one cross street by the target depth from the previous ribbon's endpoint on that cross street. Call this point `A`.
2. **Placement side**: on the other cross street, find the point `B` such that:
   - `B` is approximately the target depth from the previous ribbon's endpoint on this cross street
   - The ribbon `A→B` has a reasonable length (between 0.5× and 2× the corridor width at that point)
   - `B` is further along the cross street than the previous ribbon's endpoint (no backtracking)
3. **Validate the ribbon** `A→B`:
   - Does not cross water or reserved land
   - Does not cross any existing road (other than the two bounding cross streets)
   - Is at least the minimum ribbon length
   - The parcel formed between this ribbon and the previous one has at least the minimum depth
4. **Accept or skip**: if validation passes, accept the ribbon and the parcel it creates. If it fails, try adjusting `B` (closer or further along the cross street). If no valid placement exists, skip this ribbon position and try the next advancement on the determined side.
5. **Swap determined/placement sides** for the next iteration.
6. **Stop** when either cross street is exhausted (the advancement point would go past the end).

#### 4. Handle the final parcel

The last parcel in a corridor may be undersized if the cross streets don't divide evenly by the target depth. If the remaining length is less than the minimum parcel depth, merge the last parcel with the previous one rather than creating a sliver.

### Corridor iteration order

Process corridors from one side of the zone to the other. The first corridor is between cross streets 0 and 1, the next between 1 and 2, etc.

**Junction sharing**: when corridor (A,B) finishes, the endpoints it placed on cross street B become the determined endpoints for corridor (B,C). This ensures continuous roads — a ribbon ending at point P on cross street B means the next corridor's ribbon starts from P.

## Parcel Creation

The space between two consecutive accepted ribbons in a corridor is immediately a parcel. Each parcel has:

- **Four edges**: two ribbon segments (the "top" and "bottom" of the parcel) and two cross street segments (the "sides")
- **Frontage**: the two ribbon edges are the frontage (roads the plots face)
- **Depth**: the distance between the two ribbons, measured along the cross streets

### Parcel validation

| Check | Rule | If fails |
|-------|------|----------|
| Minimum depth | At least 15m between ribbons | Merge with adjacent parcel |
| Maximum depth | No more than 60m | Split with an extra ribbon |
| Aspect ratio | Between 0.5 and 5.0 | Flag as irregular but keep |
| Water content | Less than 30% water cells | Skip — leave as open space |

## Parameters

| Parameter | Value | Meaning |
|-----------|-------|---------|
| Target parcel depth | ~35m | Distance between ribbons (two plot rows back-to-back + road width) |
| Minimum ribbon length | 20m | Don't create tiny stubs |
| Minimum parcel depth | 15m | Reject slivers |
| Maximum parcel depth | 60m | Split oversized parcels |
| Corridor width tolerance | 0.5×–2× | Acceptable ribbon length relative to local corridor width |

## Per-Sector Ribbons

With [[terrain-face-segmentation|per-sector cross streets]] (experiment 021), ribbons operate within each sector independently. Each sector's cross streets have a consistent gradient direction from their terrain face, so ribbons within a sector are well-aligned.

**Sector boundary gaps**: ribbons don't currently cross sector boundaries. Adjacent sectors have different gradient directions, so their cross streets don't align. This means ribbon coverage stops at sector edges. Possible future fixes:
- Blending gradient direction near sector edges so cross streets from adjacent sectors converge
- Stitching ribbons across sector boundaries where cross streets from different sectors come close

## What This Produces

For each corridor (pair of adjacent cross streets):
- A sequence of **ribbon streets** connecting the two cross streets
- A sequence of **parcels** between consecutive ribbons
- Shared **junction points** on cross streets, reused by adjacent corridors

## Related

- [[laying-zone-cross-streets]] — Phase 1: the cross street scaffold that ribbons fill
- [[incremental-street-layout]] — the overall two-phase layout process
- [[terrain-face-segmentation]] — sectors provide per-sector cross streets for ribbon alignment
- [[plots]] — parcels created by ribbons are further subdivided into plots
- [[road-network-invariants]] — geometry and topology constraints ribbons must satisfy
- [[world-state-invariants]] — water, reservation, and road constraints
