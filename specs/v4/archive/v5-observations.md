# V5 Observations

Issues, decisions, and patterns noticed during V5 development.

## Unified bitmap pipeline (implemented)

Scattered ad-hoc checks for water, sea level, slope, edge margin, and occupancy were duplicated across 5+ cost functions and 3+ buildability checks. Consolidated into two canonical sources:

- **`buildability.js`** — single float32 grid (0=unbuildable, 1=ideal). Encodes water, sea level, slope falloff, edge margin, waterfront bonus, occupancy. Recomputed after operations that change occupancy.
- **`pathCost.js`** — parameterized cost function factory. Reads buildability for all terrain checks. Only adds pathfinding-specific concerns on top: slope penalty (direction-dependent), bridge bypass, road reuse discount, plot penalty.

Key insight: buildability collapses road/plot/empty into a single score (occupied=0), but pathfinding needs to distinguish roads (discount) from plots (penalty) from empty (neutral). So occupancy stays as a separate input to pathCost.

## pathCost reads buildability, not raw terrain (implemented)

Previously pathCost duplicated water/sea/slope/edge checks that buildability already encodes. Now it reads buildability directly:
- `b < 0.01` → unbuildable (Infinity by default, configurable via `unbuildableCost`)
- `b < 0.3` → moderate penalty scaling
- `b >= 0.3` → no terrain penalty
- Bridge grid overrides unbuildable water cells

This means the available-land visualization and the pathfinding decisions now read the same data.

## Early buildability computation needed

Buildability must be computed before anchor routes (which use `anchorRouteCost` → `createPathCost` → reads buildability grid). Added an early `computeBuildability(cityLayers)` call (terrain-only, no occupancy) before anchor route generation in all three pipelines. It's recomputed later with occupancy after institutional plots and periodically during growth.

## Nucleus spacing was too tight and too central

Original niche-finding for satellite nuclei:
- Capped at 6-12 nuclei depending on tier
- Min spacing 80m (8 grid cells)
- Search limited to 35% of map radius
- Scored by proximity to center → all nuclei clustered centrally

Fixed:
- Caps raised: tier 1→20, tier 2→14, tier 3→10
- Min spacing 150m (15 grid cells)
- Search covers entire buildable map (no radius cap)
- Scoring: 50% buildability quality + 50% spacing from existing nuclei
- Niche finder receives existing nuclei list and rewards distance from them

Result: nuclei spread across all available buildable pockets rather than clustering near center.

## Satellite validation uses buildability

Regional satellite placement and niche-finding now read the buildability grid instead of duplicating water/sea/slope checks. Single check: `buildability.get(gx, gz) < 0.1` → skip. Consistent with all other land-use decisions.

## Seed propagation across screens

Seed is now passed through the full UI flow: Region → City/Debug → Back. The URL always reflects the current seed (`?seed=N` on region, `?mode=city&seed=N&gx=X&gz=Z` on city, `?mode=debug&...` on debug). Back button returns to region with the same seed pre-filled. City screen deep-links are supported.

## Path cost visualization layer

Added a `path-cost` layer to the debug bitmap viewer. Renders static traversal cost per cell (white=favoured, black=impassable). Slope excluded since it's direction-dependent — the visualization shows only the position-dependent component that buildability and occupancy contribute.
