# Experiment 017: Cross Streets Only

## Previous state
Experiment 016 mixed cross streets and ribbons. Issues with one affected the other.

## Problem
Need to get cross streets right in isolation before adding ribbons. The vector march algorithm from wiki/pages/laying-zone-cross-streets.md needs to be implemented and verified.

## Hypothesis
Implementing the vector march approach — starting from the bottom edge, accumulating gradient + skeleton road perpendicular pull — will produce cross streets that span the zone uphill, meet skeleton roads at right angles, and fan gently with the zone shape.

## Changes
- New `src/city/incremental/crossStreets.js` implementing the vector march algorithm
- New `scripts/render-cross-streets.js` rendering only cross streets (no ribbons)
- Green dots = start points (bottom edge), white dots = endpoints, magenta = cross street paths

## Results
_To be filled after rendering._

## Decision
_KEEP or REVERT_
