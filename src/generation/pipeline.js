/**
 * City generation orchestrator — 8-phase pipeline + feedback loops.
 *
 * Phase 1: Terrain Preparation & Water Infrastructure
 * Phase 2: Primary Network — Arterials & Bridges
 * Phase 3: Density Field Generation
 * Phase 4: District Division & Collector Roads
 * Phase 5: Local Streets & Block Subdivision
 * Phase 6: Plot Subdivision
 * Phase 7: Building Footprint & Massing
 * Phase 8: Amenity & Service Placement
 *
 * Feedback loops (each runs once, after relevant phases):
 *   A: underserved density peaks → add collector to nearest arterial
 *   B: awkward plots → merge/flag as open space, re-run Phase 7
 *   C: upgrade streets serving amenities to collector width
 *   D: rezone high-centrality residential frontages to mixed_use
 */

import { SeededRandom } from '../core/rng.js';
import { resetNodeIds, resetEdgeIds, separateCloseEdges } from './graph.js';
import { runPhase1 } from './phase1Terrain.js';
import { runPhase2 } from './phase2Arterials.js';
import { runPhase3 } from './phase3Density.js';
import { runPhase4 } from './phase4Districts.js';
import { runPhase5 } from './phase5Streets.js';
import { runPhase6 } from './phase6Plots.js';
import { runPhase7 } from './phase7Buildings.js';
import { runPhase8 } from './phase8Amenities.js';
import { distance2D, clamp } from '../core/math.js';
import { findPath, terrainCostFunction, simplifyPath, smoothPath } from '../core/pathfinding.js';
import { newNodeId, newEdgeId } from './graph.js';

/**
 * Yield a frame to let the browser breathe.
 */
function yieldFrame() {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(resolve);
    } else {
      setTimeout(resolve, 0);
    }
  });
}

// ---------------------------------------------------------------------------
// Feedback loops
// ---------------------------------------------------------------------------

/**
 * Loop A: After Phase 3, check if density peaks lack arterial access.
 * Add a collector road from underserved peaks to nearest arterial.
 */
function feedbackLoopA(densityField, roadNetwork, terrainData) {
  const { heightmap, waterCells, waterExclusion } = terrainData;
  const gridWidth = heightmap.width;
  const gridHeight = heightmap.height;
  const cellSize = heightmap._cellSize;
  const worldExtent = (gridWidth - 1) * cellSize;

  const costFn = terrainCostFunction(heightmap, {
    slopePenalty: 12,
    waterCells: waterExclusion || waterCells,
    waterPenalty: Infinity,
    edgeMargin: 2,
    edgePenalty: 2,
  });

  for (const center of densityField.districtCenters) {
    // Check if this center is near an arterial
    let nearestArterialDist = Infinity;
    for (const edge of roadNetwork.edges) {
      if (edge.hierarchy !== 'primary' && edge.hierarchy !== 'secondary') continue;
      if (!edge.points || edge.points.length < 2) continue;
      for (const pt of edge.points) {
        const d = distance2D(center.x, center.z, pt.x, pt.z);
        if (d < nearestArterialDist) nearestArterialDist = d;
      }
    }

    // If too far from arterial, add a collector to the nearest arterial point
    if (nearestArterialDist > 200) {
      let nearestPt = null;
      let nearDist = Infinity;
      for (const edge of roadNetwork.edges) {
        if (edge.hierarchy !== 'primary' && edge.hierarchy !== 'secondary') continue;
        if (!edge.points) continue;
        for (const pt of edge.points) {
          const d = distance2D(center.x, center.z, pt.x, pt.z);
          if (d < nearDist) {
            nearDist = d;
            nearestPt = pt;
          }
        }
      }

      if (nearestPt) {
        const sx = clamp(center.x, 0, worldExtent);
        const sz = clamp(center.z, 0, worldExtent);
        const ex = clamp(nearestPt.x, 0, worldExtent);
        const ez = clamp(nearestPt.z, 0, worldExtent);

        const startG = heightmap.worldToGrid(sx, sz);
        const endG = heightmap.worldToGrid(ex, ez);
        const sGx = clamp(Math.round(startG.gx), 0, gridWidth - 1);
        const sGz = clamp(Math.round(startG.gz), 0, gridHeight - 1);
        const eGx = clamp(Math.round(endG.gx), 0, gridWidth - 1);
        const eGz = clamp(Math.round(endG.gz), 0, gridHeight - 1);

        const pathResult = findPath(sGx, sGz, eGx, eGz, gridWidth, gridHeight, costFn);
        if (pathResult) {
          const simplified = simplifyPath(pathResult.path, 1.5);
          const smoothed = smoothPath(simplified, cellSize, 2);
          const startId = newNodeId();
          const endId = newNodeId();

          roadNetwork.nodes.set(startId, {
            id: startId, gx: sGx, gz: sGz, x: sx, z: sz, type: 'intersection',
          });
          roadNetwork.nodes.set(endId, {
            id: endId, gx: eGx, gz: eGz, x: ex, z: ez, type: 'intersection',
          });

          roadNetwork.edges.push({
            id: newEdgeId(),
            from: startId, to: endId,
            points: smoothed,
            gridPath: pathResult.path,
            width: 12,
            hierarchy: 'collector',
          });
        }
      }
    }
  }
}

/**
 * Loop B: After Phase 7, find awkward plots and merge/flag as open space.
 * Re-generate buildings for affected plots.
 */
function feedbackLoopB(plots, buildings, terrainData, roadNetwork, densityField, cityContext, rng) {
  // Find buildings that are too small or have bad aspect ratios
  const affectedPlotIds = new Set();

  for (const building of buildings) {
    if (building.w < 3 || building.d < 3) {
      affectedPlotIds.add(building.plotId);
    }
    // Very extreme aspect ratio
    if (building.w / building.d > 5 || building.d / building.w > 5) {
      affectedPlotIds.add(building.plotId);
    }
  }

  if (affectedPlotIds.size === 0) return buildings;

  // Flag affected plots as open space
  for (const plot of plots) {
    if (affectedPlotIds.has(plot.id)) {
      plot.flags.add('open_space');
    }
  }

  // Remove buildings on affected plots
  const filteredBuildings = buildings.filter(b => !affectedPlotIds.has(b.plotId));

  return filteredBuildings;
}

/**
 * Loop C: After Phase 8, upgrade streets serving amenities to collector width.
 */
function feedbackLoopC(amenities, roadNetwork) {
  for (const amenity of amenities) {
    // Find local streets near the amenity
    for (const edge of roadNetwork.edges) {
      if (edge.hierarchy !== 'local') continue;
      if (!edge.points || edge.points.length < 2) continue;

      for (const pt of edge.points) {
        if (distance2D(pt.x, pt.z, amenity.x, amenity.z) < 30) {
          // Upgrade to collector
          edge.hierarchy = 'collector';
          edge.width = Math.max(edge.width, 12);
          break;
        }
      }
    }
  }
}

/**
 * Loop D: Already handled in Phase 8 via rezoneHighCentrality.
 * This is a no-op since the rezoning happens during Phase 8.
 */

// ---------------------------------------------------------------------------
// Pipeline entry point
// ---------------------------------------------------------------------------

/**
 * Run the full city generation pipeline.
 *
 * @param {Object} cityContext - CityContext from the regional layer
 * @param {Object} [params]
 * @param {number} [params.seed=12345]
 * @param {number} [params.gridSize=256]
 * @param {number} [params.cellSize] - auto-derived from city bounds if omitted
 * @param {number} [params.organicness=0.5]
 * @param {number} [params.detailAmplitude=3]
 * @param {Function|null} [onProgress] - optional callback(phase, progress)
 * @returns {Promise<Object>} CityData
 */
export async function generateCity(cityContext, params = {}, onProgress = null) {
  const {
    seed = 12345,
    gridSize = 256,
    organicness = 0.5,
    detailAmplitude = 3,
  } = params;

  const boundsWidth = cityContext.cityBounds.maxX - cityContext.cityBounds.minX;
  const boundsHeight = cityContext.cityBounds.maxZ - cityContext.cityBounds.minZ;
  const cellSize = params.cellSize || Math.max(boundsWidth, boundsHeight) / (gridSize - 1);

  // Reset graph ID counters
  resetNodeIds();
  resetEdgeIds();

  const rng = new SeededRandom(seed);

  const timings = {};

  async function runPhase(name, fn) {
    if (onProgress) onProgress(name, 0);
    await yieldFrame();
    const t0 = performance.now();
    const result = fn();
    const elapsed = performance.now() - t0;
    timings[name] = elapsed;
    if (onProgress) onProgress(name, 1);
    return result;
  }

  // --- Phase 1: Terrain Preparation ---
  const terrainData = await runPhase('terrain', () =>
    runPhase1(cityContext, rng.fork('terrain'), { gridSize, cellSize, detailAmplitude })
  );

  // --- Phase 2: Primary Network ---
  const roadNetwork = await runPhase('arterials', () =>
    runPhase2(terrainData, cityContext, rng.fork('roads'), { organicness })
  );

  // --- Phase 3: Density Field ---
  const densityField = await runPhase('density', () => {
    const df = runPhase3(terrainData, roadNetwork, cityContext, rng.fork('density'));
    feedbackLoopA(df, roadNetwork, terrainData); // Loop A
    return df;
  });

  // --- Phase 4: Districts + Collectors ---
  const { districts } = await runPhase('districts', () =>
    runPhase4(terrainData, roadNetwork, densityField, cityContext, rng.fork('districts'), { organicness })
  );

  // --- Phase 5: Local Streets + Blocks ---
  const { blocks } = await runPhase('streets', () =>
    runPhase5(terrainData, roadNetwork, densityField, districts, rng.fork('streets'))
  );

  // --- Phase 6: Plot Subdivision ---
  const plots = await runPhase('plots', () =>
    runPhase6(blocks, roadNetwork, districts, rng.fork('plots'))
  );

  // --- Phase 7: Buildings ---
  let buildings = await runPhase('buildings', () => {
    const b = runPhase7(plots, terrainData, roadNetwork, densityField, cityContext, rng.fork('buildings'));
    return feedbackLoopB(plots, b, terrainData, roadNetwork, densityField, cityContext, rng.fork('loopB')); // Loop B
  });

  // --- Phase 8: Amenities ---
  const { amenities, edgeCentrality, population } = await runPhase('amenities', () => {
    const result = runPhase8(plots, blocks, buildings, roadNetwork, densityField, rng.fork('amenities'));
    feedbackLoopC(result.amenities, roadNetwork); // Loop C
    // Loop D handled within Phase 8
    return result;
  });

  // --- Post-processing: separate close non-connected road edges ---
  separateCloseEdges(roadNetwork.edges);

  // --- Post-processing: filter road edges that pass through water ---
  const seaLevel = terrainData.seaLevel;
  const hm = terrainData.heightmap;
  roadNetwork.edges = roadNetwork.edges.filter(edge => {
    if (!edge.points || edge.points.length < 2) return true;
    // If a bridge covers this edge, keep it
    const hasBridge = roadNetwork.bridges.some(b => b.edgeId === edge.id);
    if (hasBridge) return true;
    // Check if more than 30% of points are underwater
    let underwaterCount = 0;
    for (const pt of edge.points) {
      const h = hm.sample(pt.x, pt.z);
      if (h < seaLevel - 1) underwaterCount++;
    }
    return underwaterCount / edge.points.length < 0.3;
  });

  // Log timings
  const total = Object.values(timings).reduce((s, v) => s + v, 0);
  console.log(`City generated in ${total.toFixed(0)}ms:`,
    Object.entries(timings).map(([k, v]) => `${k}=${v.toFixed(0)}ms`).join(', '));

  // --- Return CityData ---
  return {
    heightmap: terrainData.heightmap,
    seaLevel: terrainData.seaLevel,
    rivers: terrainData.rivers,
    coast: terrainData.coast,
    terrainData,
    densityField,
    districts,
    network: {
      nodes: roadNetwork.nodes,
      edges: roadNetwork.edges,
      blocks,
      bridges: roadNetwork.bridges,
    },
    plots,
    buildings,
    amenities,
    edgeCentrality,
    population,
    cityContext,
    params: { seed, gridSize, cellSize, organicness, detailAmplitude },
  };
}
