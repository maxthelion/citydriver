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
const BLEND_CELLS = 3;       // cells of slope from natural terrain to cut

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

  // 2b. Convert railway polylines to local coords + terrain-following heights
  const railways = prepareRailways(map, ox, oz, cs);

  // 3. Build surface height grids from roads and rivers
  const surfaceGrid = new Float32Array(w * h).fill(-Infinity);
  stampRoadHeights(roads, surfaceGrid, w, h, cs);
  stampRiverHeights(rivers, surfaceGrid, w, h, cs);

  // 4. Compute modified terrain elevation (cut under roads/rivers, blend edges)
  const cutElevation = cutTerrain(map.elevation, surfaceGrid, w, h);

  return { roads, rivers, railways, cutElevation, surfaceGrid, width: w, height: h, cellSize: cs };
}

/**
 * Convert road polylines from world to local coords.
 * Compute centerline elevation for neutral camber.
 * Polylines are already Chaikin-smoothed by the pipeline.
 */
function prepareRoads(map, ox, oz, cs) {
  return map.ways.map(road => {
    const pts = road.polyline;
    if (!pts || pts.length < 2) return null;

    const halfW = (road.width || 6) / 2;
    let localPts = pts.map(p => {
      const x = p.x - ox;
      const z = p.z - oz;
      const centerY = map.elevation.sample(x / cs, z / cs) + ROAD_Y_OFFSET;
      return { x, z, y: centerY };
    });

    // Densify: insert points every ~1 cell so elevation tracks terrain on slopes
    localPts = _densifyAndResample(localPts, cs, map.elevation, ox, oz);

    // Trim segments below sea level (roads shouldn't render in the sea)
    if (map.seaLevel != null) {
      const seaY = map.seaLevel + ROAD_Y_OFFSET;
      localPts = _trimBelowSea(localPts, seaY);
      if (localPts.length < 2) return null;
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
 * Convert railway polylines from world to local coords.
 * Same approach as roads: densify for terrain following, sample elevation.
 */
function prepareRailways(map, ox, oz, cs) {
  const railFeatures = (map.features || []).filter(f => f.type === 'railway');
  return railFeatures.map(rail => {
    const pts = rail.polyline;
    if (!pts || pts.length < 2) return null;

    let localPts = pts.map(p => {
      const x = p.x - ox;
      const z = p.z - oz;
      const centerY = map.elevation.sample(x / cs, z / cs) + ROAD_Y_OFFSET;
      return { x, z, y: centerY };
    });

    localPts = _densifyAndResample(localPts, cs, map.elevation, ox, oz);

    if (map.seaLevel != null) {
      const seaY = map.seaLevel + ROAD_Y_OFFSET;
      localPts = _trimBelowSea(localPts, seaY);
      if (localPts.length < 2) return null;
    }

    return { localPts, halfWidth: 7, hierarchy: rail.hierarchy || 'branch' };
  }).filter(Boolean);
}

/**
 * Insert intermediate points along road segments so that no two consecutive
 * points are more than ~1 cell apart. Resample elevation at each new point
 * so the road closely tracks the terrain on slopes.
 */
function _densifyAndResample(pts, cs, elevation, ox, oz) {
  if (pts.length < 2) return pts;
  const result = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    result.push(a);
    const dx = b.x - a.x, dz = b.z - a.z;
    const segLen = Math.sqrt(dx * dx + dz * dz);
    const steps = Math.floor(segLen / cs);
    if (steps > 1) {
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        const x = a.x + dx * t;
        const z = a.z + dz * t;
        // Resample elevation from the terrain grid at this position
        const y = elevation.sample(x / cs, z / cs) + ROAD_Y_OFFSET;
        result.push({ x, z, y });
      }
    }
  }
  result.push(pts[pts.length - 1]);
  return result;
}

/**
 * Keep only the longest run of above-sea-level points.
 * Roads that dip into the sea get trimmed at the coastline.
 */
function _trimBelowSea(pts, seaY) {
  let bestStart = 0, bestLen = 0;
  let runStart = -1;
  for (let i = 0; i <= pts.length; i++) {
    if (i < pts.length && pts[i].y >= seaY) {
      if (runStart < 0) runStart = i;
    } else {
      if (runStart >= 0) {
        const runLen = i - runStart;
        if (runLen > bestLen) { bestStart = runStart; bestLen = runLen; }
        runStart = -1;
      }
    }
  }
  return bestLen > 0 ? pts.slice(bestStart, bestStart + bestLen) : [];
}

/**
 * Convert river polylines from world to local coords.
 * Elevation is read from the map (already carved by carveChannels in the pipeline).
 * A lightweight monotonic clamp handles any remaining interpolation artifacts
 * from bilinear sampling between carved grid cells.
 */
function prepareRivers(map, ox, oz, cs) {
  const w = map.width, h = map.height;
  return map.rivers.map(river => {
    const pts = river.polyline;
    if (!pts || pts.length < 2) return null;

    const seaLevel = map.seaLevel || 0;
    const waterType = map.waterType || (map.hasLayer ? map.getLayer('waterType') : null);

    const localPts = [];
    for (const p of pts) {
      const x = p.x - ox;
      const z = p.z - oz;
      const gx = Math.round(x / cs);
      const gz = Math.round(z / cs);

      // Stop the river ribbon where it enters open sea water
      if (waterType && gx >= 0 && gx < w && gz >= 0 && gz < h) {
        if (waterType.get(gx, gz) === 1) break; // sea cell — stop here
      }

      const y = map.elevation.sample(x / cs, z / cs) + RIVER_Y_OFFSET;
      localPts.push({ x, z, y, width: p.width || 10 });
    }
    if (localPts.length < 2) return null;

    // Order downstream using elevation (high → low).
    if (localPts[0].y < localPts[localPts.length - 1].y) {
      localPts.reverse();
    }

    // Clamp any remaining uphill bumps from bilinear grid interpolation
    for (let i = 1; i < localPts.length; i++) {
      if (localPts[i].y > localPts[i - 1].y) {
        localPts[i].y = localPts[i - 1].y;
      }
    }

    // Extend endpoints to terrain boundary so clipped rivers don't stop short.
    // Skip extension for endpoints at/below sea level (river mouth at coast).
    const maxX = (w - 1) * cs, maxZ = (h - 1) * cs;
    const seaY = (map.seaLevel || 0) + RIVER_Y_OFFSET;
    _extendToEdge(localPts, 0, 1, maxX, maxZ, cs, seaY);
    _extendToEdge(localPts, localPts.length - 1, localPts.length - 2, maxX, maxZ, cs, seaY);

    return { localPts };
  }).filter(Boolean);
}

/**
 * If a river endpoint is within a few cells of the terrain boundary,
 * extend it along its final direction to reach the edge. This prevents
 * clipped rivers from stopping visibly short of the terrain.
 */
function _extendToEdge(pts, endIdx, neighborIdx, maxX, maxZ, cs, seaY) {
  const ep = pts[endIdx];
  // Don't extend if endpoint is at/below sea level (river mouth at coast)
  if (ep.y <= seaY) return;
  const threshold = cs * 3;
  const nearEdge = ep.x < threshold || ep.z < threshold ||
                   ep.x > maxX - threshold || ep.z > maxZ - threshold;
  if (!nearEdge) return;

  const nb = pts[neighborIdx];
  const dx = ep.x - nb.x, dz = ep.z - nb.z;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 0.01) return;
  const ux = dx / len, uz = dz / len;

  // Extend just enough to reach the boundary (capped to avoid crossing sea)
  const maxExt = cs * 4;
  let tMin = Infinity;
  if (ux > 0.001) tMin = Math.min(tMin, (maxX - ep.x) / ux);
  else if (ux < -0.001) tMin = Math.min(tMin, -ep.x / ux);
  if (uz > 0.001) tMin = Math.min(tMin, (maxZ - ep.z) / uz);
  else if (uz < -0.001) tMin = Math.min(tMin, -ep.z / uz);

  if (tMin <= 0 || tMin === Infinity) return;
  tMin = Math.min(tMin, maxExt);

  const ext = {
    x: ep.x + ux * tMin, z: ep.z + uz * tMin,
    y: ep.y, width: ep.width,
  };
  if (endIdx === 0) pts.unshift(ext);
  else pts.push(ext);
}

/**
 * Stamp road surface heights into the grid.
 * Walks along each road segment at cell-sized steps, stamping a circle
 * of radius = halfWidth + 1 cell at each step for continuous coverage.
 */
function stampRoadHeights(roads, grid, w, h, cs) {
  for (const road of roads) {
    const stampRadius = Math.ceil(road.halfWidth / cs) + 1;
    const pts = road.localPts;
    for (let i = 0; i < pts.length; i++) {
      _stampCircle(grid, pts[i], stampRadius, w, h, cs);

      // Walk along segment to next point, stamping at cell intervals
      if (i < pts.length - 1) {
        const a = pts[i], b = pts[i + 1];
        const dx = b.x - a.x, dz = b.z - a.z;
        const segLen = Math.sqrt(dx * dx + dz * dz);
        const steps = Math.ceil(segLen / cs);
        for (let s = 1; s < steps; s++) {
          const t = s / steps;
          const y = a.y + (b.y - a.y) * t;
          _stampCircle(grid, { x: a.x + dx * t, z: a.z + dz * t, y }, stampRadius, w, h, cs);
        }
      }
    }
  }
}

function _stampCircle(grid, p, radius, w, h, cs) {
  const cgx = Math.round(p.x / cs), cgz = Math.round(p.z / cs);
  for (let dj = -radius; dj <= radius; dj++) {
    for (let di = -radius; di <= radius; di++) {
      const gx = cgx + di, gz = cgz + dj;
      if (gx < 0 || gx >= w || gz < 0 || gz >= h) continue;
      const i = gz * w + gx;
      if (p.y > grid[i]) grid[i] = p.y;
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
