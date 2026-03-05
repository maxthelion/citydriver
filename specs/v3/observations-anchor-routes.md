# B2 Anchor Routes — Observations

File: `src/city/generateAnchorRoutes.js`

## Current approach: corridor-constrained pathfinding

Regional roads are inherited into the city via a two-step process:

1. **Map regional path to city coords** — The raw A* path from the regional model
   (every grid cell, stored as `rawPath` on each road) is converted to city-local
   world coordinates and clipped at the city boundary using Liang-Barsky interpolation.

2. **Re-pathfind at city resolution within a corridor** — A distance field is built
   from the regional centerline (BFS outward from rasterized path segments). The A*
   pathfinder uses city-scale elevation and slope data, but is constrained to stay
   within a corridor (~10 city cells / 100m) around the regional route. Cost increases
   quadratically with distance from the centerline, so roads naturally follow the
   regional route while responding to city-scale terrain features.

3. **Road sharing** — A `roadGrid` tracks cells used by already-placed roads. Later
   roads get a 0.3x cost discount on existing road cells, so overlapping corridors
   merge into shared routes instead of producing parallel duplicates. This mirrors
   the same mechanism used in regional road generation (`src/regional/generateRoads.js`).

4. **Simplify + smooth** — The city-resolution path is simplified with
   Ramer-Douglas-Peucker and smoothed with Chaikin's corner-cutting, then stored
   as a single graph edge with polyline intermediate points.

### Additional anchor elements

- **Seed connection** — The city center is connected to the nearest inherited road
  node via pathfinding (or snapped if already close).
- **Waterfront structural road** — A coastal promenade is pathfound near the city
  center using a water-proximity cost bonus. Uses hierarchy `'structural'` and is
  rendered in a distinct colour (light blue).
- **Fallback roads** — If no regional roads exist, two cardinal roads are pathfound
  from the seed to grid edges.

## Key files

- `src/regional/generateRoads.js` — Stores `rawPath` (full A* grid cells) alongside
  the simplified `path` on each road, so the city can inherit terrain-following detail.
- `src/city/extractCityContext.js` — Passes `regionalCellSize` in params for
  coordinate conversion.
- `src/city/generateAnchorRoutes.js` — The main implementation.

## History of issues and fixes

### Raw path vs simplified path
Regional roads store a simplified path (Ramer-Douglas-Peucker, epsilon 1.5) which
can reduce nearly-straight roads to just 2 points. At city scale this produced
straight lines that didn't follow terrain. Fixed by adding `rawPath` field with
every A* grid cell.

### Straight lines through water
Early versions used direct coordinate mapping without pathfinding, producing straight
edges through sea. Fixed by the corridor-constrained pathfinding approach.

### Parallel duplicate roads
Multiple regional roads sharing similar corridors produced near-parallel paths at
city scale. Fixed by the `roadGrid` sharing mechanism (0.3x discount on existing
road cells).

### Star topology
Original implementation connected all entry points to a central seed node. Fixed by
inheriting the regional road topology directly — roads connect between their
original endpoints (settlements and boundary crossings).

### Boundary crossing points
Roads that cross the city boundary have interpolated entry/exit points. These exist
as graph nodes but are NOT special destinations that other routes target — they're
just where the inherited road meets the rectangle edge.
