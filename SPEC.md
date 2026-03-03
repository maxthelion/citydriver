# Open World Driving Game — Specification

## Overview

A browser-based 3D open-world driving game. The player drives a car through a procedurally generated city built on hilly terrain. The city contains roads on a grid, buildings of varying heights, parks with trees, and streetlights. A minimap shows the city layout and player position. The city can be regenerated at the press of a button.

The game runs entirely client-side in a modern browser using Three.js (or equivalent WebGL library). No server or build step is required beyond a static file server for ES module imports.

---

## Core Requirements

### 1. Terrain

A continuous hilly landscape covering at least 800x800 world units, with surrounding terrain extending ~200 units beyond the city boundary.

**Elevation**: Generated using fractal Brownian motion (fBm) over Perlin noise with multiple octaves:
- Large rolling hills (low frequency, high amplitude ~40 units)
- Medium terrain detail (medium frequency, ~12 units amplitude)
- Small ground variation (high frequency, ~3 units amplitude)

Total height variation should be roughly 30-55 units to create visually interesting hills without being impassable by car.

**Critical constraint — the heightmap consistency problem**: The terrain mesh displayed by the GPU and the height values used to place objects (roads, buildings, car) **must agree exactly**. If the mesh is built from a `PlaneGeometry` with N segments, the GPU linearly interpolates between vertices. Any object placement function must reproduce this same linear interpolation, not query the raw analytical noise function. The recommended approach is:

1. Generate a discrete heightmap array (`Float32Array`) by sampling the analytical noise at each grid vertex
2. Build the terrain mesh directly from this array
3. Provide a `sampleHeightmap(x, z)` function that does bilinear interpolation of the same array
4. **All object placement and car physics use `sampleHeightmap()`**, never the raw noise function

This eliminates the class of bugs where objects float above or clip through the visible terrain surface.

**Critical constraint — the PlaneGeometry coordinate system**: A Three.js `PlaneGeometry` is created in local XY space (Z=0), then rotated `-PI/2` around X to lay flat as terrain. After this rotation:
- local X → world X
- local Y → world **-Z** (negated!)
- local Z → world Y (height)

When writing heightmap values into the geometry's Z attribute, the sampling coordinates must account for this negation. If the geometry vertex has local coordinates `(localX, localY)`, the correct heightmap query is `sampleHeightmap(localX, -localY)`, **not** `sampleHeightmap(localX, localY)`. Omitting the negation causes the terrain surface to show heights for `(x, -z)` while all objects are placed at heights for `(x, z)`, producing large mismatches (up to tens of units) that grow with distance from Z=0.

### 2. City Layout

The city uses a grid-based layout:

- **Grid cell**: A city block (~60 units) plus a road (~12 units wide), totalling ~72 units per cell
- **Grid size**: Enough cells to fill the city area (approximately 11x11)
- **Road network**: Axis-aligned roads running the full city extent in both directions, forming a regular grid
- **Block contents**: Each block is either a building block or a park, determined by noise-based selection (~25-35% parks)

### 3. Roads

Roads follow the terrain surface. Each road is a triangle-strip mesh with vertices sampled every few units along its length, conforming to the heightmap. Roads sit slightly above the terrain (a small lift of ~0.15 units) to reduce z-fighting. Additionally, the road material should use `polygonOffset` (factor and units of -1) to bias depth testing in favor of roads over terrain. Without this, the terrain will bleed through the road surface, especially on slopes where the road mesh resolution doesn't exactly match the terrain mesh resolution. Road segments should be no longer than the terrain cell size (~4-5 units) so the road closely conforms to the terrain between vertices.

Intersections (where roads cross) need small terrain-conforming patches to fill the square gap.

A center line (yellow) runs along each road.

**Critical constraint — triangle winding order**: Road meshes are constructed with two vertices per cross-section (left edge and right edge), connected into triangles. The triangle winding must produce **upward-facing normals** so the road surface is visible from above. When constructing a triangle strip from left/right vertex pairs, the cross product of the along-road edge and the across-road edge must yield a positive Y component. If roads run in different axis directions (some along X, some along Z), the left/right vertex assignment must be consistent so that all road triangles face upward. A common bug is that roads running in one direction render correctly while roads in the perpendicular direction are back-face culled (invisible). Verify with a test that all road mesh vertex normals have `normal.y > 0`.

### 4. Buildings

Buildings are box-shaped with these properties:
- **Height distribution**: Taller near city center, shorter at edges (simulating a downtown core)
- **Density**: More buildings per block near center, fewer at edges
- **Types**: Residential (brown tones, short), commercial (blue-gray, medium), skyscraper (dark, tall)
- **Windows**: Taller buildings have rows of emissive window panels on their facades
- **Rooftop details**: Skyscrapers get antennas and AC units
- **Grounding**: Each building samples the heightmap at its center and four corners, takes the minimum, and places its base there. An extra ~2 units of depth is added below ground level so the building is buried into slopes rather than floating.
- **No overlaps**: Buildings must not overlap each other. Use collision detection during placement.

### 5. Parks

Parks fill city blocks that aren't assigned buildings:
- A green ground patch conforming to the terrain (subdivided mesh, not a flat plane)
- 5-12 trees with cylindrical trunks and spherical canopies, placed on the terrain surface
- 1-3 benches

### 6. Streetlights

Placed at every other intersection along the road grid. Each has a pole and a glowing light sphere at the top, positioned on the terrain surface.

**Placement**: Streetlights must be offset from the intersection center in **both X and Z** (e.g. `ROAD_WIDTH/2 + 1` in each direction) so they sit on the pavement corner, not in the middle of the road. A common bug is offsetting in only one axis, which places the light on the centerline of one of the two crossing roads.

### 7. Car

A simple car model built from box primitives:
- Red body (lower chassis + glass cabin)
- Four wheels that visually spin proportional to speed
- Headlights (front, emissive yellow) and tail lights (back, emissive red)

**Physics**:
- Acceleration (forward/reverse), braking, and friction
- Speed-dependent steering (slower turning at low speed, prevents spinning in place)
- **Gravity**: The car has vertical velocity. Gravity pulls it down each frame. When `car.y <= sampleHeightmap(car.x, car.z) + wheelOffset`, the car is grounded and vertical velocity resets to zero.
- **Terrain slope**: When grounded, the car tilts to match the terrain slope (pitch from front/back height difference, roll from left/right)
- **Building collision**: AABB collision pushes the car out of building footprints and kills speed
- Max speed ~60 units/s forward, ~15 reverse

**Controls**:
- W / Up Arrow: Accelerate
- S / Down Arrow: Brake / Reverse
- A / Left Arrow: Steer left
- D / Right Arrow: Steer right
- Space: Handbrake
- C: Cycle camera mode

### 8. Camera

Three modes:
1. **Chase cam** (default): Follows behind the car with smooth interpolation, offset ~12 units back and ~5 units up. Camera must not go below terrain.
2. **Top-down**: Directly above the car looking down.
3. **Hood cam**: First-person from the car's hood, looking forward.

### 9. Minimap

A 200x200 pixel canvas overlay in the bottom-right corner showing:
- Elevation-tinted background (greener = higher)
- Roads as dark lines
- Buildings as bright dots/rectangles (brighter = taller)
- Parks as green patches
- Car position as a red directional arrow

The minimap is drawn once when the city generates (static base layer) then the car arrow is redrawn each frame on top.

### 10. UI

- **Regenerate City** button (top-left): Generates a completely new random city
- **Speedometer** (bottom-left): Shows current speed in MPH
- **Controls help** (top-right): Lists keyboard controls
- **Loading indicator**: Shows during initial generation

### 11. Regeneration

Clicking "Regenerate City" creates an entirely new city with a new random seed. The old city is cleaned up (geometries disposed) and replaced. If a regeneration is triggered while one is in progress, the old one is cancelled.

---

## Performance Requirements

### Progressive/Async Generation

City generation must not freeze the browser. The terrain mesh can be created synchronously (it's a single geometry), but roads, buildings, parks, and streetlights should be built across multiple frames using async/await with `requestAnimationFrame` yields. The player should be able to see the terrain and drive on it while the city builds around them.

Suggested approach:
1. Frame 1: Generate heightmap + terrain mesh, place car
2. Frames 2-N: Build roads in batches of 4-8
3. Frames N+1-M: Build buildings in batches of 4-8
4. Frames M+1-end: Parks, streetlights, minimap

### Material and Geometry Reuse

Create shared materials (road, grass, window, building colors, etc.) and shared geometries (streetlight poles, window panes, benches, etc.) once at startup. Reuse them across all instances via `new THREE.Mesh(sharedGeometry, sharedMaterial)`. Do not create a new material per building.

### Terrain Resolution

256 segments for a ~1200-unit terrain gives ~4.7 units per cell. This is sufficient when using the shared heightmap approach (no analytical/mesh discrepancy). Going higher (512) is smoother but 4x the vertices — profile before increasing.

---

## Algorithms

### Perlin Noise

Standard 2D Perlin noise with:
- Permutation table seeded from a seed value (for deterministic generation)
- `fade(t) = 6t^5 - 15t^4 + 10t^3` smoothing
- Gradient vectors from hash function
- fBm (fractal Brownian motion): sum multiple octaves at doubling frequency and halving amplitude

### City Block Classification

Use a separate Perlin noise evaluation (different frequency/offset from terrain noise) to decide which blocks become parks vs building blocks. This creates organic clusters of parks rather than random scattering.

### Building Placement

Within each building block:
1. Determine count from density (higher near center)
2. For each building, pick random width/depth (6-20 units), height (5 to maxHeight based on distance from center)
3. Pick random position within the block (with margin from edges)
4. Check overlap against all previously placed buildings; skip if overlapping
5. Use seeded random for determinism

### Bilinear Heightmap Interpolation

Given world coordinates (x, z):
1. Convert to grid indices: `gx = (x + halfSize) / cellSize`, `gz = (z + halfSize) / cellSize`
2. Clamp to valid range
3. Get integer indices and fractional parts
4. Sample 4 surrounding heightmap values
5. Bilinear interpolate: `lerp(lerp(h00, h10, fx), lerp(h01, h11, fx), fz)`

This matches the GPU's linear interpolation of `PlaneGeometry` vertices.

---

## Test Suite

The world generation should have an automated test suite that verifies coherence. Tests run in Node.js using the `three` npm package (which works without WebGL for geometry/math operations) and a test runner like Vitest.

All tests use a **fixed seed** for deterministic results.

### Required Tests

**1. Terrain mesh vertex accuracy**
- Create a terrain mesh and heightmap with fixed seed
- For every mesh vertex, **transform local coordinates to world space** (accounting for the PlaneGeometry rotation: worldX = localX, worldZ = -localY, worldY = localZ)
- Assert `worldY` matches `sampleHeightmap(worldX, worldZ)` within 1e-4
- Catches: coordinate system bugs (especially the local-Y to world-Z negation), heightmap indexing errors

**2. Road-terrain contact**
- Build all road chunks
- For every road mesh vertex, verify: `vertexY - ROAD_LIFT ≈ sampleHeightmap(vertexX, vertexZ)` within 0.01
- Catches: roads floating or clipping through terrain

**3. Road face normals point upward**
- Build all road chunks, compute vertex normals
- For every vertex normal on road meshes, assert `normal.y > 0`
- Catches: triangle winding bugs where roads in one direction are back-face culled (invisible from above)

**4. Building grounding**
- For every building, verify its base Y position is at or below `sampleHeightmap()` at all 4 footprint corners
- No building base corner should be more than `EXTRA_DEPTH + 0.5` above terrain
- Catches: floating buildings

**5. Park objects on ground**
- Every tree trunk base Y ≈ `sampleHeightmap(x, z)` within 0.5
- Every bench Y ≈ `sampleHeightmap(x, z) + benchOffset` within 0.5
- Catches: floating/buried park objects

**6. Car ground check**
- Sample 100 random positions across the city
- Verify `sampleHeightmap(x, z)` returns consistent values (same call twice = same result)
- Verify the value is within the terrain mesh's bounds
- Catches: car physics using a different height source than the terrain

**7. No building overlaps**
- For every pair of buildings, assert their XZ footprints (with 1-unit margin) do not overlap
- Catches: placement algorithm bugs

**8. Buildings within blocks (not on roads)**
- For each building, verify its footprint center falls within a block boundary, not on a road corridor
- Catches: buildings placed in the middle of roads

### Test Architecture

The game code must be split into importable ES modules so tests can import the pure logic:
- Noise generation (pure math, no DOM/WebGL dependency)
- Heightmap generation and sampling (pure math + Float32Array)
- City data generation (pure math)
- Mesh builders (depend on Three.js geometry, but not on WebGL renderer)

Tests import these modules directly. No browser or WebGL context is needed.

---

## Project Structure (Suggested)

```
index.html          — HTML shell with CSS, imports game entry point
src/
  noise.js          — PerlinNoise class
  heightmap.js      — Constants, generateHeightmap(), sampleHeightmap()
  city.js           — CityGenerator class (pure data, no meshes)
  builders.js       — Mesh construction functions (roads, buildings, parks, terrain)
  materials.js      — Shared materials and geometries
  car.js            — Car mesh and optionally car physics
  game.js           — Game class (scene, renderer, game loop, UI, camera)
package.json        — type: "module", devDeps: three, vitest
test/
  *.test.js         — Test files
```

Implementors should feel free to use whatever module structure, class hierarchy, or abstractions best suit their approach. The key invariants are the heightmap consistency, the test coverage, and the visual/gameplay requirements above.

---

## Visual Reference

The game should feel like a simplified, low-poly GTA. The player drives through a hilly city with a downtown core of tall buildings that gives way to shorter buildings and parks at the edges. Roads follow the terrain. The minimap gives a sense of the city layout. The atmosphere is bright daylight with a blue sky and distance fog.

---

## Technology

- **Three.js** (r160+) loaded via CDN import map, or installed via npm
- **No build step** required for the browser app (ES modules served directly)
- **Node.js + Vitest** for the test suite
- Must work in modern Chrome, Firefox, and Safari
