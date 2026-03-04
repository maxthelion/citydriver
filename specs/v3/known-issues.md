# Known Issues and Observations

## Terrain: Making Mountains Work

The terrain generation went through several iterations to produce convincing mountains:

1. **Base height was too linear** — Original `resistance * 60 + 10` gave max 70 units. Now `10 + smoothR * 25` — deliberately small so ridged noise shapes mountains, not geology boundaries.

2. **Ridged noise** — Musgrave ridged multifractal (`ridgedMultifractal()` on PerlinNoise) with domain warping. Blended additively via `smoothstep(0.25, 0.7, smoothR)` so hard rock gets ridge character, soft rock stays smooth FBM. See "Sharp Ridges" section below for full details.

3. **Stepped terrain at geological boundaries** — Rock type changes are abrupt (granite 0.9 → clay 0.2 in one cell). Fixed by smoothing erosion resistance (6 box-blur passes). Smoothed field (`smoothR`) drives elevation envelope and ridge blend; original sharp resistance drives noise texture.

4. **Escarpments were too aggressive** — Multiplier reduced from 20 to 8. Subtle definition at boundaries.

5. **Power-curve post-process** — `pow(normalized, 1.4)` redistributes elevation: sharpens peaks, compresses valleys.

Key insight: separate the concerns — smooth field for *elevation envelope*, sharp field for *noise texture*.

## River Ribbons (Replacing Blocky Cells)

Rivers in city view were blocky blue terrain squares. Replaced with smooth ribbon meshes:

- Ribbon geometry built with perpendicular-offset quad strips (same pattern as road meshes)
- Width proportional to `sqrt(accumulation)` — widens downstream naturally
- **Chaikin's corner-cutting** (3 iterations) smooths the cell-by-cell zigzag into natural curves
- Confluence gaps fixed by extending each child segment's polyline to its parent's join point
- Material: semi-transparent blue, `depthWrite: false` + `DoubleSide` to avoid z-fighting with terrain
- Y offset +1.0 above terrain (0.3 was invisible due to depth buffer precision)
- Blue tinting removed from terrain mesh — river cells now use normal land cover colors underneath

Added to both city view (`buildRiverMeshes` in waterMesh.js) and region 3D preview (`buildRegionRiverMeshes` in regionPreview3D.js).

## Square Island Shape (fixed)

Was using Chebyshev distance for uniform edge falloff, making every map a square island. Now uses configurable `coastEdges` param — only specified edges get coastal falloff with noise-varied coastline. Default is one random edge.

## Rivers Flow Away From the Sea (fixed)

Rivers were flowing inland because noise amplitudes (±100 units) overwhelmed the narrow coastal falloff (30% margin). Fixed by adding a **continental tilt** — a linear gradient from 0 at the coast to +120 inland, applied additively before noise. The 120-unit tilt dominates the macro drainage direction; noise adds local variation but can't reverse it. Geology multiplier reduced from 160 to 120 to compensate.

## Coastal Cliffs: Geology-Responsive Coastline (fixed)

Coastal falloff margin now responds to erosion resistance:
- **Hard rock** (smoothR ~0.9): narrow margin (~0.05), steep falloff → cliffs and headlands, deep water at base (subSeaDepth ~28)
- **Soft rock** (smoothR ~0.2): wide margin (~0.29), gentle falloff → beaches and plains, shallow shelf (subSeaDepth ~14)
- Formula: `baseMargin = 0.35 - smoothR * 0.3`, `subSeaDepth = 10 + smoothR * 20`
- Noise still varies the margin slightly (±0.08) for irregular coastlines

## Mountains: Sharp Ridges (fixed), Still Blobby (partially fixed)

Hard rock terrain originally produced smooth flat-topped domes. Fixed via multiple changes:

**Fixed:**
1. **Musgrave ridged multifractal** — `PerlinNoise.ridgedMultifractal()` with signal squaring, octave feedback (`weight = clamp(signal * gain)`), and spectral weights `lacunarity^(-i*H)`. Key gotcha: spectral weights must use *relative* frequency progression, not absolute sampling frequency — using `freq^-H` (starting at freq=4) crushed output to ~30%.
2. **Ridge noise as primary shape** — Ridge character is additively blended via `smoothstep(0.25, 0.7, smoothR)`, centered by subtracting approximate mean (~80) to avoid elevation jumps at geological boundaries.
3. **Power-curve post-process** — `pow(normalized, 1.4)` after elevation loop. Exponent >1 sharpens peaks; <1 creates plateaus (counterintuitive — 0.7 was tried first and flattened everything).
4. **Domain warping** — Warp noise (3-octave FBM, amplitude 0.25) applied to ridge coordinates. Breaks Perlin lattice so ridgelines twist organically.
5. **Reduced geology-driven domes** — `baseHeight` reduced from `pow(smoothR,1.5)*120` to `smoothR*25`; `largeTerrain` amplitude decoupled from resistance (`40+smoothR*30` instead of `20+smoothR*80`). The geology-shaped baseHeight was the main source of dome/blob shapes.
6. **More resistance smoothing** — 3→6 box-blur iterations for gradual geological transitions.

**Remaining issue: blobby mountains.** Mountains still tend to form circular blobs rather than elongated ridge systems. This is because the geology layer creates roughly circular hard-rock patches, and elevation still correlates with resistance (via `baseHeight` and `ridgeBlend`). Real mountain ranges are elongated because they form along tectonic/fold boundaries. Possible fixes:
- Anisotropic geology generation (elongated rock regions along a random axis)
- Large-scale directional ridge features independent of geology
- Thermal erosion post-process to carve valleys and break up blob shapes

## Regional Roads: Duplicate parallel routes between settlements (unfixed)

`generateRoads.js` pathfinds each settlement connection independently via A*. When multiple roads connect to the same settlement, they each find their own path rather than sharing segments of existing routes. This results in multiple parallel roads between cities instead of a branching network where collector roads join arterials. Roads should prefer to merge onto already-routed paths rather than always pathfinding from scratch.

## Rivers: Grid-Following Partially Addressed

Rivers follow D8 flow directions (8 cardinal/diagonal). `smoothRiverPaths` in flowAccumulation.js adds sinusoidal meanders on gentle terrain. The ribbon mesh renderer applies Chaikin smoothing on top. Result is much better than raw grid paths but still somewhat angular at close zoom. Further improvement would need sub-cell flow routing or spline fitting in the hydrology phase itself.

## Recently Fixed Bugs

1. **CityRadius too small** — was hardcoded 15, now tier-based (40/30/20)
2. **Roads in water** — terrainCostFunction now returns Infinity below sea level; entry points snap to land
3. **Street subdivision capped at 50** — now processes all blocks per iteration, maxIterations=200
4. **Collector over-generation** — budget capped at 1.5x existing edges, sorted shortest-first
5. **Plot overlap** — depth capped at half perpendicular block extent
6. **Q_amenityCatchment filter broken** — now checks actual types (terrace/detached/semi-detached)

## UI Features Added

- Layers palette: checkbox panel toggling terrain/water/roads/buildings/parks/rivers visibility
- Minimap: orthographic camera bottom-right (200x200px) with red dot for camera position
- Region minimap in city view showing city extent within the region
