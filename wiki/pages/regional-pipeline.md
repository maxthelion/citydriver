---
title: "Regional Pipeline"
category: "pipeline"
tags: [pipeline, regional, terrain, geology, hydrology, settlements, roads]
summary: "Full phase-by-phase breakdown of the regional generation pipeline that produces landscapes with terrain, rivers, settlements, roads, and railways."
last-modified-by: user
---

## Overview

The regional pipeline generates a complete landscape from a seed. It runs as a single call to `generateRegion(params, rng)` in `src/regional/pipeline.js`, which returns a `LayerStack` containing all grids and data structures.

The pipeline is organised into phases (A0–A8), each enriching the shared LayerStack. Phases aren't strictly sequential — some run out of numeric order for dependency reasons, and the settlement/road phases use a feedback loop.

**Default grid:** 256×256 cells at 50m resolution = 12.8km × 12.8km region.

## Phase Order

```
A0  Tectonics        → coast edges, plate angle, intensity
A0b Corridor Planning → river corridor polylines + influence grids
A1  Geology          → rock type, erosion resistance, permeability, soil fertility
A2  Terrain          → elevation, slope (with corridor depression)
A4  Coastline        → erosion-shaped coast features
A3  Hydrology        → rivers, water mask, valley carving
A6a Settlements      → primary cities, towns, villages
A6b Farms            → hamlets and farmsteads
A7a Roads (pass 1)   → initial road network
A6c Market Towns     → road-attracted towns + hamlet promotions
A7b Roads (pass 2)   → connect new settlements
A6d Growth           → promote busy settlements
A5  Land Cover       → forest, grassland, scrub, farmland
    Flood Zone       → precomputed exclusion grid
```

## Phases

### A0. Tectonics

**File:** `src/regional/generateTectonics.js`

Generates the tectonic context that drives all downstream phases. Determines which map edges are coastal, the plate compression angle (controls mountain ridge orientation), tectonic intensity (controls terrain drama), and derived parameters like treeline altitude and rock bias.

**Outputs:** `coastEdges`, `plateAngle`, `intensity`, `ridgeAngle`, `ridgeAmplitude`, `bandDirection`, `rockBias`, `treeline`

### A0b. River Corridor Planning

**File:** `src/regional/planRiverCorridors.js`

Plans 0–3 major river corridors before terrain exists. These represent antecedent drainage — rivers that predate the current mountain ranges. Corridors run from inland edges to coastal edges as smooth polylines.

**Outputs:** `corridors` (polylines + accumulation values), `corridorDist` (Grid2D), `corridorInfluence` (Grid2D, gaussian falloff 0–1)

**Consumed by:** Terrain generation (ridge suppression), hydrology (entry accumulation injection)

See [[regional-rivers]] for full details on how corridors feed into the river pipeline.

### A1. Geology

**File:** `src/regional/generateGeology.js`

Generates rock types in tectonic-aligned bands with igneous intrusions. Each rock type has distinct erosion resistance, permeability, soil fertility, and cliff tendency.

**Outputs (Grid2D):** `rockType`, `erosionResistance`, `permeability`, `soilFertility`, `springLine`

**Consumed by:** Terrain (noise character per rock), hydrology (flow thresholds, gorge/valley profiles), settlements (soil fertility scoring), land cover

### A2. Terrain

**File:** `src/regional/generateTerrain.js`

Generates the elevation grid from layered noise modulated by geology and tectonics:

1. **Continental tilt** from coast field (positive = land, zero-crossing = coastline)
2. **Base height** from smoothed erosion resistance (hard rock = higher)
3. **Mountain ridges** — ridged multifractal noise stretched along tectonic ridge angle, with asymmetric profile
4. **Detail terrain** — large undulation + detail ridges + medium/small roughness, all modulated by rock character
5. **Corridor suppression** — mountains flattened and base depressed along planned river corridors
6. **Power curve** — normalised elevation raised to exponent 1.3–1.7 for dramatic relief
7. **Escarpments** — cliff faces at rock type boundaries

**Outputs (Grid2D):** `elevation`, `slope`

### A4. Coastline

**File:** `src/regional/generateCoastline.js`

Runs before hydrology so coastal erosion shapes the terrain before rivers are routed. Produces coastline features (bays, headlands, harbours) from the interaction of wave energy with rock resistance.

**Outputs:** `coastlineFeatures` (array of feature objects)

### A3. Hydrology

**File:** `src/regional/generateHydrology.js`

The most complex phase. Derives the river network from flow accumulation, carves valleys, and produces the water mask.

See [[regional-rivers]] for the full 12-step breakdown, data structures, and known issues.

**Outputs:** `rivers` (segment tree), `confluences`, `riverPaths` (vector paths), `waterMask` (Grid2D)

**Modifies:** `elevation` (valley carving, floodplain flattening)

### A6. Settlements (feedback loop)

**Files:** `src/regional/generateSettlements.js`, `generateFarms.js`, `generateMarketTowns.js`, `growSettlements.js`

Settlement placement runs in four sub-phases interleaved with road generation:

1. **A6a. Primary settlements** — scored by terrain suitability (flatness, elevation, water access, soil fertility, confluence bonus, coastline features). Placed with minimum spacing by tier.
2. **A6b. Farms and hamlets** — geography-driven placement in fertile lowlands away from existing settlements.
3. **A6c. Market towns** — attracted to road junctions. Hamlets on arterial roads get promoted.
4. **A6d. Growth** — settlements with high road traffic get tier promotions.

Each settlement has: `{ gx, gz, tier, name, archetype, nuclei, ... }`

**Outputs:** `settlements` (array)

### A7. Roads (two passes)

**File:** `src/regional/generateRoads.js`

Terrain-aware A* pathfinding connects settlements. Runs twice:

1. **A7a** — connects primaries + hamlets after initial placement
2. **A7b** — incrementally connects market towns, reusing the existing road grid

Road cost function penalises steep slopes, water crossings, and long distances. Roads follow valleys and contours naturally.

**Outputs:** `roads` (array of road objects with path cells)

### A5. Land Cover

**File:** `src/regional/generateLandCover.js`

Assigns land cover types (forest, grassland, scrub, farmland, bare rock) based on elevation, slope, soil fertility, moisture, and proximity to settlements. Respects the treeline altitude from tectonics.

**Outputs (Grid2D):** `landCover`

### Flood Zone

**File:** `src/core/terrainSuitability.js`

Precomputed grid marking cells that are both low-lying (< seaLevel + 3m) and within 250m of water. Used to exclude flood-prone areas from settlement and building placement.

**Outputs (Grid2D):** `floodZone`

## LayerStack Contents

After `generateRegion` completes, the LayerStack contains:

| Type | Key | Source Phase |
|------|-----|-------------|
| Data | `params` | Setup |
| Data | `tectonics` | A0 |
| Data | `riverCorridors` | A0b |
| Grid | `corridorDist` | A0b |
| Grid | `corridorInfluence` | A0b |
| Grid | `rockType` | A1 |
| Grid | `erosionResistance` | A1 |
| Grid | `permeability` | A1 |
| Grid | `soilFertility` | A1 |
| Grid | `springLine` | A1 |
| Grid | `elevation` | A2 (modified by A3) |
| Grid | `slope` | A2 |
| Data | `coastlineFeatures` | A4 |
| Data | `rivers` | A3 |
| Data | `confluences` | A3 |
| Data | `riverPaths` | A3 |
| Grid | `waterMask` | A3 |
| Data | `settlements` | A6 |
| Data | `roads` | A7 |
| Grid | `landCover` | A5 |
| Grid | `floodZone` | Post |

## Entry Point

```javascript
import { generateRegion } from './src/regional/pipeline.js';
import { SeededRandom } from './src/core/rng.js';

const rng = new SeededRandom(786031);
const layers = generateRegion({
  width: 256,
  height: 256,
  cellSize: 50,
  seaLevel: 0,
  coastEdges: ['north'],  // optional override
}, rng);
```
