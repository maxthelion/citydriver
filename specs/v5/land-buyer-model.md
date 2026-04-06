# Land Buyer Model

## Purpose

This spec defines a declarative growth model for land allocation based on
**buyer families** and **buyer variants** rather than hard-coded conditional
logic inside the growth tick.

The intent is to make archetype-specific land allocation:

- easier to experiment with
- easier to debug
- easier to compose from reusable behaviors
- and clearer about the distinction between **where** a buyer wants to act in
  the city and **how** it wants to claim land inside a chosen sector

This sits on top of the land allocation work described in
[land-allocation-experiments.md](/Users/maxwilliams/dev/citygenerator/specs/v5/land-allocation-experiments.md).

---

## Why Buyers

The reservation problem is not just “apply land-use rules to cells.”

Different kinds of demand behave differently:

- commercial wants frontage and high-throughput edges
- parks and civic uses want distributed presence and coherent open space
- industrial wants large, flat, well-connected land
- residential fills residual land but still requires access and frontage
- some residential also behaves as an edge-buyer around civic space before the
  residual fill begins
- some residential seeks premium sites such as sea views, hilltops, and quiet
  edges, and accepts lower density in exchange

Treating these as declarative buyers is better than burying the logic in a
single loop full of `if` conditions, because:

- the priorities become explicit
- archetypes become compositions of buyers
- different buyer types can share claim mechanics
- the event log can report “who bought this and why”

---

## Three Layers

### 1. Archetype Program

An archetype declares which buyer families exist, how much budget they get, and
what order they run in.

Examples:

- market town
- harbour
- industrial city
- civil centre

The archetype program answers:

- which buyers are active
- which ones are dominant
- how aggressively they claim land

### 2. Buyer Family

A buyer family is a strategic actor with shared goals across the city.

Examples:

- `commercial`
- `civic`
- `industrial`
- `residential`

A family can contain multiple variants that share city-wide intent but claim
different kinds of sites.

### 3. Buyer Variant

A buyer variant is the concrete local claimant that actually reserves land.

Examples:

- `commercial/frontage-strip`
- `civic/park`
- `civic/market-square`
- `civic/church`
- `industrial/warehouse-yard`
- `residential/edge-terrace`
- `residential/hillside-villa`
- `residential/sea-view-villa`
- `residential/residual-fill`

Variants differ in:

- search constraints
- scoring
- claim shape
- road consequences

---

## Macro Search vs Micro Claim

This is the most important distinction in the model.

### Macro Search

Macro search decides **which parts of the city** a buyer family or variant wants
to act in.

Examples:

- parks want sectors distributed across the city
- warehouses want flat sectors near port infrastructure
- commercial frontage wants sectors with strong road exposure
- residential prefers sectors near claims made by commercial and civic buyers

Macro search is city-wide or zone-wide. It selects candidate sectors, faces,
corridors, or district fragments.

Typical macro fields:

- `targetSectors`
- `cityPreference`
- `minSpacing`
- `requiredAdjacency`
- `forbiddenAdjacency`
- `budget`

### Micro Claim

Micro claim decides **how the buyer reserves land inside the chosen sector**.

Examples:

- claim a shallow frontage strip
- place a rectangular park
- wrap terraced housing around a civic edge
- claim low-density housing on premium-view land
- claim a large yard
- fill residual land
- emit access gaps or a perimeter road

Typical micro fields:

- `shape`
- `edgeCondition`
- `frontageDepth`
- `targetWidth`
- `targetHeight`
- `emitRoads`
- `preserveRearAccess`
- `streetLayout`

### Reconciliation

The growth system should not conflate these layers.

The process should be:

1. A buyer family identifies macro-suitable sectors
2. A variant chooses one candidate sector or block
3. The variant performs a micro claim within that chosen area
4. The claim may emit new road constraints or generated roads
5. Later buyers work against the changed land/road state

So the question:

- “which parts of the city does this buyer want?”

is separate from:

- “which part of this sector does it want?”

---

## Road Consequences

Some claims only reserve land. Others also create road structure.

### Pure Reservation

Claims land without forcing roads.

Examples:

- industrial storage yard
- protected open land

### Frontage Reservation

Claims frontage and preserves access through gaps or stubs.

Examples:

- commercial frontage strip

Consequences:

- emits access gaps
- may emit stubs
- may imply a first internal service road

### Edge-Generating Reservation

Claims land and creates new edges that later street layout must respect.

Examples:

- park
- churchyard
- square
- station precinct

Consequences:

- perimeter road
- perimeter path
- frontage edges
- special connectors

This is why zoning and roads are not entirely separate. Some reservations are
really “land claim plus edge creation.”

### Civic-Edge Residential Reservation

Some residential should not be treated as a passive remainder.

Examples:

- terraced housing facing a park
- houses fronting a square
- tighter residential edges around a churchyard

Consequences:

- these claims happen **before** generic residual residential fill
- they use the civic edge as their frontage anchor
- they reserve a shallow residential band around the civic polygon
- the later residual ribbons fill what is left after that ring has been taken

This means residential needs at least two distinct buyer variants:

- `residential/edge-terrace`
- `residential/residual-fill`
- `residential/view-villa`

---

## Family Hierarchies

Buyer families can contain multiple related variants.

### Example: Civic Family

Family goals:

- distribute claims across the city
- avoid clustering the same amenity type
- maintain minimum spacing

Variants:

- `park`
- `market-square`
- `church`
- `hospital`

The family owns:

- city-wide distribution logic
- spacing rules
- budget split

The variant owns:

- shape
- scoring details
- road/access consequences

### Example: Port Commercial Family

Family goals:

- prefer port-adjacent, flat, connected land
- reserve coherent areas early

Variants:

- `warehouse-yard`
- `quayside-trade`
- `market-storage`

### Example: Residential Family

Family goals:

- maximize road and civic frontage for habitable plots
- avoid leaving inaccessible middle bands
- adapt plot form to surrounding use
- differentiate between high-value low-density housing and ordinary residual
  housing

Variants:

- `edge-terrace`
- `view-villa`
- `residual-fill`

The family owns:

- decisions about whether civic edges should be fronted by housing
- depth/coverage strategy for residential claims
- order between edge-claiming residential and generic residual residential
- how much premium landscape/value is consumed by affluent low-density housing

The variants own:

- whether they claim a narrow terrace band or the full residual
- whether they seek view/amenity sites at lower density
- which anchor they use
- whether they emit supporting lanes or rely on existing roads

---

## Minimal Declarative Schema

The exact JS shape can evolve, but the first version should look roughly like:

```js
{
  name: 'market-town',
  families: [
    {
      key: 'commercial',
      macroSearch: {
        targetSectors: 'road-facing-prime',
        cityPreference: 'high-centrality-near-main-roads',
      },
      familyGoals: {
        preserveRearAccess: true,
      },
      variants: [
        {
          key: 'frontage-strip',
          kind: 'frontage-strip',
          microClaim: {
            shape: 'frontage-strip',
            frontageDepth: 'half-block',
            emitRoads: ['access-gaps', 'stubs', 'service-road'],
          },
        },
      ],
    },
    {
      key: 'civic',
      macroSearch: {
        targetSectors: 'interior-buildable',
        cityPreference: 'distributed-across-city',
      },
      variants: [
        {
          key: 'park',
          kind: 'central-park',
          microClaim: {
            shape: 'rectangle',
            emitRoads: ['perimeter-road', 'connector-road'],
          },
        },
      ],
    },
    {
      key: 'residential',
      macroSearch: {
        targetSectors: 'adjacent-to-civic-or-commercial',
        cityPreference: 'fillable-and-frontage-rich',
      },
      variants: [
        {
          key: 'edge-terrace',
          kind: 'edge-terrace',
          microClaim: {
            shape: 'edge-band',
            edgeCondition: 'around-civic-space',
            frontageDepth: 'single-row',
          },
        },
        {
          key: 'view-villa',
          kind: 'view-villa',
          macroSearch: {
            targetSectors: 'high-amenity-residential',
            cityPreference: 'sea-views-hilltops-quiet-edges',
          },
          microClaim: {
            shape: 'loose-cluster',
            density: 'low',
            preferredAmenity: ['sea-view', 'hilltop', 'park-edge'],
          },
        },
        {
          key: 'residual-fill',
          kind: 'residual-fill',
          microClaim: {
            shape: 'residual-fill',
          },
        },
      ],
    },
  ],
}
```

The first engine does not need to interpret every field. It is enough that the
model shape already separates macro search from micro claim.

---

## First Execution Scope

The first execution scope should stay deliberately narrow:

- one sector
- one commercial frontage variant
- one park variant
- one residential civic-edge variant
- one residential residual fill variant

This means:

- macro search remains declarative metadata in early experiments
- micro claim is what actually runs first

That is acceptable. The important thing is to avoid designing the schema in a
way that prevents macro search from being added later.

---

## Relationship to Current Micro Experiments

The `040`–`043` experiments already exercise the micro claim rules:

- commercial frontage
- access gaps and stubs
- half-depth frontage
- residual residential fill
- central park with perimeter road

The next micro rule to add on top of these is:

- residential terrace/frontage bands around civic space before residual fill
- premium low-density residential claims on special amenity land before generic
  residual fill

The next step is to rerun those mechanics through the declarative buyer model
so that:

- commercial becomes a buyer family / variant
- civic park becomes a buyer family / variant
- residential residual fill becomes a buyer family / variant

That first buyer-program run should be considered the bridge from ad-hoc micro
experiments to the eventual archetype-level growth tick.

---

## Open Questions

- How much of macro search should be family-level vs variant-level?
- Should budgets live at family level, variant level, or both?
- When multiple buyers want the same sector, is conflict resolved by priority,
  score, or negotiated splitting?
- Which emitted roads are hard requirements versus soft suggestions?
- How should buyer decisions appear in the event log?
- When should civic-edge residential be mandatory versus optional?
- How should premium residential compete with civic and commercial claims for
  high-amenity land?

---

## Recommendation

Adopt the buyer-family model incrementally:

1. Keep the current micro geometry as the ground truth
2. Wrap it in declarative buyer families and variants
3. Log claims in buyer terms
4. Only then expand the model to true macro sector selection

This preserves fast progress while keeping the architecture aligned with the
larger city-growth vision.
