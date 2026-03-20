# CityScreen Refactor Plan

## Problem

`CityScreen` currently does four unrelated things:

1. **Runs the city pipeline** — `setupCity`, archetype scoring, `LandFirstDevelopment.runToCompletion()`
2. **Post-processes the map** — Chaikin road smoothing, `prepareCityScene`, `computeCoverageLayers`
3. **Builds THREE.js meshes** — terrain, roads, water, rivers, trees, buildings, railways, debug markers
4. **Runs the render loop** — camera, fly controls, minimap, HUD, resize handler

Only 3 and 4 belong in a screen component. Because 1 and 2 live inside `CityScreen`, the generation
code is untestable (no test ever imports `CityScreen`), bugs go undetected until someone opens a
browser, and the constructor does hundreds of milliseconds of blocking work before returning.

The `road.polyline = chaikinSmooth(...)` crash is a direct symptom: the smoothing lived in the
UI layer, never got tested, and used the old plain-object assignment pattern that broke silently
when `Road` got its private field.

---

## Goal

`CityScreen` receives a complete `map` and renders it. All derivation of the map from
seed + archetype + region position + pipeline step happens outside it.

---

## New interface

### `src/city/buildCityMap.js` — async factory (new file)

```js
/**
 * Build a city map from declarative parameters.
 * Returns a fully-generated, ready-to-render FeatureMap.
 *
 * @param {object} options
 * @param {number}        options.seed       — region seed (for RNG)
 * @param {object}        options.layers     — regional layer bag from generateRegion
 * @param {object}        options.settlement — settlement record (gx, gz, …)
 * @param {string|object} options.archetype  — archetype key, 'auto', or archetype object
 * @param {string|null}   options.step       — pipeline step to stop after (null = complete)
 * @param {number}        options.growth     — growth tick count (when step === 'growth')
 * @returns {Promise<{ map: FeatureMap, archetype: object }>}
 */
export async function buildCityMap({ seed, layers, settlement, archetype = 'auto', step = null, growth = 0 })
```

Responsibilities:
- `setupCity(layers, settlement, rng)` — create the base map
- Archetype resolution: `'auto'` → `scoreSettlement`, string key → `ARCHETYPES[key]`, object → pass through
- Run the pipeline via `LandFirstDevelopment` to the requested step/completion
- **Chaikin road smoothing** — moved here from CityScreen; part of canonical map state,
  not a rendering concern. All consumers (debug view, compare, city screen) get smoothed roads.
- Return `{ map, archetype }` so callers can display the archetype name

The `step`/`growth` parameters use the same semantics as the URL params introduced in the UI refactor:

| `step`      | meaning                                          |
|-------------|--------------------------------------------------|
| `null`      | run to completion                                |
| `'skeleton'`| stop after skeleton roads                        |
| `'zones'`   | stop after zone extraction (incl. refine)        |
| `'spatial'` | stop after spatial layers                        |
| `'growth'`  | stop after `growth` complete ticks               |
| `'connect'` | stop after connect (same as null)                |

---

### `src/ui/CityScreen.js` — updated constructor

**Old:** `CityScreen(container, layers, settlement, rng, seed, onBack)`

**New:** `CityScreen(container, map, seed, onBack)`

- `map` — a pre-built `FeatureMap` from `buildCityMap`
- `seed` — still needed for deterministic building/tree placement
- No more `layers`, `settlement`, `rng` — the screen has no generation responsibility

Remove from `CityScreen`:
- All imports of `setupCity`, `LandFirstDevelopment`, `ARCHETYPES`, `scoreSettlement`, `chaikinSmooth`
- The pipeline run block + Chaikin smoothing
- `this._regionalLayers`, `this._settlement` (used only during generation)

Keep in `CityScreen`:
- `prepareCityScene` (3D coordinate conversion, rendering prep)
- `computeCoverageLayers` (rendering-specific continuous field)
- All `_build*` mesh methods
- Camera, fly controls, minimap, HUD, animate loop

---

### `src/main.js` — updated `enterSubScreen`

```js
// Before creating CityScreen:
const { map } = await buildCityMap({
  seed, layers, settlement,
  archetype: opts.archetype || 'auto',
  step: opts.step || null,
  growth: opts.growth || 0,
});
cityScreen = new CityScreen(container, map, seed, goBack);
```

`enterSubScreen` is already async-capable (it doesn't await its own result), so this can be
wrapped in an async IIFE or `enterSubScreen` itself can become async.

The URL deep-link path in `main.js` (bottom of the file) gets the same treatment.

---

### `src/ui/DebugScreen.js` and `src/ui/CompareArchetypesScreen.js`

These already construct `LandFirstDevelopment` themselves and run it step-by-step (for the
step-through UX). They should also move to `buildCityMap` for their initial setup, but that's
a larger change. For now, just ensure they also call Chaikin smoothing after completion
(or rely on `buildCityMap` doing it when they eventually migrate).

Actually — if Chaikin smoothing moves into `buildCityMap`, DebugScreen's maps will be
un-smoothed when constructed manually. The cleanest fix: move smoothing into the pipeline
as a named step `smooth-roads` after `connect`, so it runs automatically regardless of
how the pipeline is invoked.

---

## Road smoothing: pipeline step vs factory

**Option A — Named pipeline step `smooth-roads`** (preferred)
- Add to `cityPipeline.js` after `connect`
- Runs automatically in all code paths: CityScreen, DebugScreen, CompareArchetypesScreen, scripts
- Visible in URL state (`?step=smooth-roads`)
- Testable via the existing pipeline invariant harness
- One place, no duplication

**Option B — In `buildCityMap` factory only**
- DebugScreen and CompareArchetypesScreen would need separate handling
- Duplication risk

Recommendation: **Option A**.

---

## Files changed

| File | Change |
|------|--------|
| `src/city/buildCityMap.js` | **New** — async factory: setupCity + archetype + pipeline + smoothing |
| `src/city/pipeline/cityPipeline.js` | Add `smooth-roads` step after `connect` |
| `src/ui/CityScreen.js` | Remove generation; constructor takes `(container, map, seed, onBack)` |
| `src/main.js` | Call `buildCityMap` before `CityScreen`; `enterSubScreen` becomes async |
| `src/ui/DebugScreen.js` | No change needed (step-through pipeline runs smooth-roads automatically) |
| `src/ui/CompareArchetypesScreen.js` | No change needed (same) |

---

## Migration order

1. Add `smooth-roads` step to `cityPipeline.js` — standalone, testable change
2. Create `buildCityMap.js` — new file, no existing code changes yet
3. Update `CityScreen` constructor — breaking change, requires step 4 first
4. Update `main.js` callers — makes step 3 functional
5. Remove dead imports from `CityScreen`

---

## What this enables

- `CityScreen` becomes testable in principle (pass a mock map, check scene contents)
- Generation bugs surface in unit/integration tests rather than browser crashes
- `buildCityMap` can be called from scripts (e.g. a headless render pipeline)
- The `step`/`growth` params give DebugScreen and RegionScreen a single canonical
  entry point for "give me a city at this state" rather than reimplementing it everywhere
- Chaikin smoothing is automatic and consistent — no screen can accidentally skip it
