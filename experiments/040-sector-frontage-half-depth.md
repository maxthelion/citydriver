# 040 — Sector Frontage Half Depth

## Goal

Work out micro-level reservation rules before attempting city-wide land
allocation.

This experiment takes one road-facing sector per candidate zone and applies a
simple frontage model:

- reserve commercial only to a **half-depth** frontage band along road-facing
  sector edges
- leave periodic **access gaps** in that frontage
- run short **stubs** inward from those gaps
- place a first internal **service road** at one full block depth behind the
  anchor road, not directly behind the commercial
- fill the remaining reachable area with **residential**

The key rule being tested is that the anchor road to first internal road span
should contain two backing rows, not three:

1. commercial facing the anchor road
2. residential backing onto the commercial

There should not be a road immediately behind the commercial, and there should
not be a three-row sandwich that leaves an inaccessible middle row.

## What It Does

The renderer:

1. Loads the city at `spatial`
2. Segments zones into terrain sectors
3. Chooses one "prime" road-facing sector per selected zone
4. Detects road-adjacent sector boundary runs
5. Reserves shallow commercial frontage on those runs
6. Inserts periodic access gaps and stubs
7. Builds a simple internal road one full block depth behind the frontage
8. Flood-fills the remaining reachable area as residential
9. Marks leftover unreachable cells in red

This is deliberately a **micro** experiment. It is not yet trying to solve the
macro question of which sectors should become commercial at the city scale.

## Colour Key

- magenta: road-facing anchor edge cells
- orange: commercial frontage
- pale yellow: first internal service road
- bright yellow: access stubs
- cyan: reachable residential residual
- dark red: unreachable leftover cells
- white dots: frontage access gap centres

## Why This Matters

This is the smallest useful experiment for the new land-allocation questions:

- commercial frontage should preserve permeability
- frontage depth should be shallower than a normal road-to-road residential
  block
- residential should fill the residual polygon behind frontage, not start from
  the original sector edges

The next logical follow-up is the same experiment with a park or church/square
polygon inserted into the sector so we can see how edge-generating civic
reservations reshape the residual residential fill.
