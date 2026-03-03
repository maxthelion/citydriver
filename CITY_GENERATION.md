# Generative City — Building & District Design

## Overview

The current city generator places simple box buildings with height/density gradients from center to edge. This document describes a richer system where city blocks have **district types** that determine the character of their buildings, and buildings are assembled from **templates with parametric variation** — so every building is unique but recognizably belongs to its district.

The inspiration is low-poly city builders where buildings follow clear patterns (rectangular bodies, window grids, flat roofs) but vary in color, proportions, ground-floor treatment, and rooftop accessories.

---

## District Types

Each city block is classified into a district type based on its position, noise values, and distance from center. Districts replace the current binary "building block or park" classification.

| District | Location tendency | Character |
|---|---|---|
| **Downtown office** | City center | Tall glass/steel towers, lobbies at ground level |
| **Highrise residential** | Inner ring | Tall apartment blocks, balconies, rooftop gardens |
| **Shopping street** | Along major roads | Low-rise with shop fronts, awnings, signage |
| **Market** | Scattered clusters | Open stalls, canopies, low temporary structures |
| **Suburban houses** | Outer ring | Small detached houses, pitched roofs, gardens |
| **Park** | Noise-based clusters | Green space, trees, benches (existing) |
| **Industrial** | Edge/corner areas | Warehouses, flat roofs, loading docks |

### Assignment algorithm

1. Compute `distFromCenter` (0 at center, 1 at edge) for each block
2. Sample district noise (separate Perlin layer) at block position
3. Use a weighted lookup:
   - `distFromCenter < 0.2` → downtown office (80%) or highrise residential (20%)
   - `distFromCenter < 0.5` → highrise residential (40%), shopping street (30%), park (30%)
   - `distFromCenter < 0.8` → shopping street (25%), suburban houses (40%), park (20%), market (15%)
   - `distFromCenter >= 0.8` → suburban houses (50%), industrial (30%), park (20%)
4. District noise biases toward clustering — adjacent blocks tend to share types

---

## Building Templates

Each district has 2-4 **building templates**. A template defines the structural skeleton; parametric variation produces unique instances.

### Template structure

A building template is a function that takes parameters and returns a `THREE.Group`:

```
template(params) → THREE.Group
```

Parameters include:
- `width`, `depth` — footprint dimensions (within range for district)
- `floors` — number of stories
- `color` — facade color (from district palette)
- `accentColor` — trim/detail color
- `seed` — for deterministic random details

### Shared construction primitives

All templates build from the same primitives (keeping geometry count low):

- **Box section** — a rectangular prism (walls, floors, extensions)
- **Window grid** — rows × columns of emissive planes on a facade
- **Awning** — a sloped plane or wedge below windows on ground floor
- **Roof cap** — flat slab slightly wider than the body
- **Pitched roof** — triangular prism on top
- **Rooftop accessory** — AC unit, water tower, antenna, satellite dish (random selection)
- **Balcony** — small protruding box per window on residential buildings
- **Signage** — colored plane on ground-floor facade (shops)

---

## District Templates in Detail

### Downtown Office

**Template A — Glass Tower**
- Tall (8-25 floors), narrow
- Blue/grey glass facade, dark metal frame
- Lobby: ground floor is taller (1.5x), different color, no windows
- Window grid covers full facade, high emissive (lit offices)
- Rooftop: antenna or helipad pad (flat circle)
- Variation: width (8-16), depth (8-16), floor count, glass tint

**Template B — Stepped Tower**
- Main body + smaller upper section (setback)
- Lower section wider, upper section narrower
- Creates a stepped silhouette
- Variation: setback floor (60-80% up), upper section width ratio

### Highrise Residential

**Template A — Apartment Block**
- Medium-tall (5-15 floors), wide
- Colored facade (warm tones: cream, terracotta, sage)
- Regular window grid with balcony boxes every other floor
- Flat roof with railing edge (thin box perimeter)
- Rooftop: water tower or clotheslines (thin cylinders)
- Variation: color, balcony frequency, floor count

**Template B — L-Shape / U-Shape**
- Two or three box sections joined at right angles
- Creates courtyard feeling
- Same window/balcony treatment as Template A
- Variation: arm lengths, whether L or U shape

### Shopping Street

**Template A — Shop Row**
- Low (2-3 floors)
- Ground floor: large "window" (bright emissive plane), awning above
- Awning: colored wedge shape, extends 1-2 units from facade
- Upper floors: residential windows, different facade color
- Buildings placed edge-to-edge filling the block frontage
- Variation: awning color, shop window color, facade color, height

**Template B — Corner Shop**
- Like Shop Row but wraps around a corner
- Slightly taller, sometimes with a turret/tower element at the corner
- Two facades with awnings

### Market

**Template A — Market Stall**
- Very low (1 floor, 3-4 units tall)
- Open front (no wall on one side) — just poles + canopy
- Canopy: colored plane tilted slightly, supported by thin cylinders
- Variation: canopy color, size, orientation

**Template B — Market Hall**
- Larger enclosed structure (1-2 floors)
- Wide, low profile
- Large door openings (gaps in the facade)
- Corrugated roof look (slight texture variation)

### Suburban Houses

**Template A — Detached House**
- Small (1-2 floors), pitched roof
- Roof: triangular prism on top, different color from walls
- Front door (small colored rectangle on ground floor)
- 2-4 windows per floor
- Small garden space (gap between house and block edge)
- Variation: wall color, roof color, 1 vs 2 floors, width

**Template B — Terraced Houses**
- Row of 3-5 narrow houses sharing walls
- Each has own door and color but shared roofline
- Slight height variation between units
- Creates a street frontage

### Industrial

**Template A — Warehouse**
- Large footprint, low (1-2 floors), flat roof
- Grey/metal colored, few or no windows
- Loading dock: recessed section on one face
- Rooftop: large AC units, vents
- Variation: footprint size, door placement

**Template B — Factory**
- Taller than warehouse, with sawtooth roof profile
- Sawtooth: repeating triangular sections along the roof
- Built from multiple box + wedge primitives
- Smokestack: tall thin cylinder

---

## Parametric Variation System

Each building instance is generated by:

1. **Select template** — random weighted choice from district's templates
2. **Generate parameters** — seeded random within district-defined ranges:

```
{
  width:       [min, max],      // footprint
  depth:       [min, max],
  floors:      [min, max],      // story count
  floorHeight: [3.0, 4.0],     // per story
  colors:      [...palette],    // facade options
  accents:     [...palette],    // trim/awning options
  rooftop:     [...accessories],// weighted random
  features: {
    awnings:    probability,    // 0-1
    balconies:  probability,
    signage:    probability,
    extensions: probability,    // side wing / setback
  }
}
```

3. **Build mesh** — template function assembles the THREE.Group from primitives
4. **Place in block** — standard placement with overlap detection and heightmap grounding

### Color palettes per district

**Downtown**: `[#4A5A6A, #5A6A7A, #3A4A5A, #2A3A4A]` (cool greys/blues)
**Residential**: `[#C4A882, #B85C38, #8B9E6B, #D4A76A, #7B8FA1]` (warm earth tones)
**Shopping**: `[#2D6B1E, #B83A3A, #2A4A8A, #C4A832, #8B4513]` (bold shopfront colors)
**Market**: `[#CC6633, #CC3333, #3366CC, #33CC33]` (bright canopy colors)
**Suburban**: `[#F5F0E1, #E8D8C4, #C9B99A, #D4C5A0]` (muted pastels) + roof colors `[#8B4513, #A0522D, #555555, #2F4F4F]`
**Industrial**: `[#666666, #777777, #888888, #555555]` (greys)

---

## Block Layout Patterns

Different districts arrange buildings differently within a block:

### Edge-fill (Shopping streets, Terraced houses)
Buildings placed along the block perimeter facing the road, leaving a courtyard or gap in the center. Each building's facade aligns with the road edge.

### Scatter (Downtown, Residential highrises)
Buildings placed freely within the block with overlap detection (current approach). Taller buildings need more spacing.

### Grid (Markets)
Regular grid of small structures within the block, with narrow paths between them.

### Single (Suburban houses)
One house per ~20x20 unit plot, subdividing the block into 4-9 plots with small garden gaps.

---

## Implementation Approach

### Phase 1 — District classification
Replace the current park/building binary with district types. Modify `CityGenerator.generate()` to assign district types to each block. The existing `parkNoise` approach extends naturally — use multiple noise samples and distance to classify.

### Phase 2 — Template primitives
Create shared helper functions in a new `src/buildingTemplates.js`:
- `makeWindowGrid(width, height, rows, cols, material)` → Group
- `makeAwning(width, depth, color)` → Mesh
- `makeRoofFlat(width, depth)` → Mesh
- `makeRoofPitched(width, depth, height)` → Group
- `makeRooftopAccessory(type)` → Mesh
- `makeBalcony()` → Mesh

These are geometry-construction helpers, not full templates.

### Phase 3 — District templates
Create template functions for each district type. Each returns a THREE.Group given parameters. Start with 1-2 templates per district, expand later.

### Phase 4 — Parametric instantiation
In `CityGenerator.generateBlock()`, use the block's district type to select templates and parameter ranges. Generate building data with richer metadata (template ID, color indices, feature flags). The mesh builder then uses this data to construct the right template.

### Phase 5 — Block layout patterns
Different layout strategies per district type. Shopping streets use edge-fill, suburbs use plot subdivision, etc.

---

## Performance Considerations

- **Geometry sharing**: Window panes, balconies, awnings, and rooftop accessories use shared geometries. Only position/rotation/scale vary per instance.
- **Material sharing**: Each district has a small palette (4-6 colors). Materials are created once per color, shared across all buildings of that color.
- **LOD potential**: Far-away buildings could drop window/balcony detail. Not needed initially but the template system makes it easy — pass a `lod` parameter that skips small details.
- **Batch generation**: Same async chunked approach as current system. Buildings are still generated in batches across frames.

---

## Example: Generating a Shopping Street Block

```
District: shopping_street
Block center: (144, 72)
Block size: 60x60

1. Determine frontage sides (roads on north and west edges)
2. Place Template A (Shop Row) along north edge:
   - 4 buildings, each 12-15 units wide, edge-to-edge
   - Each: 2-3 floors, random awning color, random shop window color
   - Awning extends 1.5 units over sidewalk
3. Place Template B (Corner Shop) at NW corner:
   - Wraps around corner, slightly taller
4. Place Template A along west edge (remaining frontage)
5. Interior of block: 1-2 smaller residential buildings (filler)
6. Ground building bases on heightmap (existing logic)
```

This produces a block that looks like a real shopping street — continuous shopfronts with awnings facing the road, each shop a slightly different color and height.
