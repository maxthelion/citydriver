# Roof Tile Textures Design

## Goal

Replace solid-colour roof materials with procedurally drawn tile/slate patterns using the same canvas texture approach as window panes.

## Patterns

| Style | Description | Used by |
|-------|-------------|---------|
| `slate` | Staggered rectangular tiles, subtle shade variation per row | Victorian terrace, German townhouse |
| `clay` | Curved/wavy interlocking tiles (pantile look) | Parisian Haussmann |
| `shingle` | Flat uniform small tiles, minimal texture | Suburban detached, Low-rise apartments |

Each pattern drawn on a 128x128 canvas with:
- Base colour from archetype's `roofColor`
- Per-tile-row shade variation (±10% brightness nudge)
- Thin darker lines for tile edges/gaps

## Architecture

`getRoofTexture(style, baseColor)` draws the tile pattern, caches by `style:hexColor` key in a module-level Map. Returns `THREE.CanvasTexture` with `wrapS/wrapT = RepeatWrapping`.

Material uses `color: 0xffffff` with `map: texture` so the baked-in colour comes through clean (same approach as window textures).

UV coordinates added to all four roof geometry helpers (`_gableRoofSides`, `_gableRoofFrontBack`, `_hipRoof`, `_mansardRoof`). UVs derived from vertex world-space positions so tiles scale consistently — roughly 1 texture repeat per 2m of roof surface.

## Changes

**`src/buildings/generate.js`:**
- New `getRoofTexture(style, baseColor)` function — draws pattern, caches, returns CanvasTexture
- New `_drawRoofPattern(ctx, w, h, style, baseColor)` — renders tile lines/shading
- Modified `addPitchedRoof` — reads `house._roofTileStyle`, creates material with texture map, sets `color: 0xffffff`
- Modified `_gableRoofSides`, `_gableRoofFrontBack`, `_hipRoof`, `_mansardRoof` — generate UV coordinates alongside position data
- Also apply roof texture to porch roofs, bay window roofs, extension roofs, dormer roofs

**`src/buildings/archetypes.js`:**
- Add `roofTileStyle` field to each archetype's `shared` params
- `generateRow` sets `house._roofTileStyle = s.roofTileStyle || 'slate'` before calling `addPitchedRoof`

## Archetype mapping

- `victorianTerrace`: `roofTileStyle: 'slate'`, `roofColor: 0x6b4e37`
- `parisianHaussmann`: `roofTileStyle: 'clay'`, `roofColor: 0x4a4a4a`
- `germanTownhouse`: `roofTileStyle: 'slate'`, `roofColor: 0x8b4513`
- `suburbanDetached`: `roofTileStyle: 'shingle'`, `roofColor: 0x6b4e37`
- `lowRiseApartments`: `roofTileStyle: 'shingle'`, `roofColor: 0x888888`

## What we're NOT doing

- No per-house roof colour variation — variation is within the texture (per-tile-row)
- No separate textures for dormer/porch/extension roofs — they share main roof style
- No parametric tile size — fixed 128x128 patterns
- No ridge cap or edge tile details
