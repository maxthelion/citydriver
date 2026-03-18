# Experiment 001: Baseline — Current State

## Previous state
N/A — this is the starting point.

## Output
- `001-output/reservations-seed884469-tick27.png`
- `001-output/reservations-seed42-tick27.png`
- `001-output/reservations-seed12345-tick25.png`

## Current system
- Value bitmap pipeline: influence → value → allocate per tick
- Commercial: frontage allocator (thin strips along roads) — working
- Industrial/civic/openSpace: BFS blob allocator — working
- Residential: ribbon allocator — barely claiming anything (0.0-0.1%)
- Road growth: ribbon gaps become streets, cross streets from endpoints — almost nothing generated

## Problems

1. **Residential is essentially absent** — 0.0% across all three seeds. The ribbon allocator can only sprout from existing road cells, and the skeleton arterials are too sparse. Chicken-and-egg: ribbons need roads, roads come from ribbons.

2. **87% of zone cells are unclaimed** — the city is mostly empty. Only commercial frontage (along arterials), industrial/civic/openSpace blobs, and a thin agriculture belt are placed.

3. **No internal street network** — the only roads are the skeleton arterials from tick 1. No growth-tick roads are being generated because residential isn't claiming enough to produce ribbon gaps.

4. **The original layoutRibbons (tick28 render, before road fix) produced a good organic street pattern** — terrain-following, dense but natural. But it ran all at once and ahead of land allocation.

## Key observation
The previous layoutRibbons system generated nice roads. The problem was it wasn't tick-limited. If we bring it back but throttled per tick, and run it BEFORE allocation (roads first, then fill between them), the chicken-and-egg problem goes away.
