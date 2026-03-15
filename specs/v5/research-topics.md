# Research Topics

Topics for further discussion, grouped by domain.

## Status notes

- **Railways** don't exist in the current generator. Topics referencing them
  (railside industrial zones, terminus vs through station, railway episodes)
  are aspirational. Railways may need to be simulated as a regional feature
  before city-scale effects can use them.
- **Rivers** exist in the regional pipeline but are somewhat broken at city
  import — tributary structure is lost and rivers enter abruptly at city
  boundaries (see code-observations.md #4, #5). River-dependent features
  (waterfront archetypes, mill placement, river crossings) need river import
  to be fixed or simulated first.
- **Implementation approach**: any work arising from these topics should be
  organized as a step in the existing city pipeline (tick N), not as a
  separate system.

- **Plot Structure**
  - Plot size determination
  - Plot shape and boundary rules
  - Plot subdivision and amalgamation
  - Vertical land use profiles
  - Frontage vs depth tradeoff

- **Ownership and Tenure**
  - Plot ownership and tenure systems
  - Road ownership and dedication
  - Road provision as landowner tradeoff
  - Unified vs fragmented ownership effects
  - Leasehold estate vs freehold sale
  - Institutional plot persistence

- **Block and Street Structure**
  - Block size and origin
  - Block persistence under unified ownership
  - Commercial spine types
  - Road creation in planned vs organic subdivision

- **Land Use**
  - Land use taxonomy
  - Land use mixing and planning era
  - Civic square and plaza placement
  - Industrial zone placement rules
  - Landmark building types
  - Landmark precinct influence
  - Permanent use flagging

- **Open Space**
  - Park and open space types
  - Park land value radiation
  - Cemetery persistence
  - Industrial monument conversion

- **City Character and Archetypes**
  - City archetypes for practical generation
  - Archetype blending
  - Density profiles and falloff curves
  - Founding geometric intention
  - Cultural region and privacy norms
  - Commercial spine types

- **Founding Conditions**
  - Founding purpose taxonomy
  - Founding date and epoch entry
  - Age classes and morphological layering
  - Settlement hierarchy derivation
  - Gateway city logic

- **Epochs and Episodes**
  - Episode architecture
  - Episode types taxonomy
  - Organic growth as iterated micro-episode
  - Spatial primitives library
  - City state data structure
  - Chronology loop structure
  - Era as capability and pressure bundle
  - Epoch transition system
  - Clearance episode triggers
  - Decline and regeneration episodes
  - Railway episode and morphological effects
  - Terminus vs through station logic
  - Motorway episode and clearance effects
  - Airport as satellite development cluster

- **Regional and Off-Map Forces**
  - External pressure field
  - Off-map attractors and cardinal pressures
  - Map edge context
  - World state parameters
  - Market town spacing via central place theory

- **Geography and Environment**
  - Internal geography layer stack
  - Macroclimate parameters
  - Mesoclimate derivation from terrain
  - Weather as episode trigger
  - Agricultural potential layer
  - Agricultural surplus type
  - Hinterland carrying capacity
  - Resource deposits and industrial demand

- **LLM Integration**
  - LLM decision layer architecture
  - Bitmap layer rendering for LLM input
  - Structured episode output and validation
  - Reasoning trace as city narrative
  - Compression strategies for LLM specs
