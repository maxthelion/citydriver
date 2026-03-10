# Procedural Building Generator — Design

## Goal

A procedural building generator that creates varied buildings within a coherent architectural style, driven by climate. A UI screen displays a 3x3 grid of buildings (plot size × richness) with tweakable style parameters.

## Architecture

Two modules:

1. **`src/buildings/generate.js`** — Pure geometry generation. Takes a style object + building recipe, returns a THREE.Group of meshes. No rendering or UI concerns.

2. **`src/ui/BuildingStyleScreen.js`** — UI screen with sidebar (climate selector + parameter sliders) and a 3x3 grid of 3D viewports. Single WebGLRenderer with 9 scissored regions.

**Flow:** Climate selector populates style defaults → sliders allow overrides → generator produces 9 buildings (3 plot sizes × 3 richness levels) → each rendered in its viewport. Any parameter change regenerates all 9.

## Climate Zones

Climate is the top-level selector. Each zone sets sensible defaults for all style parameters.

| Climate | Roof | Pitch | Windows | Floors | Key features |
|---------|------|-------|---------|--------|--------------|
| Cold | Steep gable | 45-60° | Small | 1-3 | Dormers, thick walls |
| Temperate | Gable/hip | 30-45° | Medium | 2-4 | Porches |
| Continental | Hip/flat | 20-35° | Large | 3-6 | Courtyards, stucco |
| Mediterranean | Low hip/mansard | 15-30° | Tall | 3-6 | Balconies, shutters |
| Tropical | Hip/gable | 30-45° | Large/open | 1-2 | Stilts, deep verandah |
| Arid | Flat | 0-5° | Small | 1-3 | Thick walls, courtyard |

All parameters are overridable via sliders after selecting a climate.

## Style Object

Shared across all 9 buildings in a generation:

```
Style {
  floorHeight: 2.8-4.0m
  floorCountRange: [min, max]

  roofType: 'gable' | 'hip' | 'flat' | 'mansard'
  roofPitch: 0-60 degrees
  roofOverhang: 0-0.5m

  windowWidth: 0.8-1.5m
  windowHeight: 1.0-2.5m
  windowSpacing: 2.0-4.0m (center-to-center)
  windowHeightDecay: 0-0.1 (per-floor shrinkage)
  windowArched: false (toggled by richness)

  hasPorch: true/false
  porchDepth: 1.5-3.0m
  hasBalcony: true/false
  balconyFloors: [2, 5]
  hasDormers: true/false

  wingProbability: 0-1

  wallColor, roofColor, trimColor, windowColor
}
```

## Building Recipe

**`buildRecipe(style, plotSize, richness, seed)`** produces a per-building recipe.

### Plot size mapping

| | Small | Medium | Large |
|---|---|---|---|
| Width | 6-8m | 10-14m | 16-22m |
| Depth | 8-10m | 10-14m | 14-20m |
| Floors | style.min | lerp(min, max, 0.5) | style.max |
| Wings | 0 | 0-1 | 0-2 |

Exact values randomized by seed within these ranges.

### Richness mapping (0, 0.5, 1)

| | Plain (0) | Moderate (0.5) | Ornate (1) |
|---|---|---|---|
| Windows | Simple rects | Sills + lintels | Arched + sills + lintels |
| Corners | Plain | Plain | Quoins |
| Balconies | None | Some floors | All eligible floors |
| Dormers | None | 1-2 | Full row |
| Chimneys | 0-1 | 1 | 1-2 |
| Cornice | None | Simple band | Thick band |
| Porch | None/minimal | Standard depth | Full depth |

### Color variation

Base colors from climate. Per-building, the seed nudges wall color ±10% lightness so the 9 feel cohesive but not identical. Roof and trim stay fixed.

## Volume Composition

A building is 1-3 axis-aligned volumes:

```
Volume { width, depth, floors, offsetX, offsetZ, role: 'main' | 'wing' }
```

Main volume is always present. Wings attach to sides or back, always shorter than the main mass. Layouts:

- **Rectangle** — main only
- **L-shape** — main + 1 wing on side
- **T-shape** — main + 1 wing on back center
- **U-shape** — main + 2 wings on sides

## Geometry Pipeline

For each volume:

### 1. Walls

4 wall quads per volume. Where a wing meets the main mass, the shared wall section is removed (no interior faces). Vertex colors from `style.wallColor`.

### 2. Windows (painted faces)

Walk each exterior wall face. Place window-colored quads at `windowSpacing` intervals, on each floor. Window sits 0.01m in front of wall (polygon offset for z-fighting). Richness adds:

- **Arched tops** — semicircle of triangles above window rect
- **Sills/lintels** — thin trim-colored quads below/above
- **Quoins** — alternating trim blocks at corners

### 3. Roofs

Each volume gets a roof:

- **Gable** — two sloped faces + two triangular gable walls. Ridge along longer axis.
- **Hip** — four sloped faces meeting at ridge (or peak if square).
- **Flat** — thin slab on top, slight parapet.
- **Mansard** — lower steep slope (70°) + upper shallow slope (30°).

**Wing roof trimming:** Wing ridge sits below main wall height. Roof faces are clipped at the main mass wall plane — ridge ends at the wall face, slopes terminate cleanly. Creates a proper butt joint rather than overlapping geometry.

### 4. Feature attachments

All painted flat geometry:

- **Porch/verandah** — posts + roof slab from front wall. Tropical gets wrap-around.
- **Balconies** — thin platform + railing quads on specified floors.
- **Dormers** — small gabled boxes on roof slope, one per windowSpacing interval.
- **Chimneys** — rectangular extrusions on ridge, 1-2 per building.
- **Stilts** (tropical) — raised main floor, posts underneath, open ground level.

## UI Screen

### Layout

```
┌──────────────┬──────────────────────────────┐
│              │   Plain    Moderate   Ornate  │
│  Climate:    │  ┌──────┐ ┌──────┐ ┌──────┐  │
│  [dropdown]  │  │ S    │ │ S    │ │ S    │  │
│              │  └──────┘ └──────┘ └──────┘  │
│  Sliders:    │  ┌──────┐ ┌──────┐ ┌──────┐  │
│  Floor ht    │  │ M    │ │ M    │ │ M    │  │
│  Roof pitch  │  └──────┘ └──────┘ └──────┘  │
│  Window size │  ┌──────┐ ┌──────┐ ┌──────┐  │
│  ...etc      │  │ L    │ │ L    │ │ L    │  │
│              │  └──────┘ └──────┘ └──────┘  │
│  [Randomize] │                               │
└──────────────┴──────────────────────────────┘
```

### Rendering

Single WebGLRenderer filling the right panel. Animation loop iterates 9 cells with viewport/scissor. Each cell has its own Scene (building + ground plane + lights) and OrthographicCamera from a fixed 3/4 angle, auto-fitted to building bounding box.

### Interaction

- **Climate dropdown** — repopulates sliders, regenerates all 9
- **Slider change** — regenerates all 9
- **Randomize button** — new seed, same style, regenerates all 9
- **Click cell** — zooms building to fill panel with orbit controls; click/Escape returns to grid
- **Escape** — back to previous screen

### Sliders

Floor height, roof pitch, window width, window height, window spacing, porch depth, wall color, roof color.

## Testing

`test/buildings/generate.test.js`:

1. Each climate produces valid geometry (no NaN positions)
2. Window count scales with facade width
3. Floor count respects recipe (bounding box height ≈ floors × floorHeight + roof)
4. Wing roof doesn't exceed main wall height
5. Richness adds features (ornate has more meshes than plain)
6. Flat roof has no sloped faces
7. Mansard has two slope breaks
8. All 9 combinations × 6 climates generate without errors
