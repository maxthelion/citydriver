# V2 Architecture — Regional + City Generation

## Three Nested Scales

```
Regional (100m/cell, ~100km²)
  └─ City (5m/cell, ~3-5km²)
       └─ Block/Building (sub-meter, on-demand)
```

Each scale inherits constraints from the one above. Nothing is arbitrary — every decision traces back to terrain.

---

## Core Principle: Data vs. Rendering Separation

Generation produces **plain JS objects/arrays** — no Three.js objects. A separate rendering layer converts data to meshes.

- Tests run in Node.js with zero WebGL dependencies
- Each pass independently testable with known inputs/outputs
- Rendering is swappable

---

## Module Structure

```
src/
  core/
    rng.js                — SeededRandom (fork-able for isolation)
    noise.js              — PerlinNoise with fBm
    heightmap.js          — Heightmap class (Float32Array + bilinear interp)
    math.js               — lerp, smoothstep, clamp, geometry utils
    flowAccumulation.js   — D8 flow, sink filling, stream extraction
    pathfinding.js        — A* on grid with terrain-aware cost

  regional/
    regionalTerrain.js    — R1: coarse heightmap generation
    drainage.js           — R2: watershed + river network from flow accumulation
    biomes.js             — R3: resource/biome tagging from terrain
    settlements.js        — R4: site scoring + settlement hierarchy placement
    regionalRoads.js      — R5: inter-settlement terrain-aware routing
    region.js             — Orchestrator for regional pipeline

  generation/
    pipeline.js           — City generation orchestrator (async, receives CityContext)
    terrain.js            — Pass 1: refine regional heightmap + carve rivers/coast
    river.js              — River refinement from regional drainage
    coast.js              — Coastline from regional data
    primaryRoads.js       — Pass 2: roads from entry points to center + anchors
    secondaryRoads.js     — Pass 3: block subdivision
    landUse.js            — Pass 4: zone assignment + plot subdivision
    buildings.js          — Pass 5: building data generation
    graph.js              — Planar graph ops, block detection

  rendering/
    regionalMap.js        — 2D canvas overview map
    terrainMesh.js        — Heightmap → Three.js terrain mesh
    roadMesh.js           — Road edges → triangle strip meshes
    buildingMesh.js       — Building data → Three.js meshes (style templates)
    waterMesh.js          — River/coast → water planes
    parkMesh.js           — Trees, benches
    bridgeMesh.js         — Bridge geometry
    materials.js          — MaterialRegistry (shared, created once)

  game/
    car.js                — Car mesh + physics
    camera.js             — Chase / top-down / hood cam
    minimap.js            — Canvas overlay
    ui.js                 — HUD elements
    game.js               — Main loop, scene, regeneration
    modes/
      GameMode.js         — Base class
      TreasureHunt.js     — Treasure hunt mode
      targetPicker.js     — Road location picker

test/
  core/                   — Unit tests for core utilities
  regional/               — Regional pipeline invariant tests
  generation/             — City pass invariant tests
  rendering/              — Mesh construction tests
```

---

## Key Abstractions

### SeededRandom (`core/rng.js`)

Every random decision flows through a seeded RNG. No `Math.random()` in generation code.

```js
class SeededRandom {
  constructor(seed)
  next()             // [0, 1)
  range(min, max)    // float in range
  int(min, max)      // integer in range
  pick(array)        // random element
  shuffle(array)     // in-place shuffle
  fork(label)        // derive child RNG with independent stream
}
```

`fork()` prevents cascade effects — changing one building's template doesn't shift every subsequent random decision.

### Heightmap (`core/heightmap.js`)

Single source of truth for terrain elevation.

```js
class Heightmap {
  constructor(width, depth, resolution)
  get(gridX, gridZ)              // direct array access
  set(gridX, gridZ, value)       // modification (Pass 1 only)
  sample(worldX, worldZ)         // bilinear interpolation
  sampleSlope(worldX, worldZ)    // { pitch, roll }
  freeze()                       // prevent further modification
}
```

After Pass 1 completes, `freeze()` is called. All subsequent passes and the game loop use only `sample()`.

### Flow Accumulation (`core/flowAccumulation.js`)

Rivers emerge from terrain rather than being hand-placed.

```
1. fillSinks(heightmap)     → no landlocked basins
2. flowDirections(heightmap) → D8: each cell → lowest neighbor
3. accumulate(directions)    → upstream area per cell
4. extractStreams(accum, thresholds) → DrainageTree
```

Output: `DrainageNode { cells, flowVolume, children, mouth }`

### Road Graph

Roads as a proper planar graph. Blocks are faces of the graph.

```js
Node:  { id, x, z, type: 'intersection'|'bridge'|'deadend' }
Edge:  { id, from, to, points: [{x,z}], width, hierarchy }
Block: { id, polygon: [{x,z}], area, edgeIds, landUse, plots }
```

---

## Regional Pipeline

### R1: Regional Heightmap
Coarse fBm at 100m/cell. 1000×1000 grid = 1M cells. Fast.

### R2: Flow Accumulation → Drainage
D8 flow direction + accumulation. Rivers emerge from terrain. O(n log n).

### R3: Biome/Resource Tagging
Heuristic tagging from elevation, slope, water proximity.

### R4: Settlement Placement
Score sites for settlement potential (river proximity, harbor, flat land, hinterland, defense). Greedy placement with spacing penalty (central place theory).

Settlement hierarchy: city > town > village > hamlet.

Economic role derived from WHY the site scored well: port, river_crossing, market_town, mining, pass_town, fishing.

### R5: Regional Road Network
Tree-structured road network built in three phases:

1. **Trunk roads** (major): Kruskal MST between cities + redundant edges within 1.5× longest MST edge.
2. **Town spurs** (secondary): Each unconnected town routes via A* to the *nearest existing road cell*, creating a T-junction where it joins the trunk. Processed closest-to-network first (Prim-like growth).
3. **Village spurs** (minor): Same as towns — each village branches off the nearest existing road cell.

**Key rule**: Settlements never get independent parallel routes. Every new road connects to the nearest point on the existing network, producing shared trunks with branching spurs. This eliminates duplicate/parallel roads and creates a realistic hierarchical tree.

Output per settlement: road entry points with direction and hierarchy.

---

## CityContext — Interface Between Regional and City

```js
CityContext: {
  center: {x, z},
  regionHeightmapSample,     // coarse elevation for this area
  rivers: [{                  // from drainage network
    entryPoint, exitPoint,
    flowVolume,
    path: [{x,z}],
  }],
  coastline: {...} | null,
  roadEntries: [{             // from regional roads
    point: {x, z},
    direction,
    hierarchy,
    destination,
  }],
  economicRole,
  rank,
  hinterland: { agriculture, timber, minerals, fishing },
}
```

---

## City Pipeline (5 Passes)

### Pass 1 — Terrain Refinement
Refine regional heightmap: add high-frequency detail noise (wavelengths < regional cell size). Carve river channels from drainage data. Apply coastline. Freeze heightmap.

### Pass 2 — Primary Roads
Connect road entry points to city center and anchor points. A* routing for organic cities, grid for planned cities. Bridges where roads cross rivers.

### Pass 3 — Secondary Roads + Blocks
Fill between primary roads. Detect blocks as faces of planar road graph.

### Pass 4 — Land Use + Plots
Assign land use per block (commercial, residential, industrial, civic, parks). Subdivide blocks into building plots with style-appropriate setbacks.

### Pass 5 — Buildings
Generate building data from plots. Style system maps (landUse, era) → template function. Template produces `{ x, z, w, d, h, floors, style, roofType, doorFace }`.

---

## Heightmap Refinement (Consistency Across Scales)

```js
function refinedHeight(worldX, worldZ, regional, detailNoise) {
  const coarse = regional.sample(worldX, worldZ);  // bilinear interp
  const detail = detailNoise.fbm(worldX, worldZ, {
    minFrequency: 1/50,   // above regional resolution
    maxFrequency: 1/5,
  });
  return coarse + detail * localAmplitude;
}
```

No detail noise at frequencies that contradict regional shape. Frequency banding ensures consistency.

---

## Data Structures (Plain Objects)

All pipeline output is serializable and inspectable:

```js
River:      { centerline: [{x,z}], width, floodplainWidth, tributaries: [River] }
Coast:      { edge, seaLevel, shoreline: [{x,z}], submergedMask }
Anchor:     { x, z, type: 'crossing'|'harbor'|'hilltop'|'saddle'|'river_mouth' }
Bridge:     { edgeId, start:{x,z}, end:{x,z}, deckHeight }
Plot:       { polygon, frontage, depth, setbacks, style, landUse }
Building:   { x, z, w, d, h, floors, style, roofType, landUse, doorFace }
Settlement: { x, z, rank, economicRole, roadEntries }
DrainageNode: { cells, flowVolume, children, mouth }
```

Building contract: `{ x, z, w, d }` with positive numbers — used by collision, minimap, and tests.

---

## Testability

Generation tests need zero Three.js. Only rendering tests need it.

| Layer | What's Tested |
|---|---|
| core | Heightmap consistency, noise determinism, RNG fork isolation |
| core | Flow accumulation produces connected tree, rivers flow downhill |
| core | A* finds paths, respects terrain cost |
| regional | Settlements at sensible locations (near water, flat land) |
| regional | Roads follow valleys, connect all settlements |
| generation | Refined terrain consistent with regional |
| generation | Roads connect to entry points |
| generation | Blocks are closed polygons, land use follows rules |
| generation | Buildings within plots, no overlaps, no water placement |
| rendering | Road normals point up, vertices contact terrain |
| rendering | Building grounding: base Y = max(heightmap at corners) |

Property-based: run full pipeline across 50 random seeds, assert invariants hold for all.

---

## Implementation Waves

### Wave 1 — Foundation (parallel, no deps)
- Core modules: rng, math, noise, heightmap + tests
- Flow accumulation + tests
- Pathfinding (A*) + tests

### Wave 2 — Regional + Game Shell (parallel, needs Wave 1)
- Regional generation: all 6 modules + tests
- Game shell: Three.js scene, car, camera, materials, terrain renderer
- City generation Passes 1-3

### Wave 3 — City Detail + Renderers (parallel, needs Wave 2)
- City Passes 4-5: land use, plots, buildings
- Renderers: road, building, water, bridge meshes

### Wave 4 — Integration
- Minimap, regional map UI, game modes, full pipeline wiring

---

## Design Decisions

1. **Flow accumulation over hand-placed rivers**: Coherent hydrology for free
2. **Settlement as optimization**: Sites are sensible because they're scored by geography
3. **CityContext as interface boundary**: Clean contract between regional and city layers
4. **Frequency banding for heightmap refinement**: Regional owns low freq, city adds high freq
5. **Economic role drives character**: Geography → economics → architecture (causal chain)
6. **rng.fork() prevents cascade**: Each sub-step gets independent random stream
7. **Heightmap.freeze()**: Catches accidental mutation after Pass 1
8. **Road graph → block faces**: Blocks emerge from road network topology
9. **No class hierarchy for buildings**: Template functions, not inheritance
10. **Async between passes, sync within**: Simple suspension model
