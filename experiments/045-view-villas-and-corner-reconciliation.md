# 045 — View Villas And Corner Reconciliation

## Goal

Build on `044` with two improvements:

1. fix the over-wide frontage/service treatment at anchor corners
2. add a first premium residential buyer that claims a low-density amenity site
   before generic residual residential fill

## Corner Reconciliation

Earlier micro experiments let multiple frontage runs carry full service-road and
commercial depth structure straight into shared corners. That produced
inappropriately wide yellow/orange bands where two edge systems piled into the
same corner.

`045` adds a corner-clearance rule:

- detect anchor corner cells that border roads on multiple sides
- clear a small interior radius around those corners
- prevent frontage/service/stub claims from projecting fully through that zone

This is still simple, but it is closer to the intended behaviour:

- one tighter corner condition
- less doubled-up service structure

## Premium Residential Buyer

`045` also introduces a first `residential/view-villa` buyer.

This buyer:

- searches for a high-amenity micro site
- currently scores elevation and water proximity most strongly
- claims a small low-density cluster
- emits a short access lane
- reserves that land before the generic `residential/residual-fill` step

This is a first proof of the idea that residential is not one homogeneous fill
class. Some buyers want special land at lower density.

## Buyer Program

Families:

1. `commercial/frontage-strip`
2. `civic/park`
3. `residential/view-villa`
4. `residential/residual-fill`

## Colour Key

- magenta edge cells: road-facing anchor boundary
- orange: commercial frontage
- pale yellow: first internal service road
- bright yellow: frontage stubs
- dark green: park
- light green: park perimeter road
- lavender: premium residential
- pale lavender: premium residential access lane
- cyan fill: generic residual residential
- magenta lines: residual cross streets
- cyan lines: residual ribbons
- orange dots: ribbon endpoints
- dark red: unreachable leftover cells

## Read

This is the first micro experiment where the declarative buyer model begins to
differentiate residential demand internally, while also cleaning up one of the
most visible geometric artifacts from the earlier frontage logic.
