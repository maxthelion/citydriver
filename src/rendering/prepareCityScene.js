/**
 * Pre-process city FeatureMap data for 3D rendering.
 *
 * Converts world-coord polylines to local scene coords, computes road surface
 * heights with neutral camber, and cuts terrain under roads and rivers.
 * River monotonic flow is enforced upstream by carveChannels() in the pipeline.
 *
 * Returns a render-ready data object that mesh builders consume directly.
 */

const ROAD_Y_OFFSET = 0.3;  // road surface sits this far above natural terrain
const RIVER_Y_OFFSET = -0.3; // river bed sits this far below natural terrain
const CUT_DEPTH = 0.5;       // terrain depressed this far below road/river surface
const BLEND_CELLS = 2;       // cells of slope from natural terrain to cut

/**
 * @param {import('../core/FeatureMap.js').FeatureMap} map
 * @returns {CitySceneData}
 */
export function prepareCityScene(map) {
  const w = map.width, h = map.height, cs = map.cellSize;
  const ox = map.originX, oz = map.originZ;

  // 1. Convert road polylines to local coords + compute flat-camber heights
  const roads = prepareRoads(map, ox, oz, cs);

  // 2. Convert river polylines to local coords + enforce downhill flow
  const rivers = prepareRivers(map, ox, oz, cs);

  // 3. Build surface height grids from roads and rivers
  const surfaceGrid = new Float32Array(w * h).fill(-Infinity);
  stampRoadHeights(roads, surfaceGrid, w, h, cs);
  stampRiverHeights(rivers, surfaceGrid, w, h, cs);

  // 4. Compute modified terrain elevation (cut under roads/rivers, blend edges)
  const cutElevation = cutTerrain(map.elevation, surfaceGrid, w, h);

  return { roads, rivers, cutElevation, surfaceGrid, width: w, height: h, cellSize: cs };
}

/**
 * Convert road polylines from world to local coords.
 * Compute centerline elevation for neutral camber.
 * Apply Chaikin corner-cutting to round sharp corners.
 */
function prepareRoads(map, ox, oz, cs) {
  return map.roads.map(road => {
    const pts = road.polyline;
    if (!pts || pts.length < 2) return null;

    const halfW = (road.width || 6) / 2;
    let localPts = pts.map(p => {
      const x = p.x - ox;
      const z = p.z - oz;
      const centerY = map.elevation.sample(x / cs, z / cs) + ROAD_Y_OFFSET;
      return { x, z, y: centerY };
    });

    // Chaikin corner-cutting: 2 iterations to round sharp corners
    for (let iter = 0; iter < 2; iter++) {
      localPts = _chaikinSmooth(localPts);
    }

    return {
      localPts,
      halfWidth: halfW,
      width: road.width || 6,
      hierarchy: road.hierarchy || 'local',
    };
  }).filter(Boolean);
}

/**
 * One iteration of Chaikin corner-cutting smoothing.
 * Preserves first and last points. Doubles point count per iteration.
 */
function _chaikinSmooth(pts) {
  if (pts.length < 3) return pts;
  const result = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    result.push({
      x: a.x * 0.75 + b.x * 0.25,
      z: a.z * 0.75 + b.z * 0.25,
      y: a.y * 0.75 + b.y * 0.25,
    });
    result.push({
      x: a.x * 0.25 + b.x * 0.75,
      z: a.z * 0.25 + b.z * 0.75,
      y: a.y * 0.25 + b.y * 0.75,
    });
  }
  result.push(pts[pts.length - 1]);
  return result;
}

/**
 * Convert river polylines from world to local coords.
 * Elevation is read from the map (already carved by carveChannels in the pipeline).
 * A lightweight monotonic clamp handles any remaining interpolation artifacts
 * from bilinear sampling between carved grid cells.
 */
function prepareRivers(map, ox, oz, cs) {
  return map.rivers.map(river => {
    const pts = river.polyline;
    if (!pts || pts.length < 2) return null;

    const localPts = pts.map(p => {
      const x = p.x - ox;
      const z = p.z - oz;
      const y = map.elevation.sample(x / cs, z / cs) + RIVER_Y_OFFSET;
      return { x, z, y, width: p.width || 10, accumulation: p.accumulation || 0 };
    });

    // Determine downstream direction from accumulation
    if (localPts.length >= 2) {
      if (localPts[0].accumulation > localPts[localPts.length - 1].accumulation) {
        localPts.reverse();
      }
    }

    // Clamp any remaining uphill bumps from grid interpolation
    for (let i = 1; i < localPts.length; i++) {
      if (localPts[i].y > localPts[i - 1].y) {
        localPts[i].y = localPts[i - 1].y;
      }
    }

    return { localPts };
  }).filter(Boolean);
}

/**
 * Stamp road surface heights into the grid.
 * For each road polyline point, stamp a circle of radius = halfWidth + 1 cell.
 */
function stampRoadHeights(roads, grid, w, h, cs) {
  for (const road of roads) {
    const stampRadius = Math.ceil(road.halfWidth / cs) + 1;
    for (const p of road.localPts) {
      const cgx = Math.round(p.x / cs), cgz = Math.round(p.z / cs);
      for (let dj = -stampRadius; dj <= stampRadius; dj++) {
        for (let di = -stampRadius; di <= stampRadius; di++) {
          const gx = cgx + di, gz = cgz + dj;
          if (gx < 0 || gx >= w || gz < 0 || gz >= h) continue;
          const i = gz * w + gx;
          if (p.y > grid[i]) grid[i] = p.y;
        }
      }
    }
  }
}

/**
 * Stamp river surface heights into the grid.
 * For each river polyline point, stamp a circle of radius = halfWidth + 1 cell.
 */
function stampRiverHeights(rivers, grid, w, h, cs) {
  for (const river of rivers) {
    for (const p of river.localPts) {
      const halfW = (p.width || 10) / 2;
      const stampRadius = Math.ceil(halfW / cs) + 1;
      const cgx = Math.round(p.x / cs), cgz = Math.round(p.z / cs);
      for (let dj = -stampRadius; dj <= stampRadius; dj++) {
        for (let di = -stampRadius; di <= stampRadius; di++) {
          const gx = cgx + di, gz = cgz + dj;
          if (gx < 0 || gx >= w || gz < 0 || gz >= h) continue;
          const i = gz * w + gx;
          // Rivers cut down, so use min (lowest surface wins for terrain cutting)
          if (grid[i] === -Infinity || p.y < grid[i]) grid[i] = p.y;
        }
      }
    }
  }
}

/**
 * Cut terrain under roads/rivers with a blend zone at the edges.
 * Returns a new Float32Array of modified elevations.
 */
function cutTerrain(elevation, surfaceGrid, w, h) {
  const result = new Float32Array(w * h);

  // Compute distance-to-feature grid (0 = on feature, up to BLEND_CELLS)
  const distToFeature = new Float32Array(w * h).fill(999);
  for (let i = 0; i < w * h; i++) {
    if (surfaceGrid[i] > -Infinity) distToFeature[i] = 0;
  }

  // Propagate distances (multiple passes for accuracy)
  for (let pass = 0; pass < BLEND_CELLS; pass++) {
    for (let gz = 1; gz < h - 1; gz++) {
      for (let gx = 1; gx < w - 1; gx++) {
        const i = gz * w + gx;
        distToFeature[i] = Math.min(
          distToFeature[i],
          distToFeature[i - w] + 1,
          distToFeature[i + w] + 1,
          distToFeature[i - 1] + 1,
          distToFeature[i + 1] + 1,
        );
      }
    }
    // Reverse pass for better propagation
    for (let gz = h - 2; gz >= 1; gz--) {
      for (let gx = w - 2; gx >= 1; gx--) {
        const i = gz * w + gx;
        distToFeature[i] = Math.min(
          distToFeature[i],
          distToFeature[i + w] + 1,
          distToFeature[i - w] + 1,
          distToFeature[i + 1] + 1,
          distToFeature[i - 1] + 1,
        );
      }
    }
  }

  // Find nearest feature surface height for blend zone cells
  const blendHeight = new Float32Array(w * h).fill(-Infinity);
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      const i = gz * w + gx;
      if (surfaceGrid[i] > -Infinity) {
        blendHeight[i] = surfaceGrid[i];
        continue;
      }
      if (distToFeature[i] > BLEND_CELLS) continue;
      // Search nearby for feature height
      const r = Math.ceil(distToFeature[i]);
      let best = -Infinity;
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          const ngx = gx + di, ngz = gz + dj;
          if (ngx < 0 || ngx >= w || ngz < 0 || ngz >= h) continue;
          const ni = ngz * w + ngx;
          if (surfaceGrid[ni] > -Infinity && surfaceGrid[ni] !== -Infinity) {
            if (best === -Infinity || surfaceGrid[ni] < best) best = surfaceGrid[ni];
          }
        }
      }
      if (best > -Infinity) blendHeight[i] = best;
    }
  }

  // Apply terrain cutting
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      const i = gz * w + gx;
      let elev = elevation.get(gx, gz);
      const dist = distToFeature[i];

      if (dist <= BLEND_CELLS && blendHeight[i] > -Infinity) {
        const featureY = blendHeight[i] - CUT_DEPTH;
        if (dist === 0) {
          // Directly under feature: force terrain down
          elev = Math.min(elev, featureY);
        } else {
          // Blend zone: interpolate
          const t = dist / BLEND_CELLS;
          const cutElev = Math.min(elev, featureY);
          elev = cutElev + (elev - cutElev) * t;
        }
      }

      result[i] = elev;
    }
  }

  return result;
}
