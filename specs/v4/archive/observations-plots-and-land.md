# Observations: Plots, Land Scarcity, and Urban Growth

## The Core Tension

Plots are currently generated after streets, as a downstream step. But in
reality, plots are the economic unit that drives everything. Streets exist to
serve plots. Buildings exist on plots. The value of land determines what gets
built where.

We've moved toward frontage-first generation (plots projected from road
edges), which is better than face extraction, but plots still don't
influence road placement. They're passive consumers of whatever road layout
the earlier steps produce. The result feels mechanical -- every road gets
plots on both sides regardless of whether those plots make economic sense.

## The Pipeline Problem

Up to step 4 (anchor routes), the current pipeline makes sense:
1. Extract context (elevation, water)
2. Refine terrain (slope, rivers)
3. Anchor routes (regional roads clipped into city)
4. River crossings (bridges)

After that, neighborhoods start generating roads that don't relate to plot
demand. The neighborhood connection step (C5) creates arterials between
nuclei, but then the street generation (C7) adds local streets without
any understanding of what those streets are for.

**Proposed revision:** After step 4, run density/districting, then start
placing plots directly. Plots should drive where new streets appear, not
the other way around.

## Land as a Scarce Resource

A city has a finite amount of buildable land. As it grows, land becomes
scarcer and more valuable. This scarcity creates pressure that shapes the
city:

**Early growth (low scarcity):**
- Land is cheap and abundant
- Large institutions claim big plots: churches, markets, hospitals, schools
- Parks and commons are established (nobody else wants the land yet)
- Plots are generous -- wide frontages, deep gardens
- Streets are wide because there's no pressure to squeeze

**Mid growth (moderate scarcity):**
- Remaining land near the centre becomes valuable
- New plots are smaller than the originals
- Back-land behind existing plots gets developed (back lanes appear)
- Gardens get shortened to create new building plots
- Institutions that need space must go to the periphery

**Late growth (high scarcity):**
- Infill everywhere -- any gap gets a building
- Plot subdivision: a wide plot gets split into two narrow ones
- Plot amalgamation: several small plots get merged for a large building
- Vertical growth: more floors on existing footprints
- Streets can't be widened because buildings are in the way

This progression is what gives real cities their character. The old town has
wide plots with big gardens because they were laid out when land was cheap.
The Victorian terraces are narrow because they were squeezed in later. The
modern estates are on the edge because that's where land was available.

## What This Means for Generation

### Large plots should be placed first

Parks, hospitals, schools, markets, churches -- these need large contiguous
areas. In the current pipeline they're added as amenities after buildings,
which is backwards. A park isn't squeezed into leftover space -- the park
was there first and buildings grew around it.

Proposed order after anchor routes:
1. Density/districting pass (what kind of area is this?)
2. Large institutional plots (parks, churches, markets, hospitals)
3. Primary frontage plots along arterials (generous sizes)
4. Neighborhood connector streets (driven by plot demand)
5. Secondary frontage plots along new streets (smaller sizes)
6. Back lanes and cross streets (where density warrants)
7. Infill plots in remaining gaps
8. Buildings on plots

### Plot economics should vary by location

Not every plot is equally valuable. Factors:

| Factor | Effect on plot value |
|--------|---------------------|
| Distance from centre | Closer = more valuable |
| Road hierarchy | Arterial frontage > local street |
| Slope | Flat > sloped |
| Water adjacency | Premium for waterfront, penalty for flood risk |
| Existing density | Being near other buildings increases value |

High-value plots get built first and get denser development. Low-value
plots might stay as gardens or fields for a long time.

### Plot size should respond to demand

In high-demand areas:
- Frontage width shrinks (more buildings per road length)
- Depth stays roughly constant (you need a minimum for a building + garden)
- Coverage increases (less garden, more building)
- Buildings grow taller

In low-demand areas:
- Wider frontages (land is cheap, why not?)
- Deeper plots (room for big gardens)
- Low coverage (lots of open space)
- Single storey

We currently handle this with the density field, but it's applied uniformly.
A more realistic model would have the density emerge from the economics
rather than being imposed.

### Plot amalgamation and subdivision

Real cities constantly rework their plots:

**Subdivision** -- a large plot gets split:
- Owner sells half their garden as a building plot
- A detached house plot becomes two terraced house plots
- A farm field gets parcelled into housing plots

**Amalgamation** -- several plots get merged:
- A developer buys three terraced houses, demolishes them, builds flats
- A supermarket absorbs several shops and their plots
- An institution expands into neighboring plots

This is hard to simulate procedurally but could be approximated:
- After initial plot generation, scan for clusters of small plots that
  could become one large institutional plot
- In high-density areas, merge adjacent narrow plots into wider ones
  suitable for larger buildings

## Implications for the Pipeline

The current pipeline treats plots as a single pass after streets. A more
realistic model would interleave plot generation with street generation
across multiple "epochs" of city growth:

```
Epoch 1 (founding):
  - Main streets from regional roads
  - Central market/church (large plot)
  - Park/common land
  - Large plots along main streets

Epoch 2 (growth):
  - Back lanes behind deep plots
  - Cross streets to create new blocks
  - Smaller plots along new streets
  - First institutions (school, hospital)

Epoch 3 (densification):
  - Plot subdivision in high-demand areas
  - Infill development
  - Taller buildings replacing shorter ones
  - Streets extended to periphery

Epoch 4 (sprawl):
  - Suburban plots on the edge
  - Low-density development
  - Large plots for out-of-town retail/industry
```

Each epoch produces plots of a characteristic size and type. The overlap
of epochs creates the layered texture of a real city -- medieval core,
Georgian terraces, Victorian suburbs, modern estates.

## Open Questions

- How many epochs are worth simulating? Even 2-3 would be a big improvement
  over the current single-pass approach.
- Should large institutional plots be carved out of the plot grid, or should
  they be placed first and the grid built around them?
- How do we handle the transition? If epoch 1 places large plots, epoch 2
  shouldn't overwrite them -- it should fill the gaps.
- Can we use the density field to approximate epochs? High density = later
  epoch = smaller plots?
- Should roads have an "era" attribute that affects their width and style?
  A medieval lane vs a Georgian boulevard vs a modern bypass.
