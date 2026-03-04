# Regional Geology Implementation Plan

## Context

The current regional generator (`src/regional/`) produces terrain from arbitrary fBm noise, coastlines from simple edge falloff, and rivers from uniform flow-accumulation thresholds. The result looks procedural — terrain features don't relate to each other, coastlines lack headland/bay structure, and all rivers behave the same regardless of landscape.

The spec (`specs/v2/regional-geology-plan.md`) proposes generating an invisible geology layer first, then deriving terrain, rivers, coastlines, and settlement sites from it. Hard rock creates highlands and headlands; soft rock creates lowlands and bays; river character varies by the rock it flows through. The result is a coherent regional map where landscape features arise from the same underlying logic.

## Approach: Geology as Optional Layer

All geology behaviour is gated on `geology !== null`. When `params.geology` is false/omitted, every function executes its original code path unchanged. This preserves backwards compatibility and lets existing tests pass without modification.

## New File

### `src/regional/geology.js`

Exports `generateGeology(params, rng)` → GeologyData.

```
GeologyData {
  rockTypes: Uint8Array,     // per cell: 0=IGNEOUS, 1=HARD_SED, 2=SOFT_SED, 3=CHALK, 4=ALLUVIAL
  bandDirection: number,     // radians
  intrusions: [{cx, cz, radius}],
  springLine: Uint8Array,    // 1 at hard/soft rock boundaries
}
```

**Rock properties table** (constants, not per-cell):

| Rock | erosionResistance | permeability | cliffTendency | soilFertility |
|------|-------------------|--------------|---------------|---------------|
| Igneous | 0.95 | 0.15 | 0.85 | 0.15 |
| Hard sedimentary | 0.75 | 0.60 | 0.55 | 0.35 |
| Soft sedimentary | 0.25 | 0.20 | 0.10 | 0.75 |
| Chalk | 0.50 | 0.85 | 0.70 | 0.50 |
| Alluvial | 0.05 | 0.30 | 0.00 | 0.95 |

**Algorithm:**
1. Choose band direction (param or random). Create PerlinNoise.
2. For each cell, project (gx,gz) onto band axis → `bandNoise = fbm(projection * bandFreq, cross * 0.3)`. Map through `complexity` thresholds to HARD_SED / SOFT_SED / CHALK (cycling).
3. Stamp igneous intrusions as noise-warped circular blobs at random centers.
4. Compute springLine: mark cells where any neighbor's erosionResistance differs by ≥ 0.3.
5. Alluvial is NOT placed here — deferred to drainage phase.

## Modified Files

### `src/regional/region.js`

**New pipeline step** between RNG creation and terrain:
```
geology → terrain(geology) → drainage(geology) → freeze → biomes(geology) → settlements(geology) → roads(geology)
```

**New DEFAULTS fields:**
- `geology: true` — enable geology layer
- `geologyBandDirection: null` — null = random
- `geologyComplexity: 3` — rock type transitions (2-6)
- `igneousIntrusionCount: 1` — 0-3 blobs
- `erosionResistanceContrast: 0.7` — how much rock types affect terrain
- `coastalErosionIntensity: 0.6` — headland/bay contrast
- `riverDensityMultiplier: 1.0` — scales thresholds by permeability

**Return value** adds `geology` field.

**`extractCityContext`** extended to return:
```js
geology: {
  rockTypes: /* cropped to city bounds */,
  springLine: /* cropped to city bounds */,
  buildingMaterial: string,  // dominant rock → 'granite'|'limestone'|'brick'|'flint_brick'|'brick_timber'
  dominantRock: string,
}
```

### `src/regional/regionalTerrain.js`

When geology is present, the per-cell noise loop changes:

- **Base elevation** modulated by rock type: igneous high (0.7×amplitude), soft sed low (0.15×), alluvial near-zero (0.05×)
- **Noise amplitude** modulated: igneous 1.5× (rugged), soft sed 0.5× (gentle), chalk 0.6× (smooth downs)
- **Noise frequency** modulated: igneous 1.6× (high-frequency peaks), soft sed 0.6× (rolling)
- **Octave count** varies: igneous 5 (detailed), chalk 2 (smooth)
- All modulation is scaled by `erosionResistanceContrast` parameter (0 = no effect, 1 = full)

**Escarpment detection** (new pass after noise, before coast):
- Walk springLine cells. Where hard rock neighbors soft rock, depress the soft side by `(resistanceDiff × amplitude × 0.3 × contrast)`. This creates natural scarps.

**Coastal falloff** modified:
- Existing `minFactor` adjusted by rock erosionResistance at that cell
- Hard rock: factor biased toward 1.0 (resists depression → headland)
- Soft rock: factor biased toward 0.0 (erodes further → bay)
- Scaled by `coastalErosionIntensity` parameter

### `src/regional/drainage.js`

When geology is present:

- **Variable stream thresholds**: Per-cell effective threshold = `baseThreshold × lerp(0.5, 2.0, permeability)`. High-permeability rock (chalk, limestone) needs more accumulation for a visible stream. Implemented by filtering extracted stream segments below their local geology-adjusted threshold.
- **River character tagging**: Each stream segment gets `.character`: gorge (hard rock, resistance ≥ 0.7), meander (soft rock, resistance ≤ 0.3), underground (permeability ≥ 0.7), normal (everything else).
- **Alluvial deposits**: After stream extraction, for river/majorRiver cells in soft rock (resistance ≤ 0.4), stamp surrounding cells (radius 2-4) as ALLUVIAL in the geology rockTypes array. This is the deferred Phase 3.4 from the spec.

Return value shape is unchanged; streams gain `.character` field.

### `src/regional/biomes.js`

When geology is present:

- **Soil fertility boost**: Rock soilFertility > 0.6 expands LOWLAND_FERTILE classification to slightly higher elevations (elevNorm < 0.5 instead of 0.4) and further from water (waterDist ≤ 15 instead of 10).
- **Building material tags**: After main biome loop, overlay `building_material:<type>` resource per cell based on rock type: igneous→granite, hard_sed→limestone, soft_sed→brick, chalk→flint_brick, alluvial→brick_timber.

### `src/regional/settlements.js`

When geology is present, add scoring factors:

- **Spring-line bonus** (+25): Settlement within 5 cells of a springLine cell (reliable water at geological boundary)
- **Estuary bonus** (+70): Settlement near both coast AND river mouth (highest individual factor — combined maritime + river access)
- **Settlement character**: New field `settlementCharacter` on each settlement, derived from dominant scoring factor: estuary_city, harbor_town, spring_line_town, hilltop_fort, confluence_city, crossing_town, lowland_town. This is separate from `economicRole` (which stays unchanged for backwards compat).

### `src/regional/regionalRoads.js`

When geology is present, wrap the A* cost function:

- Hard rock cells get +3× resistance cost (roads avoid highlands unless in a valley)
- Spring-line cells get 0.6× cost multiplier (natural route along escarpment base)

### `src/rendering/regionalMap.js`

Add optional geology overlay (semi-transparent rock type coloring) when `options.showGeology && region.geology`. Rock colors: igneous=reddish, hard_sed=tan, soft_sed=olive, chalk=off-white, alluvial=brown. Spring-line cells shown as thin yellow lines.

## Implementation Stages

Each stage produces a working pipeline. Run `npx vitest run` after each.

### Stage 1: Geology Map (inert data)
- Create `src/regional/geology.js` with `generateGeology()`
- Modify `region.js`: call generateGeology, store in return value, pass as null to all downstream
- Create `test/regional/geology.test.js` (8 tests: dimensions, value range, band structure, intrusions, spring line, determinism, zero-intrusions, no-alluvial-yet)
- **All existing tests pass unchanged** — geology is generated but not consumed

### Stage 2: Geology-Driven Terrain
- Modify `regionalTerrain.js`: geology-modulated noise, escarpment detection, coastal differential erosion
- Update existing terrain test tolerances if needed (elevation range may shift)
- **Visual verification**: regionalMap shows varied terrain — rugged highlands on igneous, smooth lowlands on soft sed, escarpments at boundaries, headland/bay coastlines

### Stage 3: Geology-Aware Drainage
- Modify `drainage.js`: permeability-based threshold filtering, river character tagging, alluvial deposit generation
- New test: streams sparser in chalk zones than clay zones
- **Visible result**: fewer streams in permeable rock, alluvial flats along rivers in soft rock

### Stage 4: Geology-Enhanced Biomes + Settlements
- Modify `biomes.js`: soil fertility boost, building material tags
- Modify `settlements.js`: spring-line and estuary scoring, settlementCharacter field
- New tests: spring-line settlements exist, settlementCharacter assigned, building material resources present
- **Visible result**: settlements placed at geologically meaningful sites

### Stage 5: Roads + CityContext + Rendering
- Modify `regionalRoads.js`: geology-aware cost function
- Modify `region.js` extractCityContext: return local geology data
- Modify `regionalMap.js`: geology overlay
- Update extractCityContext test
- **Visible result**: roads follow spring lines and valleys; geology overlay shows rock types

## Verification

1. `npx vitest run` — all tests pass at each stage
2. Browser: generate regions, verify terrain matches geology (toggle overlay to compare)
3. Check headland/bay coastlines on maps with coast edges
4. Check river density varies (sparse on chalk, dense on clay)
5. Check settlements placed at spring lines, estuaries, crossings
6. Enter a city: verify CityContext.geology has buildingMaterial and dominantRock
