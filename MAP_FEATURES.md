# Map Features — Specification

This document describes planned enhancements to the city's road network, terrain, and environmental features. These build on the existing grid-based city layout and district system.

---

## Arterial Roads

Some grid roads are promoted to **arterial roads** — wider, more prominent thoroughfares that carry the main flow of traffic through the city.

### Selection
- Pick 2-3 roads per axis (X and Z direction) based on proximity to center
- Roads closest to `x=0` or `z=0` become arterials
- Creates a natural hierarchy: arterials near center, local roads at edges

### Properties
- **Width**: 18-20 units (vs 12 for standard roads)
- **Lanes**: Visual lane markings (2-3 lanes per direction)
- **Central median**: A raised strip (0.5 units high, 1-2 units wide) dividing traffic directions, using grass or concrete material
- **Material**: Slightly darker asphalt than standard roads
- **Speed**: Cars could travel faster on arterials (future gameplay)

### Implementation
- During road generation, flag certain grid indices as arterial
- `buildRoadChunk` checks the arterial flag and uses wider geometry
- Adjust `CELL_SIZE` calculation for arterial rows/columns (wider road eats into adjacent blocks, or blocks on arterial edges are slightly smaller)
- Intersections where two arterials cross are larger patches

---

## Sidewalks

Narrow raised strips along both edges of every road, providing a visual separation between road surface and building frontage.

### Properties
- **Width**: 1.5-2 units per side
- **Height**: 0.15 units above road surface (curb step)
- **Material**: Lighter gray concrete (`0x999999`, roughness 0.85)
- **Placement**: Runs alongside every road segment, between road edge and block boundary

### Construction
- Built as part of `buildRoadChunk` — additional geometry strips on each side
- Conforms to terrain like roads (sampled heightmap + slight lift)
- At intersections: sidewalk corners with curb ramps (small slope down to road level)

### Interaction with Buildings
- Shopping street awnings extend over the sidewalk
- Street trees are placed on sidewalks (see Street Trees section)
- Suburban houses have garden paths connecting to the sidewalk

---

## River

A river winds through the city, creating a natural feature that roads must bridge over.

### Path Generation
- **Algorithm**: Perlin noise-based curve from one city edge to opposite edge
- Start from a random point on the north edge, exit through a point on the south edge (or east/west — pick one axis per generation)
- Sample noise at intervals along the primary axis to create lateral displacement
- Smooth the path with cubic interpolation to avoid sharp corners
- River width: 20-30 units (wider than a road)

### Terrain Integration
- Carve a shallow valley into the heightmap along the river path before generating terrain
- Riverbed is 3-5 units below surrounding terrain
- Banks slope gradually (not cliff edges)
- Heightmap modification happens during `generateHeightmap()`, before any object placement

### Water Surface
- Semi-transparent plane mesh following the river path
- Subdivided to follow curves
- Material: blue-green (`0x2277AA`), slight transparency (opacity 0.85), low roughness for reflectivity
- Optional: subtle vertex animation (gentle wave motion via sine offset in the render loop)

### Block Interaction
- Blocks that the river passes through become **waterfront blocks**
- Waterfront blocks have reduced building area (river cuts through)
- Could become parks or have special waterfront buildings (future)

### Bridge Requirement
- Every road that crosses the river needs a bridge (see Bridges section)

---

## Bridges

Elevated road sections that span the river or pass over arterial roads.

### River Bridges
- Built where grid roads cross the river path
- **Structure**: Road surface elevated 4-5 units above water level
- **Ramps**: Gradual slope up (8-10 unit run, 4-5 unit rise) on each side
- **Supports**: 2-4 cylindrical pillars from riverbed to road deck
- **Railings**: Thin box meshes along bridge edges (0.8 units tall)
- Road surface material matches normal roads but with subtle edge trim

### Overpass Bridges (Arterial Crossings)
- Where a standard road crosses over an arterial (or vice versa)
- One road passes at grade level, the other is elevated
- Elevation: 6-8 units clearance beneath
- Support structure: concrete pillars at corners
- Ramp geometry on approach roads

### Construction
- During road generation, detect intersections with river path
- Replace normal road segment with bridge geometry
- Bridge mesh: flat deck (like road) + support pillars + railings
- Deck conforms to a straight line (not terrain — bridges are flat)
- Approach ramps blend from terrain height to bridge deck height

---

## Non-Grid Roads

Roads that break the regular grid structure, adding visual variety and realism.

### Diagonal Avenues
- 1-2 diagonal roads cutting across the grid at 30-45 degree angles
- Connect important points (e.g., city center to an outer corner)
- **Implementation**: Bezier curve sampled into road mesh segments
- Cut through blocks they cross (affected blocks lose some building area)
- Intersect grid roads at oblique angles (irregular intersection patches)

### Curved Suburban Roads
- In suburban district blocks, replace the straight grid road with gentle curves
- **Implementation**: Cubic Bezier between grid intersection points, with control points offset laterally
- Same road width, just curved path
- Buildings along curved roads orient their doors toward the curve

### Cul-de-Sacs
- Dead-end roads extending into suburban blocks
- Short stub (20-30 units) ending in a circular turnaround (radius 8-10 units)
- 2-4 houses arranged around the turnaround
- Created by extending a road segment from a grid intersection into a block interior

### Ring Road
- A roughly circular road following the city perimeter
- Connects the outermost grid intersections
- Acts as a highway/bypass around the city edge
- Wider than standard roads (14-16 units)
- Could be elevated in sections where it crosses other roads

### Implementation Challenges
- Non-grid roads don't align with the cell-based block system
- Blocks intersected by diagonal/curved roads need to be split or have reduced building area
- Collision detection for car physics needs to work with arbitrary road paths (not just axis-aligned)
- Minimap rendering needs to draw curved/diagonal road paths

---

## Street Trees

Trees planted at regular intervals along roads, between the sidewalk and buildings.

### Placement
- Every 15-20 units along road segments
- Positioned on the sidewalk, offset from the road edge by 1 unit
- Alternate sides of the road or placed on both sides depending on district
- Skip placement near intersections (within 8 units) to keep sightlines clear

### Appearance by District
| District | Tree type | Trunk | Canopy | Size |
|---|---|---|---|---|
| Downtown | Ornamental | Thin, straight | Small sphere | Small (3-4 units) |
| Residential | Deciduous | Medium | Large sphere | Medium (5-7 units) |
| Shopping | Ornamental | Thin, straight | Small sphere | Small (3-4 units) |
| Suburban | Large shade | Thick | Large irregular sphere | Large (6-9 units) |
| Industrial | None | — | — | — |

### Construction
- Reuse existing tree mesh construction from parks (trunk cylinder + canopy sphere)
- Scale and color vary by district type
- Share materials with park trees (`materials.trunk`, `materials.leaf1/leaf2`)
- Grounded on heightmap like all other objects

---

## Additional Feature Ideas

### Roundabouts
- Replace some 4-way intersections with circular traffic islands
- Central green circle (grass material) with optional fountain or statue
- Roads curve around the circle
- Good visual landmark and navigation aid

### Parking Lots
- Flat open areas in industrial and shopping districts
- Grid of painted parking spaces (line markings on ground)
- A few randomly placed "parked car" meshes (simple box models)
- Break up large building blocks with open space

### Highway / Freeway
- Elevated road ring around the outer city edge
- Supported on pillars above terrain
- On/off ramps connecting to the grid road network
- Wider (20+ units), higher speed
- No intersections — overpasses and underpasses only

### Train Tracks / Rail Line
- Single rail line crossing the city (linear path, not grid-aligned)
- Level crossings where tracks meet roads (warning markings)
- Optional: elevated rail / monorail in downtown sections
- Station buildings in 1-2 locations

### Pedestrians (Future)
- Simple animated figures walking on sidewalks
- Cross at intersections
- Avoid cars (basic pathfinding)
- Density varies by district (crowded downtown, sparse suburban)

### Traffic (Future)
- AI-controlled vehicles on roads
- Follow road network, stop at intersections
- Simple state machine: drive → approach intersection → wait → turn → drive
- Density varies by road type (more on arterials)

### Day/Night Cycle
- Gradual lighting transition over time
- Building windows become emissive at night (already have emissive window material)
- Streetlights glow brighter at night
- Sky color shifts from blue to dark blue/orange at sunset
- Headlights become more prominent at night

### Weather Effects
- **Rain**: Particle system for raindrops, wet road material (higher metalness/reflectivity), puddle planes at low terrain points
- **Fog**: Increase scene fog density, reduce visibility
- **Wind**: Affect tree canopy positions (gentle sway animation)

### District Street Furniture
- **Downtown**: Bus stops, traffic lights, newspaper stands
- **Shopping**: Outdoor cafe tables, flower pots, sandwich boards
- **Suburban**: Mailboxes, garden fences, swing sets
- **Industrial**: Dumpsters, pallets, chain-link fence segments
- All built from simple box/cylinder primitives, placed on sidewalks

### Water Features
- Fountains in park blocks (central water jet + circular basin)
- Ponds in larger parks (small water plane)
- Canal sections branching off the river

---

## Implementation Priority

Suggested order based on visual impact and complexity:

1. **Sidewalks** — relatively simple geometry addition to existing road builder, big visual improvement
2. **Street trees** — reuses existing tree meshes, makes roads feel alive
3. **River** — dramatic terrain feature, requires heightmap modification
4. **Bridges** — necessary once river exists, distinctive geometry
5. **Arterial roads** — visual hierarchy, relatively simple width/material change
6. **Non-grid roads** — most complex, requires rethinking block/road intersection
7. **Everything else** — incremental additions as the game matures
