# 041 — Residual Sector Street Fill

## Goal

Take the micro-sector frontage rules from `040` and actually lay streets into
the residential residual.

This experiment keeps the same micro assumptions:

- commercial frontage is **half depth**
- a first internal **service road** sits one full block depth behind it
- frontage leaves periodic **access gaps**
- those gaps emit short **stubs**

The new step is that the remaining residential residual is treated as a real
sector for street generation.

## Important Consequences From The Design Notes

This experiment tries to respect the points raised at the start of the land
allocation phase:

### 1. This is a micro test, not a macro one

It does **not** decide where commercial belongs city-wide. It only chooses one
prime road-facing sector per zone and tests the internal reservation/street
relationship there.

### 2. Reservation and roads are coupled

The service road and access stubs are not decorative. They are generated as
part of the frontage reservation pattern and treated as real barriers/anchors
for the residual street fill.

### 3. Commercial frontage must preserve permeability

The access-gap cadence is fed into the residual cross-street phase using
explicit contour offsets. So the later street pattern is not independent of the
frontage reservation; it inherits some of its rhythm from the gaps/stubs.

### 4. Commercial is a half-depth ribbon

The anchor road to first internal road span is intended to support:

1. commercial facing the anchor road
2. residential backing onto the commercial

There should not be a road directly behind the commercial, and the experiment
is trying to avoid the three-row sandwich that would create inaccessible plots.

## What It Does

1. Chooses one road-facing sector per candidate zone
2. Detects anchor-edge runs that border existing roads
3. Reserves shallow commercial frontage along those runs
4. Leaves periodic access gaps
5. Builds short stubs from those gaps
6. Places a service road one full block depth behind the frontage
7. Takes the reachable residential residual as a new sector
8. Runs `layCrossStreets()` and `layRibbons()` inside that residual
9. Uses the gap/stub rhythm to seed explicit cross-street phase offsets

## Colour Key

- magenta edge cells: road-facing anchor boundary
- orange: commercial frontage
- pale yellow: first internal service road
- bright yellow: stubs from access gaps
- cyan fill: residential residual
- magenta lines: residual cross streets
- cyan lines: residual ribbons
- orange dots: ribbon endpoints
- dark red: leftover unreachable cells

## Read

This is the first experiment in the land-allocation thread that actually
connects:

- reservation geometry
- frontage permeability
- and downstream street generation

If this direction holds up, the next micro experiment should insert a park or
church/square polygon and test how an edge-generating civic reservation
reshapes the residual street fill.
