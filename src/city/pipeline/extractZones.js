/**
 * Pipeline step: extract development zones from land value and terrain.
 * Reads: slope, waterMask, roadGrid, landValue, terrainSuitability, nuclei
 * Writes: developmentZones (array), zoneGrid (layer)
 */

import { Grid2D } from '../../core/Grid2D.js';
import { extractDevelopmentZones } from '../zoneExtraction.js';
import { composeBuildability } from '../../core/composeMask.js';

/**
 * @param {object} map - FeatureMap with getLayer/setLayer, nuclei, dimensions
 * @returns {object} map (for chaining)
 */
export function extractZones(map) {
  // extractDevelopmentZones reads map.waterMask, map.landValue,
  // map.buildability, map.slope, map.roadGrid directly.
  // Create a compatibility shim until zoneExtraction.js is updated.
  const buildability = composeBuildability(map);
  const shim = {
    width: map.width,
    height: map.height,
    cellSize: map.cellSize,
    originX: map.originX,
    originZ: map.originZ,
    nuclei: map.nuclei,
    waterMask: map.getLayer('waterMask'),
    landValue: map.getLayer('landValue'),
    buildability,
    slope: map.getLayer('slope'),
    roadGrid: map.getLayer('roadGrid'),
    elevation: map.getLayer('elevation'),
  };

  const zones = extractDevelopmentZones(shim);
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
