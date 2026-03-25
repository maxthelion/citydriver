---
title: "Spatial Concepts"
category: "concepts"
tags: [concepts, zones, parcels, plots, ribbons, roads, glossary]
summary: "The hierarchy of spatial concepts in the city generator — what each thing IS, how they relate, and what questions they answer."
last-modified-by: user
---

## Overview

The city generator works with a hierarchy of spatial concepts. Each level answers a different question about the land. Understanding these concepts — what they mean in the real world, not just in the code — is essential for making good design decisions.

```
City map
  └── Zones — "what land is available?"
        └── Parcels / Reservations — "what is this land for?"
              └── Ribbons — "how is this land laid out?" (one possible layout)
                    └── Plots — "who owns this piece?"
                          └── Buildings — "what's built here?"
```

## The Concepts

### Zone

**What it is:** A piece of land enclosed by boundaries — roads, rivers, coastline, or the edge of the map. The remainder after roads and water have been accounted for.

**Real-world analogy:** A city block. The area between streets.

**What question it answers:** "What land exists that we could potentially do something with?"

**Key properties:**
- Bounded by roads, water, and map edges
- Contains only buildable land (steep slopes, water excluded)
- Has terrain metadata (slope, direction) that influences what can be built
- Has land value that influences development priority
- Does NOT have a single use type — a zone can contain multiple uses

**Relationship to other concepts:** A zone is subdivided into parcels. A zone's boundaries are roads and natural features. A zone may contain commercial along the anchor road and residential in the interior.

See [zones](zones) for full details.

### Parcel (Reservation)

**What it is:** An area within a zone that is given over to a particular use. The parcel is the spatial extent; the reservation is the decision about what it's for.

**Real-world analogy:** A planning designation. "This area is zoned for residential." "This strip along the high street is commercial."

**What question it answers:** "What is this land for?"

**Key properties:**
- Always inside a zone (a zone may contain multiple parcels)
- Has a single use type (residential, commercial, industrial, civic, open space, etc.)
- Contiguous — a parcel is one connected area, not scattered cells
- Shape is influenced by the use type and the zone's geometry

**How parcels are created:** Growth agents claim cells within zones based on value bitmaps and allocation strategies. The claimed cells form parcels. Different agents use different allocation patterns:
- Commercial claims road frontage (thin strip along roads)
- Residential claims larger areas (filled with ribbons)
- Industrial claims whole zones or large sub-zones
- Civic claims specific plots for typed buildings

**Relationship to other concepts:** A parcel is inside a zone. A parcel is filled by a layout strategy (ribbons for residential, frontage for commercial). A parcel contains plots.

### Ribbon

**What it is:** A layout pattern, not a spatial unit. Ribbons are parallel streets running through a residential parcel, creating rows of buildable land on both sides of each street. It's a way of organizing residential development.

**Real-world analogy:** A terraced street — a row of houses facing a road, with another row behind facing the next parallel road. Typical of British Victorian housing, planned suburbs, and anywhere streets follow terrain contours.

**What question it answers:** "How should we lay out streets and buildings in this residential area?"

**Key properties:**
- Direction follows terrain slope (contour-following on hillsides, grid-aligned on flat ground)
- Spacing varies with density (30m urban to 50m suburban)
- Cross streets connect parallel ribbons at intervals
- Not all parcels use ribbons — only residential types

**Relationship to other concepts:** Ribbons are a layout strategy applied to residential parcels within zones. The spaces between ribbon streets are where plots are cut.

### Plot

**What it is:** An individual piece of land intended for a single building or use. The smallest spatial unit. It has an implied owner.

**Real-world analogy:** A property boundary. "42 Acacia Avenue" — the land that belongs to one house, including front garden, back garden, and the house footprint.

**What question it answers:** "Who owns this piece of land and what's built on it?"

**Key properties:**
- Always inside a parcel
- Has road frontage (access to at least one street)
- Has a specific size based on use type and density
- Contains one building (or is empty/garden)
- Oriented relative to its street (front faces road)

**How plots are created:** Cut from the land between adjacent streets (in a ribbon layout) or placed individually (for civic buildings). Walk along the street at regular intervals, cut perpendicular to the street to create rectangular-ish lots.

**Relationship to other concepts:** Plots are cut from land within parcels, typically between ribbon streets. A building sits on a plot.

### Road

**What it is:** A linear feature that provides access and separates land into zones. Roads exist at multiple hierarchy levels.

**Real-world analogy:** Streets, from motorways down to cul-de-sacs.

**What question it answers:** "How do you get from here to there?" and "What separates this land from that land?"

**Hierarchy:**
- **Arterial / Skeleton** — major roads connecting nuclei. Built first. The city's main structure.
- **Collector / Zone boundary** — secondary roads along zone edges. Created when zones are subdivided.
- **Local / Ribbon** — residential streets within zones. Created during development.

**Relationship to other concepts:** Roads are zone boundaries. Roads provide plot frontage. Roads determine commercial parcel locations (frontage allocation).

### Nucleus

**What it is:** A growth centre — the seed point from which a settlement develops. Cities can have multiple nuclei (a main town centre, a secondary market, a waterfront district).

**Real-world analogy:** A village green, a market square, a church — the historical centre around which a settlement grew.

**What question it answers:** "Where did this settlement start growing from?"

**Key properties:**
- Position on buildable land
- Drives land value (proximity to nucleus = higher value)
- Drives zone ownership (each zone belongs to its nearest nucleus)
- Drives development priority (zones closer to nuclei develop first)
- Connected by skeleton roads

### Boundary

**What it is:** Anything that separates one area of land from another. Roads are one type of boundary, but water, railways, and map edges are also boundaries.

**Real-world analogy:** The edge of a city block isn't always a road — it might be a river, a railway embankment, or a property line with no physical form.

**Types:**
- **Road boundary** — a road in the road network
- **Water boundary** — a river, coastline, or lake edge
- **Map boundary** — the edge of the generated area
- **Railway boundary** — a railway line (not yet implemented as graph edge)
- **Planning line** — an administrative boundary with no physical form (not yet implemented)

**Relationship to other concepts:** Boundaries enclose zones. The planar graph contains all boundary edges. Graph face extraction uses boundaries to find zones.

## Scoring Layers (Not Spatial Units)

These are grids of values that drive decisions. They're separate from the spatial hierarchy — they score the land, they don't divide it.

### Land Value

A 0-1 score per cell combining flatness, nucleus proximity, and water proximity. Drives development priority (high-value zones develop first) and use type assignment (highest value → commercial/civic, mid value → residential, low value → industrial/agriculture).

### Terrain Suitability / Buildability

A binary or graded assessment of whether land can be built on. Filters zone cells during extraction — cells that are too steep, too wet, or otherwise unsuitable are excluded.

### Influence Layers

Proximity gradients from existing development (industrial proximity, civic proximity, etc.). These shift future development — industrial repels residential, civic attracts commercial. Recomputed each growth tick.

## The Key Insight

The spatial hierarchy is about **progressive refinement**:

1. Start with raw terrain
2. Roads and water carve it into **zones** (what's available)
3. Value scoring and growth agents assign **parcels** (what it's for)
4. Layout strategies (ribbons, frontage) create **streets** within parcels
5. Streets define **plots** (who owns what)
6. **Buildings** fill plots

Each level uses information from the level above. Zones depend on roads. Parcels depend on zones. Plots depend on streets. This is why getting zones right is fundamental — everything downstream depends on them.
