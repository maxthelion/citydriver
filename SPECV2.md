# Open World Driving Game — Specification V2

## Overview

A browser-based 3D open-world driving game. The player drives a car through a procedurally generated city whose shape is driven by terrain, water, and historical growth logic. No two cities are the same, but every city feels plausible — roads follow terrain, buildings fill plots, and land use emerges from geography.

The game runs entirely client-side in a modern browser using Three.js. No server or build step is required beyond a static file server for ES module imports.

---

## Part 1 — City Generation Pipeline

The generation order mirrors history. Real cities grow in a sequence driven by geography, and the generator follows the same logic:

1. **Terrain and water** — rivers, hills, and coastlines drive everything
2. **Primary routes** — paths of least resistance between important points
3. **Secondary network and blocks** — fill between primary roads
4. **Plot subdivision** — divide blocks into building lots
5. **Building generation** — fill plots with structures appropriate to their zone and style

Each pass reads the output of previous passes. Nothing is arbitrary — every decision has a cause rooted in terrain, access, or economics.

### City Archetypes

The combination of water features fundamentally shapes the city:

| Archetype | River | Coast | Feel |
|---|---|---|---|
| **River + Coast** | Yes | Yes | London, Hamburg — estuary city, docks, dense waterfront. City forms at the river mouth or first crossing point. |
| **River only** | Yes | No | Paris, Prague — inland city bisected by a river, bridges as landmarks. Settlement starts at the lowest bridging point. |
| **Coast only** | No | Yes | Barcelona, Marseille — fishing port that grew, harbor as focal point. |
| **Inland** | No | No | Madrid, Munich — city on a plain or plateau. |

### Parameter Set

```
{
  seed:               number,     // reproducibility
  archetype:          string,     // 'river_coast' | 'river' | 'coast' | 'inland'

  // Base terrain
  hilliness:          [0, 1],     // elevation range — 0 = flat fenland, 1 = San Francisco
  roughness:          [0, 1],     // frequency — 0 = broad gentle hills, 1 = craggy terrain

  // River
  riverMeandering:    [0, 1],     // 0 = straight canal, 1 = heavily winding
  floodplainWidth:    [0, 1],     // 0 = narrow gorge, 1 = wide floodplain
  tributaries:        [0, 3],     // number of tributary streams

  // Coast
  coastEdge:          string,     // 'north' | 'south' | 'east' | 'west'
  coastIndentation:   [0, 1],     // 0 = straight, 1 = deep bays and headlands
  harborGuarantee:    boolean,    // ensure at least one harbor

  // City character
  organicness:        [0, 1],     // 0 = rigid planned grid, 1 = fully organic
}
```

---

### Pass 1 — Heightmap and Water

#### 1.1 Base Landform

Layered Perlin noise (fBm) with two independent controls:

**Hilliness** (amplitude): `baseAmplitude = lerp(5, 60, hilliness)`
```
octave1: fbm(x * freq1) * baseAmplitude * 0.7    // large rolling hills
octave2: fbm(x * freq2) * baseAmplitude * 0.2    // medium detail
octave3: fbm(x * freq3) * baseAmplitude * 0.1    // fine variation
```

**Roughness** (frequency): `freqMultiplier = lerp(0.6, 1.8, roughness)`
```
freq1 = 0.0015 * freqMultiplier
freq2 = 0.005  * freqMultiplier
freq3 = 0.02   * freqMultiplier
```

| hilliness | roughness | Feel |
|---|---|---|
| 0.1 | 0.2 | Flat coastal plain (Netherlands) |
| 0.5 | 0.5 | Moderate hills (default) |
| 0.7 | 0.9 | Rugged hilly city (San Francisco) |
| 0.8 | 0.4 | High plateau with broad hills (Madrid) |

#### 1.2 River

Rivers are the single most important feature. The river determines where the city center is, which bank develops first (the flatter one), and where industry clusters (downstream, near docks).

**Path**: Spline with randomized control points from one map edge to the opposite (or to coast). `riverMeandering` controls lateral deviation. Sampled at ~4-unit intervals to a centerline polyline. Width 20-30 units.

**Valley carving** (modifies heightmap in-place):
- **Channel** (dist < halfWidth): depress 3-5 units with smooth center-to-edge falloff
- **Floodplain** (dist < halfWidth + floodplainExtent): flatten and lower with smoothstep. Width from ~5 units (gorge) to ~40 units (delta). Wide floodplain = space for docks and dense settlement.
- **Bank transition** (~10 units): smoothstep taper to natural terrain

**Tributaries**: 0-3 smaller streams (10-15 units wide) joining the main river, each carving its own valley. Natural neighborhood boundaries.

**River-to-coast**: river widens approaching coast (estuary), valley merges with sea level.

#### 1.3 Coastline

**Sea level**: set at ~30th-50th percentile of terrain elevations along the chosen coast edge.

**Boundary warping**: 1D noise creates bays and headlands. `coastIndentation` controls depth. Harbor guarantee ensures at least one concave indentation (40+ units wide, sheltered).

**Terrain**: gentle slope toward waterline (beach effect). Water mesh at sea level covering submerged area.

#### 1.4 Hydrological Consistency

- River centerline always lower than its banks
- River flows consistently downhill entry → exit
- No accidental landlocked basins (smooth out or fill with lakes)

#### 1.5 Anchor Points

Identify key locations that seed the road network:
- **River crossing(s)**: narrowest/flattest river points → city center for river archetypes
- **Harbor**: most sheltered coastal bay → center for coast-only archetypes
- **Hilltop(s)**: local elevation maxima → civic/religious/wealthy sites
- **River mouth**: where river meets coast → key anchor for river+coast
- **Terrain saddles**: low points between hills → natural pass routes

---

### Pass 2 — Primary Road Network

Primary roads are paths of least resistance between anchor points. They become high streets and arterials. They follow ridgelines, river valleys, and contour lines.

**Organic cities (organicness > 0.5)**: A*-like pathfinding penalizing steep grades and water crossings. Roads follow contour lines and valleys. 4-8 primary roads radiate from the city center.

**Grid cities (organicness < 0.3)**: Regular grid imposed on flat areas. Breaks around rivers, hills, coastline. 1-2 old pre-grid roads cut diagonally (like Broadway across Manhattan).

**Mixed (0.3-0.7)**: Grid in flat areas, organic in hilly/waterfront areas.

**Road hierarchy**: Primary roads are wider (16-20 units) with lane markings, central median, sidewalks, and street trees.

**Bridges**: Where roads cross the river — flat elevated deck, ramps, support pillars, railings. The lowest crossing point gets the most important bridge (historic center).

---

### Pass 3 — Secondary Network and Blocks

Fill between primary roads with secondary streets.

**Organic**: Recursive subdivision following terrain contours. Irregular block shapes and sizes.

**Grid**: Regular subdivision (~60-72 unit cells). Blocks truncated at rivers, slopes, coastline, diagonal roads.

**Block properties**: boundary polygon, area, adjacent roads and their hierarchy, terrain character (elevation, slope, water proximity).

**Intersections**: primary×primary = large (potential roundabout), secondary×primary = T-junction, dead ends = cul-de-sacs. Network is always connected.

---

### Pass 4 — Land Use and Plot Subdivision

#### Land Use Assignment

Driven by cause-and-effect, not arbitrary zones:

- **Commercial**: where routes converge (river crossing, harbor)
- **Industrial**: water access (downstream, docks), low-lying, flat
- **Residential**: fills between. Wealth gradient driven by elevation (higher = wealthier), wind direction (upwind of industry), water proximity
- **Civic/religious**: hilltops, central squares, road junctions
- **Parks**: steep slopes, flood-prone areas, preserved green space

#### Plot Subdivision

Blocks divided into building lots. Plot shape constrains building shape.

| Style | Frontage | Depth | Feel |
|---|---|---|---|
| **Terrace** | Narrow (5-7 units) | Deep (15-20) | Attached houses in rows, rear gardens |
| **Perimeter block** | Medium (8-12) | Full block | Buildings enclose courtyard |
| **Suburban** | Wide (15-20) | Shallow (10-15) | Detached, front setbacks, side yards |
| **Commercial** | Large (20-40) | Variable | Amalgamated plots |
| **Industrial** | Very large (30-60) | Very deep | Warehouse-scale |
| **Downtown** | Full block | Full block | Single tower per block |

Corner plots are special — often larger, landmark buildings.

**Setbacks**: front (0 for terraces, 3-5 for suburban), side yards (0 for terraced, 1-2 semi-detached, 3+ detached), rear gardens.

---

### Pass 5 — Building Generation

#### Footprint

Derived from plot minus setbacks. Terraced: fills width. Detached: centered. Commercial: fills most of plot. Perimeter: follows block edge.

#### Style System

Controls per district: materiality, roof form, window rhythm, facade articulation, neighbor relationship, street-level elements, color palette, uniformity within a street.

| Profile | Roof | Street level | Uniformity |
|---|---|---|---|
| **Victorian terrace** | Pitched behind parapet | Railings, steps | High within street |
| **Continental apartment** | Steep pitch / mansard | Courtyard entrance, shops | Medium |
| **Downtown office** | Flat | Lobby, retail at ground | Medium-high per block |
| **Suburban houses** | Pitched gable | Garden, driveway, porch | Low |
| **Industrial** | Flat / sawtooth | Loading docks | High |
| **Market** | Canopy / tent | Open stall fronts | Medium (colorful) |

#### Height and Density

- Downtown: 8-25 floors. Urban residential: 3-8. Suburban: 1-2. Industrial: 1-2 (large footprint).
- Height decreases from center. Tallest buildings near river crossing / harbor.

#### Landmark Buildings

Special buildings at anchor points: town hall near oldest bridge, church on hilltop, customs house at harbor, corner pubs at junctions.

#### Doors

Every building has a door on its road-facing facade. Required for future interior systems. Offset from wall to prevent z-fighting.

---

### Historical Layering

The generation simulates eras layered on each other:
- **Old town** (center): organic roads, narrow plots, terraced 3-5 floor buildings
- **Victorian expansion** (inner ring): more regular grid, terraced/apartment blocks, 2-4 floors
- **Modern suburbs** (outer ring): grid or cul-de-sacs, detached houses, 1-2 floors
- **Industrial zones** (downstream/docks): large blocks, warehouses
- **Modern downtown** (redeveloped center): glass towers on medieval street patterns

---

## Part 2 — Technical Constraints (Lessons Learned)

### The Heightmap Consistency Problem

The terrain mesh displayed by the GPU and the height values used to place objects **must agree exactly**.

1. Generate a discrete heightmap array (`Float32Array`) by sampling analytical noise at each grid vertex
2. All terrain modifications (river carving, coastline) modify this same array
3. Build the terrain mesh directly from this array
4. Provide `sampleHeightmap(x, z)` that does bilinear interpolation of the same array
5. **All object placement and car physics use `sampleHeightmap()`**, never the raw noise

This eliminates the class of bugs where objects float above or clip through terrain.

### The PlaneGeometry Coordinate System

A Three.js `PlaneGeometry` is created in local XY (Z=0), rotated `-PI/2` around X to lay flat. After rotation:
- local X → world X
- local Y → world **-Z** (negated!)
- local Z → world Y (height)

The correct heightmap query for vertex `(localX, localY)` is `sampleHeightmap(localX, -localY)`.

### Road Construction

Roads are terrain-following triangle-strip meshes:
- Vertices sampled every ~4 units along length, conforming to heightmap
- Sit slightly above terrain (`ROAD_LIFT ≈ 0.15`) to reduce z-fighting
- Material uses `polygonOffset` (factor -1, units -1) for depth bias
- **Triangle winding must produce upward-facing normals.** Verify with test: all `normal.y > 0`. A common bug: roads in one axis direction render, perpendicular roads are back-face culled.

### Geometry Construction — Avoid Euler Rotation Composition

Angled surfaces (pitched roofs, awnings, sawtooth roofs) must be constructed using **direct vertex geometry** (`BufferGeometry` with explicit vertex positions), not by rotating `PlaneGeometry` meshes.

Euler rotation composition (e.g. `rotation.y = PI/2` then `rotation.x = angle`) produces incorrect orientations because Euler angles are order-dependent. Use `THREE.DoubleSide` material to avoid winding issues on symmetric surfaces.

Single-axis rotations (e.g. just `rotation.y` for a door) are fine.

### Building Grounding

Each building samples the heightmap at its center and four footprint corners, takes the **maximum** height, and places its base there. This ensures the ground floor and door are accessible at the highest terrain point. An extra depth (~8 units) is added below ground level on every building body so the lower corners are buried into the slope.

The extra depth must exceed the maximum height difference between the highest and lowest corners of any building footprint.

### Building Data Contract

Every building object must have at minimum: `{ x, z, w, h, d }` (position and footprint dimensions). These fields are used by car collision, minimap rendering, target picker, and tests.

---

## Part 3 — Game Systems

### Car

A simple car model built from box primitives:
- Red body (lower chassis + glass cabin)
- Four wheels that spin proportional to speed
- Headlights (front, emissive yellow) and tail lights (back, emissive red)

**Physics**:
- Acceleration, braking, friction
- Speed-dependent steering (prevents spinning in place at low speed)
- Gravity with vertical velocity. Grounded when `car.y <= sampleHeightmap(x, z) + wheelOffset`
- Terrain slope: pitch from front/back height, roll from left/right
- Building collision: AABB pushes car out and kills speed
- Bridge surfaces: when on a bridge, ground level = bridge deck height (overrides heightmap)
- Water: entering river channel applies drag (or blocks entry)
- Max speed ~60 forward, ~15 reverse

**Controls**:
- W / Up: Accelerate
- S / Down: Brake / Reverse
- A / Left: Steer left
- D / Right: Steer right
- Space: Handbrake
- C: Cycle camera

### Camera

Three modes:
1. **Chase cam** (default): smooth follow, ~12 back, ~5 up. Must not go below terrain.
2. **Top-down**: directly above, looking down.
3. **Hood cam**: first-person from hood, looking forward.

### Minimap

200×200 pixel canvas overlay (bottom-right):
- Elevation-tinted background
- Roads as dark lines (wider for arterials)
- River as blue line
- Coast as blue area
- Buildings as bright dots (brighter = taller)
- Parks as green patches
- Car as red directional arrow

Static base layer drawn once per generation. Car arrow redrawn per frame. Game modes can overlay (markers, paths).

### UI

- **Regenerate City** button (top-left)
- **Speedometer** (bottom-left, MPH)
- **Controls help** (top-right)
- **Loading indicator** during generation

### Regeneration

New random seed on each regenerate. Old city cleaned up (geometries disposed). Cancellation if re-triggered mid-generation.

### Game Modes

Pluggable modes layer behavior onto the core driving simulation:

- `game.modes` — array of active mode instances
- Modes extend `GameMode` base class with hooks: `cleanup(game)`, `cityGenerated(game)`, `update(dt, game)`, `drawMinimap(ctx, game)`
- Self-contained: modes own their 3D objects, HUD, and state
- Multiple modes active simultaneously

**Treasure Hunt** (existing mode): target on road network, gold 3D marker, minimap overlay, timer scoring with streak bonuses.

---

## Part 4 — Performance

### Progressive/Async Generation

City generation must not freeze the browser. Terrain + heightmap can be synchronous. All subsequent phases (roads, buildings, parks, trees) are built across multiple frames using async/await with `requestAnimationFrame` yields.

The player can see terrain and drive while the city builds around them.

### Material and Geometry Reuse

Shared materials and geometries created once at startup. Reused across all instances. Never create a new material per building.

### Terrain Resolution

256 segments for ~1200-unit terrain gives ~4.7 units per cell. Sufficient with the shared heightmap approach. Higher resolution possible but profile first.

---

## Part 5 — Algorithms

### Perlin Noise

Standard 2D Perlin noise:
- Seeded permutation table for determinism
- `fade(t) = 6t^5 - 15t^4 + 10t^3`
- fBm: sum octaves at doubling frequency, halving amplitude

### Bilinear Heightmap Interpolation

Given world (x, z):
1. Convert to grid indices
2. Clamp to bounds
3. Sample 4 neighbors
4. `lerp(lerp(h00, h10, fx), lerp(h01, h11, fx), fz)`

Matches GPU's PlaneGeometry linear interpolation.

### A* Terrain Pathfinding (Pass 2)

Cost function for organic road routing:
- Base movement cost (distance)
- Slope penalty: `abs(heightDiff) * slopeFactor`
- Water crossing penalty (rivers need bridges)
- Edge-of-map penalty (keep roads within city)

Runs on heightmap grid (~66K nodes). Standard priority queue A*. Fast enough for 4-8 routes.

### Distance to River Centerline

Point-to-polyline distance: project point onto each segment, take minimum. Optimize with spatial binary search (river is monotonic along primary axis) and early termination.

---

## Part 6 — Test Suite

Tests run in Node.js with Vitest. All use a fixed seed for determinism.

### Terrain Tests
1. **Mesh vertex accuracy**: every terrain vertex matches `sampleHeightmap()` within 1e-4 (accounting for PlaneGeometry Y→-Z negation)
2. **Heightmap consistency**: same coordinates always return same value
3. **River carving**: centerline points lower than banks, river flows downhill

### Road Tests
4. **Road-terrain contact**: vertex Y - ROAD_LIFT ≈ sampleHeightmap(x, z) within 0.01
5. **Face normals point up**: all road mesh normals have `normal.y > 0`

### Building Tests
6. **Grounding**: base Y = max of heightmap at center + 4 corners. Slope < BUILDING_EXTRA_DEPTH
7. **No overlaps**: XZ footprints with 1-unit margin don't intersect
8. **Within blocks**: building centers fall within block boundaries, not on roads
9. **Doors**: every built mesh contains door geometry near ground level

### City Tests
10. **Land use validity**: every block has a valid land use type
11. **Variety**: city contains at least 3 different land use types
12. **Compatibility contract**: all buildings have `x, z, w, d` as positive numbers
13. **No buildings in water**: no building footprint overlaps river channel or submerged coast

### Park Tests
14. **Trees on ground**: trunk base Y ≈ sampleHeightmap(x, z)
15. **Benches on ground**: bench Y ≈ sampleHeightmap(x, z) + offset

### Test Architecture

Game code split into importable ES modules. Tests import pure logic directly — no browser or WebGL context needed.

---

## Part 7 — Project Structure

```
index.html
src/
  noise.js              — PerlinNoise class
  heightmap.js          — Constants, generateHeightmap(), sampleHeightmap()
  river.js              — River path generation, heightmap carving, water mesh
  coast.js              — Coastline generation, water mesh
  pathfinding.js        — A* terrain pathfinding for organic roads
  city.js               — Generation pipeline orchestrator (passes 2-5)
  builders.js           — Mesh construction (roads, buildings, parks, terrain)
  buildingTemplates.js  — Building style templates and shared primitives
  materials.js          — Shared materials, palettes, and geometries
  car.js                — Car mesh
  game.js               — Game class (scene, renderer, loop, UI, camera)
  modes/
    GameMode.js         — Base class
    TreasureHunt.js     — Treasure hunt mode
    targetPicker.js     — Road location picker
package.json
test/
  *.test.js
```

---

## Technology

- **Three.js** (r160+) via CDN import map or npm
- **No build step** for browser (ES modules served directly)
- **Node.js + Vitest** for tests
- Modern Chrome, Firefox, Safari

---

## Design Documents

- **TERRAIN_GENERATION.md** — detailed specification of the five-pass generation pipeline, terrain parameters, river/coast mechanics, plot subdivision, and building style system
- **MAP_FEATURES.md** — additional map features (sidewalks, street trees, roundabouts, parking lots, street furniture, day/night cycle, weather)
- **CITY_GENERATION.md** — original district-based building template system (superseded by Pass 5 in TERRAIN_GENERATION.md but useful as reference for existing template code)
