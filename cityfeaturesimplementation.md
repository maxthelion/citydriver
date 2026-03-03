# Plan: Implement All MAP_FEATURES.md Features

## Context

The user wants to implement ALL features described in MAP_FEATURES.md: river, bridges, arterial roads, sidewalks, non-grid roads, street trees, and the additional features (roundabouts, parking lots, street furniture, day/night cycle, water features). Also update SPEC.md to reference MAP_FEATURES.md.

Pedestrians and traffic AI are marked "(Future)" in the spec and won't be implemented — they require gameplay systems beyond geometry generation.

---

## Implementation Order (dependency-driven)

1. **Materials** — new shared materials/geometries for all features
2. **River** — heightmap carving must happen before terrain mesh; affects block classification
3. **Arterial roads** — flag grid roads, wider geometry, medians, lane markings
4. **Sidewalks** — raised strips alongside all roads
5. **Bridges** — elevated road sections over river
6. **Non-grid roads** — diagonal avenues, ring road, cul-de-sacs
7. **Street trees** — placed on sidewalks, district-specific
8. **Roundabouts** — replace select intersections
9. **Parking lots** — flat areas in industrial/shopping blocks
10. **Street furniture** — district-specific sidewalk objects
11. **Water features** — fountains in parks
12. **Day/night cycle** — lighting changes in render loop
13. **Tests + SPEC.md update**

---

## Files Modified/Created

| File | Changes |
|---|---|
| `src/materials.js` | Add ~12 new materials + shared geometries |
| `src/river.js` | **NEW** — river path generation, heightmap carving, water mesh, bridge mesh |
| `src/city.js` | Arterial flags, river-aware block classification, river-aware overlap check, diagonal avenues, ring road, cul-de-sacs, street tree placement, roundabout selection, parking lot blocks |
| `src/builders.js` | Sidewalks in `buildRoadChunk`, arterial support, `buildBezierRoad`, `buildStreetTree`, `buildRoundabout`, `buildParkingLot`, `buildStreetFurniture`, `buildFountain` |
| `src/game.js` | River pipeline in `regenerateCity()`, bridge/water/tree/roundabout/parking build phases, bridge-aware car physics, day/night cycle in render loop, minimap updates for river/curved roads |
| `src/heightmap.js` | Export `getHeightmapData()` if not already (for river carving) |
| `SPEC.md` | Reference MAP_FEATURES.md, add summary of implemented features |
| `test/river.test.js` | **NEW** — river path, heightmap carving, bridge detection, water mesh tests |
| `test/features.test.js` | **NEW** — arterial roads, sidewalks, street trees, roundabouts tests |

---

## Step 1: Materials (`src/materials.js`)

New materials in `initMaterials()`:
- `materials.arterialRoad` — `0x2a2a2a`, roughness 0.9, polygonOffset (darker than standard `0x333333`)
- `materials.sidewalk` — `0x999999`, roughness 0.85, polygonOffset -2
- `materials.median` — `0x556B2F`, roughness 0.95 (grass median)
- `materials.laneLine` — LineBasicMaterial `0xffffff` (white lane markings)
- `materials.water` — `0x2277AA`, transparent, opacity 0.85, roughness 0.2, metalness 0.3, DoubleSide
- `materials.bridgePillar` — `0x888888`, roughness 0.9
- `materials.bridgeRailing` — `0x666666`, roughness 0.8
- `materials.ringRoad` — `0x2a2a2a`, roughness 0.9, polygonOffset (same as arterial)
- `materials.parkingLine` — LineBasicMaterial `0xffffff`
- `materials.parkingLot` — `0x444444`, roughness 0.9, polygonOffset
- `materials.fountain` — `0x888888`, roughness 0.4, metalness 0.5

New shared geometries in `initGeometries()`:
- `sharedGeo.mailbox` — BoxGeometry(0.4, 1.0, 0.3)
- `sharedGeo.dumpster` — BoxGeometry(1.5, 1.2, 1.0)
- `sharedGeo.cafeTable` — CylinderGeometry(0.5, 0.5, 0.8, 6)
- `sharedGeo.flowerPot` — CylinderGeometry(0.3, 0.4, 0.5, 6)

---

## Step 2: River (`src/river.js` — NEW FILE)

### River path generation

`generateRiverPath(perlin)`:
- Choose axis (NS or EW) based on `perlin.noise(0.5, 0.5)`
- Sample Perlin noise along primary axis at 4-unit intervals to create lateral displacement
- Entry point: random within `[-halfCity*0.6, halfCity*0.6]`
- Width: 24 units (base) ± 4 (noise variation)
- Returns `{ points: [{x,z}...], width, axis, roadCrossings: [], blockIntersections: [] }`

### Heightmap carving

`carveRiverIntoHeightmap(riverPath)`:
- Iterate all heightmap cells
- For each, compute distance to river centerline polyline
- Inside river (dist < halfWidth): depress 4 units with smooth center-to-edge falloff
- Bank zone (dist < halfWidth + 15): smoothstep taper to zero
- Uses `getHeightmapData()` to modify the Float32Array in-place
- Called AFTER `generateHeightmap()`, BEFORE `createTerrain()`

### Helper: `distanceToRiverCenterline(x, z, riverPath)`
- Point-to-polyline distance (project onto each segment, take minimum)
- Used by carving, block detection, building overlap, car physics

### River-road crossings

`computeRiverRoadCrossings(riverPath, roads)`:
- For each road, check if its axis-aligned line crosses any river segment
- Record crossing point, compute bridge deck Y after heightmap is carved

### River-block intersections

`computeRiverBlockIntersections(riverPath)`:
- For each grid block, check if river centerline comes within `halfWidth + BLOCK_SIZE/2`
- Affected blocks become waterfront (fewer buildings, or parks)

### Water surface mesh

`buildWaterSurface(riverPath)`:
- Subdivided mesh following river curve, 4 cross-sections
- Water Y = per-cross-section centerline terrain + 1.0 (flat across width)
- Uses `materials.water`

### Bridge construction

`buildBridge(crossing, riverPath)`:
- Flat deck at `bridgeDeckY` with smoothstep ramps (10 units long) at each end
- Road-width cross-section, uses `materials.road`
- Support pillars (cylinders from riverbed to deck)
- Railings (thin boxes along deck edges, 0.8 units tall)
- Bridge overlays existing terrain-following road (simple approach — no road splitting needed)

---

## Step 3: Arterial Roads

### Data changes in `city.js`

`CityGenerator.generate()`:
- Flag grid indices 5 and 6 per axis as arterial (roads at x/z = -36 and +36, straddling center)
- Add `arterial: true, width: 20` to those road objects
- Standard roads get `arterial: false, width: ROAD_WIDTH`
- Return `arterialIndicesX` and `arterialIndicesZ` Sets in cityData

### Builder changes in `builders.js`

`buildRoadChunk(road)` modifications:
- Read `road.width` (default `ROAD_WIDTH`) for `halfW` and cross-section width
- Use `road.arterial ? 6 : 3` for `crossStrips` (more subdivisions)
- Arterial roads use `materials.arterialRoad`
- Arterial roads: add central median (grass strip, 1.5 units wide, 0.3 units above road)
- Arterial roads: add white lane markings at ±width/4
- Standard roads: keep existing yellow center line

`buildIntersection(ix, iz, widthX, widthZ)`:
- Accept variable widths based on whether the crossing roads are arterial
- Intersection patch size adapts: `hw = max(widthX, widthZ) / 2 + 1`

### No CELL_SIZE change needed
The extra 4 units per side (20 vs 12) extends into the block margin zone where buildings already don't place.

---

## Step 4: Sidewalks

Added inside `buildRoadChunk(road)`:
- Two strips per road, one on each side
- Width: 2 units, placed from road edge outward
- Height: `ROAD_LIFT + 0.15` (curb step above road surface)
- Uses `materials.sidewalk`
- Same terrain-following vertex sampling as roads

In `buildIntersection()`:
- Add 4 corner sidewalk patches where sidewalk strips meet at intersections
- Inner edge at road level (curb ramp), outer edge at sidewalk height

---

## Step 5: Bridges (over river)

Built in `src/river.js` (see Step 2 above).

Car physics bridge support in `game.js` `updateCar()`:
- After sampling heightmap ground, check if car position is within any bridge footprint
- If on bridge: `groundY = max(groundY, bridgeSurfaceY)` where bridge surface interpolates between ramp and flat deck
- Store `this.riverPath` on game instance for access

---

## Step 6: Non-Grid Roads

### Bezier math helpers (in `src/builders.js`)

`bezierPoint(p0, p1, p2, p3, t)` — cubic Bezier evaluation
`bezierTangent(p0, p1, p2, p3, t)` — derivative for perpendicular direction

### `buildBezierRoad(road)` (in `src/builders.js`)

- Sample curve at 60 steps
- At each step: compute center point, perpendicular direction, place cross-section vertices
- Terrain-following like grid roads
- Center line along curve
- Returns THREE.Group

### Diagonal avenues (in `src/city.js`)

`generateDiagonalAvenues()`:
- 1-2 diagonal roads connecting near-center intersections to outer intersections
- Cubic Bezier with control points creating gentle curves
- Width 14 units
- Added to `cityData.curvedRoads` array

### Ring road (in `src/city.js`)

`generateRingRoad()`:
- Collect outermost grid intersections around perimeter
- Connect consecutive intersections with Bezier segments (curved at corners)
- Width 15 units
- Added to `cityData.curvedRoads` array

### Cul-de-sacs (in `src/city.js`)

`generateCulDeSacs(blocks)`:
- 30% of suburban blocks get a cul-de-sac
- Short road stub (20-30 units) from block edge into interior
- Circular turnaround at end (radius 8-10)
- Added to `cityData.curvedRoads` array

### Minimap
- Draw curved roads as polylines (sample Bezier at intervals)
- Draw river as thick blue line

---

## Step 7: Street Trees

### Placement (in `src/city.js`)

`generateStreetTrees(roads, blocks, buildings)`:
- Every 17 units along road segments
- Skip within 8 units of intersections
- Place on both sides, on sidewalk (offset 1 unit from road edge)
- Skip if overlaps a building
- No trees in industrial districts
- Returns `[{x, z, district}...]`

### Construction (in `src/builders.js`)

`buildStreetTree(tree)`:
- Size varies by district: downtown/shopping = small (3-4 units), residential = medium (5-7), suburban = large (6-9)
- Reuses `materials.trunk`, `materials.leaf1/leaf2`
- Trunk cylinder + canopy sphere, grounded on heightmap

---

## Step 8: Roundabouts

### Selection (in `src/city.js`)

- 2-3 intersections become roundabouts (where arterials cross, or at key positions)
- Store in `cityData.roundabouts` array: `[{x, z, radius}...]`

### Construction (in `src/builders.js`)

`buildRoundabout(roundabout)`:
- Central green circle (grass, radius ~5)
- Annular road ring around it (4 units wide)
- Terrain-following, built as triangle fan + annular strip
- Replaces the normal intersection patch at that position

---

## Step 9: Parking Lots

### Selection (in `src/city.js`)

- ~15% of industrial/shopping blocks become parking lots instead of buildings
- Store in `cityData.parkingLots` array: `[{x, z, size}...]`

### Construction (in `src/builders.js`)

`buildParkingLot(lot)`:
- Flat terrain-following ground plane (uses `materials.parkingLot`)
- White line markings for parking spaces (LineSegments grid)
- 2-4 simple "parked car" box meshes in random spots

---

## Step 10: Street Furniture

### Placement (in `src/city.js`)

Alongside street trees, every ~30 units:
- Downtown: bus stops (tall thin box), newspaper stands
- Shopping: cafe tables (cylinder), flower pots
- Suburban: mailboxes, garden fences (thin boxes)
- Industrial: dumpsters, pallets

### Construction (in `src/builders.js`)

`buildStreetFurniture(item)`:
- Simple box/cylinder meshes from shared geometries
- Placed on sidewalk, grounded on heightmap

---

## Step 11: Water Features (Fountains)

### Placement
- 30% of parks get a fountain at center

### Construction (in `src/builders.js`)

`buildFountain(x, z)`:
- Circular basin (short cylinder, `materials.fountain`)
- Central water jet (thin cylinder, `materials.water`)
- Small water surface disk in basin

---

## Step 12: Day/Night Cycle

### In `src/game.js`

New state: `this.timeOfDay = 0.3` (starting at morning)

`updateDayNight(dt)`:
- `timeOfDay` advances slowly: `+= dt * 0.005` (wraps at 1.0)
- Compute sun angle: `sunAngle = timeOfDay * Math.PI * 2`
- Adjust directional light position (arc across sky)
- Adjust ambient light intensity: bright at noon (0.5), dim at midnight (0.05-0.1)
- Adjust fog color: blue during day, dark blue at night, orange at sunset/sunrise
- Adjust sky color (renderer.setClearColor or scene background)
- Window emissive intensity: low during day, high at night
- Streetlight emission: off during day, bright at night

Transition bands:
- Dawn: timeOfDay 0.2-0.3
- Day: 0.3-0.7
- Dusk: 0.7-0.8
- Night: 0.8-0.2

---

## Step 13: Tests + SPEC.md

### `test/river.test.js`
1. River path stays within city bounds
2. River crosses from one edge to opposite
3. River points are smoothly spaced
4. Heightmap is depressed along river centerline
5. Bank zones have intermediate elevation
6. Terrain far from river is unchanged
7. Road-river crossings detected correctly
8. No building overlaps the river channel
9. Water mesh vertices above riverbed

### `test/features.test.js`
1. Arterial roads exist (at least 2 per axis) with width > ROAD_WIDTH
2. All roads have arterial/width properties
3. Street trees exist and are not in industrial districts
4. Street trees are not within 8 units of any intersection
5. Roundabouts exist at valid intersection positions

### SPEC.md update
- Add "Map Features" section referencing MAP_FEATURES.md
- Brief summary: "The city includes arterial roads, sidewalks, a river with bridges, diagonal/ring/cul-de-sac roads, street trees, roundabouts, parking lots, street furniture, fountains, and a day/night cycle. See MAP_FEATURES.md for the full specification."

---

## `regenerateCity()` Updated Phase Sequence

```
Phase 1a: Generate river path (pure math, uses perlin)
Phase 1b: Generate heightmap (analytical noise)
Phase 1c: Carve river into heightmap
Phase 1d: Create terrain mesh
Phase 2:  City data (river-aware blocks, arterial flags, curved roads, trees, roundabouts, parking)
Phase 2b: Compute river-road crossings + bridge deck elevations
Phase 3:  Grid roads (with arterial/sidewalk support) — batched
Phase 4:  Non-grid roads (Bezier roads) — batched
Phase 5:  Intersections + roundabouts
Phase 6:  Bridges over river
Phase 7:  Buildings — batched
Phase 8:  Parks + fountains — batched
Phase 9:  Parking lots — batched
Phase 10: Streetlights
Phase 11: Street trees + furniture — batched
Phase 12: Water surface mesh
Phase 13: Minimap (extended for river, curved roads, arterials)
Phase 14: Notify game modes
```

Store `this.riverPath` on game instance for car physics and minimap.

---

## Verification

1. `npm test` — all existing 30 tests pass + new river/features tests
2. Visual: river winding through city with water surface
3. Visual: bridges where roads cross river, car can drive over them
4. Visual: wider arterial roads near center with medians and lane markings
5. Visual: raised sidewalks along all roads
6. Visual: diagonal avenue and ring road visible on minimap
7. Visual: street trees lining roads (smaller downtown, larger suburban, none industrial)
8. Visual: roundabouts at select intersections
9. Visual: parking lots in industrial/shopping areas
10. Visual: day/night cycle changes lighting over time
11. Car drives over bridges correctly (doesn't fall through)
12. Buildings don't overlap the river
13. Minimap shows river, curved roads, arterials
