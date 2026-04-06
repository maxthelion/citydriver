# 043 — Central Park With Ring Road

## Goal

Extend the micro-sector allocation model from `042` by inserting a rectangular
park in the middle of the chosen sector.

This experiment treats the park as an **edge-generating reservation**, not just
as carved-out land:

- the park itself reserves a rectangular interior
- a one-cell perimeter road is generated around it
- that perimeter road is connected back into the planned internal road system
- the remaining reachable land is then filled with residual cross streets and
  ribbons

## Why

Earlier in the design discussion we identified that some reservations are not
separable from road building.

A park in the middle of a sector should not just leave a hole for later street
filling to awkwardly work around. It should create edges that the later fill
responds to.

## What Stays The Same

This keeps the micro rules from `042`:

- commercial frontage is half depth
- a first internal service road sits one full block depth behind it
- frontage preserves permeability through access gaps and stubs
- gap cadence influences residual cross-street phase, but does not force a
  street at every gap

## What Changes

1. Search for a central rectangular park that fully fits inside the sector
2. Reserve the park cells
3. Reserve a ring road around the park
4. Connect that ring road to the planned service-road/stub network
5. Treat both the park and its ring road as constraints/anchors for the
   residual fill

## Colour Key

- magenta edge cells: road-facing anchor boundary
- orange: commercial frontage
- pale yellow: first internal service road
- bright yellow: stubs from access gaps
- dark green: park
- light green: park perimeter road
- cyan fill: residential residual
- magenta lines: residual cross streets
- cyan lines: residual ribbons
- orange dots: ribbon endpoints
- dark red: leftover unreachable cells

## Read

This is the first micro land-allocation experiment where a reserved civic-like
space actively reshapes the later street fill.

If it behaves well, it should be a better foundation for church/square and
other edge-generating reservations than the earlier frontage-only experiments.
