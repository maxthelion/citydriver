# Experiment 002: Throttled Ribbon Roads Before Allocation

## Previous state
See `001-baseline.md` and `001-output/`. Residential at 0%, no internal streets.

## Problems
The ribbon allocator needs roads to sprout from, but the only roads are sparse skeleton arterials. The original `layoutRibbons` produced a good organic street pattern but ran all at once.

## Hypothesis
Move `layoutRibbons` into the growth tick loop, running BEFORE allocation. Throttle it to process only a limited number of zones per tick (proportional to development proximity — zones near existing development get streets first). This creates streets incrementally, and residential can then fill the blocks between them using the existing ribbon allocator.

Roads first, then fill.

## Changes
1. In `growthTick.js`, call `layoutRibbons` (or a throttled version) before the allocation phase
2. Limit it to zones where `developmentProximity` is above a threshold — streets only appear near existing development
3. Cap the number of zones processed per tick
4. Residential ribbon allocator stays as-is — it should now find plenty of road seeds

## Results
- `002-output/reservations-seed884469-tick27.png`
- Road network is back and organic — terrain-following ribbons
- Commercial jumped from 0.6% to 4.5% — filling along all new streets
- Residential still near zero — can't compete with commercial for road frontage
- Roads still running ahead of development (5 zones/tick too aggressive)
- The street pattern itself looks good — organic, terrain-following

## Decision
KEEP — the road generation is working. Next experiment should fix residential by making it fill blocks between streets (BFS) rather than compete for road frontage (ribbon), and throttle road generation further.
