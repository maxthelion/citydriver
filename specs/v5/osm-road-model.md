# OSM Road Model — Alignment and Export Plan

## Background

OpenStreetMap models roads as **Ways** — ordered sequences of shared **Nodes**.
A junction is not an explicit object; it emerges naturally from two Ways
referencing the same Node. This is fundamentally different from the current
city generator model, where roads are independent polylines and junctions are
nodes in a separate `PlanarGraph` that must be kept in sync with the polylines.

This document covers two related but separable goals:

1. **Export** — emit the generated road network in OSM or GeoJSON format so it
   can be viewed and analysed in standard map tools
2. **Internal alignment** — restructure the road network model to use shared
   nodes, which solves the sync problem documented in
   `road-network-abstraction.md` as a side effect

---

## Why This Matters

### What OSM export enables

- View generated cities in **JOSM** or **iD editor** — proper map tools with
  filtering, validation, and query support
- Load into **QGIS** for spatial analysis and comparison with real cities
- Feed into **OSRM** or **Valhalla** to run a routing engine on a generated
  city — useful for evaluating connectivity
- Overlay on real map tiles to compare generated vs real city structure at the
  same location
- Use as ground truth for the petri loop visual evaluation tier

### What internal alignment fixes

The current model has two parallel representations of the same topology:

```
Road (polyline)  ←→  PlanarGraph (nodes + edges)
```

These must be kept in sync manually by `RoadNetwork`. Six sites in the pipeline
bypass this sync (see `road-network-abstraction.md`). The root cause is that
the graph and the polylines are independent — a change to one doesn't
automatically propagate to the other.

In the OSM model, there is no separate graph. The topology *is* the structure:

```
Way (ordered Node refs)  — junctions emerge from shared Node references
```

Adopting this internally eliminates the sync problem because there is nothing
to sync.

---

## Part 1: Export

This is independently useful and low risk. It adds a translation layer over
the existing model without changing internals.

### Coordinate system

The generator uses local metric coordinates (`originX`, `originZ` in metres).
OSM requires latitude/longitude. Two options:

**Fictitious anchor** — pick a plausible real-world anchor (e.g. `51.5, -0.1`
for a London-ish location) and apply an equirectangular projection:

```js
function toLatLon(x, z, anchor) {
  return {
    lat: anchor.lat + z / 111320,
    lon: anchor.lon + x / (111320 * Math.cos(anchor.lat * Math.PI / 180)),
  };
}
```

Sufficient for display in map tools. The city won't align with real terrain
but the road network will be correctly shaped and scaled.

**Real-world anchor** — if the regional map ever gains a geographic reference
point (e.g. the regional origin mapped to a real lat/lon), export the city at
its actual location and overlay on real map tiles. This would require a
geographic anchor in the regional pipeline parameters.

For now, use a fictitious anchor with a configurable default.

### Attribute mapping

| Generator | OSM tag |
|-----------|---------|
| `hierarchy: 'arterial'` | `highway=primary` |
| `hierarchy: 'collector'` | `highway=tertiary` |
| `hierarchy: 'local'` | `highway=residential` |
| `hierarchy: 'boundary'` | skip — not a physical road |
| `width` | `width=N` |
| `source` | `generator:source=N` (custom namespace) |
| bridge segment | `bridge=yes` on the bridge Way |

### Node deduplication at junctions

A naive export creates one Node per polyline point, with no sharing at
junctions — two Roads ending at the same world position would produce two
separate Nodes. OSM validators and routing engines require proper shared nodes.

The `PlanarGraph` already has junction nodes with their world positions. The
correct export uses graph nodes as OSM Nodes and intermediate polyline points
as non-junction OSM Nodes:

```
For each Road:
  - graph node at road.start → OSM Node (junction candidate)
  - intermediate polyline points → OSM Nodes (geometry only, not junctions)
  - graph node at road.end → OSM Node (junction candidate)
  - all three groups → OSM Way (ordered node refs)
```

Junction OSM Nodes are shared across Ways that meet at that graph node.
Intermediate Nodes belong to exactly one Way.

### OSM XML format

Writing OSM XML requires no library — it is simple well-documented XML:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="citygenerator">
  <node id="-1" lat="51.50012" lon="-0.10034"/>
  <node id="-2" lat="51.50045" lon="-0.10078"/>
  <way id="-101">
    <nd ref="-1"/>
    <nd ref="-2"/>
    <tag k="highway" v="residential"/>
    <tag k="width" v="6"/>
    <tag k="generator:source" v="growth-ribbon"/>
  </way>
</osm>
```

Generated IDs are negative by convention (positive IDs are reserved for
real OSM data). A simple counter suffices.

### GeoJSON format

GeoJSON is simpler and more universally readable when OSM tooling is not the
goal. Paste into geojson.io for instant visual inspection:

```js
{
  type: 'FeatureCollection',
  features: map.roads
    .filter(r => r.hierarchy !== 'boundary')
    .map(road => ({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: road.polyline.map(p => [p.x, p.z]),
      },
      properties: {
        highway: hierarchyToHighway(road.hierarchy),
        width: road.width,
        source: road.source,
        id: road.id,
      },
    })),
}
```

### Implementation plan

1. Add `src/core/exportGeoJSON.js` — GeoJSON export from a `FeatureMap`.
   Include roads, rivers, and zone boundaries as separate feature layers.
   No coordinate projection for now (use raw x/z as coordinates).

2. Add `src/core/exportOSM.js` — OSM XML export with proper node deduplication
   using the existing `PlanarGraph` junction nodes. Apply equirectangular
   projection with a configurable anchor.

3. Add `scripts/export-city.js` — CLI script:
   ```bash
   bun scripts/export-city.js --seed 42 --format osm --output city.osm
   bun scripts/export-city.js --seed 42 --format geojson --output city.geojson
   ```

4. Add a download button to the debug UI that exports the current city as
   GeoJSON (browser can trigger a file download directly).

---

## Part 2: Internal Alignment

This is the larger, longer-term change. It reframes the work in
`road-network-abstraction.md` as an OSM-style model migration rather than a
series of individual bug fixes.

### The target model

```js
class OsmNode {
  id        // integer
  x, z      // world coordinates
  tags      // Map (rarely needed — junctions carry no tags in the generator)
}

class OsmWay {
  id        // integer
  nodes     // OsmNode[] — shared references, not copies
  tags      // { highway, width, source, ... }
  bridges   // parametric bridge annotations (generator-specific extension)
}
```

A junction is any `OsmNode` referenced by more than one `OsmWay`. No separate
graph object. `PlanarGraph` still exists for face extraction — it consumes the
Way/Node structure — but it is derived from the Ways rather than maintained in
parallel.

### What this fixes

| Current problem | How shared-node model fixes it |
|----------------|-------------------------------|
| `growRoads` direct `roadGrid.set()` | Ways are the source of truth; grid is derived by stamping all Ways |
| `road._replacePolyline` skips grid re-stamp | Replacing a Way's nodes triggers re-stamp automatically |
| `graph.splitEdge()` bypasses RoadNetwork | Splitting a Way inserts a Node into its `nodes` array; graph is rebuilt from Ways |
| `graph.mergeNodes()` bypasses RoadNetwork | Merging two Nodes updates all Ways that reference either; graph follows |
| `graph._adjacency.delete()` direct access | No separate adjacency structure to corrupt |

### The `roadGrid` stays as a derived raster

The bitmap is still needed for pathfinding cost functions, zone extraction
barriers, and invariant checks. It becomes strictly derived — always
reconstructable from the current set of Ways by stamping each Way's node
sequence. Never mutated directly.

### `PlanarGraph` becomes a view over Ways

`facesWithEdges()` operates on the graph. The graph is rebuilt or
incrementally updated when Ways are added or removed. The graph is no longer a
parallel source of truth — it's a derived topological view.

Adding a Way:
1. Insert shared Nodes (or reuse existing Nodes at the same position within
   snap distance)
2. Stamp the Way's node sequence into `roadGrid`
3. Add the corresponding edge(s) to the graph

Removing a Way:
1. Unstamp from `roadGrid` (ref-counted, as today)
2. Remove edge(s) from the graph
3. Remove any Nodes that are no longer referenced

Splitting a Way at a point:
1. Insert a new Node at the split point into the Way's `nodes` array
2. Split the Way into two Ways sharing that Node
3. Update `roadGrid` (no change — same cells)
4. Update graph (replace one edge with two)

### Migration path

This is a significant change. It should be done incrementally, not all at
once.

**Step 1:** Add `OsmNode` and `OsmWay` classes alongside the existing `Road`
and `PlanarGraph`. No migration yet — just define the target model.

**Step 2:** Make `RoadNetwork` maintain an `OsmWay` for each `Road` it creates,
sharing `OsmNode` objects at graph junction positions. This is additive — the
existing model continues to work, but the OSM representation is kept in sync.

**Step 3:** Build the export from the `OsmWay`/`OsmNode` structure (Part 1,
step 2). Validate it in JOSM and with a routing engine.

**Step 4:** Incrementally replace the bypass sites in
`road-network-abstraction.md` using the shared-node model. Each fix makes the
old `Road`+`PlanarGraph` model less necessary.

**Step 5:** Remove `Road` and the direct `PlanarGraph` manipulation. `RoadNetwork`
becomes a thin wrapper over `OsmWay`/`OsmNode` that also maintains the derived
`roadGrid`.

### What to keep from the current model

- `roadGrid` — the derived raster bitmap (keep, but make strictly derived)
- `bridgeGrid` — same
- Bridge annotations — OSM uses `bridge=yes` on a Way segment; keep the
  current parametric model as a generator-specific extension alongside OSM tags
- `PlanarGraph.facesWithEdges()` — OSM has no concept of faces; keep this as
  the mechanism for zone extraction, but rebuild it from Ways rather than
  maintaining it in parallel

### Generator-specific OSM extensions

Some generator concepts have no OSM equivalent and should be kept as custom
tags or separate data:

| Generator concept | Representation |
|---|---|
| `importance` | `generator:importance=0.45` |
| `source` | `generator:source=growth-ribbon` |
| Bridge parametric data | Store on Way alongside standard `bridge=yes` tag |
| Road hierarchy beyond highway class | `generator:hierarchy=arterial` |

---

## Relationship to Other Specs

- **`road-network-abstraction.md`** — the six bypass violations this plan fixes
  as a side effect. The individual fixes described there are the short-term
  path; internal OSM alignment is the long-term structural solution.
- **`pipeline-event-log.md`** — road mutations (Way added, Node inserted, Way
  split) are natural events for the event log. The OSM model makes these
  mutations explicit and named rather than implicit grid writes.
- **`functionality-overview.md`** — the regional road network (connecting
  settlements) and the city road network (skeleton, collectors, ribbons) would
  both be exportable once the export layer exists. A single city.osm file could
  contain both.

---

## Open Questions

- Should the geographic anchor be configurable per-region, or always fictitious?
- Should rivers and zone boundaries be included in the OSM export (as
  `waterway=river` Ways and custom relation types)?
- Should the export include buildings and plots as OSM `building=yes` closed
  Ways once those are generated?
- Does the routing engine use case (OSRM/Valhalla) require oneway tags and turn
  restrictions, or is the road network useful without them?
- Should `OsmRelation` be modelled for named roads (grouping Ways that form a
  single named street) or is this premature?
