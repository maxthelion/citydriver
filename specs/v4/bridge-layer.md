# Bridge Visualization Layer

## Goal
Add a "bridges" layer to the interactive viewer showing each bridge as a straight line from bank to bank.

## Data
`cityLayers.getData('bridges')` — array of `{ startGx, startGz, endGx, endGz, gx, gz, x, z, width, heading, importance }`.

## Rendering
- Thick line (3px) from `(startGx, startGz)` to `(endGx, endGz)` in orange `[255, 140, 40]`
- Small circles at each endpoint (radius 2, white)
- Label bridge width near midpoint

## Files to change
- `src/rendering/layerRenderers.js` — add `renderBridgesLayer`, register in `LAYER_NAMES` and `LAYER_RENDERERS`
