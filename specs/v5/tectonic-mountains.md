# Tectonic Mountains & Macro Region Classification

## Goal

Replace the current independent random parameters (coastEdges, bandDirection, etc.) with a coherent tectonic context driven by two variables: `plateAngle` and `intensity`. This produces geologically consistent mountains with directional ridges, asymmetric profiles, and appropriate coastline character. Forest should carry through to city scale.

## The Two Drivers

```
plateAngle:  0–2π   Direction compression comes FROM
intensity:   0–1    0 = passive margin, 1 = active collision
```

## Derived Values

From `plateAngle`:
- `ridgeAngle = plateAngle + π/2` — ridges perpendicular to compression
- `bandDirection = ridgeAngle + smallOffset` — strata align with ridges
- `asymmetryDir = { cos(plateAngle), sin(plateAngle) }` — steep face toward compression
- `coastEdges` — coast on side facing compression (unless user overrides)

From `intensity`:
- `ridgeAmplitude` — 20m (passive) to 300m+ (active)
- `intrusionCount` — 0–1 (passive) to 3–5 (active)
- `coastalShelfWidth` — wide (passive) to narrow (active)
- Rock type bias — more granite at high intensity, more sedimentary at low

## Changes

### 1. New: `generateTectonics(params, rng)` → TectonicContext

Runs before geology. Rolls plateAngle and intensity, computes all derived values. Returns a context object consumed by downstream generators.

The user can still override coastEdges via params — the system picks compatible defaults otherwise.

### 2. Modified: `generateGeology`

Receives tectonic context:
- `bandDirection` from context instead of random param
- Rock type selection biased by intensity (high = more granite/hard, low = more sedimentary)
- Intrusion placement biased toward ridge axis (granite batholiths in mountain cores)

### 3. Modified: `generateTerrain`

Add large-scale directional ridge field:
- New noise layer at frequency 1.5–2 (~8–12km wavelength) — mountain ranges
- Directionally stretched along ridgeAngle (0.4× freq along ridges, 1.0× across)
- Asymmetric profile: compression-facing side steeper via directional offset blend
- Current detail ridges (frequency 6) modulated by large-scale field — stronger in mountains, weaker in plains
- Intensity controls overall ridge amplitude

### 4. Forest at City Scale

- Extract regional `landCover` grid when building city patch
- Downsample to city cell resolution
- Use regional forest cells as initial `urbanCover` woodland (type 3)
- Urban development overrides near settlement; forest remains at city edges

## Intensity Character Table

| Intensity | Character |
|-----------|-----------|
| 0.0–0.2 | Flat coastal plain / fenland. Minimal elevation change. Wide beaches. Clay/chalk. |
| 0.2–0.4 | Rolling hills / downs. Gentle ridges. Mixed sedimentary. |
| 0.4–0.6 | Uplands / old eroded mountains. Clear ridgelines, moderate valleys. Some granite. |
| 0.6–0.8 | Young fold mountains. Sharp ridges, asymmetric valleys, escarpments. |
| 0.8–1.0 | Active collision. Dramatic peaks, narrow coastal shelf, granite intrusions. |
