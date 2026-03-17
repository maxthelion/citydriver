# River Problems in v5

Observations from debugging regional terrain generation (2026-03-17).

## 1. Main river disconnect at region edge (seed 786031)

The main river entering from the edge of the region map appears disconnected. The corridor planning (`planRiverCorridors`) creates a depression along the planned path, but the actual river extracted by flow routing doesn't always follow it. This leaves gaps where the corridor is depressed but no river flows through.

## 2. Valleys not deep/wide enough for rivers

After removing `seaFloorPlunge` (which was incorrectly plunging ALL waterMask cells including inland rivers), the main river became a narrow trickle. The valley carving (`computeValleyDepthField` in `carveValleys.js`) and floodplain carving (`carveFloodplains` in `generateHydrology.js`) don't lower terrain enough for rivers to appear significant. Previously seaFloorPlunge was masking this by flood-filling valleys down to sea level.

## 3. Need bitmap renderings at each pipeline stage

To properly diagnose river issues, we need to output bitmap renderings of the river state at each stage of the regional pipeline:
- After `generateTerrain` (corridor depression visible?)
- After `fillSinks` / flow routing (where does water flow?)
- After `extractStreams` (which cells are identified as rivers?)
- After `smoothRiverPaths` (do meanders break connectivity?)
- After `carveFloodplains` (how much elevation changes?)
- After `computeValleyDepthField` + `applyTerrainFields` (valley shape?)
- After `paintPathsOntoWaterMask` (final waterMask)

## 4. Rivers plunging to sea level in 3D city view

In the city-level 3D renderer, rivers are still being rendered at or below sea level rather than at their natural terrain elevation. This is a separate issue from the regional pipeline — likely in the city terrain import or the WebGPU renderer's water surface handling.
