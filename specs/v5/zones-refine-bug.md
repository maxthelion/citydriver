# zones-refine destroys most development zones

## Status: Bug — discovered 2026-03-20

## Summary

The `zones-refine` pipeline step (re-running `extractZones` after `zone-boundary` adds secondary roads) destroys most development zones across all seeds tested. The initial `zones` step produces healthy zone counts, but after `zone-boundary` inserts roads and `zones-refine` re-extracts, nearly all zones vanish.

## Evidence

| Seed | After `zones` | After `zones-refine` |
|------|--------------|---------------------|
| 884469 | 37 zones (108k cells top) | 2 zones (163 cells top) |
| 400 | 58 zones (138k cells top) | 3 zones (1.5k cells top) |
| 42 | 3 zones (32k cells top) | 2 zones (31k cells top) |
| 99 | 2 zones (93k cells top) | 1 zone (93k cells top) |
| 12345 | 3 zones (10k cells top) | 2 zones (10k cells top) |

Seeds with many zones (884469, 400) are decimated. Seeds with few zones (42, 99) survive mostly intact — likely because `zone-boundary` adds fewer roads when there are fewer zone boundaries to trace.

## Impact

- The organic growth pipeline (`growth-N:*` steps) operates on the surviving zones, so cities develop on a fraction of the available land
- Experiment seed 884469 (the primary test seed for ribbon layout experiments) is completely broken — its zones shrink from 108k to 163 cells
- Seed 42 was adopted as a workaround (commit `19a8873`) but it only works by accident (few zones → less damage)
- CityScreen runs the full pipeline including `zones-refine`, so the 3D city view is also affected

## Likely cause

`zone-boundary` adds road segments along zone boundaries (`zoneBoundaryRoads.js`). These roads are stamped onto `roadGrid`. When `zones-refine` re-runs `extractZones`, the zone extraction algorithm excludes road cells — and the newly-added boundary roads may be fragmenting zones into pieces too small to pass the minimum-size filter.

The `zones-refine` step was added in commit `e04c83a` (Step 3 — zone re-extraction feedback loop). The intent was that secondary roads would split large zones into finer parcels. Instead, the boundary roads appear to be cutting zones apart in a way that destroys them.

## Pipeline context

```
skeleton → land-value → zones → zone-boundary → zones-refine → spatial → growth...
                         ^^^^                     ^^^^^^^^^^^^
                         37 zones (884469)        2 zones (884469)
```

The `zone-boundary` step is conditional — `zones-refine` only runs if `zoneBoundaryResult.segmentsAdded > 0`. For seeds where zone-boundary adds many segments, zones-refine does the most damage.

## What to investigate

1. Are the boundary roads being stamped too wide, consuming zone interior cells?
2. Is `extractZones` using a minimum zone size threshold that's too aggressive at 5m resolution?
3. Does the re-extraction use the road grid (which now includes boundary roads) as an exclusion mask, fragmenting zones along every new road?
4. Should `zones-refine` preserve the original zone definitions and only split where boundary roads actually bisect a zone, rather than re-extracting from scratch?

## Related files

- `src/city/pipeline/cityPipeline.js` — step ordering, conditional zones-refine
- `src/city/pipeline/extractZones.js` — zone extraction logic
- `src/city/pipeline/zoneBoundaryRoads.js` — boundary road insertion
- `specs/v5/next-steps.md` § Step 3 — original spec for zone re-extraction feedback loop
