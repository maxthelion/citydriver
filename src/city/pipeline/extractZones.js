/**
 * Pipeline step: extract development zones from land value and terrain.
 * Reads: slope, waterMask, roadGrid, landValue, terrainSuitability, nuclei
 * Writes: developmentZones (array), zoneGrid (layer)
 */

import { Grid2D } from '../../core/Grid2D.js';
import { extractDevelopmentZones } from '../zoneExtraction.js';

/**
 * @param {object} map - FeatureMap with getLayer/setLayer, nuclei, dimensions
 * @returns {object} map (for chaining)
 */
export function extractZones(map) {
  const zones = extractDevelopmentZones(map);
  map.developmentZones = zones;

  // Build zoneGrid — mark cells that belong to any zone
  const zoneGrid = new Grid2D(map.width, map.height, {
    type: 'uint8',
    cellSize: map.cellSize,
    originX: map.originX,
    originZ: map.originZ,
  });
  for (const zone of zones) {
    for (const cell of zone.cells) {
      zoneGrid.set(cell.gx, cell.gz, zone.id || 1);
    }
  }
  map.setLayer('zoneGrid', zoneGrid);

  return map;
}
