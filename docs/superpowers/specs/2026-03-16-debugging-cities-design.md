# Debugging Cities: URL-Driven Debug & Archetype Comparison

## Problem

The debug screen has archetype, tick, and layer selection as UI-only state. You can't link to a specific view or compare the same city under different archetypes side by side. This makes it hard to evaluate whether land reservation and growth ticks are working correctly across archetypes.

## Solution

Two changes:

1. **Debug screen URL params** — encode archetype, tick, and lens in the URL so views are linkable
2. **Compare-archetypes screen** — new screen showing a grid of 2D debug panels, one per archetype, sharing the same tick and lens

## URL Schema

### Debug screen (`mode=debug`)

```
?seed=42&mode=debug&gx=3&gz=5&archetype=marketTown&tick=5&lens=reservations
```

| Param | Values | Default |
|-------|--------|---------|
| `archetype` | `marketTown`, `portCity`, `gridTown`, `industrialTown`, `civicCentre`, `auto`, `none` | omitted = `auto` (best fit) |
| `tick` | `0`-`7` — where 0 = setup only (no pipeline ticks), 7 = all pipeline ticks complete | `0` |
| `lens` | kebab-case layer slug (e.g. `land-value`, `reservations`, `development-zones`) | `composite` |

Existing params (`seed`, `gx`, `gz`, `col`, `row`) unchanged.

When the user changes archetype dropdown, tick buttons, or layer buttons, `history.replaceState` updates the URL. On load, URL params seed the UI state — if `tick=5` is in the URL, the pipeline auto-advances through ticks 1-5 on load (new behaviour; currently the user must click through manually).

### Compare-archetypes screen (`mode=compare-archetypes`)

```
?seed=42&mode=compare-archetypes&gx=3&gz=5&archetypes=portCity,marketTown&tick=5&lens=reservations
```

| Param | Values | Default |
|-------|--------|---------|
| `archetypes` | comma-separated archetype keys | omitted = all 5 |
| `tick` | `0`-`7` | `0` |
| `lens` | kebab-case layer slug | `composite` |

## Compare-Archetypes Screen

### Layout

CSS grid of equally-sized 2D canvases. Each panel labelled with archetype name. Grid auto-fits columns (2 archetypes = 2 columns, 3-5 fills rows to fit viewport).

### Shared controls (top bar)

- **Tick slider/buttons** (0-7) — changes all panels simultaneously
- **Lens dropdown** — same layer across all panels
- **Archetype checkboxes** — toggle which archetypes are shown (updates URL)

### Per-panel rendering

- Run `setupCity()` once, then clone the resulting FeatureMap for each archetype (setup is archetype-independent)
- Each panel creates its own `LandFirstDevelopment` with a different archetype and advances to the selected tick
- The selected debug layer is rendered to that panel's canvas using existing `debugLayers.js` render functions
- All panels share the same seed and RNG fork — only the archetype-driven pipeline ticks produce different results

### Navigation

- Reachable from debug screen via a "Compare archetypes" button
- Reachable from region screen
- Clicking a panel navigates to the debug screen for that specific archetype

## Layer Slug Mapping

A lookup from kebab-case URL slugs to LAYERS array entries. Derived by lowercasing, stripping special characters (parentheses, colons), and hyphenating the layer display name. Examples:

- `Land Value` → `land-value`
- `Path Cost (growth)` → `path-cost-growth`
- `Path Cost (nucleus)` → `path-cost-nucleus`
- `Coverage: Water` → `coverage-water`

Used by both debug and compare screens.

## Debug Screen Changes

- On init, read `archetype`, `tick`, `lens` from URL params and set UI state
- When user changes any control, `history.replaceState` updates URL
- No other behaviour changes

## Pipeline Execution (Compare Screen)

- Run `setupCity()` once to produce a base FeatureMap, then clone it for each archetype
- Each clone gets its own `LandFirstDevelopment` instance with the target archetype
- N independent FeatureMaps in memory (manageable for up to 5)
- Tick changes re-run the pipeline from scratch (optimise with caching later if needed)
- The existing `CompareScreen.js` uses this same clone-and-tick pattern and serves as a reference implementation

## Entry Points

- Add `compare-archetypes` case to all three mode-routing blocks in `main.js` (`enterSubScreen`, `popstate` handler, initial URL deep-link)
- Add navigation helper to build compare URLs

## Files Changed

- `src/ui/DebugScreen.js` — read/write URL params for archetype, tick, lens; auto-advance to tick on load
- `src/ui/CompareArchetypesScreen.js` — new file
- `src/ui/RegionScreen.js` — add "Compare archetypes" navigation button/callback
- `src/main.js` — add `compare-archetypes` to all three mode-routing blocks, navigation helpers
- `src/rendering/debugLayers.js` — add layer slug mapping with special character handling
