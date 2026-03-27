---
title: "Terrain Face Segmentation"
category: "algorithms"
tags: [terrain, faces, zones, slope, segmentation, pipeline, parcels]
summary: "Segmenting the entire buildable terrain into faces based on gradient direction, elevation, and steepness — independent of zones. Faces and zones are parallel systems; their intersection creates sectors for street layout."
last-modified-by: agent
---

## Problem

[[Zones]] are created by flood-filling buildable land between roads and water. A zone can cover a large area where the terrain changes direction — a hill might slope east on one side and south on the other. The [[laying-zone-cross-streets|cross street algorithm]] uses a single gradient direction per zone, which doesn't work well when the slope varies across the zone.

The terrain needs to be segmented into **faces** — regions where gradient direction, elevation, and steepness are consistent. Faces are a **parallel system to zones**, not a subdivision of them.

## Faces vs Zones

| | Zones | Faces |
|---|---|---|
| **Based on** | Nuclei, land value, roads | Terrain gradient |
| **Purpose** | Growth ordering, land use allocation | Street direction, terrain character |
| **Boundaries** | Roads, water, buildability threshold | Gradient direction changes, elevation steps |
| **Scope** | Developable land only | All non-water land |

Zones answer *what to build and when*. Faces answer *how to lay it out*.

## Algorithm: Gradient-Direction Region Growing (v2)

Implemented in `src/city/incremental/ridgeSegmentationV2.js`.

### Steps

1. **Smooth elevation** — Gaussian blur, radius 10 cells. Suppresses local noise so gradient direction is stable.
2. **Compute gradient** — direction (angle) and magnitude at each non-water cell.
3. **Region-grow from map centre** — BFS expands to neighbours whose gradient direction is within tolerance of the face's running average. Additional constraints checked per-cell:
   - **Direction tolerance** (default 60°, 30° for finer segmentation)
   - **Elevation tolerance** (optional, e.g. 100m) — tracks face min/max elevation range, rejects cells that would push range beyond tolerance
   - **Slope bands** (optional, e.g. [0.3, 0.8]) — cells must be in same steepness band as seed
4. **Grow remaining cells** — unvisited cells seed new faces, sorted by distance from centre.
5. **Merge small faces** — faces below 1% of total buildable cells are absorbed into largest neighbour.

### Why not curvature-based ridge detection?

The original proposal (curvature thresholding + flood-fill between ridges) was implemented in experiment 019 but had problems:
- Thick bands of ridge cells created visual artefacts
- Grid-aligned boundaries from axis-aligned curvature computation
- Per-zone segmentation echoed zone boundaries rather than finding independent terrain transitions

Region growing produces cleaner boundaries and naturally adapts to the terrain.

### Why not per-zone segmentation?

Early experiments (019, 019b) segmented each zone independently. This caused face boundaries to follow zone boundaries because:
- The region-grow was constrained to zone cells
- The biggest gradient changes within a zone tend to be near its edges (where roads follow ridges)
- Faces couldn't cross zone boundaries

Making faces zone-independent (v2) solved this. Faces now follow terrain regardless of where roads or zones are.

## Sectors: Zone × Face Intersection

A **sector** is the intersection of one zone with one terrain face. Each sector inherits:
- From its **zone**: priority, land value, nucleus assignment
- From its **face**: gradient direction, avgSlope, elevation range, steepness band

Sectors are the unit for street layout — each sector gets cross streets / ribbons aligned to its face's gradient direction. Streets within a sector subdivide it into [[plots|parcels]] (land developed as a unit, e.g. a housing estate), which are further divided into individual plots/lots.

Hierarchy: **faces** (terrain) → **zones** (planning) → **sectors** (zone × face, street layout) → **parcels** (subdivided by streets, developed as a unit) → **plots** (individual lots)

Typical stats: 2-4 sectors per zone, median ~4000 cells per sector. Sectors below 50 cells are discarded as slivers.

### Land use implications

Sector terrain properties can inform land use allocation:
- **Flat sectors** (avgSlope < 0.3) → commercial, industrial, grid streets
- **Moderate sectors** (0.3–0.8) → residential, contour-following streets
- **Steep sectors** (> 0.8) → parks, open space, or terraced housing

Steepness is a *cost factor*, not a hard exclusion. The buildability layer encourages building in suitable areas but steep land can still be developed if land value justifies it.

## What Not to Filter

Face segmentation should cover **all non-water land**, not just buildable land. Reasons:
- Buildability is a preference, not a hard boundary
- Steep land may still be developed (terracing, expensive grading)
- The zone intersection already limits what gets developed
- Face terrain properties (avgSlope, elevation) are more useful as metadata on sectors than as filters that exclude terrain

## Experiments

- **019**: Per-zone curvature approach (abandoned — artefacts, grid-aligned)
- **019b**: Per-zone gradient region growing (abandoned — echoes zone boundaries)
- **019c/d**: Whole-map faces, direction only, 60°/30° tolerance
- **019e**: Direction + elevation bands (100m)
- **019f**: Direction + slope bands ([0.3, 0.8])
- **019g/h**: Combined direction + elevation + slope (best results)
- **019i**: Combined with buildability filter (too aggressive for hilly terrain)
- **020/020a**: Zone × Face sector intersection (020a removes buildability filter from faces)
- **021**: Per-sector cross streets — runs `layCrossStreets` per sector instead of per zone. Each sector gets its own gradient direction from the face. Results: much better terrain alignment in large zones (e.g. 7 sectors with visibly different street angles vs 1 uniform direction). Gaps at sector boundaries are the main issue.

## Implementation

- `src/city/incremental/ridgeSegmentationV2.js` — whole-map face segmentation
- `src/city/incremental/ridgeSegmentation.js` — original per-zone approach (kept for reference)
- `src/city/pipeline/segmentTerrainFaces.js` — slope octant approach (pre-existing, not recommended)

## Related

- [[zones]] — how zones are created (flood-fill between roads/water)
- [[laying-zone-cross-streets]] — cross street algorithm that runs per-parcel
- [[terrain-face-streets]] — the per-face street layout design
- [[incremental-street-layout]] — the overall layout process
