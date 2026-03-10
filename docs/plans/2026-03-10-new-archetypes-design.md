# New Archetypes Design

## Goal

Add 4 new building archetypes (Parisian Haussmann, German townhouse, suburban detached, low-rise apartments) to exercise the full composable building API. Wire them into the TerracedRowScreen via a dropdown selector.

## Architecture

New archetype objects follow the existing `shared`/`perHouse` pattern from `victorianTerrace`. `generateRow` gains conditional calls for `addPorch`, `addBalcony`, `addDormer`, `addExtension` based on archetype fields. A `sideGap` perHouse field creates spacing between detached houses.

## Archetype definitions

| | Victorian | Haussmann | German | Suburban | Apartments |
|---|---|---|---|---|---|
| **floors** | 2-3 | 5-6 | 3-4 | 2 | 4-5 |
| **roof** | pitched sides | mansard | steep pitched sides | hip (all) | flat (pitch 0) |
| **roofPitch** | 35-45 | 60-70 | 45-55 | 25-30 | 0 |
| **bay** | box, 1-2 floors | null | null | null | null |
| **balcony** | null | full, floors 2-3 | null | null | full, all floors |
| **dormers** | null | window, 2-3 | window, 1-2 | null | null |
| **porch** | null | null | gable | slope | null |
| **extension** | null | null | null | left, 1 floor | null |
| **partyWalls** | left+right | left+right | left+right | none | left+right |
| **sideGap** | 0 | 0 | 0 | 1-2m | 0 |
| **plotWidth** | 4.5-6 | 5-7 | 5-6.5 | 8-12 | 6-8 |
| **depth** | 8-10 | 10-12 | 9-11 | 8-10 | 12-15 |
| **wallColor** | warm sandstone 0xd4c4a8 | cream 0xe8dcc8 | warm grey 0xc0b8a8 | varied 0xd8d0c0 | white/light grey 0xe0ddd8 |
| **groundHeight** | 0.3-0.5 | 0.5-0.8 | 0.3-0.5 | 0.2-0.3 | 0.3-0.5 |

## generateRow changes

New conditional operations based on archetype fields:

```
createHouse(plotWidth - sideGap*2, depth, floorHeight, color)
  house offset by sideGap within plot
setPartyWalls
addFloor (loop)
addPitchedRoof
addFrontDoor
addBayWindow       (if s.bay)
addPorch           (if s.porch)
addExtension       (if s.extension)
addWindows
addBalcony         (if s.balcony, per floor in range)
addWindowSills     (if s.sills)
addDormer          (if s.dormers, per count)
addGroundLevel     (if needed)
```

`sideGap`: sampled per-house from `perHouse.sideGap`. Plot positioning uses full `plotWidth` for xOffset, but house is narrower and offset within the plot.

Balcony floors: `s.balcony.floors` is `[startFloor, endFloor]` — loop from start to end, calling `addBalcony(house, floor, s.balcony.style)`.

Dormers: `s.dormers.count` sampled once at row level. Each dormer positioned at `(i + 0.5) / count` across the roof width.

## TerracedRowScreen changes

Add `<select>` dropdown above the count slider. Options: Victorian Terrace, Parisian Haussmann, German Townhouse, Suburban Detached, Low-rise Apartments. Selected archetype passed to `generateRow`.

## What we're NOT doing

- No new composable operations — using existing API only
- No city generator integration — archetypes are data, wired in later
- No new screen — reusing TerracedRowScreen with selector
