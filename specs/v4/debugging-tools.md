# Debugging Tools

## Overview

The city generation pipeline produces complex output that's hard to verify
from the 3D view alone. We have several debugging tools at different zoom
levels to inspect the pipeline at each stage.

## Tools

### 1. Pipeline Debug Grid (`scripts/debug-city.js`)

Generates a 4x4 grid of tiles showing each pipeline step as a separate
image. Also outputs individual tile PNGs.

```
node scripts/debug-city.js [--seed 12345] [--out dirname]
```

Output: `debug-{seed}/` folder containing:
- `grid.png` — 4x4 composite of all steps
- `00-region.png` — regional overview with city boundary
- `01-elevation.png` through `16-land-cover.png` — individual steps

Each tile is rendered at 1px per grid cell (city grid resolution, typically
~400x400px). Good for seeing the overall city structure but too zoomed out
to inspect individual plots or buildings.

**Tile types:**
- `elevation` — terrain height coloured blue-green-brown-white
- `slope` — steepness as greyscale
- `waterMask` — water overlay with bridge points
- `roads` — road network with hierarchy colours (white=arterial, yellow=collector, cyan=new)
- `neighborhoods` — ownership regions with nucleus markers
- `density` — heat map (black→yellow→red)
- `districts` — district type colours (red=commercial, orange=dense res, etc.)
- `plots` — plot outlines coloured by district
- `buildings` — building footprints coloured by material
- `amenities` — amenity markers
- `urbanCover` — land cover types

### 2. Schematic Close-up (`scripts/debug-schematic.js`)

Renders 500m x 500m areas at 2px/m (1000x1000px output) as an
architectural schematic. Shows plot-level detail: individual plot outlines,
building footprints within plots, road surfaces at true width, kerb lines,
centre-line dashes on major roads, dimension labels, and a 50m scale bar.

```
node scripts/debug-schematic.js [--seed 12345] [--center cx,cz] [--out dirname]
```

If `--center` is omitted, automatically generates views centred on:
1. City centre (old town nucleus)
2. Furthest neighborhood from centre
3. Waterfront area (if any)
4. A mid-distance neighborhood

Output: `schematic-{seed}/` folder containing named PNGs.

**Colour key:**
- Grey fill = road surface
- Red outlines = commercial plots
- Orange outlines = dense residential
- Yellow outlines = suburban
- Purple outlines = industrial
- Green outlines = parkland
- Dark fill within plots = building footprints
- White dashes = arterial/collector centre lines
- Red dimension labels = `{frontage}x{depth}` in metres

### 3. Debug Viewer (`scripts/debug-viewer.html`)

Browser-based viewer that auto-discovers PNG files in a debug output folder.
Supports scroll-wheel zooming (up to 16x) for inspecting individual pixels.
Open in a browser and point it at the output directory.

## When to Use What

| Question | Tool |
|----------|------|
| "Does the road network look connected?" | Pipeline grid — roads tile |
| "Are neighborhoods placed sensibly?" | Pipeline grid — neighborhoods tile |
| "Are plots the right size and shape?" | Schematic close-up |
| "Do buildings fit properly in their plots?" | Schematic close-up |
| "Is road width visible between buildings?" | Schematic close-up |
| "How does density fall off from centre?" | Pipeline grid — density tile |
| "What district types are assigned where?" | Pipeline grid — districts tile |

## Future Ideas

- Overlay a selectable grid on the pipeline debug tiles; clicking a cell
  renders a schematic close-up of that area, side by side.
- Annotate plots with neighbourhood type, density value, building type.
- Epoch/era colouring to show temporal layering of development.
- Interactive browser tool combining the grid view with zoom-to-schematic.
