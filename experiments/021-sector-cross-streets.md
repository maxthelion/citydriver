# Experiment 021: Cross Streets Per Sector

## Goal

Run `layCrossStreets` on sectors (zone × face intersections) instead of whole zones, and render the results to see whether per-sector gradient directions produce better-aligned cross streets than per-zone.

## Context

Read these files first to understand the full picture:

- `wiki/pages/terrain-face-segmentation.md` — explains faces, zones, sectors, and the hierarchy
- `src/city/incremental/ridgeSegmentationV2.js` — whole-map face segmentation (gradient direction region growing)
- `src/city/incremental/crossStreets.js` — the `layCrossStreets(zone, map)` function that lays cross streets using gradient-direction sweep
- `scripts/render-cross-streets.js` — existing per-zone cross street renderer (experiment 017k baseline for comparison)
- `scripts/render-parcels.js` — sector intersection and rendering (experiment 020a is the latest)
- `experiments/017k-output/` — baseline: cross streets rendered per-zone with single gradient

## What to build

### 1. Render script: `scripts/render-sector-cross-streets.js`

Copy the boilerplate from `scripts/render-cross-streets.js` (pipeline setup, zone selection, cropped rendering, Bresenham).

For each of the top 3 zones:
1. Run `segmentTerrainV2(map, { dirTolerance: Math.PI / 6, elevTolerance: 100, slopeBands: [0.3, 0.8] })` to get faces
2. Build a `cellToFace` map (cell key → face index)
3. Intersect the zone's cells with faces to create sectors (filter out sectors < 50 cells)
4. For each sector: call `layCrossStreets(sector, map)` — the sector already has `cells`, `centroidGx/Gz`, `avgSlope`, `slopeDir` so it works as a drop-in zone replacement
5. Render:
   - Elevation grayscale base
   - Sector cells colored by sector (semi-transparent, different hue per sector)
   - Contour lines (every 5m, dark green, same as render-cross-streets.js)
   - Roads (grey)
   - Cross streets per sector (magenta polylines with green start dots, white end dots — same as render-cross-streets.js)
   - Sector boundaries (thin white lines between sectors)
   - Zone boundary (yellow, 2px thick)

### 2. Run as experiment 021

```
bun scripts/run-experiment.js --experiment 021 --script render-sector-cross-streets.js --seeds "884469:27:95"
```

### 3. Compare with experiment 017k

Read the output PNGs from both 021 and 017k and report:
- Do cross streets within each sector follow the local terrain better?
- Are there gaps or overlaps at sector boundaries?
- Do any sectors produce no cross streets (too small, weird shape)?
- Is the overall coverage better or worse than per-zone?

## Key constraints

- Don't modify any existing source files
- Run the face segmentation once per seed (not per zone) — it's a whole-map operation
- Use `run-experiment.js` for rendering, not raw scripts
- The sector needs these fields to work with `layCrossStreets`: `cells`, `centroidGx`, `centroidGz`, `avgSlope`, `slopeDir`, `boundary` (can reuse zone boundary)
- Don't run slow test files during iteration
