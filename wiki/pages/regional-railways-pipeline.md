---
title: "Regional Railways Pipeline"
category: "pipeline"
tags: [railway, pipeline, pathfinding, regional]
summary: "How railways are generated in the regional pipeline: off-map cities, A* routing with settlement bonus, corridor sharing, and bridge detection."
last-modified-by: user
---

## Overview

Railway generation runs as phase A8 of the regional pipeline, after settlements and roads are fully placed. It produces a small number of lines (3-7 per region) radiating from the main city to off-map destinations, with the A* cost function naturally routing through intermediate settlements.

See [[railway-network]] for the architectural design and [[pipelines-overview]] for where this fits in the overall pipeline.

## Pipeline Position

```
A6d. growSettlements()
A8a. generateOffMapCities()    — place 3-5 exit points on inland map edges
A8b. generateRailways()        — route lines from main city to each off-map city
A5.  generateLandCover()       — (continues)
```

## Off-Map Cities

`generateOffMapCities(params, rng, { coastEdges })` places 3-5 cities at region edges:

- Only on **inland edges** — `coastEdges` from tectonics data excludes coastal edges
- One is designated the **capital** (importance 1)
- Others get importance 2-3 and roles (industrial, port, market, university)
- Positions spread across available edges, 20-80% along each edge

## Railway Generation

`generateRailways(params, settlements, offMapCities, elevation, slope, waterMask)` builds a tree-shaped network:

### Cost Function

The railway A* cost function (`railwayCostFunction` in `src/core/railwayCost.js`) differs from roads:

| Parameter | Road value | Railway value | Why |
|-----------|-----------|---------------|-----|
| Slope penalty | 15 | 150 | Railways need very gentle gradients (~2-3% max) |
| Water penalty | 50 | 500 | Stay on one side of rivers; crossings are expensive bridges |
| Edge penalty | 3 | 0 | Railways need to reach map edges (off-map cities) |
| Max gradient | n/a | 3% | Cost skyrockets above this threshold |

Two additional bonuses layered on top:

- **Settlement bonus** — a proximity grid gives up to 70% cost discount near settlements, so A* naturally routes through towns
- **Track reuse** — existing rail cells cost only 5% of normal, so later lines lock onto shared corridors

### Connection Strategy

All lines radiate from the main city. Capital (importance 1) is routed first, then other off-map cities in importance order. The track reuse discount means later lines share the earlier trunk where they head in a similar direction, then diverge — producing a natural branching tree without explicit merge logic.

Tier-2 settlements get a short branch line to nearest existing track if they're not already within 5 cells of a line.

### Path Simplification

Raw A* paths (hundreds of grid cells) are simplified to a handful of waypoints:

1. **RDP simplification** (epsilon=8) removes unnecessary intermediate points
2. **Settlement pinning** — any settlement within 5 cells of the raw path is inserted as a fixed waypoint that cannot be smoothed away
3. **World-coordinate polyline** — grid coords converted to world coords (`gx * cellSize`) for city inheritance

### Bridge Detection

Any path cell on water (`waterMask > 0`) is recorded as a bridge in the output. Bridge data is stored on the LayerStack as `railBridges`.

### Dry Land Origin

If the main city's grid position is on water (common for river cities), the railway origin is BFS-nudged to the nearest dry land cell within 20 cells.

## Output

Stored on the LayerStack:

| Key | Type | Contents |
|-----|------|----------|
| `railways` | data | Array of `{ path, polyline, hierarchy, from, to }` |
| `railGrid` | grid (uint8) | 1 where track cells exist |
| `railBridges` | data | Array of `{ gx, gz }` bridge cells |
| `offMapCities` | data | Array of `{ gx, gz, edge, importance, role, name }` |

## Rendering

Railways are rendered in three views:

- **3D region preview** — `buildRegionRailways()` in regionPreview3D.js, black lines above terrain
- **2D region map** — `drawRailways()` in mapRenderer.js, dashed black lines
- **Railway schematic** — dedicated `RailwayScreen` at `?mode=railway`, Chaikin-smoothed coloured lines with station dots

## Source Files

| File | Role |
|------|------|
| `src/regional/generateOffMapCities.js` | Off-map city placement (inland edges only) |
| `src/regional/generateRailways.js` | Network construction, A* routing, path simplification |
| `src/core/railwayCost.js` | Railway-specific A* cost function |
| `src/core/inheritRailways.js` | Clip polylines to city bounds (see [[city-region-inheritance]]) |
| `src/ui/RailwayScreen.js` | 2D schematic screen |
| `src/rendering/railwaySchematic.js` | Schematic rendering functions |
