# City Generation Pipeline — Specification

## Philosophy

The generation order mirrors history. Real cities grow in a sequence driven by geography, and the generator should too:

1. **Terrain and water** — rivers, hills, and coastlines drive everything
2. **Primary routes** — paths of least resistance between important points
3. **Secondary network and blocks** — fill between primary roads, subdivide into blocks
4. **Plot subdivision** — divide blocks into building lots based on frontage and land use
5. **Building generation** — fill plots with structures appropriate to their zone and style

Each pass reads the output of previous passes and adds structure. Nothing is arbitrary — every decision has a cause rooted in terrain, access, or history.

---

## City Archetypes

The combination of water features fundamentally shapes the city's character:

| Archetype | River | Coast | Real-world feel |
|---|---|---|---|
| **River + Coast** | Yes | Yes | London, New York, Hamburg — estuary city, docks, dense waterfront. The city forms at the first good crossing point or river mouth. |
| **River only** | Yes | No | Paris, Prague, Florence — inland city bisected by a river, bridges as landmarks. Settlement starts at the lowest bridging point. |
| **Coast only** | No | Yes | Barcelona, Marseille — fishing port that grew, harbor as focal point. |
| **Inland** | No | No | Madrid, Munich — city on a plain or plateau, no major water features. |

The archetype is either chosen explicitly or picked randomly (weighted toward river-only and river+coast as more interesting). It determines which water features exist, which in turn determines where the city center forms and how the road network develops.

---

## Parameter Set

```
{
  seed:               number,     // reproducibility
  archetype:          string,     // 'river_coast' | 'river' | 'coast' | 'inland' (or random)

  // Base terrain
  hilliness:          [0, 1],     // elevation range — 0 = flat fenland, 1 = San Francisco
  roughness:          [0, 1],     // frequency — 0 = broad gentle hills, 1 = rugged craggy terrain

  // River (ignored if archetype has no river)
  riverMeandering:    [0, 1],     // 0 = mostly straight canal, 1 = heavily winding
  floodplainWidth:    [0, 1],     // 0 = narrow gorge (Bristol, Durham), 1 = wide floodplain
  tributaries:        [0, 3],     // number of tributary streams

  // Coast (ignored if archetype has no coast)
  coastEdge:          string,     // 'north' | 'south' | 'east' | 'west' (or random)
  coastIndentation:   [0, 1],     // 0 = straight coastline, 1 = deep bays and headlands
  harborGuarantee:    boolean,    // ensure at least one concave harbor-like indentation

  // City character (affects passes 2-5)
  organicness:        [0, 1],     // 0 = rigid planned grid, 1 = fully organic medieval
}
```

---

## Pass 1 — Heightmap and Water

### 1.1 Base Landform

Generated from layered Perlin noise (fBm). Two independent controls:

**Hilliness** controls amplitude:
```
baseAmplitude = lerp(5, 60, hilliness)
octave1: fbm(x * freq1) * baseAmplitude * 0.7    // large rolling hills
octave2: fbm(x * freq2) * baseAmplitude * 0.2    // medium detail
octave3: fbm(x * freq3) * baseAmplitude * 0.1    // fine variation
```

**Roughness** controls frequency:
```
freqMultiplier = lerp(0.6, 1.8, roughness)
freq1 = 0.0015 * freqMultiplier
freq2 = 0.005  * freqMultiplier
freq3 = 0.02   * freqMultiplier
```

| hilliness | roughness | Feel |
|---|---|---|
| 0.1 | 0.2 | Flat coastal plain (Netherlands) |
| 0.3 | 0.3 | Gentle rolling countryside (English Midlands) |
| 0.5 | 0.5 | Moderate hills (default) |
| 0.8 | 0.4 | High plateau with broad hills (Madrid) |
| 0.7 | 0.9 | Rugged hilly city (San Francisco, Edinburgh) |
| 0.2 | 0.8 | Low but locally bumpy (Amsterdam surroundings) |

### 1.2 River (Subtractive)

Rivers are the single most important feature. Settlements form at river crossings, confluences, river mouths, or the lowest bridging point. The river determines where the old town center is, which bank develops first (usually the flatter one), and where industry clusters (downstream, near docks).

**Path generation:**
1. Pick entry and exit edges (opposite sides, or entry edge + coast for river-to-sea)
2. Generate a spline with randomized control points. The `riverMeandering` parameter controls lateral deviation:
   - 0.1: nearly straight canal
   - 0.5: gentle S-curves (natural European river)
   - 0.9: dramatic oxbow-like bends
3. Sample at ~4-unit intervals to produce a centerline polyline
4. Width: 20-30 units, optionally varying (wider in flat sections, narrower in hilly)

**Valley carving** — modifies the heightmap in-place:

- **River channel** (dist < halfWidth): depress 3-5 units. Smooth center-to-edge falloff so riverbed is relatively flat. Deeper in hilly areas, shallower in flat.
- **Floodplain** (dist < halfWidth + floodplainExtent): `floodplainWidth` controls extent from ~5 units (narrow gorge — Bristol, Durham) to ~40 units (wide delta — Netherlands). Terrain is flattened and lowered with smoothstep blend. Wide floodplain = space for docks, warehouses, dense settlement. Narrow = dramatic gorge, fewer buildings near water.
- **Bank transition** (dist < halfWidth + floodplainExtent + ~10): smoothstep taper to natural terrain.

**Tributaries:**
- 0-3 secondary streams joining the main river
- Narrower (10-15 units), shorter
- Each carves its own smaller valley
- Natural boundaries between neighborhoods

**River-to-coast interaction:** If both exist, the river widens approaching the coast (estuary), and the valley merges with sea level. This creates the most valuable land in the city — the river mouth.

### 1.3 Coastline (Subtractive)

Applied after river carving.

**Sea level:** Set at ~30th-50th percentile of edge elevations along the chosen coast edge. Some land submerged (water), some protrudes (headlands).

**Boundary warping:** 1D noise along the coast edge creates lateral displacement:
```
coastOffset(t) = noise(t * freq) * coastIndentation * maxIndent
```
Produces bays (concave) and headlands (convex). `maxIndent` ~80-120 units.

**Harbor guarantee:** If enabled, scan for sufficiently concave sections. If none, override the noise to create an explicit indentation (bay at least 40 units wide, sheltered on two sides).

**Terrain modification:** Gentle slope toward waterline in the near-shore zone (beach effect). Heightmap left as-is below sea level — water plane covers it.

**Water mesh:** Semi-transparent plane at sea level covering the water area. Blue-green (`0x2277AA`), opacity 0.85, low roughness.

### 1.4 Hydrological Consistency

After all terrain modifications:
- **River valley check:** Every centerline point is lower than its banks
- **Flow direction:** River flows consistently downhill entry→exit. Any uphill points are lowered.
- **Basin detection** (optional): No accidental landlocked depressions. Smooth out or fill with small lakes if found.

### 1.5 Anchor Points

Before moving to Pass 2, identify the **anchor points** that will seed the road network:
- **River crossing point(s):** The narrowest or flattest point(s) along the river — where bridges naturally form. This becomes the city center for river archetypes.
- **Harbor:** The most sheltered coastal indentation. City center for coast-only archetypes.
- **Hilltop(s):** Local elevation maxima within the city area. Historically attract civic/religious buildings, wealthy districts.
- **River mouth:** Where river meets coast. Key anchor for river+coast archetypes.
- **Terrain saddles:** Low points between hills — natural pass routes.

These anchor points drive Pass 2's road network.

---

## Pass 2 — Primary Road Network

Primary roads don't start as grids — they start as paths of least resistance between important points. These become high streets and main arterials. They follow ridgelines, river valleys, and contour lines.

The "organic" feel of European cities comes from roads that respond to terrain and were formalized from footpaths over centuries. The American grid is a specific artifact: land surveyed before settlement, imposed on flat terrain. The `organicness` parameter controls this spectrum.

### 2.1 Route Generation

Connect anchor points with terrain-following paths:

**For organic cities (organicness > 0.5):**
- Use A*-like pathfinding on the heightmap grid that penalizes steep grades
- Cost function: `baseCost + slopePenalty * abs(heightDiff) + waterPenalty`
- Water crossings have high cost (rivers need bridges — expensive historically)
- Paths tend to follow contour lines, ridgelines, and river valleys
- The path from the river crossing to each hilltop becomes a main road
- The path along each riverbank becomes a waterfront road
- Result: an irregular network of 4-8 primary roads radiating from the city center

**For grid cities (organicness < 0.3):**
- Overlay a regular grid on flat areas
- Grid breaks around rivers, hills, and coastlines
- One or two "old roads" (pre-grid) cut diagonally across the grid like Broadway across Manhattan's grid — these are the oldest routes (the river crossing road, the hilltop path)
- Grid orientation aligned to the dominant terrain direction or coast

**For mixed (organicness 0.3-0.7):**
- Grid in flat central areas, organic roads in hilly/waterfront areas
- A few diagonal breaks where old roads predate the grid

### 2.2 Road Hierarchy

Primary roads from this pass are wider (16-20 units) and become the city's arterials. They have:
- Lane markings (2-3 lanes per direction)
- Central median (grass or concrete strip)
- Sidewalks on both sides
- Street trees

### 2.3 River Crossings (Bridges)

Where primary roads cross the river, bridges are placed:
- Flat deck elevated above water level
- Ramps on each approach
- Support pillars from riverbed to deck
- Railings along edges
- The lowest/narrowest crossing point gets the oldest/most important bridge — this is the city's historic center

---

## Pass 3 — Secondary Network and Blocks

Fill between primary roads with secondary streets. The method depends on `organicness` and local terrain.

### 3.1 Block Generation

**Organic subdivision (high organicness):**
- Recursive subdivision of the areas between primary roads
- Each subdivision follows terrain contours — roads prefer to run along contour lines or directly up/down slopes, not diagonally across them
- Some randomness in subdivision angles and spacing
- Produces irregular, organic-feeling blocks of varying sizes
- Reference: Parish and Müller's CityEngine approach — L-system or agent-based road generation

**Grid subdivision (low organicness):**
- Regular grid imposed on flat areas
- Grid cell size ~60-72 units (current CELL_SIZE)
- Grid breaks at rivers, steep slopes, coastline, and pre-grid diagonal roads
- Blocks adjacent to breaks are irregular (truncated by the obstacle)

**Mixed:**
- Grid in flat commercial/industrial areas
- Organic in hilly residential areas and old town center
- Transition zones where grid meets organic have irregularly shaped blocks

### 3.2 Block Properties

Each block records:
- Boundary polygon (not necessarily rectangular for organic layouts)
- Area and aspect ratio
- Adjacent roads (which edges face roads, and which road hierarchy level)
- Terrain character (mean elevation, slope, proximity to water)
- These properties feed into Pass 4's land use assignment

### 3.3 Intersections and Features

- Where primary roads cross: larger intersections, potential roundabouts
- Where secondary roads meet primary: T-junctions or right-angle joins
- Dead ends in suburban areas become cul-de-sacs (circular turnaround)
- The road network forms a connected graph — every block is accessible

---

## Pass 4 — Land Use and Plot Subdivision

### 4.1 Land Use Assignment

Land use follows from access and terrain. The assignment is driven by cause-and-effect:

**Commercial center:** Forms where routes converge, usually near the original river crossing or harbor. High-access, flat, central blocks become commercial.

**Industrial:** Follows water access (transport, power, waste disposal). Blocks downstream of the city center along the river, or near docks/harbor. Also along rail lines (future). Low-lying, flat terrain preferred.

**Residential:** Fills in between commercial and industrial. Wealth gradient driven by:
- **Elevation** — higher ground = wealthier (better air, views, drainage). Think London: West End (uphill, upwind) became affluent, East End didn't.
- **Wind direction** — upwind of industry = desirable
- **Water proximity** — waterfront can be wealthy (if not industrial) or working-class (if near docks)
- **Access** — near primary roads = denser, further = quieter

**Civic/religious:** Prominent sites — hilltops, central squares, road junctions. Large plots, landmark buildings.

**Parks:** Low-value terrain (steep slopes, flood-prone areas), or deliberately preserved green spaces.

### 4.2 Plot Subdivision

Blocks are divided into building lots. The plot shape constrains the building shape, and this is what gives districts their character.

**Frontage rule:** Plots face the road. Plot width is measured along the street frontage. Depth is measured perpendicular to the street into the block interior.

| District style | Frontage | Depth | Feel |
|---|---|---|---|
| **London terrace** | Narrow (5-7m / 5-7 units) | Deep (15-20 units) | Long narrow plots with rear gardens, terraced houses built speculatively in rows |
| **Continental perimeter** | Medium (8-12 units) | Full block depth | Buildings line the block perimeter enclosing a courtyard. German/French städtische pattern |
| **American suburban** | Wide (15-20 units) | Shallow (10-15 units) | Wide shallow lots with front setbacks and side yards |
| **Commercial** | Large amalgamated (20-40 units) | Variable | Multiple small plots merged for larger commercial buildings |
| **Industrial** | Very large (30-60 units) | Very deep | Warehouse-scale plots, minimal subdivision |
| **Downtown** | Full block | Full block | Single large building per block (skyscrapers, office towers) |

**Corner plots** are special: often larger, sometimes get landmark buildings (turrets, corner shops with two frontages).

**Plot data:**
```
{
  boundary: [{x, z}...],        // polygon vertices
  frontageEdge: [startIdx, endIdx],  // which boundary edge faces the road
  frontageWidth: number,
  depth: number,
  landUse: string,              // commercial | residential | industrial | civic | park
  wealthLevel: [0, 1],         // affects building quality/style
  cornerPlot: boolean,
}
```

### 4.3 Setbacks and Gardens

The plot isn't entirely filled by the building:
- **Front setback:** distance from road to building face. Zero for terraced houses and shops. 3-5 units for suburban. Variable for commercial.
- **Side yards:** spacing between buildings. Zero for terraced (shared walls). 1-2 units for semi-detached. 3+ for detached.
- **Rear garden:** remaining space behind the building. London terraces have long rear gardens. American houses have back yards.

---

## Pass 5 — Building Generation

Given a plot shape, land use, wealth level, and style parameter, generate the building.

### 5.1 Building Footprint

The building footprint is derived from the plot:
- Apply setbacks (front, side, rear) to get the buildable area
- For terraced houses: footprint fills the full width between party walls
- For detached: centered in plot with side yards
- For commercial: footprint may fill most of the plot
- For perimeter blocks: building follows the block edge, leaving a central courtyard

### 5.2 Style System

What makes a district feel like a specific place is the combination of many elements. The style system controls:

- **Materiality:** brick, stone, stucco/render, concrete, glass, timber
- **Roof form:** pitched (gable, hipped), flat (with parapet), mansard, sawtooth
- **Window rhythm:** regular grid, irregular, large shopfronts, small domestic
- **Facade articulation:** bay windows, balconies, cornices, pilasters
- **Relationship to neighbors:** terraced (attached), semi-detached, detached
- **Street-level elements:** railings, steps, shopfronts, awnings, doors
- **Color palette:** per district, warm/cool, muted/bold
- **Consistency:** uniformity within a street (speculative development) vs. variation between streets

### 5.3 Style Profiles

| Profile | Materiality | Roofs | Windows | Street level | Uniformity |
|---|---|---|---|---|---|
| **Georgian/Victorian terrace** | Brick, stone trim | Pitched, hidden behind parapet | Sash windows, regular grid | Iron railings, steps up to front door | High within a street |
| **Continental apartment** | Rendered/plastered | Steeper pitch or mansard | Shutters, different proportions | Courtyard entrance, shops at ground | Medium |
| **American downtown** | Glass, steel frame | Flat | Curtain wall grid | Lobby entrance, retail at ground | Medium-high per block |
| **Suburban houses** | Mixed (brick, timber, rendered) | Pitched gable | Domestic scale, irregular | Front garden, driveway, porch | Low (individual variation) |
| **Industrial** | Metal cladding, concrete | Flat or sawtooth | Few, small, or none | Loading docks, roller doors | High (functional uniformity) |
| **Market/bazaar** | Light materials, canvas | Canopy/tent | Open front | Stall counters, display goods | Medium (colorful variation) |

### 5.4 Height and Density

Building height follows from land use, wealth, and centrality:
- Downtown commercial: 8-25 floors (skyscrapers)
- Urban residential: 3-8 floors (apartment blocks)
- Suburban residential: 1-2 floors
- Industrial: 1-2 floors but large footprint
- Height decreases with distance from center (naturally — land is cheaper)
- Buildings near the river crossing / harbor are tallest and densest

### 5.5 Landmark Buildings

Special buildings at anchor points:
- **River crossing:** major civic building (town hall, cathedral) near the oldest bridge
- **Hilltop:** church, castle, or wealthy mansion
- **Harbor:** customs house, lighthouse, maritime buildings
- **Road junctions:** corner pubs, market halls, clock towers

### 5.6 Doors

Every building has a door on its road-facing facade. Doors are required for future interior systems. Placed at ground level, offset from the wall to prevent z-fighting.

---

## Interaction Between Passes

### Terrain → Routes
- Steep slopes increase road cost (roads avoid them or switchback)
- Rivers force bridges (expensive — few crossing points)
- Ridgelines and valleys become natural road corridors

### Routes → Land Use
- Convergence points become commercial centers
- River access becomes industrial/docks
- Quiet, elevated areas become wealthy residential
- Noisy, low-lying areas become working class or industrial

### Land Use → Plot Shape
- Commercial: large amalgamated plots, full block coverage
- Terraced residential: narrow-frontage deep plots
- Suburban: wide-frontage shallow plots
- Industrial: very large plots

### Plot Shape → Building
- Plot width constrains building width
- Plot depth constrains building depth
- Setback rules create gardens, courtyards, sidewalks
- Corner plots get special treatment

### Historical Layering
The generation simulates different eras layered on top of each other:
- **Old town** (center): organic road pattern, narrow plots, terraced buildings, 3-5 floors. Near the original river crossing or harbor.
- **Victorian/Georgian expansion** (inner ring): more regular grid, terraced houses or apartment blocks, 2-4 floors. Follows primary roads outward.
- **Modern suburbs** (outer ring): rigid grid or cul-de-sac pattern, detached houses, 1-2 floors. Low density.
- **Industrial zones** (downstream, near rail/docks): large blocks, warehouses, minimal subdivision.
- **Modern downtown** (redeveloped center): tall buildings replacing original old-town plots. Glass towers on medieval street patterns.

---

## Water Surface Meshes

Separate meshes placed after terrain:
- **River:** subdivided strip following the centerline curve, ~1 unit above the carved riverbed. Cross-section width matches river width. Per-cross-section Y is flat (water finds a level).
- **Coast:** large plane at sea level covering the water area.
- **Tributaries:** narrower versions of river mesh.
- All use the same material: `0x2277AA`, transparent, opacity 0.85, roughness 0.2, metalness 0.3, DoubleSide.

---

## Performance

- **Heightmap carving:** ~66K cells × ~200 river segments. Optimize with spatial binary search (reduces to ~5-10 checks per cell) and early termination.
- **A* pathfinding** (Pass 2): runs on the heightmap grid (~66K nodes). Standard A* with terrain slope as cost. Runs a few times (one per anchor-pair route). Fast.
- **Plot subdivision** (Pass 4): recursive subdivision per block. O(blocks × plots per block). Blocks ~100-200, plots ~5-20 each. Trivial.
- **Building generation** (Pass 5): same async batched approach as current system. Buildings built in batches across frames.

---

## Implementation Priorities

The five passes can be implemented incrementally:

1. **Pass 1 (terrain + water)** — parameterized heightmap, river carving, water surface. This is the foundation and gives the biggest visual impact. Can be done while keeping the existing grid road system — the grid just adapts to the carved terrain.

2. **Arterial roads + sidewalks + bridges** — enhance the existing grid system with wider arterials, sidewalks, and bridges over the river. Quick wins on the existing road system before replacing it.

3. **Pass 2 (primary routes)** — replace or augment the grid with terrain-following primary roads. The biggest architectural change. The organic pathfinding and road hierarchy live here.

4. **Pass 3 (secondary network)** — fill between primary roads. This replaces the current fixed CELL_SIZE grid with adaptive block generation.

5. **Pass 4 + 5 (plots and buildings)** — plot subdivision and style-driven building generation. Replaces the current district template system with something richer.

Each stage produces a playable city. The game works at every intermediate step.

---

## Future Extensions

- Seasonal water levels (floodplain expands in spring)
- Erosion simulation (terrain detail near rivers)
- Multiple rivers / confluences
- Islands within coastal water
- Rail lines and stations (follow terrain like roads, cross river on bridges)
- Pedestrians on sidewalks
- Traffic AI on road network
- Day/night cycle with window lighting
- Weather effects (rain, fog, puddles)
- Elevation-dependent vegetation
- Terracing for hillside building plots
