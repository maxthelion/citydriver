/**
 * Pipeline step: extract development zones via bitmap flood-fill.
 *
 * Zones are extracted by flood-filling buildable land (thresholded by land value,
 * slope, water, roads). Each zone gets a boundary polygon traced from its cells,
 * then matched back to graph edges for topology references (boundingEdgeIds,
 * boundingNodeIds).
 *
 * Reads:  graph, waterMask, landValue, terrainSuitability, slope, elevation, nuclei
 * Writes: developmentZones (array of zones), zoneGrid (layer)
 */

import { Grid2D } from '../../core/Grid2D.js';
import { extractDevelopmentZones } from '../zoneExtraction.js';

// ── Pipeline step ──────────────────────────────────────────────────────────

/**
 * @param {object} map - FeatureMap with getLayer/setLayer, nuclei, graph
 * @returns {object} map (for chaining)
 */
export function extractZones(map) {
  const zones = extractDevelopmentZones(map);

  map.developmentZones = zones;

  // Build zoneGrid (last-write-wins — higher-priority zones overwrite earlier ones).
  // Zones are sorted by priority descending, so we write in reverse order so that
  // the highest-priority zone wins each contested cell.
  const zoneGrid = new Grid2D(map.width, map.height, {
    type: 'uint8', cellSize: map.cellSize,
    originX: map.originX, originZ: map.originZ,
  });
  for (let i = zones.length - 1; i >= 0; i--) {
    const zone = zones[i];
    for (const cell of zone.cells) {
      zoneGrid.set(cell.gx, cell.gz, zone.id || 1);
    }
  }

  // Reconcile zone.cells with zoneGrid: each cell belongs to exactly one zone.
  // Cells that were claimed by a higher-priority zone are removed from lower ones.
  for (const zone of zones) {
    zone.cells = zone.cells.filter(c => zoneGrid.get(c.gx, c.gz) === zone.id);
  }

  map.setLayer('zoneGrid', zoneGrid);

  return map;
}
