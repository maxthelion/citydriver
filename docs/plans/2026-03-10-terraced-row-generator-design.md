# Terraced Row Generator Design

## Goal

Validate the composable building API end-to-end by generating a row of Victorian terraced houses with shared party walls, coherent style, and per-building variation. Also validates the archetype-driven instantiation pattern.

## Architecture

Three new files, one modification:

| File | Purpose |
|------|---------|
| `src/buildings/archetypes.js` | Archetype definitions + `generateRow(archetype, count, seed)` |
| `src/ui/TerracedRowScreen.js` | Minimal THREE.js viewer with count/seed controls |
| `test/buildings/archetypes.test.js` | Unit tests for generateRow |
| `src/buildings/generate.js` (modify) | Fix `addWindows` to respect `_partyWalls` |

**Data flow:**

```
archetype object (parameter ranges)
    -> generateRow(archetype, count, seed)
        -> per-house: position-seed RNG -> sample concrete values from ranges
        -> per-house: composable API calls (createHouse -> setPartyWalls -> addFloor -> ...)
        -> position houses side-by-side (x offset = cumulative plot widths)
    -> THREE.Group of houses
        -> TerracedRowScreen renders it with orbit camera
```

## Archetype Object

```js
export const victorianTerrace = {
  typology: 'terraced',
  partyWalls: ['left', 'right'],
  floors: [2, 3],
  floorHeight: [2.8, 3.2],
  roofPitch: [35, 45],
  roofDirection: 'sides',
  roofOverhang: 0.2,
  plotWidth: [4.5, 6],
  depth: [8, 10],
  door: 'left',
  bay: { style: 'box', span: 1, floors: [1, 2], depth: [0.6, 0.9] },
  groundHeight: [0.3, 0.5],
  wallColor: 0xd4c4a8,
  roofColor: 0x6b4e37,
  colorVariation: 0.06,
  windowSpacing: [2.2, 2.8],
  windowHeight: [1.3, 1.6],
  sills: { protrusion: 0.08 },
};
```

**Convention:** single values are fixed across the row (roof direction, door side, wall base color). Arrays of two numbers `[min, max]` are per-house ranges sampled by the position-seeded RNG. This gives coherence (all gable roofs, all doors on left) with variation (slightly different heights, widths, bay depths).

**End houses:** first house drops `'left'` from party walls, last house drops `'right'`. This gives them windows on the exposed side.

## generateRow(archetype, count, seed)

Per-house seeding uses world position: `hashPosition(seed, worldX, 0)` where worldX is the cumulative offset. This means a house at a given position always looks the same regardless of row membership or count.

Each house: sample concrete values from archetype ranges, determine party walls (ends get one side exposed), then call composable API in order: `createHouse` -> `setPartyWalls` -> `addFloor` -> `addPitchedRoof` -> `addFrontDoor` -> `addBayWindow` -> `addWindows` -> `addWindowSills` -> `addGroundLevel`. Position with `house.group.position.x = xOffset`.

**Helpers:**
- `hashPosition(seed, x, z)` -- integer hash combining seed with quantised coordinates
- `sample(rng, rangeOrValue)` -- if `[min, max]` array, returns `rng.range(min, max)`; if scalar, returns unchanged

## addWindows Fix

Add `face: 'left'` and `face: 'right'` labels to the left/right wall entries in the walls array. Add `if (house._partyWalls?.has(wall.face)) continue;` at the top of the wall loop. Two lines changed, one added.

## TerracedRowScreen

Minimal THREE.js scene: orbit camera, ground plane, directional + ambient light. Two controls: count slider (3-10, default 6) and seed number input. Camera positioned to see full row based on count x average plot width.

## Tests

1. Deterministic -- same seed + count produces identical group
2. Position-stable -- changing count doesn't change house at a given position
3. Party walls -- first house no left, last house no right, middle has both
4. End houses have side windows -- more window meshes than middle houses
5. sample() helper -- scalars pass through, arrays sample range
6. Row dimensions -- total width equals sum of individual house widths
7. addWindows respects party walls (in generate.test.js) -- set party walls, verify no windows on those sides
