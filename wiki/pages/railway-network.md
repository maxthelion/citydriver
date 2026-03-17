---
title: "Railway Network"
category: "architecture"
tags: [railway, transport, regional, pathfinding, stations]
summary: "Design spec for a regional railway network connecting settlements to off-map cities, with historical layering, tunnel routing, and fan-shaped terminus stations."
last-modified-by: user
---

## Overview

The railway network is a regional-scale transport layer that connects settlements to each other and to imagined cities beyond the region. Unlike roads, which grow organically through a feedback loop with settlements, railways are planned infrastructure — built in historical phases from main trunk lines down to local branch lines.

Railways are inherited by cities in the same way rivers are (see [[city-generation-pipeline]]), with stations becoming landmarks and track alignments constraining development.

## Off-Map Cities

A small number of cities are imagined beyond the region edges. These are exit points that railway lines are projected toward.

Each off-map city has:
- **Name** (generated or seeded)
- **Edge position** — where the line exits the regional map
- **Size/importance** — affects line priority and capacity (double vs single track)
- **Role** — one is designated the national/regional **capital**; others might be industrial centres, ports, or market cities

Off-map city importance may feed back into regional generation — a settlement on the main line to the capital has a trade advantage, which could influence market town placement and settlement growth (see [[city-archetypes]]).

## Network Topology

The network is not a simple tree from the main city outward. It's a connected graph with heavy emphasis on major settlements:

- **Trunk lines** connect the region's tier 1-2 settlements to off-map cities, especially the capital
- **Branch lines** connect tier 3 settlements to the trunk network
- **Not every settlement gets a station** — tier 4-5 (hamlets/farms) are unlikely to have rail service

Lines between off-map exits can pass through intermediate settlements without routing via the main city. The main city is a hub but not necessarily the sole hub — a port city and an inland market town might both be junction points.

### Connection Priority

1. Main city → capital (off-map) — the primary trunk line, always double-track
2. Main city → other off-map cities — secondary trunk lines
3. Off-map → off-map through the region — cross-country routes that happen to pass through
4. Tier 2 settlements → nearest trunk line junction
5. Tier 3 settlements → nearest line of any kind (branch lines)

## Historical Layering

Lines are built in phases, reflecting how real railway networks developed:

### Phase 1: Main Line
The first line built. Connects the region's primary city to the capital (off-map). This is the highest-capacity, most direct route. Always double-track (2+ parallel lines at stations).

### Phase 2: Secondary Trunk Lines
Connect the main city to other off-map destinations and to tier 2 settlements. May share track with the main line near the main city before diverging. Double-track near cities, potentially single-track in rural sections.

### Phase 3: Branch Lines
Connect tier 3 settlements to the existing network. Single-track with passing loops. These take more liberties with gradient — branch lines were often built to cheaper standards.

### Phase 4: Cross-Country Routes
Later connections between secondary centres that bypass the main city. These might connect two off-map exits via tier 2 settlements, or link two tier 2 settlements directly.

Phase determines:
- **Track count** — main line is double/triple track near stations, branch lines are single
- **Engineering standard** — main lines have gentler gradients and longer tunnels; branch lines tolerate steeper grades
- **Speed/importance** for rendering (line thickness, colour)

## Pathfinding

Railway A* pathfinding reuses the existing infrastructure (see `src/core/pathfinding.js`) but with a radically different cost function:

### Cost Function

Railways need **very gradual elevation change**. The cost function should heavily penalise slope:

- **Gradient penalty** — much steeper than roads. Real railways max out at ~2-3% grade (1:50 to 1:33). The slope penalty should be an order of magnitude higher than road pathfinding
- **Curvature penalty** — railways prefer gentle curves. Sharp direction changes should be penalised (successive path segments with large angle difference)
- **Existing road discount** — unlike roads, railways should NOT prefer existing road corridors. They're independent infrastructure
- **Valley bonus** — cells in valleys (low local elevation relative to surroundings) should be cheaper, as they represent natural corridors through terrain
- **Water crossing penalty** — high but not infinite. Railway bridges and viaducts are expensive but common

### Tunnel Routing

When terrain forces a choice between a long detour and a short tunnel:

- Tunnels should be **as short as possible** — the algorithm should seek valleys and passes on the far side of obstacles
- A tunnel is triggered when the surface route cost exceeds a threshold vs the straight-line cost through terrain
- Tunnel segments are explicitly marked with **portal positions** (entry/exit points) and **length**
- The algorithm should prefer routing around mountains via valleys, only tunnelling through ridges where the ridge is narrow relative to the detour

Possible approach: two-pass pathfinding
1. First pass: surface-only A* with very high slope penalty to find the natural route
2. Identify segments where the path makes large detours around obstacles
3. For each detour, test whether a short tunnel (straight or gently curved through the obstacle) would be cheaper
4. Replace detour segments with tunnel+valley combinations where beneficial

### Gradient Constraints by Phase

| Phase | Max gradient | Tunnel budget | Curve radius |
|-------|-------------|---------------|--------------|
| Main line | ~1.5% | High (long tunnels OK) | Large (gentle) |
| Secondary trunk | ~2% | Medium | Medium |
| Branch line | ~3% | Low (short tunnels only) | Tighter allowed |

## Station Design

### Terminus Stations

The main city station (and potentially major junction stations) is a **terminus** — trains arrive and depart from the same end. Key characteristics:

- **Parallel platforms** — a set of parallel tracks fanning out from the station throat
- **Fan shape** — lines converge from different directions into the throat, then spread into parallel platform tracks
- **Not radial** — unlike roads which radiate from a centre point, railway lines approach from a concentrated direction and fan out. A terminus faces one direction.

The throat direction is determined by where the majority of lines approach from (typically toward the capital / most important off-map destination).

### Through Stations

Smaller settlements on a line get through stations — the line passes through with one or two platform faces. Branch line junctions have a diverging track.

### Station Inheritance by Cities

When a city inherits the regional railway, it receives:
- Station position and orientation (throat direction)
- Track alignments entering/leaving the city bounds
- Number of platform tracks (from line count and phase)
- Whether terminus or through station

This constrains city development — railway cuttings and embankments act as barriers (like rivers), and the station area becomes a land use anchor (likely industrial/commercial nearby).

## Visualization

The railway network is displayed as a **2D schematic map** — a separate screen accessible from the region view, not overlaid on the 3D terrain.

### Visual Style
- Curved lines representing track alignments (smoothed with Chaikin or similar)
- Line thickness/colour by phase and track count
- Settlement dots at stations (sized by tier)
- Off-map cities shown as labels at map edges with lines projecting outward
- Tunnel segments shown as dashed lines
- Station symbols at stops (terminus vs through)

### Navigation
- Accessible via a button on the RegionScreen (alongside "Enter City", "Debug City", etc.)
- URL mode: `?seed=<n>&mode=railway`
- Shows the same region, same seed — just a different view of the generated data

## Integration with Existing Pipeline

The railway generation step would run in the regional pipeline after roads and settlement growth (phases A7b / A6d), since railway placement should consider the mature settlement pattern:

```
... existing pipeline ...
A6d. growSettlements()
NEW: generateOffMapCities()     — place exit points on map edges
NEW: generateRailwayNetwork()   — phased line construction with A* routing
... existing continuation (land cover, etc.) ...
```

The railway grid/features are stored on the LayerStack alongside roads and rivers, available for city inheritance.

## Open Questions

- Should off-map cities influence settlement scoring earlier in the pipeline? (e.g. a "trade route" bonus for settlements near the capital direction)
- How do railway cuttings/embankments interact with terrain at city scale? Rivers carve channels — do railways create flat corridors?
- Should branch line closure be modelled? (Beeching cuts — some branch lines exist as disused corridors)
- Freight-only lines to industrial areas / ports — separate from passenger network?

## Source Files (Planned)

| File | Role |
|------|------|
| `src/regional/generateOffMapCities.js` | Off-map city placement and properties |
| `src/regional/generateRailwayNetwork.js` | Phased network construction |
| `src/core/railwayCost.js` | Railway-specific A* cost function |
| `src/ui/RailwayScreen.js` | 2D schematic visualization |
| `src/rendering/railwaySchematic.js` | Line rendering and station symbols |
