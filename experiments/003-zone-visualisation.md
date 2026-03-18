# Experiment 003: Zone Visualisation

## Previous state
See `002-throttled-ribbon-roads.md`. layoutRibbons filled entire zones with streets, running far ahead of development.

## Problems
Need to understand why roads spread so far. Hypothesis: zones are too large for per-zone street layout.

## Hypothesis
Visualise zones to see their size and shape relative to the city.

## Changes
Added `scripts/render-zones.js` — renders zone boundaries, fills, nuclei, and skeleton roads.

## Results
- `003-output/zones-seed884469.png`
- 37 zones across 10 nuclei
- Zones are enormous — some cover 25% of the map
- They represent ALL buildable land, not just the area that should be developed
- When layoutRibbons processes a zone, it fills the entire boundary with streets — that's why roads run ahead of development

## Decision
KEEP (visualisation only, no code change). This confirms that zones are the wrong unit for incremental road layout. Streets need to extend from the development edge by a fixed distance per tick, independent of zone boundaries.
