# River Tributary Observations

## Problem

Too many tributaries feeding into rivers. The current river generation
produces dense dendritic networks that look more like a drainage diagram
than a natural landscape. Almost every valley gets a watercourse, and
they all converge into the main rivers.

## How Real Rivers Work

**Mountains and hills are the primary source.** Rainfall and snowmelt on
high ground creates streams. These streams follow gravity downhill and
merge into rivers. The key point: rivers START on high ground, they
don't START on plains.

**Plains absorb water.** On flat ground, water infiltrates into the soil
rather than flowing overland. Plains have high water tables but few
surface watercourses. The main rivers that cross plains are fed from
distant mountains, not from local rainfall. A river on a plain is
passing through, not starting there.

**Tributary density correlates with slope and rainfall.** Steep terrain
with high rainfall (mountains) has dense tributary networks. Gentle
terrain with moderate rainfall (lowlands) has sparse tributaries. Very
flat terrain (plains, marshes) may have no visible tributaries at all —
just the main river channel.

**Stream order matters.** A first-order stream is a tiny headwater
trickle on a mountainside. Two first-order streams merge to form a
second-order stream. Two second-order streams merge to form third-order.
By the time a river reaches the lowlands, it's typically 3rd-5th order
and has few if any new tributaries joining it.

## What to Change

1. **Start streams only above a slope threshold.** If the local terrain
   is flat (slope < some threshold), don't generate a stream there even
   if the flow accumulation says water would collect. Water on flat
   ground goes underground.

2. **Reduce tributary density on lowlands.** Weight the stream generation
   by terrain steepness. On mountains: many small streams converging.
   On plains: just the main channel, maybe one or two large tributaries.

3. **Flow accumulation threshold scales with slope.** On steep terrain,
   a small catchment area is enough to produce a visible stream. On flat
   terrain, you need a much larger catchment before surface water
   appears.

4. **Prune short tributaries.** After generating the network, remove
   tributaries shorter than a threshold. This cleans up the tiny
   first-order streams that clutter flat areas.

## Possible Implementation

In the river generation step:

```
for each cell in flow accumulation order:
  if flow_accumulation[cell] > threshold(slope[cell]):
    mark as river
  else:
    skip — water infiltrates here

threshold(slope):
  if slope > 0.15: return 50   // steep mountain: small catchment needed
  if slope > 0.08: return 200  // hills: moderate catchment
  if slope > 0.03: return 800  // gentle terrain: large catchment
  return 2000                   // flat plains: very large catchment only
```

This means:
- Mountain streams appear with just 50 cells of uphill catchment
- Plains only show rivers with 2000+ cells of catchment (major rivers)
- The transition is gradual with terrain

## Reference

Real-world drainage density (km of stream per km² of land):
- Mountain areas: 5-15 km/km²
- Hilly terrain: 2-5 km/km²
- Rolling plains: 0.5-2 km/km²
- Flat plains/marsh: < 0.5 km/km²

We should aim for similar ratios scaled to our grid resolution.
