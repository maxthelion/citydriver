/**
 * Phase 5: Local Streets & Block Subdivision
 *
 * Fills in the fine-grained street network and creates city blocks:
 *   - Density-driven street spacing: lerp(30, 150, 1 - density)
 *   - Back alleys (width 4m) in dense areas (density > 0.7)
 *   - Block detection via rasterize + flood-fill
 *   - Corner plot identification at road intersections
 *   - Triangular block → tag for park/landmark
 */

import { clamp, lerp, distance2D, polygonArea, polygonCentroid } from '../core/math.js';
import { findPath, terrainCostFunction, simplifyPath, smoothPath } from '../core/pathfinding.js';
import { rasterizeRoads, floodFillRegions, extractBoundary, newNodeId, newEdgeId, snapEndpointsToNetwork } from './graph.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOCAL_STREET_WIDTH = 6;
const ALLEY_WIDTH = 4;
const MIN_BLOCK_AREA = 400;    // world units²
const MAX_BLOCK_AREA = 200000;

// ---------------------------------------------------------------------------
// Local street generation
// ---------------------------------------------------------------------------

/**
 * Generate local streets within each district, perpendicular to collectors.
 */
function generateLocalStreets(districts, terrainData, roadNetwork, densityField, rng) {
  const { heightmap, waterCells, waterExclusion } = terrainData;
  const gridWidth = heightmap.width;
  const gridHeight = heightmap.height;
  const cellSize = heightmap._cellSize;
  const worldExtent = (gridWidth - 1) * cellSize;

  // Use waterExclusion with Infinity so local streets never enter water.
  const costFn = terrainCostFunction(heightmap, {
    slopePenalty: 10,
    waterCells: waterExclusion || waterCells,
    waterPenalty: Infinity,
    edgeMargin: 2,
    edgePenalty: 2,
  });

  for (const district of districts) {
    if (district.character === 'parkland') continue;
    if (district.area < 3000) continue;

    const localRng = rng.fork(`local-${district.id}`);
    const density = district.density || 0.3;

    // Street spacing from density — wider spacing to avoid road overload
    const spacing = lerp(80, 250, 1 - clamp(density, 0, 1));

    // Find collector/arterial edges near this district
    const distSize = Math.sqrt(district.area);
    const cx = district.centroid.x;
    const cz = district.centroid.z;

    // Gather parent roads (collectors and higher) near this district
    const parentEdges = [];
    for (const edge of roadNetwork.edges) {
      if (!edge.points || edge.points.length < 2) continue;
      if (edge.hierarchy === 'local' || edge.hierarchy === 'alley') continue;

      for (const pt of edge.points) {
        if (distance2D(pt.x, pt.z, cx, cz) < distSize) {
          parentEdges.push(edge);
          break;
        }
      }
    }

    if (parentEdges.length === 0) continue;

    // Limit parent edges to the 3 longest collectors to avoid road explosion
    parentEdges.sort((a, b) => {
      const lenA = a.points ? a.points.length : 0;
      const lenB = b.points ? b.points.length : 0;
      return lenB - lenA;
    });
    const maxParents = 3;
    const usedEdges = parentEdges.slice(0, maxParents);

    // Cap total local streets per district
    const maxLocalStreets = 12;
    let localStreetCount = 0;

    // For each parent edge, emit perpendicular local streets at the appropriate spacing
    for (const parentEdge of usedEdges) {
      if (localStreetCount >= maxLocalStreets) break;
      const pts = parentEdge.points;
      if (pts.length < 2) continue;

      // Walk along the parent edge, emitting cross-streets at spacing intervals
      let accumulated = spacing * 0.5; // start offset to avoid clustering at endpoints
      for (let i = 0; i < pts.length - 1; i++) {
        if (localStreetCount >= maxLocalStreets) break;
        const segDx = pts[i + 1].x - pts[i].x;
        const segDz = pts[i + 1].z - pts[i].z;
        const segLen = Math.sqrt(segDx * segDx + segDz * segDz);
        if (segLen < 1) continue;

        // Perpendicular direction
        const perpX = -segDz / segLen;
        const perpZ = segDx / segLen;

        while (accumulated < segLen) {
          if (localStreetCount >= maxLocalStreets) break;
          const t = accumulated / segLen;
          const ox = pts[i].x + segDx * t;
          const oz = pts[i].z + segDz * t;

          // Emit local street in one perpendicular direction (alternating sides)
          const streetLen = spacing;
          const side = (localStreetCount % 2 === 0) ? 1 : -1;

          // Check if this point is roughly inside the district
          if (distance2D(ox, oz, cx, cz) < distSize * 0.7) {
            const startX = clamp(ox + perpX * side * 5, 0, worldExtent);
            const startZ = clamp(oz + perpZ * side * 5, 0, worldExtent);
            const endX = clamp(ox + perpX * side * streetLen, 0, worldExtent);
            const endZ = clamp(oz + perpZ * side * streetLen, 0, worldExtent);

            if (distance2D(startX, startZ, endX, endZ) > 30) {
              addLocalStreet(startX, startZ, endX, endZ, district, heightmap, roadNetwork, costFn, cellSize);
              localStreetCount++;
            }
          }

          accumulated += spacing;
        }
        accumulated -= segLen;
      }
    }

    // Add alleys only in very dense commercial areas
    if (density > 0.85 && (district.character === 'commercial_core' || district.character === 'mixed_use')) {
      addAlleys(district, roadNetwork, terrainData, densityField, localRng);
    }
  }
}

/**
 * Add a local street via A* routing.
 */
function addLocalStreet(startX, startZ, endX, endZ, district, heightmap, roadNetwork, costFn, cellSize) {
  const gridWidth = heightmap.width;
  const gridHeight = heightmap.height;
  const worldExtent = (gridWidth - 1) * cellSize;

  const sx = clamp(startX, 0, worldExtent);
  const sz = clamp(startZ, 0, worldExtent);
  const ex = clamp(endX, 0, worldExtent);
  const ez = clamp(endZ, 0, worldExtent);

  const startG = heightmap.worldToGrid(sx, sz);
  const endG = heightmap.worldToGrid(ex, ez);

  const sGx = clamp(Math.round(startG.gx), 0, gridWidth - 1);
  const sGz = clamp(Math.round(startG.gz), 0, gridHeight - 1);
  const eGx = clamp(Math.round(endG.gx), 0, gridWidth - 1);
  const eGz = clamp(Math.round(endG.gz), 0, gridHeight - 1);

  if (distance2D(sx, sz, ex, ez) < 15) return;

  const pathResult = findPath(sGx, sGz, eGx, eGz, gridWidth, gridHeight, costFn);
  if (!pathResult) return;

  const simplified = simplifyPath(pathResult.path, 1.0);
  const smoothed = smoothPath(simplified, cellSize, 1);

  const startId = newNodeId();
  const endId = newNodeId();

  roadNetwork.nodes.set(startId, {
    id: startId,
    gx: sGx, gz: sGz,
    x: sx, z: sz,
    type: 'intersection',
  });
  roadNetwork.nodes.set(endId, {
    id: endId,
    gx: eGx, gz: eGz,
    x: ex, z: ez,
    type: 'intersection',
  });

  const edgeId = newEdgeId();
  roadNetwork.edges.push({
    id: edgeId,
    from: startId,
    to: endId,
    points: smoothed,
    gridPath: pathResult.path,
    width: LOCAL_STREET_WIDTH,
    hierarchy: 'local',
    districtId: district.id,
  });

  snapEndpointsToNetwork(edgeId, roadNetwork.nodes, roadNetwork.edges);
}

/**
 * Add back alleys through block centers in dense areas.
 */
function addAlleys(district, roadNetwork, terrainData, densityField, rng) {
  const { heightmap, waterCells, waterExclusion } = terrainData;
  const gridWidth = heightmap.width;
  const gridHeight = heightmap.height;
  const cellSize = heightmap._cellSize;
  const worldExtent = (gridWidth - 1) * cellSize;

  const cx = district.centroid.x;
  const cz = district.centroid.z;
  const distSize = Math.sqrt(district.area);

  // Generate a few alleys parallel to main streets
  const numAlleys = clamp(Math.floor(distSize / 200), 1, 2);

  const costFn = terrainCostFunction(heightmap, {
    slopePenalty: 8,
    waterCells: waterExclusion || waterCells,
    waterPenalty: Infinity,
    edgeMargin: 1,
    edgePenalty: 1,
  });

  for (let i = 0; i < numAlleys; i++) {
    const angle = rng.next() * Math.PI;
    const halfLen = distSize * 0.3;
    const offset = (rng.next() - 0.5) * distSize * 0.3;

    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);

    const sx = clamp(cx + cosA * halfLen + (-sinA) * offset, 0, worldExtent);
    const sz = clamp(cz + sinA * halfLen + cosA * offset, 0, worldExtent);
    const ex = clamp(cx - cosA * halfLen + (-sinA) * offset, 0, worldExtent);
    const ez = clamp(cz - sinA * halfLen + cosA * offset, 0, worldExtent);

    if (distance2D(sx, sz, ex, ez) < 20) continue;

    const startG = heightmap.worldToGrid(sx, sz);
    const endG = heightmap.worldToGrid(ex, ez);
    const sGx = clamp(Math.round(startG.gx), 0, gridWidth - 1);
    const sGz = clamp(Math.round(startG.gz), 0, gridHeight - 1);
    const eGx = clamp(Math.round(endG.gx), 0, gridWidth - 1);
    const eGz = clamp(Math.round(endG.gz), 0, gridHeight - 1);

    const pathResult = findPath(sGx, sGz, eGx, eGz, gridWidth, gridHeight, costFn);
    if (!pathResult) continue;

    const simplified = simplifyPath(pathResult.path, 1.0);
    const smoothed = smoothPath(simplified, cellSize, 1);

    const startId = newNodeId();
    const endId = newNodeId();

    roadNetwork.nodes.set(startId, {
      id: startId, gx: sGx, gz: sGz, x: sx, z: sz, type: 'intersection',
    });
    roadNetwork.nodes.set(endId, {
      id: endId, gx: eGx, gz: eGz, x: ex, z: ez, type: 'intersection',
    });

    const alleyEdgeId = newEdgeId();
    roadNetwork.edges.push({
      id: alleyEdgeId,
      from: startId,
      to: endId,
      points: smoothed,
      gridPath: pathResult.path,
      width: ALLEY_WIDTH,
      hierarchy: 'alley',
      districtId: district.id,
    });

    snapEndpointsToNetwork(alleyEdgeId, roadNetwork.nodes, roadNetwork.edges);
  }
}

// ---------------------------------------------------------------------------
// Block detection
// ---------------------------------------------------------------------------

/**
 * Detect city blocks from the complete road network.
 */
function detectBlocks(roadNetwork, terrainData, districts, densityField) {
  const { heightmap, waterCells } = terrainData;
  const gridWidth = heightmap.width;
  const gridHeight = heightmap.height;
  const cellSize = heightmap._cellSize;

  // Use a finer grid for block detection
  const blockCellSize = Math.max(cellSize, 8);
  const blockGridWidth = Math.ceil((gridWidth - 1) * cellSize / blockCellSize) + 1;
  const blockGridHeight = Math.ceil((gridHeight - 1) * cellSize / blockCellSize) + 1;

  // Rasterize ALL roads
  const roadGrid = rasterizeRoads(roadNetwork.edges, blockGridWidth, blockGridHeight, blockCellSize);

  // Map water cells
  const blockWaterCells = new Set();
  for (const idx of waterCells) {
    const gx = idx % gridWidth;
    const gz = (idx - gx) / gridWidth;
    const bx = Math.round(gx * cellSize / blockCellSize);
    const bz = Math.round(gz * cellSize / blockCellSize);
    if (bx >= 0 && bx < blockGridWidth && bz >= 0 && bz < blockGridHeight) {
      blockWaterCells.add(bz * blockGridWidth + bx);
    }
  }

  // Flood fill
  const regions = floodFillRegions(roadGrid, blockWaterCells, blockGridWidth, blockGridHeight);

  const blocks = [];
  for (const region of regions) {
    const area = region.length * blockCellSize * blockCellSize;
    if (area < MIN_BLOCK_AREA || area > MAX_BLOCK_AREA) continue;

    const polygon = extractBoundary(region, blockGridWidth, blockCellSize);
    if (polygon.length < 3) continue;

    // Compute centroid
    let cx = 0, cz = 0;
    for (const p of polygon) { cx += p.x; cz += p.z; }
    cx /= polygon.length;
    cz /= polygon.length;

    // Sample density
    const density = densityField.sampleDensity(cx, cz);

    // Sample elevation and slope
    const hmGx = clamp(Math.round(cx / cellSize), 0, gridWidth - 1);
    const hmGz = clamp(Math.round(cz / cellSize), 0, gridHeight - 1);
    const elevation = heightmap.get(hmGx, hmGz);

    // Find owning district
    let districtId = -1;
    let districtCharacter = 'suburban_residential';
    let bestDistDist = Infinity;
    for (const d of districts) {
      const dd = distance2D(cx, cz, d.centroid.x, d.centroid.z);
      if (dd < bestDistDist) {
        bestDistDist = dd;
        districtId = d.id;
        districtCharacter = d.character;
      }
    }

    // Find bounding edge IDs
    const edgeIds = [];
    for (const edge of roadNetwork.edges) {
      if (!edge.points || edge.points.length < 2) continue;
      for (const pt of edge.points) {
        if (distance2D(pt.x, pt.z, cx, cz) < Math.sqrt(area) * 0.8) {
          edgeIds.push(edge.id);
          break;
        }
      }
    }

    // Detect triangular blocks (few vertices, small area → park/landmark candidate)
    const isTriangular = polygon.length <= 4 && area < 3000;

    // Water proximity
    let waterProximity = Infinity;
    for (const wIdx of waterCells) {
      const wgx = wIdx % gridWidth;
      const wgz = (wIdx - wgx) / gridWidth;
      const d = distance2D(cx, cz, wgx * cellSize, wgz * cellSize);
      if (d < waterProximity) waterProximity = d;
    }

    blocks.push({
      id: blocks.length,
      polygon,
      area,
      centroid: { x: cx, z: cz },
      edgeIds,
      elevation,
      density,
      districtId,
      districtCharacter,
      waterProximity,
      isTriangular,
      isCorner: false, // set below
      landUse: districtCharacter === 'parkland' ? 'park' : null,
    });
  }

  // Identify corner blocks (blocks near road intersections)
  for (const block of blocks) {
    let intersectionCount = 0;
    for (const node of roadNetwork.nodes.values()) {
      if (node.type === 'intersection' || node.type === 'plaza') {
        if (distance2D(block.centroid.x, block.centroid.z, node.x, node.z) < Math.sqrt(block.area) * 0.6) {
          intersectionCount++;
        }
      }
    }
    block.isCorner = intersectionCount >= 2;
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Phase 5 entry point
// ---------------------------------------------------------------------------

/**
 * Run Phase 5: Local Streets & Block Subdivision.
 *
 * @param {Object} terrainData - from Phase 1
 * @param {Object} roadNetwork - from Phases 2+4 (will be extended with local streets)
 * @param {Object} densityField - from Phase 3
 * @param {Array} districts - from Phase 4
 * @param {Object} rng
 * @returns {Object} { blocks, roadNetwork (extended) }
 */
export function runPhase5(terrainData, roadNetwork, densityField, districts, rng) {
  // 1. Generate local streets within each district
  generateLocalStreets(districts, terrainData, roadNetwork, densityField, rng);

  // 2. Detect blocks from the now-complete road network
  const blocks = detectBlocks(roadNetwork, terrainData, districts, densityField);

  return { blocks, roadNetwork };
}

