/**
 * Explicit composition functions that build derived masks from source layers.
 *
 * Each function takes a map (with getLayer/hasLayer) and returns a new Grid2D.
 * No side effects — the map is read-only.
 */

/**
 * Build a buildability mask from terrain, water, and roads.
 * Returns terrain suitability with water and road cells zeroed.
 */
export function composeBuildability(map) {
  const terrain = map.getLayer('terrainSuitability');
  const water = map.getLayer('waterMask');
  const roads = map.hasLayer('roadGrid') ? map.getLayer('roadGrid') : null;

  return terrain.map((value, gx, gz) => {
    if (water.get(gx, gz) > 0) return 0;
    if (roads && roads.get(gx, gz) > 0) return 0;
    return value;
  });
}

/**
 * Build a residential placement mask.
 * Cells where ribbon layout and house placement may operate:
 * terrain suitable, not water, not road, in a development zone,
 * not reserved for other use.
 */
export function composeResidentialMask(map) {
  const terrain = map.getLayer('terrainSuitability');
  const water = map.getLayer('waterMask');
  const roads = map.hasLayer('roadGrid') ? map.getLayer('roadGrid') : null;
  const zones = map.hasLayer('zoneGrid') ? map.getLayer('zoneGrid') : null;
  const reservations = map.hasLayer('reservationGrid')
    ? map.getLayer('reservationGrid') : null;

  return terrain.map((value, gx, gz) => {
    if (value < 0.3) return 0;
    if (water.get(gx, gz) > 0) return 0;
    if (roads && roads.get(gx, gz) > 0) return 0;
    if (zones && zones.get(gx, gz) === 0) return 0;
    if (reservations && reservations.get(gx, gz) > 0) return 0;
    return value;
  });
}
