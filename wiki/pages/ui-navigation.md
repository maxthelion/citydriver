---
title: "UI Navigation"
category: "ui"
tags: [navigation, region, city, debug, compare, controls]
summary: "How the user navigates from the region view into city views, with controls for archetype, tick, debug layer, and view mode."
last-modified-by: user
---

## Overview

The region map is the starting point. The user selects a settlement, configures how they want to view it, and launches into one of several city views. All the parameters needed to reproduce a view are encoded in the URL so views can be linked and shared.

## Region Screen

The region screen shows the regional map with settlements, roads, rivers, and terrain. Clicking a settlement selects it.

### Controls (on settlement selection)

When a settlement is selected, a control panel appears with:

| Control | Type | Description |
|---------|------|-------------|
| **Archetype** | Dropdown | `Auto (best fit)`, `(none)`, or one of the 5 archetypes (Market Town, Port City, Grid Town, Industrial Town, Civic Centre) |
| **Tick** | Number input / slider | 0-20+. How many pipeline ticks to run. 0 = setup only. Higher = more developed. |
| **Debug Layer** | Dropdown | Which bitmap layer to visualise. Only shown when Debug or Compare mode is selected. List of all available layers (Composite, Terrain, Slope, Buildability, Reservations, Land Value, etc.) |
| **View Mode** | Dropdown | Which screen to launch into (see below) |
| **Go** | Button | Launch the selected view |

### View Modes

| Mode | Description | URL param |
|------|-------------|-----------|
| **3D City** | Full 3D view with terrain, buildings, roads, rivers, trees. The main visual output. | `mode=city` |
| **Debug** | 2D bitmap view with tick stepping, layer selection, cell zoom. For inspecting pipeline output. | `mode=debug` |
| **Compare Archetypes** | Side-by-side 2D grid comparing multiple archetypes at the same tick and layer. | `mode=compare-archetypes` |
| **Compare Growth** | Side-by-side comparison of growth strategies. | `mode=compare` |

## URL Schema

All view state is encoded in the URL:

```
?seed=884469&mode=debug&gx=27&gz=95&archetype=marketTown&tick=5&lens=reservations
```

| Param | Description |
|-------|-------------|
| `seed` | Region seed |
| `gx`, `gz` | Settlement grid coordinates |
| `mode` | View mode (`city`, `debug`, `compare-archetypes`, `compare`) |
| `archetype` | Archetype key (`marketTown`, `portCity`, etc.) or `auto`/`none` |
| `tick` | Pipeline tick number |
| `lens` | Debug layer slug (kebab-case, e.g. `land-value`, `reservations`) |
| `col`, `row` | Cell detail view coordinates (debug mode only) |
| `archetypes` | Comma-separated archetype keys (compare mode only) |

Changing any control updates the URL via `history.replaceState`. Pasting a URL reconstructs the full view state.

## Current State

The region screen currently has separate buttons for each view mode (Enter City, Debug City, Compare Growth, Compare Archetypes). The archetype, tick, and debug layer are selected inside the target screen after launch, not on the region screen.

## Proposed Change

Move the archetype, tick, and debug layer controls to the region screen so the user configures everything before launching. The "Go" button then opens the selected view with all parameters pre-set. This:

- Makes it clear what you're about to see before you launch
- Reduces clicks (no need to set archetype after entering debug view)
- Makes the URL predictable (all params set from one place)
- Allows the region screen to show a preview (e.g. archetype scores for the selected settlement)

The individual view screens still have their own controls for changing parameters after launch (e.g. stepping through ticks in debug view). But the initial state comes from the region screen.

## Data Flow

```
Region Screen
  ├── Select settlement → shows control panel
  ├── Set archetype, tick, debug layer, view mode
  └── Click "Go"
        ├── mode=city     → CityScreen(seed, gx, gz, archetype)
        ├── mode=debug    → DebugScreen(seed, gx, gz, archetype, tick, lens)
        ├── mode=compare-archetypes → CompareArchetypesScreen(seed, gx, gz, archetypes, tick, lens)
        └── mode=compare  → CompareScreen(seed, gx, gz)

All screens read URL params on init. All screens update URL on control changes.
```

## Relationship to Other Pages

- [[debugging-cities]] — describes the debug and compare screens in detail
- [[city-generator-overview]] — describes what the pipeline produces
- [[progress-indicators]] — loading feedback during city generation
