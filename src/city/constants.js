/**
 * Shared city-level constants.
 * Single source of truth for parameters that must stay in sync
 * across setup, rendering, and strategy code.
 */

// Grid geometry
export const CITY_CELL_SIZE = 20;      // meters per city grid cell
export const CITY_RADIUS = 15;         // regional cells from settlement center

// River stamping — FeatureMap is always at city resolution, so no
// coarse/fine conditional needed. 0.4 * cellSize gives a tight stamp
// that paints the river cell without inflating into neighbors.
// (Regional stamping in riverGeometry.js uses its own 0.75 factor.)
export const RIVER_STAMP_FRACTION = 0.4;

// Step size for walking along polylines (roads, rivers) when stamping.
// Half-cell ensures every cell the path crosses gets a stamp.
export const STAMP_STEP_FRACTION = 0.5;
