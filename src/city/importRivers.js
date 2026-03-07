/**
 * Import rivers from regional data at city resolution.
 * Receives pre-computed regional vector paths, clips to city bounds,
 * adds a Chaikin subdivision for higher resolution, and paints
 * onto the city waterMask.
 */

import { chaikinSmooth, riverHalfWidth, paintPathsOntoWaterMask } from '../core/riverGeometry.js';

/**
 * Import regional rivers into city-resolution data.
 *
 * Steps:
 * 1. Receive regional riverPaths (already smoothed with width)
 * 2. Clip to city bounds + coordinate transform
 * 3. Additional Chaikin subdivision for 10m resolution
 * 4. Paint onto waterMask
 *
 * Falls back to segment tree traversal if regional paths not available.
 *
 * @param {import('../core/LayerStack.js').LayerStack} cityLayers
 */
export function importRivers(cityLayers) {
  const params = cityLayers.getData('params');
  const regionalLayers = cityLayers.getData('regionalLayers');
  if (!params) return;

  const cs = params.cellSize;
  const cityWorldW = params.width * cs;
  const cityWorldH = params.height * cs;
  const originX = params.originX || 0;
  const originZ = params.originZ || 0;

  const elevation = cityLayers.getGrid('elevation');
  const seaLevel = params.seaLevel || 0;

  // Prefer regional vector paths (new pipeline)
  const regionalPaths = cityLayers.getData('regionalRiverPaths');
  let cityRiverPaths;

  if (regionalPaths && regionalPaths.length > 0) {
    cityRiverPaths = importFromPaths(regionalPaths, originX, originZ, cityWorldW, cityWorldH, elevation, cs, seaLevel);
  } else if (regionalLayers) {
    // Fallback: build from segment tree (old pipeline)
    const rivers = regionalLayers.getData('rivers');
    if (!rivers || rivers.length === 0) return;
    cityRiverPaths = importFromSegmentTree(rivers, params, elevation, seaLevel);
  } else {
    return;
  }

  if (!cityRiverPaths || cityRiverPaths.length === 0) return;

  cityLayers.setData('riverPaths', cityRiverPaths);

  // Paint smoothed rivers onto waterMask
  const waterMask = cityLayers.getGrid('waterMask');
  if (waterMask) {
    paintPathsOntoWaterMask(waterMask, cityRiverPaths, cs, params.width, params.height);
  }
}

/**
 * Import from pre-computed regional vector paths.
 * Clips to city bounds, transforms coords, adds subdivision.
 */
function importFromPaths(regionalPaths, originX, originZ, cityWorldW, cityWorldH, elevation, cs, seaLevel) {
  const margin = 100; // world-unit margin for clipping
  const cityRiverPaths = [];

  for (const path of regionalPaths) {
    const pts = path.points;
    if (pts.length < 2) continue;

    // Transform to city-local coords and clip to bounds
    const localPoints = [];
    for (const p of pts) {
      const lx = p.x - originX;
      const lz = p.z - originZ;

      // Skip points far outside city bounds
      if (lx < -margin || lx > cityWorldW + margin ||
          lz < -margin || lz > cityWorldH + margin) continue;

      // Sea-level clip
      if (elevation) {
        const gx = Math.round(lx / cs);
        const gz = Math.round(lz / cs);
        if (gx >= 0 && gx < elevation.width && gz >= 0 && gz < elevation.height) {
          if (elevation.get(gx, gz) < seaLevel) break;
        }
      }

      localPoints.push({
        x: lx,
        z: lz,
        accumulation: p.accumulation,
      });
    }

    if (localPoints.length < 2) continue;

    // Additional Chaikin pass for 10m resolution
    const smooth = chaikinSmooth(localPoints, 1);

    const points = smooth.map(p => ({
      x: p.x,
      z: p.z,
      width: riverHalfWidth(p.accumulation) * 2,
      accumulation: p.accumulation,
    }));

    cityRiverPaths.push({ points, children: [] });
  }

  return cityRiverPaths;
}

/**
 * Fallback: import from segment tree (old pipeline path).
 * Kept for backwards compatibility when regional paths aren't available.
 */
function importFromSegmentTree(rivers, params, elevation, seaLevel) {
  const rcs = params.regionalCellSize || 50;
  const minGx = params.regionalMinGx || 0;
  const minGz = params.regionalMinGz || 0;
  const cs = params.cellSize;
  const cityWorldW = params.width * cs;
  const cityWorldH = params.height * cs;
  const maxRgx = minGx + cityWorldW / rcs;
  const maxRgz = minGz + cityWorldH / rcs;

  const cityRiverPaths = [];

  function processSegment(seg, parentConfluence) {
    if (!seg.cells || seg.cells.length < 2) {
      for (const child of (seg.children || [])) {
        processSegment(child, parentConfluence);
      }
      return null;
    }

    const worldPoints = [];
    for (const cell of seg.cells) {
      if (cell.gx >= minGx - 1 && cell.gx <= maxRgx + 1 &&
          cell.gz >= minGz - 1 && cell.gz <= maxRgz + 1) {
        if (elevation) {
          const cellGx = Math.round((cell.gx - minGx) * rcs / cs);
          const cellGz = Math.round((cell.gz - minGz) * rcs / cs);
          if (cellGx >= 0 && cellGx < params.width && cellGz >= 0 && cellGz < params.height) {
            if (elevation.get(cellGx, cellGz) < seaLevel) break;
          }
        }
        worldPoints.push({
          x: (cell.gx - minGx) * rcs,
          z: (cell.gz - minGz) * rcs,
          accumulation: cell.accumulation,
        });
      }
    }

    if (parentConfluence && worldPoints.length > 0) {
      worldPoints.push(parentConfluence);
    }

    let cityPath = null;
    if (worldPoints.length >= 2) {
      const smooth = chaikinSmooth(worldPoints, 3);
      const points = smooth.map(p => ({
        x: p.x,
        z: p.z,
        width: riverHalfWidth(p.accumulation) * 2,
        accumulation: p.accumulation,
      }));
      cityPath = { points, children: [] };
      cityRiverPaths.push(cityPath);
    }

    const firstCell = seg.cells[0];
    const joinPoint = {
      x: (firstCell.gx - minGx) * rcs,
      z: (firstCell.gz - minGz) * rcs,
      accumulation: firstCell.accumulation,
    };
    for (const child of (seg.children || [])) {
      const childResult = processSegment(child, joinPoint);
      if (childResult && cityPath) {
        cityPath.children.push(childResult);
      }
    }

    return cityPath;
  }

  for (const root of rivers) processSegment(root, null);
  return cityRiverPaths;
}
