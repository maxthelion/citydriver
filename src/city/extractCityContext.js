/**
 * B1a. Extract city-scale context from regional layers.
 * Crops regional grids to city bounds and builds a city-scale LayerStack.
 */

import { LayerStack } from '../core/LayerStack.js';
import { Grid2D } from '../core/Grid2D.js';

/**
 * @param {import('../core/LayerStack.js').LayerStack} regionalLayers
 * @param {object} settlement - {gx, gz, tier, type, score}
 * @param {object} [options]
 * @param {number} [options.cityRadius=30] - Radius in regional grid cells
 * @param {number} [options.cityCellSize=10] - City-scale cell size in world units
 * @returns {LayerStack}
 */
export function extractCityContext(regionalLayers, settlement, options = {}) {
  const {
    cityRadius = 30,
    cityCellSize = 10,
  } = options;

  const params = regionalLayers.getData('params');
  const regionalCellSize = params.cellSize;
  const seaLevel = params.seaLevel;

  const cityLayers = new LayerStack();

  // City bounds in regional grid coords
  const minGx = Math.max(0, settlement.gx - cityRadius);
  const minGz = Math.max(0, settlement.gz - cityRadius);
  const maxGx = Math.min(params.width - 1, settlement.gx + cityRadius);
  const maxGz = Math.min(params.height - 1, settlement.gz + cityRadius);

  // City grid dimensions at finer resolution
  const regionWidth = maxGx - minGx + 1;
  const regionHeight = maxGz - minGz + 1;
  const scaleRatio = regionalCellSize / cityCellSize;
  const cityWidth = Math.floor(regionWidth * scaleRatio);
  const cityHeight = Math.floor(regionHeight * scaleRatio);

  // City origin in world coordinates
  const originX = minGx * regionalCellSize;
  const originZ = minGz * regionalCellSize;

  cityLayers.setData('params', {
    width: cityWidth,
    height: cityHeight,
    cellSize: cityCellSize,
    seaLevel,
    originX,
    originZ,
    settlement,
    regionalMinGx: minGx,
    regionalMinGz: minGz,
    regionalCellSize,
  });

  // Resample each grid layer at city resolution
  const gridNames = ['elevation', 'slope', 'erosionResistance', 'soilFertility',
    'permeability', 'rockType', 'waterMask', 'landCover'];

  for (const name of gridNames) {
    const regionalGrid = regionalLayers.getGrid(name);
    if (!regionalGrid) continue;

    const isInteger = name === 'rockType' || name === 'landCover';
    // waterMask is binary but we bilinear-sample + threshold for smooth edges
    const smoothBinary = name === 'waterMask';
    const type = (isInteger || smoothBinary) ? 'uint8' : 'float32';

    const cityGrid = new Grid2D(cityWidth, cityHeight, {
      type,
      cellSize: cityCellSize,
      originX,
      originZ,
    });

    for (let cz = 0; cz < cityHeight; cz++) {
      for (let cx = 0; cx < cityWidth; cx++) {
        // Map city grid cell to regional grid coordinates
        const rgx = minGx + cx / scaleRatio;
        const rgz = minGz + cz / scaleRatio;

        if (isInteger) {
          // Nearest-neighbor for categorical data
          cityGrid.set(cx, cz, regionalGrid.get(Math.round(rgx), Math.round(rgz)));
        } else if (smoothBinary) {
          // Bilinear interpolation then threshold for smooth binary boundaries
          const v = regionalGrid.sample(rgx, rgz);
          cityGrid.set(cx, cz, v >= 0.5 ? 1 : 0);
        } else {
          // Bilinear interpolation for continuous data
          cityGrid.set(cx, cz, regionalGrid.sample(rgx, rgz));
        }
      }
    }

    cityLayers.setGrid(name, cityGrid);
  }

  // Copy relevant data
  cityLayers.setData('settlement', settlement);
  cityLayers.setData('rivers', regionalLayers.getData('rivers'));
  cityLayers.setData('regionalRiverPaths', regionalLayers.getData('riverPaths'));

  // Copy regional roads that pass through the city area
  const roads = regionalLayers.getData('roads') || [];
  const cityRoads = roads.filter(road => {
    if (!road.path) return false;
    return road.path.some(p => {
      return p.gx >= minGx && p.gx <= maxGx && p.gz >= minGz && p.gz <= maxGz;
    });
  });
  cityLayers.setData('regionalRoads', cityRoads);

  return cityLayers;
}
