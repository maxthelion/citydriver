# V4 Observations

Issues and patterns noticed during development, to inform future work.

## Valleys should fill before slopes

Growth currently spreads outward from roads regardless of terrain. Back lanes climb steep hillsides while flat valley floors remain empty. In reality, development fills the easy flat land first — valley bottoms, river plains, coastal flats — and only pushes up slopes when the flat land is exhausted.

The growth loop should prefer low-slope, low-elevation land. Possible approaches:
- Weight edge selection in `fillFrontage` by average slope along the edge — flat edges fill first
- Back lanes should only be placed where the offset land is flatter than some threshold
- Nucleus growth fronts should expand preferentially downhill / into flat terrain
- Dead-end extension should target flat areas before steep ones

This is visible in the 3D view: rows of buildings marching up mountainsides while the river valley between them is empty.

## Plots placed on top rather than carved from space

See `specs/v4/block-subdivision-plots.md`. Plots are projected perpendicular to roads, not subdivided from the enclosed blocks between roads. This causes overlaps with adjacent roads and other plots.

## V5 A*-based growth: spaghetti roads and overlaps

After switching to A*-based road placement (V5), several issues remain:

### Road spaghetti
Too many short, wiggly, densely-packed roads in developed areas. The A* proximity penalty helps but isn't strong enough to prevent the frontier from spawning targets too close together. Roads weave around each other creating an organic but messy pattern rather than a structured grid.

### Road overlaps (V_noOverlappingRoads fails)
The 0.15x on-road discount in the A* cost function causes new roads to route along existing road cells, creating separate graph edges that share the same physical corridor. The validator catches these as overlapping non-adjacent edges. Fix: reject A* paths where >60% of cells are already road-occupied (redundant corridor).

### Macro-level neighborhood connections missing
Separate development clusters (around different nuclei) grow independently but don't get connected at the macro level. Need collector-level roads that bridge gaps between neighborhoods, closing loops on a larger scale. These connections should be able to cross water with a bridge penalty rather than treating water as impassable.

### Building overlaps (V_noBuildingOverlaps fails)
Buildings from adjacent plots overlap each other, likely due to plots being too tightly packed or building footprints not respecting plot boundaries precisely enough.

### Road proximity should attract, not just repel
The occupancy grid and road distance field create a proximity band around existing roads, but currently this is used as a **penalty** (pushing new roads away). Instead, the band at ~1-2 block depths from existing roads should act as an **attractor** — a gravity field that pulls new A* paths to run parallel at consistent spacing. This would naturally produce grid-like block patterns:
- Very close to a road (< 1 plot depth): penalty (too close, slivers)
- At ~1-2 block depths from a road: discount (ideal parallel spacing for blocks)
- Far from any road (> 2 block depths): neutral (no preference)
This "gravity band" would make new roads snap to good block-forming distances from existing ones, rather than just avoiding them.
