/**
 * Pipeline step: reserve land for non-residential uses based on archetype.
 * Reads: zoneGrid, developmentZones
 * Writes: reservationGrid (layer)
 *
 * Reservation types (uint8 values in reservationGrid):
 *   0 = unreserved (available for residential)
 *   1 = commercial
 *   2 = industrial
 *   3 = civic
 *   4 = open space
 */

import { Grid2D } from '../../core/Grid2D.js';

export const RESERVATION = {
  NONE: 0,
  COMMERCIAL: 1,
  INDUSTRIAL: 2,
  CIVIC: 3,
  OPEN_SPACE: 4,
};

/**
 * @param {object} map - FeatureMap
 * @param {object|null} archetype - City archetype parameters (see specs/v5/city-archetypes.md)
 * @returns {object} map (for chaining)
 */
export function reserveLandUse(map, archetype) {
  const grid = new Grid2D(map.width, map.height, {
    type: 'uint8',
    cellSize: map.cellSize,
    originX: map.originX,
    originZ: map.originZ,
  });

  if (archetype) {
    // TODO: implement archetype-driven reservation logic
    // See specs/v5/city-archetypes.md for archetype parameters
    // and reservation rules per archetype type.
  }

  map.setLayer('reservationGrid', grid);
  return map;
}
