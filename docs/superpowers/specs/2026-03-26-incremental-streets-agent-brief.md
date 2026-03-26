# Incremental Street Layout — Agent Brief

## Task

Implement the incremental street layout algorithm described in `wiki/pages/incremental-street-layout.md`. Build a modular library in `src/city/incremental/` with tests, then update `scripts/render-incremental-streets.js` to use it.

## Starting point

```
git checkout 4072e79
```

This commit has:
- The complete wiki spec at `wiki/pages/incremental-street-layout.md` — this is your source of truth
- A 547-line render script at `scripts/render-incremental-streets.js` that implements a first pass inline — **read it to understand the pipeline setup, rendering, and zone selection, but do NOT copy the algorithm. Implement fresh from the wiki spec.**
- Math utilities in `src/core/math.js` (distance2D, normalize2D, dot2D, cross2D, lerp, smoothstep, segmentsIntersect, pointToSegmentDist, pointInPolygon, polygonArea, chaikinSmooth)
- `scripts/run-experiment.js` and `scripts/pipeline-utils.js` for running experiments
- No `src/city/incremental/` directory — you're creating it from scratch

## What to build

### Module structure

Create `src/city/incremental/` with these files:

| File | Purpose |
|------|---------|
| `index.js` | Orchestration: `layoutIncrementalStreets(zone, map, params)` → `{ constructionLines, streets, parcels, plots, wasteRatio }` |
| `buildBlockedGrid.js` | Merge waterMask + roadGrid + reservationGrid into a single obstacle grid |
| `findAnchors.js` | Walk zone boundary, find segments near roads, merge into anchor edges |
| `routeConstructionLines.js` | Route construction lines from anchor roads across the zone |
| `layParallelStreets.js` | Lay parallel streets one at a time between construction line pairs |
| `validate.js` | Per-street and per-parcel validation |
| `subdivideParcels.js` | Cut parcels into building plots (Phase 3) |

Each module should have a corresponding test file in `test/city/incremental/`.

### Render script

Update `scripts/render-incremental-streets.js` to import and call `layoutIncrementalStreets` instead of implementing the algorithm inline. Keep the zone selection, rendering, and PPM/PNG output.

## The algorithm — key points from the wiki spec

Read the full wiki page. These are the points that matter most and are easiest to get wrong:

### Phase 1: Construction lines

- Construction lines are **cross streets** running approximately uphill/downhill (gradient direction)
- They originate from **anchor road edges** and walk into the zone
- Near the anchor road: direction is **perpendicular to the anchor** (clean junction)
- Deeper in: direction **blends toward terrain gradient** (smoothstep over ~100-200m)
- Spaced at ~90m intervals along each anchor edge
- Validate: must not cross water/unbuildable, must not run within 5m of another construction line
- **Must run all the way across the zone** — from anchor road to opposite boundary or opposite road. Don't stop early.

### Phase 2: Parallel streets

- Start from a **corner** of the zone (where a construction line meets the zone boundary or an anchor road)
- Lay **one street at a time**, validate, create parcel, then next
- Distance from previous street: `baseDistance / cos(angleFromPerpendicular)` — angle-aware spacing
- **Truncate at obstacles** — don't skip the whole street. If a street hits water or a road mid-segment, truncate there and form a T-junction. Only skip if the truncated street would be < 20m.
- **Adjust on failure** — if a street fails validation, try moving it ±1-2 cells before giving up
- Parcel = quad between this street and the previous one, bounded by the two construction lines
- Validate parcel: depth > 15m, width-to-depth ratio 0.5–5.0, no water cells inside

### Phase 3: Plot subdivision

- Walk along each parcel's frontage edges at regular intervals (plot width ~10m)
- Cut perpendicular to create rectangular lots
- Two rows back-to-back if parcel is deep enough
- Validate: min depth 10m, min frontage 5m

## Critical design principles

1. **"Correct by construction"** — Every street is validated before the next one is laid. If you find yourself doing batch-then-filter, you've missed the point.

2. **Truncate, don't skip** — The wiki says "Truncate at the obstacle" and "Truncate at the crossing, form T-junction." The existing render script rejects streets entirely when they hit obstacles. That's wrong. Truncate to the obstacle point and keep the valid portion.

3. **Construction lines must span the zone** — A construction line should run from the anchor road all the way to the opposite zone boundary (or another road). Short construction lines that stop after a few cells are a bug. The grace period near the anchor road must clear the road width.

4. **Waste matters** — The whole point of incremental layout is eliminating gaps. If your waste ratio is > 50%, something is structurally wrong. Common causes: construction lines stopping early, overly strict validation rejecting valid streets, poor grouping/pairing of construction lines.

5. **Perpendicular junctions** — Streets meet anchor roads at ~90°. Construction lines start perpendicular to the anchor, then curve. The blend function (perpendicular → gradient over ~150m) creates this. See the "Perpendicular Junctions" section of the wiki.

## Verification

Run experiments with:
```bash
bun scripts/run-experiment.js --experiment NNN --script render-incremental-streets.js --seeds "884469:27:95"
```

Read the output PNGs. You should see:
- Magenta construction lines spanning each zone
- Cyan parallel streets filling the corridors between construction lines
- Tinted parcel fills covering most of the zone area
- Minimal red (waste) — ideally < 40% for well-shaped zones

Additional seeds for testing: `42:15:50`, `12345:20:60`

Run unit tests with:
```bash
npx vitest run test/city/incremental/
```

## What NOT to do

- Don't copy the 547-line render script's algorithm and split it into modules. That script is a first pass that rejects streets at obstacles instead of truncating, stops construction lines early, and has no reservation awareness. Implement from the wiki spec.
- Don't batch-generate streets and post-filter. That's the old approach this replaces.
- Don't over-validate. If you're rejecting > 30% of proposed streets, your validation is too strict or your placement strategy needs work.
- Don't group construction lines by anchor edge index for pairing. Lines from adjacent anchor edges along the same road should be paired. Group by direction similarity and sort spatially.

## Parameters

```javascript
{
  constructionSpacing: 90,      // metres between construction lines along anchor
  parcelDepth: 35,              // metres between parallel streets
  minStreetLen: 20,             // minimum street segment length
  minParcelDepth: 15,           // minimum parcel dimension
  minParcelRatio: 0.5,          // width-to-depth ratio lower bound
  maxParcelRatio: 5.0,          // width-to-depth ratio upper bound
  anchorSearchRadius: 3,        // cells to search for nearby roads
  blendDistance: 150,           // anchor perpendicular → gradient blend distance
  maxConstructionLen: 500,      // max construction line length
  plotWidth: 10,                // building plot width
  minFrontage: 5,               // minimum plot frontage
  minPlotDepth: 10,             // minimum plot depth
}
```
