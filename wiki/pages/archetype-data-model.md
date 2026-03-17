---
title: "Archetype Data Model"
category: "data-model"
tags: [archetypes, schema, land-use, pipeline]
summary: "Schema and field definitions for city archetype objects, which parameterise the city generation pipeline."
last-modified-by: user
---

## Overview

An archetype is a plain object that parameterises the [[city-generation-pipeline]]. All archetypes are defined in `src/city/archetypes.js` and keyed by ID in the `ARCHETYPES` map.

## Current Schema

```typescript
interface Archetype {
  id: string;                    // e.g. 'marketTown'
  name: string;                  // e.g. 'Organic Market Town'
  shares: LandShares;            // budget fractions for land reservation
  reservationOrder: UseType[];   // order in which use types claim land
  placement: Record<UseType, PlacementWeights>;  // spatial layer weights per use type
  growthMode: Record<UseType, 'radial' | 'directional'>; // how each zone expands from seed
}

type UseType = 'commercial' | 'industrial' | 'civic' | 'openSpace';

interface LandShares {
  commercial: number;  // 0-1 fraction of total zone cells
  industrial: number;
  civic: number;
  openSpace: number;
  // residential is the implicit remainder: 1 - sum(shares)
}

interface PlacementWeights {
  centrality?: number;      // proximity to nuclei (0-1)
  waterfrontness?: number;  // proximity to water (0-1)
  edgeness?: number;        // peripheral location (0-1)
  roadFrontage?: number;    // local road density (0-1)
  downwindness?: number;    // position downwind of centre (0-1)
}
```

## Field Descriptions

### `shares`

Fraction of total development zone cells to allocate to each non-residential use type. Values must be 0-1 and their sum should be well under 1.0 to leave room for residential. Currently ranges from 0.04 (industrial in civicCentre) to 0.22 (industrial in industrialTown).

### `reservationOrder`

Array of four `UseType` strings. The first entry gets first pick of the best-scoring land; later entries work with whatever remains. This is the primary mechanism for expressing which land use is the "organising principle" of the city — e.g. industrial first for port cities, civic first for market towns.

### `placement`

Per-use-type dictionary of spatial layer weights. When scoring a cell for a given use type, the score is `sum(weight * spatialLayer.value)`. Only layers with non-zero weights need to be listed. See [[land-reservation]] for how scoring drives seed selection and growth.

### `growthMode`

Per-use-type choice of expansion algorithm:
- **radial** — BFS priority queue, expands roughly equally in all directions. Produces compact/circular zones.
- **directional** — BFS with axis bias (2x along dominant gradient contour, 0.5x perpendicular). Produces elongated strips.

## Current Archetypes

| ID | Name | Total reserved | Organising principle |
|----|------|---------------|---------------------|
| `marketTown` | Organic Market Town | 33% | Civic core, commercial along approach roads |
| `portCity` | Port and Waterfront City | 40% | Industrial waterfront, commercial one block back |
| `gridTown` | Planned Grid Town | 40% | Central civic plaza, commercial main street |
| `industrialTown` | Industrial Town | 39% | Large central works, everything else secondary |
| `civicCentre` | Civic and Administrative Centre | 46% | Institutional campus at centre |

## Potential Future Fields

The archetype currently only parameterises tick 5 ([[land-reservation]]). There's an open question about whether archetypes should control more of the pipeline — both which steps run and how they're configured.

Candidates for future archetype fields:

- **`nuclei`** — nucleus placement strategy. Organic towns might use the current greedy-on-land-value approach (multiple scattered growth centres), while a planned grid town might use a single central nucleus or a regular grid of nuclei. A port city might anchor nuclei along the waterfront.
- **`skeletonStrategy`** — how skeleton roads are built. MST between nuclei works for organic towns, but a grid town should lay down a regular grid. A port city might use a spine road perpendicular to the waterfront.
- **`streetPattern`** — ribbon layout parameters. Grid vs organic vs radial street patterns, block size, regularity.
- **`pipeline`** — the ordered list of tick functions to run, allowing archetypes to swap out or skip steps entirely rather than parameterising a fixed sequence.

## Source

Defined in `src/city/archetypes.js`. Retrieved by ID via `getArchetype(id)`. Auto-selected per settlement in `src/city/archetypeScoring.js`.
