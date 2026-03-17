---
title: "Regional Rivers"
category: "pipeline"
tags: [pipeline, regional, rivers, hydrology, terrain]
summary: "How the regional pipeline generates rivers: corridor planning, flow routing, stream extraction, valley carving, and known issues."
last-modified-by: user
---

## Overview

Rivers are the most complex feature in the [[regional-pipeline]]. They span four phases of the [[regional-pipeline]] — corridor planning (A0b), terrain generation (A2), coastline shaping (A4), and hydrology (A3) — each modifying the elevation grid and producing data structures consumed downstream. The river pipeline transforms a raw heightmap into a network of carved valleys with water flowing through them.

## Pipeline Stages

### A0b. Corridor Planning (before terrain)

**File:** `src/regional/planRiverCorridors.js`

Major rivers predate the current terrain (antecedent drainage). Before terrain is generated, 0–3 corridor polylines are planned from inland edges to the coast.

**Inputs:** Tectonic context (coast edges, intensity)
**Outputs:**
- `corridors` — array of corridor objects with polylines, entry accumulation, importance
- `corridorDist` — Grid2D: BFS distance from nearest corridor cell
- `corridorInfluence` — Grid2D: gaussian falloff 0–1 for ridge suppression

Each corridor has a width (400–1250m depending on importance) and a synthetic entry accumulation value (2,000–10,000) that gets injected into the hydrology phase to ensure the river has enough flow volume.

### A2. Terrain Suppression (during terrain generation)

**File:** `src/regional/generateTerrain.js`

The terrain generator reads `corridorInfluence` to create natural valleys where rivers will flow:

- **Mountain suppression:** `mountainContrib *= (1 - corridorInfluence)` — ridges are flattened along corridors
- **Base depression:** `corridorDepress = corridorInfluence * 15` — up to 15m depression along corridor centre

After all terrain noise is combined, a **power curve** normalisation (exponent 1.3–1.7) is applied to create more dramatic relief. This amplifies the corridor depression relative to surrounding terrain.

### A3. Hydrology

**File:** `src/regional/generateHydrology.js`

The main hydrology phase runs after terrain and coastline generation. It performs these steps in order:

#### 1. Elevation cloning + meander noise
A clone of the elevation grid is made for flow routing. High-frequency low-amplitude noise (±0.8m) is added to deflect flow paths and create natural meanders. This noise only affects routing, not the visible terrain.

#### 2. Sink filling
`fillSinks()` (priority flood algorithm) raises any interior depression so water can always reach a map edge. This ensures continuous flow paths but doesn't lower any cells.

#### 3. Flow directions + accumulation
D8 steepest-descent routing assigns each cell a flow direction. Flow accumulation counts how many upstream cells drain through each cell. High accumulation = large river.

#### 4. Geology-aware adjustment
Accumulation is boosted on impermeable rock (×1.0 to ×1.6) to simulate increased surface runoff on hard surfaces.

#### 5. Corridor injection
For each planned corridor, synthetic accumulation is injected at the entry point and propagated downstream along flow directions. This ensures the planned major rivers have enough volume regardless of the terrain's natural drainage.

#### 6. Stream extraction
`extractStreams()` identifies river cells and builds a segment tree:
- Cells with accumulation ≥ threshold AND above sea level are candidates
- Slope-scaled thresholds control where streams can originate (steeper terrain → smaller streams visible)
- Segments trace downstream from headwaters, splitting at confluences (cells with 2+ upstream tributaries)
- Segments are assembled into a tree by linking each segment's mouth to its downstream segment

**Ranks:** stream (≥80 acc), river (≥400 acc), majorRiver (≥800 acc)

#### 7. Path smoothing
`smoothRiverPaths()` adds sinusoidal meanders on gentle terrain (slope < 0.08). Amplitude scales with river width. Geology modulates: soft rock amplifies meanders ×1.5, hard rock dampens ×0.3.

#### 8. Floodplain carving
`carveFloodplains()` applies mild channel carving (0.2–1.2m) along river segments using the `channelProfile()` cross-section. This is intentionally subtle — detailed channel profiles are computed at city resolution.

#### 9. Water mask (initial)
All cells where `elevation < seaLevel` are marked in the `waterMask` grid.

#### 10. Vector path conversion
`segmentsToVectorPaths()` converts the segment tree to smooth polylines with per-vertex width and accumulation. Chaikin corner-cutting smoothing is applied (2 iterations).

#### 11. Valley carving
Two compositional fields are computed and applied:
- **`valleyDepthField`**: How much to lower terrain at each cell (1–15m depending on accumulation and geology). Hard rock creates narrow gorges (0.5× width, 1.3× depth), soft rock creates broad valleys (1.5× width, 0.7× depth).
- **`floodplainField`**: Near the coast (within 500m), blends terrain toward a target elevation slightly below sea level, creating flat river mouths.

Applied via `applyTerrainFields()`: `elevation -= valleyDepthField`, then blended toward floodplain targets.

#### 12. Water mask (final)
`paintPathsOntoWaterMask()` stamps all river vector paths onto the water mask using variable-width circles along each path segment.

## Data Structures

### Segment Tree (`rivers`)

Stored as `layers.getData('rivers')`. Array of root segments, each forming a tree:

```
{
  cells: [{ gx, gz, elevation, accumulation }, ...],
  flowVolume: number,
  rank: 'stream' | 'river' | 'majorRiver',
  children: [segment, ...],   // tributary segments
  mouth: { gx, gz }
}
```

### Vector Paths (`riverPaths`)

Stored as `layers.getData('riverPaths')`. Smoothed polylines derived from the segment tree:

```
{
  points: [{ x, z, width, accumulation }, ...],  // world coords
  children: [path, ...]
}
```

### Water Mask (`waterMask`)

Stored as `layers.getGrid('waterMask')`. Grid2D (uint8): 1 = water, 0 = land. Combines ocean cells (elevation < seaLevel) with painted river paths.

## Key Source Files

| File | Role |
|------|------|
| `src/regional/planRiverCorridors.js` | Corridor planning (A0b) |
| `src/regional/generateTerrain.js` | Corridor depression in terrain (A2) |
| `src/regional/generateHydrology.js` | Main hydrology pipeline (A3) |
| `src/regional/carveValleys.js` | Valley depth + floodplain fields |
| `src/core/flowAccumulation.js` | fillSinks, D8 routing, stream extraction, smoothing |
| `src/core/riverGeometry.js` | Width/depth/profile functions (single source of truth) |

## Geometry Functions (from `riverGeometry.js`)

| Function | Formula | Range |
|----------|---------|-------|
| `riverHalfWidth(acc)` | `√acc / 5` | 2–40m |
| `riverMaxDepth(hw)` | `1.5 + hw/15` | up to 4m |
| `valleyHalfWidth(acc)` | `√acc × 1.5` | 30–500m |
| `valleyDepth(acc)` | `√acc / 20` | 1–15m |

## Known Issues

See also `specs/v5/river-problems.md`.

### River fragmentation from corridor depression

The corridor depression (up to 15m) combined with the power curve normalisation pushes terrain along corridors below sea level — especially near the coast. `extractStreams` skips all cells below sea level (line 221: `if (elev < seaLevel) continue`), so the river gets fragmented at every below-sea-level gap. For seed 786031, 30.9% of the main corridor polyline is below sea level, creating a 90-cell gap that splits the river into separate root segments.

**Result:** What should be one unified river appears as 67 disconnected root segments, with only 2 containing the bulk of the flow.

### Valleys too shallow for visual impact

Valley carving (1–15m) and floodplain carving (0.2–1.2m) produce subtle terrain modifications. The rivers appear as narrow trickles rather than significant landscape features. Previously, `seaFloorPlunge` masked this by flood-filling valleys below sea level — that was removed because it also created deep depressions on inland streams.

### River plunging in 3D city view

In the city-level 3D renderer, rivers are still rendered at or below sea level rather than at their natural terrain elevation. This is a separate issue from the regional pipeline.

## Debug Tooling

Two scripts render the river state at each pipeline stage:

- `scripts/debug-rivers.js` — 13 PNGs showing elevation and river data at each hydrology step
- `scripts/debug-river-segments.js` — 6 PNGs showing the segment tree colour-coded by root, isolated rivers, and disconnected streams

Usage: `node scripts/debug-rivers.js --seed 786031`
