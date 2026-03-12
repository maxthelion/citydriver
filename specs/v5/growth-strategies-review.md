# Growth Strategies Review

## Current state

Six strategies exist, all sharing a common skeleton (tick 1: anchor roads + MST between nuclei). They diverge from tick 2 onward:

| Strategy | Approach | Notes |
|---|---|---|
| FaceSubdivision | Recursively split large faces by connecting midpoints of longest opposite sides | Simple but can create odd-shaped blocks |
| TriangleMergeSubdiv | Like FaceSubdiv but splits along dominant axis for squarish blocks | Better block shapes |
| OffsetInfill | Parallel offset curves from skeleton + perpendicular cross streets | Geometric, regular grids |
| FrontagePressure | Back lanes behind saturated frontages + cross streets every 80m | Responsive to building placement |
| DesireLines | O/D pair pathfinding → heat map → thinning → trace roads | Most organic, but complex |
| DesireLinesThen | Chains DesireLines with a secondary strategy | Composite |

The compare screen runs FaceSubdiv, OffsetInfill, FrontagePressure, and TriMerge side by side.

## Observations

- None of the existing strategies work particularly well yet
- **FrontagePressure** creates some of the right patterns but has too many artefacts
  - Roads growing inwards on every edge of a polygon causes clashes at the corners
- All strategies need evaluation in the compare view (now showing FaceSubdiv, OffsetInfill, FrontagePressure, DesireLines)

## Ideas

### Land hierarchy: Nucleus → Parcel → Plot

Real cities grow through land being sold to developers as **parcels** — rectangular-ish blocks of land along roads. These sit above the individual plot level. The generation hierarchy should be:

1. **Nucleus** — a growth seed (market town, crossroads, waterfront, etc.)
2. **Development strip / Parcel** — a band of land along a road within ~200-300m of a nucleus, ~50m deep. Represents land sold to a developer. Has road frontage on at least one side.
3. **Plot** — individual building lot subdivided from a parcel.

This means:
- Skeleton roads radiate from nuclei
- Development parcels are claimed along those roads
- Side roads are added to give parcels rear access / subdivide them
- Plots are cut from parcels
- Buildings placed on plots

### Strip Development strategy (new, experimental)

Places development land in bands along skeleton roads near nuclei, then adds perpendicular cross streets. Currently in compare view for evaluation.

Key parameters:
- Strip length: 250m from nucleus along road
- Strip depth: 50m either side of road
- Cross street spacing: 80m

### Strip Development TODO

- Handle corners properly: where two parcels meet at a junction, plots overlap and clash. Need to detect junction proximity and either trim parcels short, miter the corner, or skip plots that would overlap.

### FrontagePressure observations

- Creates some of the right patterns
- Too many artefacts
- Roads growing inwards on every edge of a polygon causes clashes at corners — needs to be selective about which edges get back lanes

### Land-First Development (latest thinking)

**Key realisation**: all the above strategies build roads first and then try to fill in buildings. Real cities find good land and build roads to serve it. The causality is backwards.

The current land value map is too dominated by waterfront proximity — flat ground near the city center is undervalued relative to riverbanks. Land value should be driven by: flatness (primary), center proximity, contiguous buildable area, with water as a bonus only.

Development should work by:
1. Finding contiguous zones of high (revised) land value
2. Choosing a street orientation per zone based on terrain slope (contour-following for hills, flexible for flat)
3. Laying out parallel streets within each zone
4. Subdividing into plots between streets
5. Connecting zones to the skeleton road network

See: **[land-first-development.md](land-first-development.md)** for full spec and implementation plan.
