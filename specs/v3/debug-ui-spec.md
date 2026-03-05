# City Pipeline Debug — Spec

## Purpose

A CLI tool that generates a region, picks the biggest city, runs the city pipeline step-by-step, and outputs a single PNG image: a 4x4 grid showing what each of the 16 pipeline steps produced. No browser needed.

## Usage

```bash
node scripts/debug-city.js [--seed 12345] [--out debug.png]
```

- `--seed`: optional. Random if omitted. Printed to stdout so you can reproduce.
- `--out`: output path. Defaults to `debug.png` in the project root.

## Output Image

A single PNG containing a 4x4 grid of tiles. Each tile visualises one pipeline step.

### Layout

```
+------------------+------------------+------------------+------------------+
| 1. Elevation     | 2. Slope         | 3. Water Mask    | 4. Anchor Routes |
|                  |                  |                  |                  |
+------------------+------------------+------------------+------------------+
| 5. Density       | 6. Arterials     | 7. Density v2    | 8. Districts     |
|                  |                  |                  |                  |
+------------------+------------------+------------------+------------------+
| 9. Collectors    | 10. Streets      | 11. Loop Closure | 12. Rezone       |
|                  |                  |                  |                  |
+------------------+------------------+------------------+------------------+
| 13. Plots        | 14. Buildings    | 15. Amenities    | 16. Land Cover   |
|                  |                  |                  |                  |
+------------------+------------------+------------------+------------------+
```

Each tile:
- Size: city grid width x height pixels (typically ~80x80 for a tier-3 city, ~160x160 for tier-1).
- Faint elevation base drawn first (alpha 0.3) for spatial context.
- Step-specific layer drawn on top at full intensity.
- Step label rendered in the top-left corner (white text, black shadow).
- 2px black border between tiles.

Total image size: `(tileW + 2) * 4` x `(tileH + 2) * 4` pixels.

## The 16 Tiles

All rendering to a raw RGBA pixel buffer. 1 pixel = 1 grid cell. World-to-grid: `gx = worldX / cellSize`.

| # | Name | Data | Rendering |
|---|------|------|-----------|
| 1 | Elevation | `getGrid('elevation')` | Colour ramp: blue below sea level, green-brown-grey above. |
| 2 | Slope | `getGrid('slope')` | Greyscale. Black = flat (0), white = steep (clamp at 1.0). |
| 3 | Water Mask | `getGrid('waterMask')` | Elevation base + blue cells where mask > 0. |
| 4 | Anchor Routes | road graph after B2 | Elevation base + road edges as lines. Orange, 1px. Nodes as 2px dots. |
| 5 | Density | `getGrid('density')` after B3 | Heatmap: black at 0, yellow at 0.5, red at 1.0. |
| 6 | Arterials | road graph after B4 | Elevation base + all edges. Arterial = white (2px), collector = yellow (1px), local = grey (1px). |
| 7 | Density v2 | `getGrid('density')` after feedback A | Same heatmap as step 5. |
| 8 | Districts | `getGrid('districts')` | Colour-coded cells: commercial = red, dense res = orange, suburban = yellow, industrial = purple, parkland = green. |
| 9 | Collectors | road graph after B6 | Elevation base + all edges by hierarchy. New collectors highlighted in yellow. |
| 10 | Streets | road graph after B7 | Elevation base + all edges. New local streets highlighted in white. |
| 11 | Loop Closure | road graph after B8 | Elevation base + all edges. New closure edges in cyan. |
| 12 | Rezone | `getGrid('districts')` after feedback D | Same as step 8 but post-rezone. |
| 13 | Plots | `getData('plots')` | Elevation base + plot outlines. Colour by district. |
| 14 | Buildings | `getData('buildings')` | Elevation base + building footprints filled. Colour by material. |
| 15 | Amenities | `getData('amenities')` | Elevation base + coloured dots. Park = green, school = blue, commercial = red. |
| 16 | Land Cover | `getGrid('urbanCover')` | Colour-coded: garden = light green, park = green, woodland = dark green, river buffer = teal, paved = grey. |

## Implementation

### Dependencies

Use `sharp` for PNG encoding (already common in Node projects, no native canvas needed). All rendering is direct pixel manipulation on a `Uint8Array` RGBA buffer — no Canvas API.

```bash
npm install --save-dev sharp
```

### Files to Create

| File | Purpose |
|------|---------|
| `scripts/debug-city.js` | CLI entry point. Parses args, runs generation, calls renderer, writes PNG. |
| `src/city/pipelineDebug.js` | `generateCityStepByStep()` — runs pipeline capturing snapshots. |
| `src/rendering/debugTiles.js` | Pure-JS pixel rendering functions + grid compositor. |

### Pixel Buffer API (`debugTiles.js`)

No Canvas API. Work with raw RGBA buffers:

```js
// Create a tile-sized buffer
function createBuffer(w, h) → { data: Uint8Array(w*h*4), width: w, height: h }

// Set a pixel
function setPixel(buf, x, y, r, g, b, a = 255)

// Alpha-blend a pixel on top
function blendPixel(buf, x, y, r, g, b, a)

// Draw a line (Bresenham)
function drawLine(buf, x0, y0, x1, y1, r, g, b, a = 255)

// Fill a polygon (scanline fill)
function fillPolygon(buf, points, r, g, b, a = 255)

// Render text label (built-in tiny bitmap font, ~5x7 pixels per char)
function drawLabel(buf, x, y, text, r, g, b)
```

### Per-Tile Renderers (`debugTiles.js`)

```js
function renderElevation(buf, elevation, seaLevel)
function renderSlope(buf, slope)
function renderWaterMask(buf, elevation, waterMask, seaLevel)
function renderDensity(buf, density)
function renderDistricts(buf, districts)
function renderUrbanCover(buf, urbanCover)
function renderRoads(buf, roadGraph, edgeIds, newEdgeIds, cellSize)
function renderPlots(buf, plots, cellSize)
function renderBuildings(buf, buildings, cellSize)
function renderAmenities(buf, amenities, cellSize)
```

Each renderer writes into a pre-allocated buffer. For tiles that need an elevation base, render elevation first at reduced alpha, then the layer on top.

### Grid Compositor

```js
function compositeGrid(tiles, tileW, tileH) → { data, width, height }
```

Takes an array of 16 tile buffers, returns one big buffer with 4x4 layout and borders.

### Step-by-Step Pipeline (`pipelineDebug.js`)

```js
export function generateCityStepByStep(regionalLayers, settlement, rng, options) {
  const steps = [];

  // B1a: Extract context
  const cityLayers = extractCityContext(regionalLayers, settlement, options);
  steps.push({ name: 'Elevation', render: 'elevation' });

  // B1b: Refine terrain
  refineTerrain(cityLayers, rng.fork('cityTerrain'));
  steps.push({ name: 'Slope', render: 'slope' });
  steps.push({ name: 'Water Mask', render: 'waterMask' });

  // B2: Anchor routes
  const roadGraph = generateAnchorRoutes(cityLayers, rng.fork('anchorRoutes'));
  let prevEdges = new Set();
  let curEdges = new Set(roadGraph.edges.keys());
  steps.push({ name: 'Anchor Routes', render: 'roads', edgeIds: new Set(curEdges), newEdgeIds: new Set(curEdges) });
  prevEdges = curEdges;

  // B3: Density
  let density = generateDensityField(cityLayers, roadGraph, rng.fork('density'));
  cityLayers.setGrid('density', density);
  // Snapshot the density grid before it gets overwritten
  const densityV1 = density.clone();
  steps.push({ name: 'Density', render: 'density', grid: densityV1 });

  // B4: Arterials
  generateArterials(cityLayers, roadGraph, rng.fork('arterials'));
  curEdges = new Set(roadGraph.edges.keys());
  steps.push({ name: 'Arterials', render: 'roads', edgeIds: new Set(curEdges), newEdgeIds: difference(curEdges, prevEdges) });
  prevEdges = curEdges;

  // Feedback A: Density v2
  density = generateDensityField(cityLayers, roadGraph, rng.fork('densityPost'));
  cityLayers.setGrid('density', density);
  steps.push({ name: 'Density v2', render: 'density' });

  // B5: Districts
  generateDistricts(cityLayers, roadGraph, rng.fork('districts'));
  // Snapshot districts before rezone
  const districtsV1 = cityLayers.getGrid('districts').clone();
  steps.push({ name: 'Districts', render: 'districts', grid: districtsV1 });

  // B6: Collectors
  generateCollectors(cityLayers, roadGraph, rng.fork('collectors'));
  curEdges = new Set(roadGraph.edges.keys());
  steps.push({ name: 'Collectors', render: 'roads', edgeIds: new Set(curEdges), newEdgeIds: difference(curEdges, prevEdges) });
  prevEdges = curEdges;

  // B7: Streets
  generateStreets(cityLayers, roadGraph, rng.fork('streets'));
  curEdges = new Set(roadGraph.edges.keys());
  steps.push({ name: 'Streets', render: 'roads', edgeIds: new Set(curEdges), newEdgeIds: difference(curEdges, prevEdges) });
  prevEdges = curEdges;

  // B8: Loop closure
  closeLoops(roadGraph, 500, cityLayers);
  curEdges = new Set(roadGraph.edges.keys());
  steps.push({ name: 'Loop Closure', render: 'roads', edgeIds: new Set(curEdges), newEdgeIds: difference(curEdges, prevEdges) });
  prevEdges = curEdges;
  cityLayers.setData('roadGraph', roadGraph);

  // Feedback D: Rezone
  rezoneHighCentralityStreets(roadGraph, cityLayers);
  steps.push({ name: 'Rezone', render: 'districts' });

  // B9: Plots
  const plots = generatePlots(cityLayers, roadGraph, rng.fork('plots'));
  cityLayers.setData('plots', plots);
  steps.push({ name: 'Plots', render: 'plots' });

  // B10: Buildings
  const buildings = generateBuildings(cityLayers, plots, rng.fork('buildings'));
  cityLayers.setData('buildings', buildings);
  steps.push({ name: 'Buildings', render: 'buildings' });

  // B11: Amenities
  const amenities = generateAmenities(cityLayers, buildings, rng.fork('amenities'));
  cityLayers.setData('amenities', amenities);
  steps.push({ name: 'Amenities', render: 'amenities' });

  // B12: Land cover
  const urbanCover = generateCityLandCover(cityLayers, amenities, rng.fork('urbanCover'));
  cityLayers.setGrid('urbanCover', urbanCover);
  steps.push({ name: 'Land Cover', render: 'urbanCover' });

  return { cityLayers, roadGraph, steps };
}

function difference(a, b) {
  return new Set([...a].filter(id => !b.has(id)));
}
```

Note: `rezoneHighCentralityStreets` is currently a private function inside `pipeline.js`. It needs to be exported (or extracted to a shared helper) so `pipelineDebug.js` can call it.

### CLI Script (`scripts/debug-city.js`)

```js
import { generateRegion } from '../src/regional/pipeline.js';
import { generateCityStepByStep } from '../src/city/pipelineDebug.js';
import { renderDebugGrid } from '../src/rendering/debugTiles.js';
import { SeededRandom } from '../src/core/rng.js';
import sharp from 'sharp';

const seed = parseSeedArg() || Math.floor(Math.random() * 100000);
const outPath = parseOutArg() || 'debug.png';

console.log(`Seed: ${seed}`);
const rng = new SeededRandom(seed);

// Generate region
const regionalLayers = generateRegion({ coastEdges: ['south'] }, rng.fork('region'));

// Pick biggest settlement
const settlements = regionalLayers.getData('settlements');
settlements.sort((a, b) => a.tier - b.tier);
const settlement = settlements[0];
console.log(`City: tier ${settlement.tier} at (${settlement.gx}, ${settlement.gz})`);

// Generate city step by step
const { cityLayers, roadGraph, steps } = generateCityStepByStep(
  regionalLayers, settlement, rng.fork('city'), {}
);

// Render 4x4 grid
const { data, width, height } = renderDebugGrid(cityLayers, roadGraph, steps);

// Write PNG
await sharp(Buffer.from(data), { raw: { width, height, channels: 4 } })
  .png()
  .toFile(outPath);

console.log(`Written ${width}x${height} to ${outPath}`);
```

## Colour Palettes

### Elevation
Same as existing `mapRenderer.js`: blue below sea level, green lowlands, brown hills, grey/white highlands.

### Districts
| Value | Type | Colour |
|-------|------|--------|
| 0 | Commercial | `#cc3333` |
| 1 | Dense residential | `#dd8833` |
| 2 | Suburban | `#ddcc44` |
| 3 | Industrial | `#8844aa` |
| 4 | Parkland | `#33aa44` |

### Urban Cover
| Value | Type | Colour |
|-------|------|--------|
| 1 | Garden | `#6baa40` |
| 2 | Park | `#33aa22` |
| 3 | Woodland | `#1f5511` |
| 4 | River buffer | `#44aa88` |
| 5 | Paved | `#999588` |

### Building Materials
Reuse `MATERIAL_COLORS` from `materials.js`: pale stone, warm stone, dark stone, brick, flint.

### Road Hierarchy (on dark/elevation base)
| Hierarchy | Colour | Width |
|-----------|--------|-------|
| arterial | `#ffffff` | 2px |
| collector | `#ffcc44` | 1px |
| local | `#999999` | 1px |
| new (highlight) | `#00ffff` | 1px |
