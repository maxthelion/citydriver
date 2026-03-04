/**
 * Phase 1: Terrain Preparation & Water Infrastructure
 *
 * Establishes the physical constraints everything else must respect:
 *   - Refined heightmap from regional data
 *   - River channel carving + water cells
 *   - Coast depression + shoreline extraction
 *   - Terrain zone classification (flat-low, flat-elevated, gentle, steep, hilltop)
 *   - Slope map
 *   - Anchor point detection (river crossings, harbors, hilltops, confluences)
 *   - Water exclusion zones (BFS buffer around water)
 */

import { Heightmap } from '../core/heightmap.js';
import { PerlinNoise } from '../core/noise.js';
import { lerp, smoothstep, clamp, distance2D, pointToSegmentDist } from '../core/math.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RIVER_CONSTANTS = {
  MIN_WIDTH: 15,
  MAX_WIDTH: 40,
  CHANNEL_DEPTH: 4,
  FLOODPLAIN_DEPTH: 1.5,
  BANK_TRANSITION: 10,
};

/** Terrain zone codes */
export const ZONE = {
  FLAT_LOW: 0,        // floodplain, coastal flat → industrial, docks
  FLAT_ELEVATED: 1,   // prime buildable land → high density
  GENTLE: 2,          // good residential
  STEEP: 3,           // low density / parkland
  HILLTOP: 4,         // landmark sites
};

/** Slope thresholds for zone classification */
const SLOPE_GENTLE = 0.03;   // below this = flat
const SLOPE_STEEP = 0.15;    // above this = steep

/** Hilltop local-maximum search radius in cells */
const HILLTOP_RADIUS = 20;

/** Water exclusion BFS buffer in cells */
const WATER_EXCLUSION_BUFFER = 6;

// ---------------------------------------------------------------------------
// Terrain refinement (ported from terrain.js)
// ---------------------------------------------------------------------------

/**
 * Generate a city-scale heightmap by refining the regional heightmap.
 *
 * @param {Object} cityContext
 * @param {Object} rng - SeededRandom
 * @param {Object} params
 * @param {number} params.gridSize
 * @param {number} params.cellSize
 * @param {number} [params.detailAmplitude=3]
 * @returns {Heightmap} NOT frozen
 */
function refineTerrain(cityContext, rng, params) {
  const { gridSize, cellSize, detailAmplitude = 3 } = params;

  const noiseRng = rng.fork('terrain-detail');
  const noise = new PerlinNoise(noiseRng);

  const heightmap = new Heightmap(gridSize, gridSize, cellSize);
  const { regionHeightmap, cityBounds } = cityContext;

  for (let gz = 0; gz < gridSize; gz++) {
    for (let gx = 0; gx < gridSize; gx++) {
      const localX = gx * cellSize;
      const localZ = gz * cellSize;

      const regionX = cityBounds.minX + localX;
      const regionZ = cityBounds.minZ + localZ;

      const coarse = regionHeightmap.sample(regionX, regionZ);

      const detail = noise.fbm(regionX, regionZ, {
        frequency: 1 / 50,
        octaves: 3,
        amplitude: detailAmplitude,
        persistence: 0.5,
        lacunarity: 2,
      });

      heightmap.set(gx, gz, coarse + detail);
    }
  }

  return heightmap;
}

// ---------------------------------------------------------------------------
// River generation (ported from river.js)
// ---------------------------------------------------------------------------

function generateRiverCenterline(controlPoints, rng, sampleInterval = 4, meanderAmplitude = 8) {
  if (controlPoints.length < 2) return controlPoints.slice();

  const meandered = [controlPoints[0]];
  for (let i = 1; i < controlPoints.length - 1; i++) {
    const prev = controlPoints[i - 1];
    const next = controlPoints[i + 1];
    const curr = controlPoints[i];

    const dx = next.x - prev.x;
    const dz = next.z - prev.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.001) {
      meandered.push(curr);
      continue;
    }

    const perpX = -dz / len;
    const perpZ = dx / len;

    const offset = (rng.next() - 0.5) * 2 * meanderAmplitude;
    meandered.push({
      x: curr.x + perpX * offset,
      z: curr.z + perpZ * offset,
    });
  }
  meandered.push(controlPoints[controlPoints.length - 1]);

  const centerline = [];
  let totalLength = 0;
  for (let i = 0; i < meandered.length - 1; i++) {
    totalLength += distance2D(meandered[i].x, meandered[i].z, meandered[i + 1].x, meandered[i + 1].z);
  }

  const numSamples = Math.max(2, Math.floor(totalLength / sampleInterval));

  for (let s = 0; s <= numSamples; s++) {
    const t = s / numSamples;
    const targetDist = t * totalLength;

    let accumulated = 0;
    let found = false;
    for (let i = 0; i < meandered.length - 1; i++) {
      const segLen = distance2D(
        meandered[i].x, meandered[i].z,
        meandered[i + 1].x, meandered[i + 1].z
      );

      if (accumulated + segLen >= targetDist) {
        const localT = segLen > 0 ? (targetDist - accumulated) / segLen : 0;
        centerline.push({
          x: lerp(meandered[i].x, meandered[i + 1].x, localT),
          z: lerp(meandered[i].z, meandered[i + 1].z, localT),
        });
        found = true;
        break;
      }
      accumulated += segLen;
    }

    if (!found) {
      centerline.push(meandered[meandered.length - 1]);
    }
  }

  return centerline;
}

function distanceToCenterline(wx, wz, centerline) {
  let minDist = Infinity;
  for (let i = 0; i < centerline.length - 1; i++) {
    const d = pointToSegmentDist(
      wx, wz,
      centerline[i].x, centerline[i].z,
      centerline[i + 1].x, centerline[i + 1].z
    );
    if (d < minDist) minDist = d;
  }
  return minDist;
}

/**
 * Carve rivers into heightmap and collect water cells.
 * Ported from river.js.
 */
function carveRivers(heightmap, cityContext, rng) {
  const riverRng = rng.fork('rivers');
  const { rivers: regionalRivers, cityBounds } = cityContext;
  const gridWidth = heightmap.width;
  const gridHeight = heightmap.height;
  const cellSize = heightmap._cellSize;

  const cityRivers = [];
  const waterCells = new Set();

  if (!regionalRivers || regionalRivers.length === 0) {
    return { rivers: cityRivers, waterCells };
  }

  for (const river of regionalRivers) {
    const segRng = riverRng.fork('seg');

    const regionalCellSize = cityContext.regionHeightmap._cellSize;
    const controlPoints = river.cells.map(cell => ({
      x: cell.gx * regionalCellSize - cityBounds.minX,
      z: cell.gz * regionalCellSize - cityBounds.minZ,
    }));

    const entryLocal = {
      x: river.entryPoint.x - cityBounds.minX,
      z: river.entryPoint.z - cityBounds.minZ,
    };
    const exitLocal = {
      x: river.exitPoint.x - cityBounds.minX,
      z: river.exitPoint.z - cityBounds.minZ,
    };

    const orderedPoints = [entryLocal, ...controlPoints, exitLocal];

    const meanderAmp = clamp(river.flowVolume / 2000, 2, 15);
    const centerline = generateRiverCenterline(orderedPoints, segRng, 4, meanderAmp);

    const width = lerp(
      RIVER_CONSTANTS.MIN_WIDTH,
      RIVER_CONSTANTS.MAX_WIDTH,
      clamp(river.flowVolume / 10000, 0, 1)
    );
    const halfWidth = width / 2;
    const floodplainWidth = width * lerp(1.5, 3, clamp(river.flowVolume / 10000, 0, 1));
    const halfFloodplain = halfWidth + floodplainWidth;

    cityRivers.push({ centerline, width, floodplainWidth });

    // Monotonic elevation enforcement
    const centerlineHeights = centerline.map(pt => {
      const cx = clamp(pt.x, 0, (gridWidth - 1) * cellSize);
      const cz = clamp(pt.z, 0, (gridHeight - 1) * cellSize);
      return heightmap.sample(cx, cz);
    });
    for (let i = 1; i < centerlineHeights.length; i++) {
      if (centerlineHeights[i] > centerlineHeights[i - 1]) {
        centerlineHeights[i] = centerlineHeights[i - 1];
      }
    }

    // Carve into heightmap — 3-zone carving
    let minGx = gridWidth, maxGx = 0, minGz = gridHeight, maxGz = 0;
    for (const pt of centerline) {
      const gx = Math.floor(pt.x / cellSize);
      const gz = Math.floor(pt.z / cellSize);
      const margin = Math.ceil(halfFloodplain / cellSize) + 2;
      minGx = Math.min(minGx, gx - margin);
      maxGx = Math.max(maxGx, gx + margin);
      minGz = Math.min(minGz, gz - margin);
      maxGz = Math.max(maxGz, gz + margin);
    }

    minGx = Math.max(0, minGx);
    maxGx = Math.min(gridWidth - 1, maxGx);
    minGz = Math.max(0, minGz);
    maxGz = Math.min(gridHeight - 1, maxGz);

    for (let gz = minGz; gz <= maxGz; gz++) {
      for (let gx = minGx; gx <= maxGx; gx++) {
        const wx = gx * cellSize;
        const wz = gz * cellSize;

        const dist = distanceToCenterline(wx, wz, centerline);
        if (dist > halfFloodplain + RIVER_CONSTANTS.BANK_TRANSITION) continue;

        const currentH = heightmap.get(gx, gz);

        // Find nearest segment for bed elevation
        let bestSegI = 0;
        let bestDist = Infinity;
        let bestT = 0;
        for (let i = 0; i < centerline.length - 1; i++) {
          const ax = centerline[i].x;
          const az = centerline[i].z;
          const bx = centerline[i + 1].x;
          const bz = centerline[i + 1].z;
          const dx = bx - ax;
          const dz = bz - az;
          const lenSq = dx * dx + dz * dz;
          let t = 0;
          if (lenSq > 0) {
            t = clamp(((wx - ax) * dx + (wz - az) * dz) / lenSq, 0, 1);
          }
          const projX = ax + t * dx;
          const projZ = az + t * dz;
          const d = distance2D(wx, wz, projX, projZ);
          if (d < bestDist) {
            bestDist = d;
            bestSegI = i;
            bestT = t;
          }
        }

        const bedH = lerp(
          centerlineHeights[bestSegI],
          centerlineHeights[bestSegI + 1],
          bestT
        ) - RIVER_CONSTANTS.CHANNEL_DEPTH;

        if (dist < halfWidth) {
          const channelFactor = smoothstep(0, halfWidth, dist);
          const channelH = lerp(bedH, bedH + RIVER_CONSTANTS.CHANNEL_DEPTH * 0.3, channelFactor);
          heightmap.set(gx, gz, Math.min(currentH, channelH));
          waterCells.add(gz * gridWidth + gx);
        } else if (dist < halfFloodplain) {
          const fpFactor = smoothstep(halfWidth, halfFloodplain, dist);
          const floodplainH = bedH + RIVER_CONSTANTS.CHANNEL_DEPTH;
          const targetH = lerp(
            floodplainH,
            currentH - RIVER_CONSTANTS.FLOODPLAIN_DEPTH * (1 - fpFactor),
            fpFactor
          );
          heightmap.set(gx, gz, Math.min(currentH, targetH));
        } else {
          const bankFactor = smoothstep(
            halfFloodplain,
            halfFloodplain + RIVER_CONSTANTS.BANK_TRANSITION,
            dist
          );
          const floodEdgeH = currentH - RIVER_CONSTANTS.FLOODPLAIN_DEPTH * 0.2;
          const transitionH = lerp(floodEdgeH, currentH, bankFactor);
          heightmap.set(gx, gz, Math.min(currentH, transitionH));
        }
      }
    }
  }

  return { rivers: cityRivers, waterCells };
}

// ---------------------------------------------------------------------------
// Coast generation (ported from coast.js)
// ---------------------------------------------------------------------------

function applyCoast(heightmap, cityContext, rng) {
  if (!cityContext.coastline) return null;

  const coastRng = rng.fork('coast');
  const noise = new PerlinNoise(coastRng);
  const seaLevel = cityContext.seaLevel;
  const edge = cityContext.coastline.edge;

  const gridWidth = heightmap.width;
  const gridHeight = heightmap.height;
  const cellSize = heightmap._cellSize;
  const worldWidth = (gridWidth - 1) * cellSize;
  const worldHeight = (gridHeight - 1) * cellSize;

  const influenceDepth = Math.max(worldWidth, worldHeight) * 0.3;

  // Use regional coordinates for coast distance so we measure from
  // the actual regional coast edge, not the city map edge
  const { cityBounds } = cityContext;
  const regionW = cityContext.regionHeightmap.worldWidth;
  const regionH = cityContext.regionHeightmap.worldHeight;

  for (let gz = 0; gz < gridHeight; gz++) {
    for (let gx = 0; gx < gridWidth; gx++) {
      const wx = gx * cellSize;
      const wz = gz * cellSize;

      // Convert to regional world coordinates
      const regionX = cityBounds.minX + wx;
      const regionZ = cityBounds.minZ + wz;

      let coastDist, alongCoast;
      switch (edge) {
        case 'north':
          coastDist = regionZ;
          alongCoast = regionX;
          break;
        case 'south':
          coastDist = regionH - regionZ;
          alongCoast = regionX;
          break;
        case 'east':
          coastDist = regionW - regionX;
          alongCoast = regionZ;
          break;
        case 'west':
          coastDist = regionX;
          alongCoast = regionZ;
          break;
        default:
          coastDist = regionX;
          alongCoast = regionZ;
      }

      const coastNoise = noise.fbm(alongCoast, 0, {
        frequency: 1 / 120,
        octaves: 3,
        amplitude: influenceDepth * 0.3,
        persistence: 0.5,
      });

      const effectiveDist = coastDist - coastNoise;

      if (effectiveDist < influenceDepth) {
        const currentH = heightmap.get(gx, gz);
        const factor = smoothstep(0, influenceDepth, effectiveDist);
        const coastTarget = seaLevel - 3;
        const newH = currentH * factor + coastTarget * (1 - factor);
        heightmap.set(gx, gz, newH);
      }
    }
  }

  const coastCells = new Set();
  const shorelinePoints = [];

  for (let gz = 0; gz < gridHeight; gz++) {
    for (let gx = 0; gx < gridWidth; gx++) {
      const h = heightmap.get(gx, gz);
      if (h <= seaLevel) {
        coastCells.add(gz * gridWidth + gx);
      }
    }
  }

  for (let gz = 0; gz < gridHeight - 1; gz++) {
    for (let gx = 0; gx < gridWidth - 1; gx++) {
      const h00 = heightmap.get(gx, gz);
      const h10 = heightmap.get(gx + 1, gz);
      const h01 = heightmap.get(gx, gz + 1);

      if ((h00 <= seaLevel) !== (h10 <= seaLevel)) {
        const t = (seaLevel - h00) / (h10 - h00);
        shorelinePoints.push({
          x: (gx + t) * cellSize,
          z: gz * cellSize,
        });
      }

      if ((h00 <= seaLevel) !== (h01 <= seaLevel)) {
        const t = (seaLevel - h00) / (h01 - h00);
        shorelinePoints.push({
          x: gx * cellSize,
          z: (gz + t) * cellSize,
        });
      }
    }
  }

  return { seaLevel, coastCells, shorelinePoints };
}

// ---------------------------------------------------------------------------
// Slope map computation
// ---------------------------------------------------------------------------

/**
 * Compute per-cell slope magnitude via central differences.
 *
 * @param {Heightmap} heightmap
 * @returns {Float32Array} slope[gz * gridWidth + gx]
 */
function computeSlopeMap(heightmap) {
  const gridWidth = heightmap.width;
  const gridHeight = heightmap.height;
  const cellSize = heightmap._cellSize;
  const slopeMap = new Float32Array(gridWidth * gridHeight);

  for (let gz = 0; gz < gridHeight; gz++) {
    for (let gx = 0; gx < gridWidth; gx++) {
      const gxL = Math.max(0, gx - 1);
      const gxR = Math.min(gridWidth - 1, gx + 1);
      const gzU = Math.max(0, gz - 1);
      const gzD = Math.min(gridHeight - 1, gz + 1);

      const dhdx = (heightmap.get(gxR, gz) - heightmap.get(gxL, gz)) / ((gxR - gxL) * cellSize);
      const dhdz = (heightmap.get(gx, gzD) - heightmap.get(gx, gzU)) / ((gzD - gzU) * cellSize);

      slopeMap[gz * gridWidth + gx] = Math.sqrt(dhdx * dhdx + dhdz * dhdz);
    }
  }

  return slopeMap;
}

// ---------------------------------------------------------------------------
// Terrain zone classification
// ---------------------------------------------------------------------------

/**
 * Classify each cell into a terrain zone based on slope and elevation.
 *
 * Zones:
 *   0 FLAT_LOW     — flat and low-lying (near water level)
 *   1 FLAT_ELEVATED — flat and above water → prime buildable
 *   2 GENTLE       — moderate slope → good residential
 *   3 STEEP        — steep → parkland / switchbacks
 *   4 HILLTOP      — local maximum within radius
 *
 * @param {Heightmap} heightmap
 * @param {Float32Array} slopeMap
 * @param {number} seaLevel
 * @param {Set<number>} waterCells
 * @returns {Uint8Array} zone[gz * gridWidth + gx]
 */
function classifyTerrainZones(heightmap, slopeMap, seaLevel, waterCells) {
  const gridWidth = heightmap.width;
  const gridHeight = heightmap.height;
  const zones = new Uint8Array(gridWidth * gridHeight);

  // Compute elevation threshold for "low-lying": within 3m of sea level
  // or within the lower 20th percentile of non-water elevations
  const lowThreshold = seaLevel + 3;

  for (let gz = 0; gz < gridHeight; gz++) {
    for (let gx = 0; gx < gridWidth; gx++) {
      const idx = gz * gridWidth + gx;
      if (waterCells.has(idx)) {
        zones[idx] = ZONE.FLAT_LOW;
        continue;
      }

      const slope = slopeMap[idx];
      const h = heightmap.get(gx, gz);

      if (slope >= SLOPE_STEEP) {
        zones[idx] = ZONE.STEEP;
      } else if (slope >= SLOPE_GENTLE) {
        zones[idx] = ZONE.GENTLE;
      } else if (h <= lowThreshold) {
        zones[idx] = ZONE.FLAT_LOW;
      } else {
        zones[idx] = ZONE.FLAT_ELEVATED;
      }
    }
  }

  // Mark hilltops: local maxima within HILLTOP_RADIUS on flat-elevated or gentle terrain
  const step = 10;
  for (let gz = HILLTOP_RADIUS; gz < gridHeight - HILLTOP_RADIUS; gz += step) {
    for (let gx = HILLTOP_RADIUS; gx < gridWidth - HILLTOP_RADIUS; gx += step) {
      const idx = gz * gridWidth + gx;
      if (waterCells.has(idx)) continue;
      if (slopeMap[idx] >= SLOPE_STEEP) continue;

      const h = heightmap.get(gx, gz);
      let isMax = true;

      for (let dz = -HILLTOP_RADIUS; dz <= HILLTOP_RADIUS && isMax; dz += 5) {
        for (let dx = -HILLTOP_RADIUS; dx <= HILLTOP_RADIUS && isMax; dx += 5) {
          if (dx === 0 && dz === 0) continue;
          if (dx * dx + dz * dz > HILLTOP_RADIUS * HILLTOP_RADIUS) continue;
          if (heightmap.get(gx + dx, gz + dz) > h) {
            isMax = false;
          }
        }
      }

      if (isMax) {
        zones[idx] = ZONE.HILLTOP;
      }
    }
  }

  return zones;
}

// ---------------------------------------------------------------------------
// Anchor point detection
// ---------------------------------------------------------------------------

/**
 * Detect anchor points that will seed the city layout.
 *
 * Types:
 *   - river_crossing: narrowest point with flattest banks
 *   - harbor: coast concavity (indentation)
 *   - hilltop: local elevation maximum
 *   - confluence: where rivers merge (multiple centerlines nearby)
 *
 * @param {Heightmap} heightmap
 * @param {Uint8Array} terrainZones
 * @param {Float32Array} slopeMap
 * @param {Array} rivers - city-scale river data [{centerline, width}]
 * @param {Object|null} coast
 * @param {Set<number>} waterCells
 * @returns {Array<{x: number, z: number, type: string, score: number}>}
 */
function detectAnchors(heightmap, terrainZones, slopeMap, rivers, coast, waterCells) {
  const gridWidth = heightmap.width;
  const gridHeight = heightmap.height;
  const cellSize = heightmap._cellSize;
  const anchors = [];

  // --- River crossings ---
  // For each river, find the narrowest point with flattest banks
  for (const river of rivers) {
    const { centerline, width } = river;
    if (centerline.length < 4) continue;

    let bestCrossingScore = -Infinity;
    let bestCrossing = null;

    // Sample crossing points along the centerline
    for (let i = 1; i < centerline.length - 1; i++) {
      const pt = centerline[i];
      const gx = Math.round(pt.x / cellSize);
      const gz = Math.round(pt.z / cellSize);
      if (gx < 2 || gx >= gridWidth - 2 || gz < 2 || gz >= gridHeight - 2) continue;

      // Compute perpendicular direction for bank slope sampling
      const prev = centerline[Math.max(0, i - 1)];
      const next = centerline[Math.min(centerline.length - 1, i + 1)];
      const dx = next.x - prev.x;
      const dz = next.z - prev.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len < 0.001) continue;

      // Sample bank slopes on both sides
      const perpX = -dz / len;
      const perpZ = dx / len;
      const bankDist = width * 1.5;

      const leftGx = clamp(Math.round((pt.x + perpX * bankDist) / cellSize), 0, gridWidth - 1);
      const leftGz = clamp(Math.round((pt.z + perpZ * bankDist) / cellSize), 0, gridHeight - 1);
      const rightGx = clamp(Math.round((pt.x - perpX * bankDist) / cellSize), 0, gridWidth - 1);
      const rightGz = clamp(Math.round((pt.z - perpZ * bankDist) / cellSize), 0, gridHeight - 1);

      const leftSlope = slopeMap[leftGz * gridWidth + leftGx];
      const rightSlope = slopeMap[rightGz * gridWidth + rightGx];
      const avgBankSlope = (leftSlope + rightSlope) / 2;

      // Score: flat banks are better (lower slope = higher score)
      // Narrow rivers are easier to cross (lower width = higher score)
      const slopeScore = 1 - clamp(avgBankSlope / 0.2, 0, 1);
      const widthScore = 1 - clamp(width / RIVER_CONSTANTS.MAX_WIDTH, 0, 1);
      const score = slopeScore * 0.6 + widthScore * 0.4;

      if (score > bestCrossingScore) {
        bestCrossingScore = score;
        bestCrossing = { x: pt.x, z: pt.z };
      }
    }

    if (bestCrossing) {
      anchors.push({
        x: bestCrossing.x,
        z: bestCrossing.z,
        type: 'river_crossing',
        score: bestCrossingScore * 3, // river crossings are high-value
      });
    }
  }

  // --- Confluences ---
  // Where two river centerlines come within 2x the wider river's width
  for (let i = 0; i < rivers.length; i++) {
    for (let j = i + 1; j < rivers.length; j++) {
      const r1 = rivers[i];
      const r2 = rivers[j];
      const threshold = Math.max(r1.width, r2.width) * 2;

      let bestDist = Infinity;
      let bestPt = null;
      for (const pt1 of r1.centerline) {
        for (const pt2 of r2.centerline) {
          const d = distance2D(pt1.x, pt1.z, pt2.x, pt2.z);
          if (d < bestDist) {
            bestDist = d;
            bestPt = { x: (pt1.x + pt2.x) / 2, z: (pt1.z + pt2.z) / 2 };
          }
        }
      }

      if (bestDist < threshold && bestPt) {
        anchors.push({
          x: bestPt.x,
          z: bestPt.z,
          type: 'confluence',
          score: 2.5,
        });
      }
    }
  }

  // --- Harbor indentations (coast concavity) ---
  if (coast && coast.shorelinePoints.length > 10) {
    const pts = coast.shorelinePoints;

    // Sort shoreline points along coast direction for concavity detection
    // Simple approach: find deepest indentation from the straight coast line
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }

    // Cluster shoreline points and find the one furthest inland
    const worldWidth = (gridWidth - 1) * cellSize;
    const worldHeight = (gridHeight - 1) * cellSize;
    let bestHarbor = null;
    let bestInland = -Infinity;

    // "Inland" direction depends on coast edge
    const edge = coast.shorelinePoints.length > 0 ? null : null; // we don't have edge here
    // Instead, just find the shoreline point furthest from the map edges
    for (const p of pts) {
      const edgeDist = Math.min(p.x, worldWidth - p.x, p.z, worldHeight - p.z);
      if (edgeDist > bestInland) {
        bestInland = edgeDist;
        bestHarbor = p;
      }
    }

    if (bestHarbor && bestInland > 50) {
      anchors.push({
        x: bestHarbor.x,
        z: bestHarbor.z,
        type: 'harbor',
        score: 2.0,
      });
    }
  }

  // --- Hilltops ---
  const step = 10;
  for (let gz = HILLTOP_RADIUS; gz < gridHeight - HILLTOP_RADIUS; gz += step) {
    for (let gx = HILLTOP_RADIUS; gx < gridWidth - HILLTOP_RADIUS; gx += step) {
      const idx = gz * gridWidth + gx;
      if (terrainZones[idx] !== ZONE.HILLTOP) continue;

      const { x, z } = heightmap.gridToWorld(gx, gz);
      const h = heightmap.get(gx, gz);

      // Score based on prominence (how much higher than surroundings)
      let sumNeighborH = 0;
      let count = 0;
      for (let dz = -HILLTOP_RADIUS; dz <= HILLTOP_RADIUS; dz += 5) {
        for (let dx = -HILLTOP_RADIUS; dx <= HILLTOP_RADIUS; dx += 5) {
          if (dx === 0 && dz === 0) continue;
          if (dx * dx + dz * dz > HILLTOP_RADIUS * HILLTOP_RADIUS) continue;
          sumNeighborH += heightmap.get(gx + dx, gz + dz);
          count++;
        }
      }
      const prominence = h - sumNeighborH / count;

      anchors.push({
        x,
        z,
        type: 'hilltop',
        score: 0.5 + clamp(prominence / 10, 0, 1.5),
      });
    }
  }

  return anchors;
}

// ---------------------------------------------------------------------------
// Water exclusion zone (BFS buffer)
// ---------------------------------------------------------------------------

/**
 * Expand waterCells outward by buffer cells using BFS.
 *
 * @param {Set<number>} waterCells
 * @param {number} gridWidth
 * @param {number} gridHeight
 * @param {number} [buffer=WATER_EXCLUSION_BUFFER]
 * @returns {Set<number>} water exclusion cells (includes original waterCells)
 */
function computeWaterExclusion(waterCells, gridWidth, gridHeight, buffer = WATER_EXCLUSION_BUFFER) {
  const exclusion = new Set(waterCells);

  // BFS from all water cells outward
  let frontier = [...waterCells];
  const dist = new Int16Array(gridWidth * gridHeight);
  dist.fill(-1);

  for (const idx of waterCells) {
    dist[idx] = 0;
  }

  for (let d = 0; d < buffer; d++) {
    const nextFrontier = [];
    for (const idx of frontier) {
      const gx = idx % gridWidth;
      const gz = (idx - gx) / gridWidth;

      const neighbors = [
        gz > 0 ? idx - gridWidth : -1,
        gz < gridHeight - 1 ? idx + gridWidth : -1,
        gx > 0 ? idx - 1 : -1,
        gx < gridWidth - 1 ? idx + 1 : -1,
      ];

      for (const nIdx of neighbors) {
        if (nIdx >= 0 && dist[nIdx] === -1) {
          dist[nIdx] = d + 1;
          exclusion.add(nIdx);
          nextFrontier.push(nIdx);
        }
      }
    }
    frontier = nextFrontier;
  }

  return exclusion;
}

// ---------------------------------------------------------------------------
// Phase 1 entry point
// ---------------------------------------------------------------------------

/**
 * Run Phase 1: Terrain Preparation & Water Infrastructure.
 *
 * @param {Object} cityContext - CityContext from regional layer
 * @param {Object} rng - SeededRandom (forked for this phase)
 * @param {Object} params
 * @param {number} params.gridSize
 * @param {number} params.cellSize
 * @param {number} [params.detailAmplitude=3]
 * @returns {Object} TerrainData
 */
export function runPhase1(cityContext, rng, params) {
  // 1. Refine terrain
  const heightmap = refineTerrain(cityContext, rng, params);

  // 2. Carve rivers
  const { rivers, waterCells } = carveRivers(heightmap, cityContext, rng);

  // 3. Apply coast
  const coast = applyCoast(heightmap, cityContext, rng);

  // Merge coast water cells
  if (coast && coast.coastCells) {
    for (const cell of coast.coastCells) {
      waterCells.add(cell);
    }
  }

  // Freeze heightmap — no more modifications
  heightmap.freeze();

  const seaLevel = coast ? coast.seaLevel : cityContext.seaLevel;

  // 4. Compute slope map
  const slopeMap = computeSlopeMap(heightmap);

  // 5. Classify terrain zones
  const terrainZones = classifyTerrainZones(heightmap, slopeMap, seaLevel, waterCells);

  // 6. Detect anchor points
  const anchorPoints = detectAnchors(heightmap, terrainZones, slopeMap, rivers, coast, waterCells);

  // 7. Compute water exclusion zone
  const waterExclusion = computeWaterExclusion(waterCells, heightmap.width, heightmap.height);

  return {
    heightmap,
    seaLevel,
    waterCells,
    waterExclusion,
    terrainZones,
    slopeMap,
    anchorPoints,
    rivers,
    coast,
  };
}
