# Window Pane Textures Design

## Goal

Replace solid-colour window planes with textured windows showing mullion/pane divider patterns. 4 distinct styles selected per archetype.

## Architecture

Procedurally draw window patterns on canvas at startup, cache as `CanvasTexture` per style. `addWindows` applies the texture to window meshes based on `house._windowStyle`.

## Window patterns

| Style | Description | Used by |
|-------|-------------|---------|
| `sash` | 2x2 grid — horizontal + vertical bar | Victorian terrace |
| `georgian` | 3x2 grid — 6 panes | Parisian Haussmann, German townhouse |
| `casement` | 2x1 — vertical bar only | Low-rise apartments |
| `single` | No divisions — plain glass with frame | Suburban detached |

Each pattern drawn on a 64x96 canvas with:
- Glass background `0x88aabb`
- Light grey mullion lines (2-3px wide)
- Thin frame border around the edge

Individual `CanvasTexture` per pattern, cached in a module-level `Map`. Created on first call, reused thereafter.

## Changes

**`src/buildings/generate.js`:**
- New function `getWindowTexture(style)` — returns cached `CanvasTexture`, draws on first call
- `addWindows` reads `house._windowStyle` (defaults to `'sash'`), creates `MeshLambertMaterial` with the texture map instead of solid colour

**`src/buildings/archetypes.js`:**
- Add `windowStyle` field to each archetype's `shared` params
- `generateRow` sets `house._windowStyle = s.windowStyle || 'sash'` before calling `addWindows`

## What we're NOT doing

- No per-archetype glass colour — same `0x88aabb` everywhere
- No sprite sheet — individual textures per pattern
- No parametric NxM generation — fixed 4 patterns
- No arched windows — rectangular only for now
