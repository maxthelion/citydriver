# Region Selection UI Spec

## Overview

Fullscreen modal shown at startup for region selection. Two-panel layout with 3D terrain preview and 2D interactive map, plus a simplified two-button interface.

## Layout

```
┌──────────────────────────────────────────────────────┐
│                  Open World Driving                   │
├──────────────────────┬───────────────────────────────┤
│                      │                               │
│   3D Terrain Preview │     2D Regional Map           │
│   (auto-rotating)    │     (click to select)         │
│                      │                               │
│                      │                               │
├──────────────────────┴───────────────────────────────┤
│  [info text]         [Regenerate]    [Enter City]    │
└──────────────────────────────────────────────────────┘
```

- **Left half**: 3D terrain preview (Three.js scene with auto-rotating orbit camera)
- **Right half**: 2D regional map (existing `renderRegionalMap()` canvas, used for settlement selection)
- **Bottom bar**: Info text + two buttons — "Regenerate" and "Enter City"

## 3D Preview

Separate Three.js renderer, scene, and camera — distinct from the game's renderer.

### Meshes
- **Terrain**: Built from `heightmap` using `buildTerrainMesh()` from `src/rendering/terrainMesh.js`
- **Water**: Flat plane at sea level using `buildWaterMesh()` from `src/rendering/waterMesh.js`
- **Rivers**: Blue line geometry rendered on terrain surface using drainage accumulation data
- **Settlement markers**: Colored cylinders — city=red, town=orange, village=yellow

### Camera
- PerspectiveCamera at ~45° elevation angle
- Auto-orbits around terrain center at 0.1 rad/s
- No user camera controls (orbit is automatic)

### Lighting
- AmbientLight(0xffffff, 0.6)
- DirectionalLight(0xffeedd, 0.8) positioned at (200, 300, 150)

### Selection Highlight
- Selected settlement marker gets an emissive glow ring (cyan)
- Synced with 2D map selection

## 2D Map (Right Panel)

Uses existing `renderRegionalMap()` and `pickSettlement()` from `src/rendering/regionalMap.js`.

- Click settlements to select → highlight ring on map AND highlight marker in 3D
- Hover shows pointer cursor change
- Canvas size: 600×600, scales to fit panel

## Buttons

### Regenerate
- Calls `generateRegion()` with a new random seed and sensible defaults
- Rebuilds both 3D and 2D views
- No sliders — terrain params use defaults (mountainousness: 0.5, roughness: 0.5, coastEdges: ['south'])

### Enter City
- Disabled until a settlement is selected
- Triggers existing `enterCity()` flow (loading screen → city generation pipeline)

## Lifecycle

1. Modal opens → auto-generates region with random seed
2. Both views update simultaneously
3. User clicks settlement on 2D map → both views highlight it
4. "Regenerate" → new random seed, rebuild both views
5. "Enter City" → hide modal, run city generation
6. "New City" button in-game → re-show modal with 3D preview

## Module: `src/rendering/regionPreview3D.js`

```
export function createRegionPreview3D(container)
  → returns { update(regionData), highlight(settlement), dispose(), canvas }
```

- `update(regionData)`: clears scene, builds terrain + water + river + settlement meshes
- `highlight(settlement)`: highlights selected settlement marker
- `dispose()`: stops animation loop, disposes renderer/geometries/materials
- Uses own `MaterialRegistry` instance for terrain/water materials
