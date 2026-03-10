# Sloping Streets Design

## Goal

Show terraced house rows on sloping terrain with road and sidewalk geometry. Houses adapt to terrain by raising foundations and extending rear walls to meet the ground. Six preset slope scenarios displayed simultaneously for comparison.

## Architecture

**Flow:** Preset defines a linear height function. Terrain is the source of truth. Houses are placed on it.

```
Preset { streetSlope, crossSlope }
  -> heightFn(x, z) = x * streetSlope + z * crossSlope
  -> generateRow(archetype, count, seed, heightFn)
      -> per house: query heightFn at front and back
      -> position house Y at front terrain height
      -> addGroundLevel for front-to-road difference
      -> add rear foundation wall if terrain drops behind
  -> build road/sidewalk strips from same heightFn
```

**Files:**

| File | Change |
|------|--------|
| `src/buildings/archetypes.js` | Add optional `heightFn` param to `generateRow`, add setback to shared params, add rear foundation logic |
| `src/ui/TerracedRowScreen.js` | Rewrite to show 6 preset rows with road/sidewalk geometry |

## generateRow changes

`generateRow(archetype, count, seed, heightFn)` where `heightFn` defaults to `() => 0`.

Layout constants (from archetype shared params or hardcoded for now):
- Road center: z = 0
- Road width: 6m
- Sidewalk width: 1.5m
- Setback: 2m
- House front z = road half-width + sidewalk + setback = 3 + 1.5 + 2 = 6.5m

Per house:
```
terrainFront = heightFn(houseCenter.x, frontZ)
roadY = heightFn(houseCenter.x, 0)
groundLevel = max(terrainFront - roadY, 0)

house.group.position.x = xOffset
house.group.position.y = terrainFront

if (groundLevel > 0.05) addGroundLevel(house, groundLevel)

terrainRear = heightFn(houseCenter.x, frontZ + depth)
rearDrop = terrainFront - terrainRear
if (rearDrop > 0.05) add rear foundation wall box
```

Rear foundation: a BoxGeometry spanning house width, height = rearDrop, positioned at the back of the house extending downward from the house base.

## Road and sidewalk geometry

Built per-row in the screen, not in generateRow. Three strips per row:

```
[sidewalk far] [----road----] [sidewalk near] [setback/grass] [houses...]
```

- Road: dark grey (0x555555), 6m wide centered on z=0
- Sidewalks: light grey (0x999999), 1.5m wide each side
- Each strip is a quad with corner Y values from heightFn

For linear slopes a single quad per strip is sufficient.

## Presets

6 rows stacked ~30m apart in Z:

| Preset | streetSlope | crossSlope | Label |
|--------|------------|------------|-------|
| Flat | 0 | 0 | "Flat" |
| Gentle uphill | 0.05 | 0 | "5% uphill" |
| Steep uphill | 0.12 | 0 | "12% uphill" |
| Hillside up | 0 | 0.08 | "Hillside up" |
| Hillside down | 0 | -0.08 | "Hillside down" |
| Combined | 0.06 | 0.05 | "6% + cross" |

All rows share the same seed and count. Labels as text sprites above each row.

## Screen layout

Sidebar: count slider (3-10), seed input, random seed button, back button. Same controls as current TerracedRowScreen.

Scene: 6 rows visible at once. Orbit camera centered on the middle of the scene. Ground plane underneath.

## What we're NOT doing

- No stepped terraces between houses -- continuous slope
- No kerb geometry -- sidewalk is flush, just different colour
- No garden/path geometry -- gap between sidewalk and house is grass
- No terrain mesh beyond road/sidewalk strips -- ground is flat green plane, slope implied by foundations
