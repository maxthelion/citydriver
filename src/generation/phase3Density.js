/**
 * Phase 3: Density Field Generation
 *
 * Computes a continuous density heatmap that drives everything from
 * street spacing to building height. Five weighted attractors:
 *   - Seed distance (0.35): inverse falloff from city center
 *   - Road proximity (0.25): BFS distance from rasterized arterials
 *   - Waterfront (0.15): bonus for desirable waterfront, penalty for industrial
 *   - Terrain (0.15): flat elevated bonus, steep/floodplain penalty
 *   - Bridge nodes (0.10): local spike at bridge approaches
 *
 * Also extracts density peaks as district center candidates and
 * normalizes the field to the target population.
 */

import { clamp, lerp, distance2D } from '../core/math.js';
import { ZONE } from './phase1Terrain.js';
import { rasterizeRoads } from './graph.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ATTRACTOR_WEIGHTS = {
  seedDistance: 0.35,
  roadProximity: 0.25,
  waterfront: 0.15,
  terrain: 0.15,
  bridgeNodes: 0.10,
};

/** Target populations by rank */
const TARGET_POPULATION = {
  city: 100000,
  town: 10000,
  village: 1000,
};

/** Density field cell size relative to heightmap */
const DENSITY_CELL_FACTOR = 4; // density grid is coarser than heightmap

/** Radius for local maxima detection (in density grid cells) */
const PEAK_RADIUS = 8;

/** Minimum density value to qualify as a peak */
const PEAK_MIN_DENSITY = 0.3;

// ---------------------------------------------------------------------------
// BFS distance transform
// ---------------------------------------------------------------------------

/**
 * BFS distance transform from seed cells on a grid.
 * Returns distance in cells from nearest seed.
 *
 * @param {Uint8Array} seedGrid - 1=seed, 0=not
 * @param {number} gridWidth
 * @param {number} gridHeight
 * @returns {Float32Array} distance from nearest seed (in cells)
 */
function bfsDistanceTransform(seedGrid, gridWidth, gridHeight) {
  const dist = new Float32Array(gridWidth * gridHeight);
  dist.fill(Infinity);

  const queue = [];
  for (let i = 0; i < gridWidth * gridHeight; i++) {
    if (seedGrid[i] === 1) {
      dist[i] = 0;
      queue.push(i);
    }
  }

  let head = 0;
  while (head < queue.length) {
    const idx = queue[head++];
    const gx = idx % gridWidth;
    const gz = (idx - gx) / gridWidth;
    const d = dist[idx];

    const neighbors = [
      gz > 0 ? idx - gridWidth : -1,
      gz < gridHeight - 1 ? idx + gridWidth : -1,
      gx > 0 ? idx - 1 : -1,
      gx < gridWidth - 1 ? idx + 1 : -1,
    ];

    for (const nIdx of neighbors) {
      if (nIdx >= 0 && dist[nIdx] === Infinity) {
        dist[nIdx] = d + 1;
        queue.push(nIdx);
      }
    }
  }

  return dist;
}

// ---------------------------------------------------------------------------
// Phase 3 entry point
// ---------------------------------------------------------------------------

/**
 * Run Phase 3: Density Field Generation.
 *
 * @param {Object} terrainData - from Phase 1
 * @param {Object} roadNetwork - from Phase 2
 * @param {Object} cityContext
 * @param {Object} rng
 * @returns {Object} DensityField
 */
export function runPhase3(terrainData, roadNetwork, cityContext, rng) {
  const { heightmap, waterCells, terrainZones, slopeMap, anchorPoints } = terrainData;
  const { nodes, edges, bridges } = roadNetwork;

  const hmWidth = heightmap.width;
  const hmHeight = heightmap.height;
  const hmCellSize = heightmap._cellSize;

  // Density grid is coarser than heightmap
  const densityCellSize = hmCellSize * DENSITY_CELL_FACTOR;
  const gridWidth = Math.ceil((hmWidth - 1) * hmCellSize / densityCellSize) + 1;
  const gridHeight = Math.ceil((hmHeight - 1) * hmCellSize / densityCellSize) + 1;
  const grid = new Float32Array(gridWidth * gridHeight);

  // --- Find city seed position ---
  const centerNode = [...nodes.values()].find(n => n.type === 'center');
  const seedX = centerNode ? centerNode.x : (hmWidth - 1) * hmCellSize / 2;
  const seedZ = centerNode ? centerNode.z : (hmHeight - 1) * hmCellSize / 2;
  const worldExtent = (hmWidth - 1) * hmCellSize;

  // --- Compute road proximity via BFS ---
  // Rasterize roads onto density grid
  const roadGrid = new Uint8Array(gridWidth * gridHeight);
  for (const edge of edges) {
    if (!edge.points || edge.points.length < 2) continue;
    const halfWidth = (edge.width || 10) / 2;
    const halfCells = Math.ceil(halfWidth / densityCellSize);

    for (let i = 0; i < edge.points.length - 1; i++) {
      const p0 = edge.points[i];
      const p1 = edge.points[i + 1];

      const minX = Math.max(0, Math.floor(Math.min(p0.x, p1.x) / densityCellSize) - halfCells);
      const maxX = Math.min(gridWidth - 1, Math.ceil(Math.max(p0.x, p1.x) / densityCellSize) + halfCells);
      const minZ = Math.max(0, Math.floor(Math.min(p0.z, p1.z) / densityCellSize) - halfCells);
      const maxZ = Math.min(gridHeight - 1, Math.ceil(Math.max(p0.z, p1.z) / densityCellSize) + halfCells);

      for (let gz = minZ; gz <= maxZ; gz++) {
        for (let gx = minX; gx <= maxX; gx++) {
          if (roadGrid[gz * gridWidth + gx] === 1) continue;
          const wx = gx * densityCellSize;
          const wz = gz * densityCellSize;

          const dx = p1.x - p0.x;
          const dz = p1.z - p0.z;
          const lenSq = dx * dx + dz * dz;
          let dist;
          if (lenSq === 0) {
            dist = distance2D(wx, wz, p0.x, p0.z);
          } else {
            let t = ((wx - p0.x) * dx + (wz - p0.z) * dz) / lenSq;
            t = clamp(t, 0, 1);
            dist = distance2D(wx, wz, p0.x + t * dx, p0.z + t * dz);
          }

          if (dist <= halfWidth) {
            roadGrid[gz * gridWidth + gx] = 1;
          }
        }
      }
    }
  }

  const roadDist = bfsDistanceTransform(roadGrid, gridWidth, gridHeight);
  const maxRoadDist = 30; // cells beyond this get zero road score

  // --- Collect bridge positions ---
  const bridgePositions = [];
  for (const node of nodes.values()) {
    if (node.type === 'bridge') {
      bridgePositions.push({ x: node.x, z: node.z });
    }
  }
  // Also from bridge data
  for (const b of bridges) {
    const bx = (b.startPoint.x + b.endPoint.x) / 2;
    const bz = (b.startPoint.z + b.endPoint.z) / 2;
    bridgePositions.push({ x: bx, z: bz });
  }

  // --- Collect river centerlines for waterfront scoring ---
  const riverCenterlines = terrainData.rivers.map(r => r.centerline);

  // --- Compute density for each cell ---
  for (let gz = 0; gz < gridHeight; gz++) {
    for (let gx = 0; gx < gridWidth; gx++) {
      const idx = gz * gridWidth + gx;
      const wx = gx * densityCellSize;
      const wz = gz * densityCellSize;

      // Map to heightmap grid for terrain data
      const hmGx = clamp(Math.round(wx / hmCellSize), 0, hmWidth - 1);
      const hmGz = clamp(Math.round(wz / hmCellSize), 0, hmHeight - 1);
      const hmIdx = hmGz * hmWidth + hmGx;

      // Skip water cells
      if (waterCells.has(hmIdx)) {
        grid[idx] = 0;
        continue;
      }

      // 1. Seed distance (inverse falloff from city center)
      const distToSeed = distance2D(wx, wz, seedX, seedZ);
      const maxDist = worldExtent * 0.5;
      const seedScore = 1 - clamp(distToSeed / maxDist, 0, 1);

      // 2. Road proximity (inverse of BFS distance)
      const rd = roadDist[idx];
      const roadScore = rd < Infinity ? 1 - clamp(rd / maxRoadDist, 0, 1) : 0;

      // 3. Waterfront (bonus near rivers, not industrial)
      let waterfrontScore = 0;
      for (const cl of riverCenterlines) {
        let minDist = Infinity;
        for (let i = 0; i < cl.length - 1; i++) {
          const ax = cl[i].x, az = cl[i].z;
          const bx = cl[i + 1].x, bz = cl[i + 1].z;
          const dx = bx - ax, dz = bz - az;
          const lenSq = dx * dx + dz * dz;
          let t = 0;
          if (lenSq > 0) t = clamp(((wx - ax) * dx + (wz - az) * dz) / lenSq, 0, 1);
          const d = distance2D(wx, wz, ax + t * dx, az + t * dz);
          if (d < minDist) minDist = d;
        }
        // Bonus within ~150m of river, slight penalty very close (industrial zone)
        if (minDist < 150) {
          const factor = 1 - clamp(minDist / 150, 0, 1);
          // Small penalty for very close (floodplain), peak at ~50m
          if (minDist < 30) {
            waterfrontScore = Math.max(waterfrontScore, factor * 0.3);
          } else {
            waterfrontScore = Math.max(waterfrontScore, factor);
          }
        }
      }

      // 4. Terrain suitability
      const zone = terrainZones[hmIdx];
      let terrainScore;
      switch (zone) {
        case ZONE.FLAT_ELEVATED: terrainScore = 1.0; break;
        case ZONE.GENTLE: terrainScore = 0.7; break;
        case ZONE.FLAT_LOW: terrainScore = 0.3; break;
        case ZONE.HILLTOP: terrainScore = 0.5; break;
        case ZONE.STEEP: terrainScore = 0.1; break;
        default: terrainScore = 0.5;
      }

      // 5. Bridge node proximity
      let bridgeScore = 0;
      for (const bp of bridgePositions) {
        const d = distance2D(wx, wz, bp.x, bp.z);
        if (d < 200) {
          bridgeScore = Math.max(bridgeScore, 1 - clamp(d / 200, 0, 1));
        }
      }

      // Sum weighted attractors
      const density =
        ATTRACTOR_WEIGHTS.seedDistance * seedScore +
        ATTRACTOR_WEIGHTS.roadProximity * roadScore +
        ATTRACTOR_WEIGHTS.waterfront * waterfrontScore +
        ATTRACTOR_WEIGHTS.terrain * terrainScore +
        ATTRACTOR_WEIGHTS.bridgeNodes * bridgeScore;

      grid[idx] = clamp(density, 0, 1);
    }
  }

  // --- Peak detection: local maxima → district centers ---
  const districtCenters = [];

  for (let gz = PEAK_RADIUS; gz < gridHeight - PEAK_RADIUS; gz++) {
    for (let gx = PEAK_RADIUS; gx < gridWidth - PEAK_RADIUS; gx++) {
      const idx = gz * gridWidth + gx;
      const val = grid[idx];
      if (val < PEAK_MIN_DENSITY) continue;

      let isMax = true;
      for (let dz = -PEAK_RADIUS; dz <= PEAK_RADIUS && isMax; dz++) {
        for (let dx = -PEAK_RADIUS; dx <= PEAK_RADIUS && isMax; dx++) {
          if (dx === 0 && dz === 0) continue;
          if (dx * dx + dz * dz > PEAK_RADIUS * PEAK_RADIUS) continue;
          const nIdx = (gz + dz) * gridWidth + (gx + dx);
          if (nIdx >= 0 && nIdx < grid.length && grid[nIdx] > val) {
            isMax = false;
          }
        }
      }

      if (isMax) {
        const wx = gx * densityCellSize;
        const wz = gz * densityCellSize;

        // Determine rough type from density level
        let type;
        if (val > 0.7) type = 'commercial_core';
        else if (val > 0.5) type = 'mixed_use';
        else if (val > 0.35) type = 'dense_residential';
        else type = 'suburban_residential';

        districtCenters.push({ x: wx, z: wz, density: val, type });
      }
    }
  }

  // Ensure there's at least one district center (the city center)
  if (districtCenters.length === 0) {
    const sgx = clamp(Math.round(seedX / densityCellSize), 0, gridWidth - 1);
    const sgz = clamp(Math.round(seedZ / densityCellSize), 0, gridHeight - 1);
    districtCenters.push({
      x: seedX,
      z: seedZ,
      density: grid[sgz * gridWidth + sgx] || 0.5,
      type: 'commercial_core',
    });
  }

  // --- Normalize density field ---
  const rank = cityContext.rank || 'town';
  const targetPopulation = TARGET_POPULATION[rank] || TARGET_POPULATION.town;

  // Compute current integral (sum * cellArea)
  const cellArea = densityCellSize * densityCellSize;
  let integral = 0;
  for (let i = 0; i < grid.length; i++) {
    integral += grid[i];
  }
  integral *= cellArea;

  // Scale so integral ≈ target population
  const scaleFactor = integral > 0 ? targetPopulation / integral : 1;
  // We don't actually scale the 0-1 grid values (they're relative density),
  // but we store the scaleFactor for later population calculations.

  // --- Build sampleDensity function ---
  function sampleDensity(wx, wz) {
    // Bilinear lookup
    const fx = wx / densityCellSize;
    const fz = wz / densityCellSize;
    const gx0 = clamp(Math.floor(fx), 0, gridWidth - 2);
    const gz0 = clamp(Math.floor(fz), 0, gridHeight - 2);
    const tx = fx - gx0;
    const tz = fz - gz0;

    const v00 = grid[gz0 * gridWidth + gx0];
    const v10 = grid[gz0 * gridWidth + gx0 + 1];
    const v01 = grid[(gz0 + 1) * gridWidth + gx0];
    const v11 = grid[(gz0 + 1) * gridWidth + gx0 + 1];

    return lerp(
      lerp(v00, v10, tx),
      lerp(v01, v11, tx),
      tz
    );
  }

  return {
    grid,
    cellSize: densityCellSize,
    gridWidth,
    gridHeight,
    districtCenters,
    targetPopulation,
    scaleFactor,
    sampleDensity,
  };
}
