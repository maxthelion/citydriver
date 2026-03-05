# Density, Sprawl, and Population

## The Question

Should population be an **input** or an **output** of the city generator?

Currently it's an input: each settlement tier has a target population
(tier 1 = 50k, tier 2 = 10k, tier 3 = 2k). The generator tries to fill
that budget by placing buildings until the population is reached. This
is a constraint-satisfaction approach — "make a city for 50,000 people."

The alternative: population is an **output**. The generator grows a city
organically — placing neighborhoods, filling them with streets and
buildings — and the population is whatever the housing stock supports.
Growth continues until some stopping condition is met, not until a
number is hit.

## Arguments for Population-as-Output

**More organic results.** Real cities don't grow to a target. They grow
because there's demand: jobs, trade, resources, safety. A city near a
good harbour and two trade roads grows more than a city on a remote
hillside, not because someone planned for 50k people, but because
the geography attracted more settlement. If we let the generator grow
until it runs out of suitable land or demand, the result should feel
more natural.

**Self-regulating density.** Instead of painting a density gradient and
filling it, the system would start sparse and densify where there's
pressure. A neighborhood near the old town has high demand (central,
good access) so it fills up quickly and buildings get taller. A distant
suburban neighborhood fills slowly and stays low-rise. Density emerges
from proximity and access, not from a mathematical function.

**Avoids the "budget accounting" problem.** The current approach has to
track remaining population budget and distribute it across buildings.
This leads to awkward situations: the budget runs out mid-neighborhood,
or a building gets 3 floors because the budget needs exactly 12 more
people. If population is an output, every building simply gets the
number of floors appropriate to its location and type.

**Natural city size variation.** Two tier-2 settlements in different
terrain should produce different-sized cities. One on a wide plain with
good road access might sprawl into a large town. One hemmed in by
mountains might be small but dense. With population-as-input, both
would target the same 10k. With population-as-output, the geography
drives the size.

## Arguments for Population-as-Input

**Predictable game balance.** If the game needs a city of roughly 50k
people at this location, it needs to know it'll get one. Population-as-
output might produce 5k or 500k depending on terrain — hard to plan
around.

**Faster generation.** A target lets the generator stop when it's done.
Without a target, what's the stopping condition? "Keep growing until
the terrain runs out" could mean generating a huge sprawl for a seed
that happens to have lots of flat land.

**Easier to test and debug.** A target population is a concrete
validation metric.

## Proposed: Hybrid — Organic Growth with Soft Limits

Combine both approaches:

1. **Growth is organic.** Neighborhoods expand outward from their nuclei,
   filling suitable terrain. Buildings get floors based on location, not
   budget. Density emerges from the neighborhood influence field.

2. **Tier sets a soft limit.** The tier determines how many neighborhood
   nuclei are placed (existing C4 logic) and their maximum combined
   radius. This indirectly controls city size: a tier-1 city gets 12
   nuclei spread over a large area, a tier-3 gets 3 in a small area.

3. **Population is computed, not allocated.** After buildings are placed,
   count the total housing capacity. This is the output population. It
   will naturally correlate with tier because tier controls nucleus count
   and radius.

4. **Feedback loop (optional).** If the output population is wildly off
   from expectation:
   - Too small: increase building heights in dense areas, or add another
     neighborhood nucleus
   - Too large: stop placing buildings in the lowest-density areas

   This is a gentle nudge, not a hard constraint. The city should look
   the same whether population is 45k or 55k.

## Growth Algorithm

Instead of generating all streets at once, grow the city iteratively:

```
1. Place neighborhood nuclei (C4 — already done)
2. For each growth step:
   a. Expand the buildable frontier outward from each nucleus
   b. Lay down streets in newly-buildable cells
   c. Place buildings along new streets
   d. Compute running population
   e. Stop when:
      - No more suitable terrain to expand into, OR
      - Population exceeds tier soft limit × 1.5, OR
      - Max iterations reached
3. Densification pass:
   a. In high-demand areas (near center, near multiple roads),
      increase building heights
   b. Add infill buildings in underused plots
```

This produces a city that grew outward from its seeds and densified
where demand was highest — much like real urban growth.

## Density Emerges from Access

The key insight: **density should be a function of access, not an input.**

A cell's density is determined by:
- How many neighborhoods it's within reach of (more = higher demand)
- How well-connected it is by roads (more connections = more access)
- Proximity to the old town / commercial core
- Terrain quality (flat, not flooded, good drainage)

This is essentially what the neighborhood influence field already does
(C6). The question is whether to use it as a hard constraint ("density
must be X here, so place buildings until X is met") or as a guide
("buildings in this area should be taller/denser because demand is
high").

The guide approach is more organic. A building in a high-density area
gets more floors because that's what the demand supports, not because
a budget says so.

## Sprawl Control

Without a hard population limit, what prevents infinite sprawl?

1. **Terrain constraints.** Water, steep slopes, and map edges naturally
   limit growth. A coastal city can only grow inland.

2. **Diminishing returns.** Neighborhoods far from center have low
   importance (existing C4 logic). At some distance, importance drops
   below the threshold and no more nuclei are placed.

3. **Tier-based nucleus count.** The number of nuclei is capped by tier.
   Since each nucleus has a finite influence radius, the city's maximum
   extent is bounded.

4. **Infrastructure cost.** Optionally: streets that are too far from
   existing infrastructure are more "expensive" (in some abstract sense)
   and get deprioritized. This naturally limits sprawl along single
   corridors.

## Population Estimation

After generation, estimate population from the built environment:

```js
for each building:
  if residential:
    floors × units_per_floor × people_per_unit
  if mixed-use:
    (floors - 1) × units_per_floor × people_per_unit  // upper floors
    // ground floor is commercial, doesn't count as housing
```

Typical densities:
- Terraced housing: ~100 people/hectare
- Semi-detached: ~50 people/hectare
- Detached suburban: ~25 people/hectare
- Dense urban (4+ floors): ~200-400 people/hectare
- Industrial/commercial: ~0 residential

The neighborhood type directly maps to a housing density profile, so
population is a natural output of the neighborhood composition.

## Implementation Path

1. Remove explicit population budget from building generation
2. Buildings get floors based on neighborhood type + density field
3. After all buildings placed, compute total population
4. Store population as output metadata on the city
5. If feedback loop is wanted: compare output to tier target, adjust
   building heights by ±1 floor in the densest areas, recompute
6. Validate: tier-1 cities should produce roughly 30k-80k, tier-2
   roughly 5k-20k, tier-3 roughly 1k-5k

## Open Questions

- Should the growth algorithm be iterative (expand step by step) or
  one-shot (place everything, then adjust)? Iterative is more organic
  but slower. One-shot is what we have now and is simpler.

- How much variation in population is acceptable? If tier-2 cities
  range from 3k to 30k depending on terrain, is that a feature or a
  problem?

- Should population affect the game (NPC counts, economy, military
  strength)? If so, predictability matters more. If it's just flavor,
  variation is fine.
