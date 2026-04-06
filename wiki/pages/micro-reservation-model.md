---
title: "Micro Reservation Model"
category: "algorithms"
tags: [land-use, reservation, frontage, parks, residential, commercial, buyer, allocation, vector]
summary: "The vector-based land reservation approach developed in experiments 040–061. Covers the buyer family/variant model, macro search vs micro claim, the ReservationLayout data model, and the src/city/land/ module."
last-modified-by: user
---

## Overview

The micro reservation model is a vector polygon-based approach to land allocation developed in experiments 040–061. It replaces the [[land-reservation|legacy BFS seed-and-grow algorithm]] for frontage-based uses with a set of explicit geometric operations that produce realistic commercial strips, parks, terrace bands, and residual residential fill.

The key shift: instead of scoring cells and growing blobs, the model works with road polylines, offset polygons, and zone boundary geometry to produce shapes that match how land is actually divided in real settlements.

The implementation lives in `src/city/land/`.

---

## The Buyer Model

Land allocation is organised around **buyer families** and **buyer variants**. This separates strategic intent from geometric execution.

### Three levels

**Archetype program** — declares which buyer families are active, their budgets, and their priority order. A market town has a different program from a harbour or industrial city.

**Buyer family** — a strategic actor with shared city-wide goals. Examples: `commercial`, `civic`, `industrial`, `residential`. A family can contain multiple variants that share intent but claim different kinds of sites.

**Buyer variant** — the concrete local claimant that performs the actual reservation. Examples:

| Family | Variant | What it claims |
|--------|---------|---------------|
| `commercial` | `frontage-strip` | Shallow strip along anchor road edge |
| `civic` | `park` | Boundary-attached polygon with perimeter road |
| `civic` | `market-square` | Central open space at road convergence |
| `residential` | `edge-terrace` | Shallow band fronting onto a park or square |
| `residential` | `view-villa` | Loose cluster on premium amenity land |
| `residential` | `residual-fill` | Ribbon streets filling everything left |

### Macro search vs micro claim

The most important distinction in the model.

**Macro search** decides which parts of the city a buyer wants to act in — which sectors, zones, or corridors. This is city-wide reasoning: parks want distributed presence, warehouses want flat sectors near transport, commercial wants high road exposure.

**Micro claim** decides how the buyer reserves land inside the chosen sector — the specific polygon shape, depth, road consequences.

The current implementation is primarily micro claim — the geometric operations within a selected sector. Macro search is expressed as metadata in the declarative schema and will drive sector selection once the city-scale allocation loop is built.

---

## The ReservationLayout Data Model

`src/city/land/microReservationModel.js` defines the output of a micro claim pass.

### ReservationLayout

The top-level container for a single sector's allocation result.

```js
layout = {
  id, kind, meta,
  frontageSpans: FrontageSpan[],
  parcels:       ReservationParcel[],
  roads:         PlannedRoad[],
  residualAreas: ResidualArea[],
}
```

`layout.summary()` returns counts and total areas. `layout.toJSON()` serialises for debug output.

### PlannedRoad

A road that should be stamped into the network as a result of this reservation. Roads are planned during the claim pass and committed separately via `commitVectorFrontageRoads()`.

```js
road = {
  id, kind,         // e.g. 'service-road', 'perimeter-road', 'connector-road'
  centerline,       // [{x, z}, ...] world coordinates
  width,            // metres
  meta,
}
```

Roads are not stamped immediately — they are collected in the layout and committed in a separate pass. This keeps the geometry computation separate from the road network mutation.

### FrontageSpan

A strip of commercial land claimed along a road edge. Holds the frontage polyline, its inward direction, depth, service road reference, and access gap positions.

```js
span = {
  id, frontage,       // polyline along the road edge
  inward,             // direction away from the road
  depth,              // metres
  serviceRoadId,      // id of the PlannedRoad one block behind
  gapDistances,       // arc-length positions of access gaps
  meta,
}
```

### ReservationParcel

A land parcel produced by a claim — a polygon with a use type and optional frontage reference.

```js
parcel = {
  id, kind,           // 'commercial', 'park', 'terrace', etc.
  polygon,            // [{x, z}, ...]
  frontageSpanId,     // reference to parent FrontageSpan if applicable
  meta,
}
```

### ResidualArea

Area left over after reservations, to be filled with residential ribbon streets.

```js
area = {
  id, polygon, meta
}
```

---

## Vector Frontage Layout

`src/city/land/vectorFrontageLayout.js` implements the micro claim operations. Each exported function takes a sector and returns a `ReservationLayout`.

### analyzeVectorFrontageSector

Baseline commercial frontage. Finds anchor road edges within the sector, smooths them into a frontage polyline, places access gaps at regular intervals, and offsets a service road one block behind.

**Output:** `FrontageSpan` + `PlannedRoad` (service road) + `ReservationParcel[]` (commercial plots between gaps)

### analyzeVectorBoundaryParkSector

Places a park polygon attached to the zone boundary. The park sits against the rear of the sector with its frontage edge facing inward.

**Output:** `ReservationParcel` (park polygon) + `PlannedRoad` (perimeter road) + `ResidualArea` (remainder)

### analyzeVectorBoundaryParkResidualCommercialSector

Park at the boundary + commercial frontage strip along the anchor road. The two reservations divide the sector: commercial at the road-facing edge, park at the rear, residual between them.

**Output:** `FrontageSpan` + `ReservationParcel` (park) + `PlannedRoad[]` + `ResidualArea`

### analyzeVectorBoundaryParkCommercialTerraceSector

Full composite: park + commercial frontage + residential terrace band between them. The terrace band fronts onto the park edge before generic residential fill claims the remainder.

**Output:** all of the above + `ReservationParcel` (terrace band)

### analyzeVectorBoundaryParkCommercialTerraceGuidedSector

Variant of the above where terrace streets are guide-aligned — the terrace band's street direction is derived from the park boundary rather than the zone's slope direction.

### commitVectorFrontageRoads

Takes a working map and a `PlannedRoad[]` array and stamps them into the road network via `roadNetwork.add()`. Run after the claim pass once the layout has been reviewed or the experiment has committed.

---

## Residual Ribbon Fill

`src/city/land/residualRibbonFill.js` fills `ResidualArea` polygons from a layout with residential ribbon streets.

The process:
1. Rasterise each residual polygon to zone cells (cells within the polygon that belong to the parent sector)
2. Build fill sectors from those cells — sub-zones inheriting the parent's slope direction
3. Run `layCrossStreets` and `layRibbons` per fill sector using the incremental street machinery
4. Commit accepted streets to the road network via `tryAddRoad`

This connects the reservation model to the existing incremental street system. Residual areas are the input to ribbon fill — they define where ribbon streets run, not the original zone boundary.

---

## Terrain Face Cache

`src/city/land/terrainFaceCache.js` caches the output of `ridgeSegmentationV2` alongside fixture files (`.terrain-faces-v2.json` + `.terrain-faces-v2.bin`). Since terrain segmentation is expensive and the result is deterministic for a given fixture, caching avoids re-running it on every experiment render.

---

## Geometry Primitives

`src/city/land/geometryPrimitives.js` collects geometry utilities used across the land allocation module:

- Arc lengths and polyline sampling (`arcLengths`, `sampleAtDistance`, `polylineLength`)
- Polygon operations (`polygonArea`, `polygonCentroid`, `polygonEdgeMidpoints`)
- Offset polylines with inward hint (`offsetPolylineWithHint`)
- Perpendicular strip construction (`buildPerpendicularStrip`, `buildPerpendicularCutLine`)
- Regularised quad construction (`buildRegularizedAttachedBoundaryQuad`)
- Polyline utilities (`dedupePolyline`, `trimPolylineEnds`, `sliceClosedPolylineBetween`, `smoothPolylineChaikin`)

These were previously scattered or reimplemented across multiple files.

---

## Experiment History

| Experiments | What was built |
|-------------|---------------|
| 040–043 | Commercial frontage strip, access gaps, service road, residual fill prototype |
| 044–049 | Declarative buyer families prototype, view villas, park edge terraces, residual blocks |
| 050–052 | Vector frontage parcels, perpendicular cuts, hierarchical access |
| 053 | Clean vector frontage baseline established |
| 054–057 | Civic park variants — boundary-attached, regularised quad, residual areas |
| 058–061 | Commercial + park + terrace combinations, guide-aligned streets |

---

## Relationship to Other Docs

- [[land-reservation]] — legacy BFS approach still running in main pipeline
- [[land-allocation-model]] — target allocation strategies this model implements
- [[incremental-street-layout]] — cross streets and ribbons used by residual fill
- [[functionality-overview]] — the higher-level vision this implements
- `specs/v5/land-buyer-model.md` — full buyer family/variant schema design
- `specs/v5/land-allocation-experiments.md` — experiment design and open questions

---

## Source Files

| File | Role |
|------|------|
| `src/city/land/microReservationModel.js` | `ReservationLayout`, `FrontageSpan`, `PlannedRoad`, `ReservationParcel`, `ResidualArea` |
| `src/city/land/vectorFrontageLayout.js` | Micro claim functions — frontage, park, terrace variants |
| `src/city/land/residualRibbonFill.js` | Fill residual areas with ribbon streets |
| `src/city/land/terrainFaceCache.js` | Cache terrain segmentation alongside fixtures |
| `src/city/land/geometryPrimitives.js` | Shared geometry utilities |
| `scripts/render-sector-clean-frontage.js` | Current experiment render script (040–061) |
| `scripts/render-sector-micro-allocation.js` | Earlier prototype render script (040–049) |
