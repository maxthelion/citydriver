/**
 * Phase 4: District Division & Collector Roads
 *
 * Subdivides the areas between arterials into districts:
 *   - District boundaries from rasterized roads + flood fill
 *   - Voronoi subdivision for oversized districts
 *   - Character assignment from density + terrain
 *   - Collector roads within each district (grid/organic/hybrid)
 *   - Plaza placement at district centers
 */

import { clamp, lerp, distance2D, pointToSegmentDist } from '../core/math.js';
import { findPath, terrainCostFunction, simplifyPath, smoothPath } from '../core/pathfinding.js';
import { rasterizeRoads, floodFillRegions, extractBoundary, newNodeId, newEdgeId, snapEndpointsToNetwork } from './graph.js';
import { ZONE } from './phase1Terrain.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** District character types */
export const CHARACTER = {
  COMMERCIAL_CORE: 'commercial_core',
  INDUSTRIAL_DOCKS: 'industrial_docks',
  MIXED_USE: 'mixed_use',
  DENSE_RESIDENTIAL: 'dense_residential',
  SUBURBAN_RESIDENTIAL: 'suburban_residential',
  PARKLAND: 'parkland',
};

/** Collector road width */
const COLLECTOR_WIDTH = 8;

/** Maximum district area before Voronoi subdivision (in world units²) */
const MAX_DISTRICT_AREA = 150000;

/** Minimum district area to keep */
const MIN_DISTRICT_AREA = 2000;

/** Plaza radius at district centers */
const PLAZA_RADIUS = 20;

// ---------------------------------------------------------------------------
// District boundary extraction
// ---------------------------------------------------------------------------

/**
 * Extract districts from the road network by rasterizing roads and flood-filling.
 *
 * @param {Array} edges - road edges
 * @param {Set<number>} waterCells - heightmap water cells
 * @param {Object} heightmap
 * @returns {Array<Object>} raw districts (before character assignment)
 */
function extractRawDistricts(edges, waterCells, heightmap) {
  const gridWidth = heightmap.width;
  const gridHeight = heightmap.height;
  const cellSize = heightmap._cellSize;

  // Use a coarser grid for block detection
  const blockCellSize = Math.max(cellSize, 8);
  const blockGridWidth = Math.ceil((gridWidth - 1) * cellSize / blockCellSize) + 1;
  const blockGridHeight = Math.ceil((gridHeight - 1) * cellSize / blockCellSize) + 1;

  // Rasterize roads onto block grid
  const roadGrid = rasterizeRoads(edges, blockGridWidth, blockGridHeight, blockCellSize);

  // Map water cells from heightmap grid to block grid
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

  // Flood fill regions
  const regions = floodFillRegions(roadGrid, blockWaterCells, blockGridWidth, blockGridHeight);

  // Convert regions to districts
  const districts = [];
  for (const region of regions) {
    const area = region.length * blockCellSize * blockCellSize;
    if (area < MIN_DISTRICT_AREA) continue;

    // Extract boundary polygon
    const polygon = extractBoundary(region, blockGridWidth, blockCellSize);
    if (polygon.length < 3) continue;

    // Compute centroid
    let cx = 0, cz = 0;
    for (const p of polygon) {
      cx += p.x;
      cz += p.z;
    }
    cx /= polygon.length;
    cz /= polygon.length;

    // Sample average elevation and slope
    let avgElevation = 0, avgSlope = 0, count = 0;
    for (const idx of region) {
      const bx = idx % blockGridWidth;
      const bz = (idx - bx) / blockGridWidth;
      const hmGx = clamp(Math.round(bx * blockCellSize / cellSize), 0, gridWidth - 1);
      const hmGz = clamp(Math.round(bz * blockCellSize / cellSize), 0, gridHeight - 1);
      avgElevation += heightmap.get(hmGx, hmGz);
      count++;
    }
    if (count > 0) avgElevation /= count;

    // Compute water proximity
    let waterProximity = Infinity;
    for (const wIdx of waterCells) {
      const wgx = wIdx % gridWidth;
      const wgz = (wIdx - wgx) / gridWidth;
      const wx = wgx * cellSize;
      const wz = wgz * cellSize;
      const d = distance2D(cx, cz, wx, wz);
      if (d < waterProximity) waterProximity = d;
    }

    // Find bounding road edges
    const edgeIds = [];
    for (const edge of edges) {
      if (!edge.points || edge.points.length < 2) continue;
      for (const pt of edge.points) {
        if (distance2D(pt.x, pt.z, cx, cz) < Math.sqrt(area) * 0.8) {
          edgeIds.push(edge.id);
          break;
        }
      }
    }

    districts.push({
      id: districts.length,
      cells: region,
      polygon,
      area,
      centroid: { x: cx, z: cz },
      elevation: avgElevation,
      waterProximity,
      edgeIds,
      character: null, // assigned later
      blockCellSize,
      blockGridWidth,
    });
  }

  return districts;
}

// ---------------------------------------------------------------------------
// Voronoi subdivision for oversized districts
// ---------------------------------------------------------------------------

/**
 * Subdivide districts that are too large using Voronoi.
 * Seeds come from density field district centers that fall within the district.
 */
function subdivideOversizedDistricts(districts, densityField) {
  const result = [];
  let nextId = 0;

  for (const district of districts) {
    if (district.area <= MAX_DISTRICT_AREA) {
      district.id = nextId++;
      result.push(district);
      continue;
    }

    // Find density centers that fall within this district
    const seeds = [];
    for (const dc of densityField.districtCenters) {
      // Simple distance check to centroid
      if (distance2D(dc.x, dc.z, district.centroid.x, district.centroid.z) < Math.sqrt(district.area)) {
        seeds.push(dc);
      }
    }

    // If no density centers fall inside, create subdivisions by splitting cells
    if (seeds.length <= 1) {
      // Split into quadrants
      const cx = district.centroid.x;
      const cz = district.centroid.z;
      const cs = district.blockCellSize;
      const gw = district.blockGridWidth;

      const quadrants = [[], [], [], []];
      for (const cellIdx of district.cells) {
        const bx = cellIdx % gw;
        const bz = (cellIdx - bx) / gw;
        const wx = bx * cs;
        const wz = bz * cs;
        const qi = (wx >= cx ? 1 : 0) + (wz >= cz ? 2 : 0);
        quadrants[qi].push(cellIdx);
      }

      for (const quad of quadrants) {
        if (quad.length === 0) continue;
        const subArea = quad.length * cs * cs;
        if (subArea < MIN_DISTRICT_AREA) continue;

        const poly = extractBoundary(quad, gw, cs);
        if (poly.length < 3) continue;

        let scx = 0, scz = 0;
        for (const p of poly) { scx += p.x; scz += p.z; }
        scx /= poly.length; scz /= poly.length;

        result.push({
          ...district,
          id: nextId++,
          cells: quad,
          polygon: poly,
          area: subArea,
          centroid: { x: scx, z: scz },
        });
      }
    } else {
      // Voronoi: assign each cell to nearest seed
      const cs = district.blockCellSize;
      const gw = district.blockGridWidth;
      const buckets = seeds.map(() => []);

      for (const cellIdx of district.cells) {
        const bx = cellIdx % gw;
        const bz = (cellIdx - bx) / gw;
        const wx = bx * cs;
        const wz = bz * cs;

        let bestSeed = 0;
        let bestDist = Infinity;
        for (let si = 0; si < seeds.length; si++) {
          const d = distance2D(wx, wz, seeds[si].x, seeds[si].z);
          if (d < bestDist) {
            bestDist = d;
            bestSeed = si;
          }
        }
        buckets[bestSeed].push(cellIdx);
      }

      for (let si = 0; si < buckets.length; si++) {
        const cells = buckets[si];
        if (cells.length === 0) continue;
        const subArea = cells.length * cs * cs;
        if (subArea < MIN_DISTRICT_AREA) continue;

        const poly = extractBoundary(cells, gw, cs);
        if (poly.length < 3) continue;

        let scx = 0, scz = 0;
        for (const p of poly) { scx += p.x; scz += p.z; }
        scx /= poly.length; scz /= poly.length;

        result.push({
          ...district,
          id: nextId++,
          cells,
          polygon: poly,
          area: subArea,
          centroid: { x: scx, z: scz },
        });
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Character assignment
// ---------------------------------------------------------------------------

/**
 * Assign district character based on density field and terrain.
 */
function assignCharacter(districts, densityField, terrainData, cityContext) {
  const { heightmap, waterCells, terrainZones, slopeMap } = terrainData;
  const gridWidth = heightmap.width;
  const cellSize = heightmap._cellSize;
  const worldExtent = (gridWidth - 1) * cellSize;

  // Find city seed (center node position)
  const centerX = cityContext.center.x - cityContext.cityBounds.minX;
  const centerZ = cityContext.center.z - cityContext.cityBounds.minZ;

  for (const district of districts) {
    const cx = district.centroid.x;
    const cz = district.centroid.z;

    // Sample density at centroid
    const density = densityField.sampleDensity(cx, cz);

    // Distance from center
    const distToCenter = distance2D(cx, cz, centerX, centerZ);
    const normalizedDist = distToCenter / (worldExtent * 0.5);

    // Sample terrain zone at centroid
    const hmGx = clamp(Math.round(cx / cellSize), 0, gridWidth - 1);
    const hmGz = clamp(Math.round(cz / cellSize), 0, gridWidth - 1);
    const hmIdx = hmGz * gridWidth + hmGx;
    const zone = terrainZones[hmIdx];
    const slope = slopeMap[hmIdx];

    // Check if waterfront
    const isWaterfront = district.waterProximity < 100;
    const isDownstream = isWaterfront && zone === ZONE.FLAT_LOW;

    // Character assignment logic
    if (slope > 0.12 || zone === ZONE.STEEP) {
      district.character = CHARACTER.PARKLAND;
    } else if (density > 0.6 && normalizedDist < 0.3) {
      district.character = CHARACTER.COMMERCIAL_CORE;
    } else if (isDownstream && density > 0.3) {
      district.character = CHARACTER.INDUSTRIAL_DOCKS;
    } else if (density > 0.45) {
      district.character = CHARACTER.MIXED_USE;
    } else if (density > 0.3) {
      district.character = CHARACTER.DENSE_RESIDENTIAL;
    } else {
      district.character = CHARACTER.SUBURBAN_RESIDENTIAL;
    }

    district.density = density;
  }

  // Fallback: ensure at least one residential district exists
  const hasResidential = districts.some(
    d => d.character === CHARACTER.DENSE_RESIDENTIAL || d.character === CHARACTER.SUBURBAN_RESIDENTIAL
  );
  if (!hasResidential) {
    // Pick the lowest-density non-parkland district and make it residential
    let bestDist = null;
    let lowestDensity = Infinity;
    for (const d of districts) {
      if (d.character === CHARACTER.PARKLAND) continue;
      if ((d.density || 1) < lowestDensity) {
        lowestDensity = d.density || 1;
        bestDist = d;
      }
    }
    if (bestDist) {
      bestDist.character = CHARACTER.DENSE_RESIDENTIAL;
    }
  }
}

// ---------------------------------------------------------------------------
// Collector road generation within districts
// ---------------------------------------------------------------------------

/**
 * Generate collector roads within each district.
 *
 * @param {Array} districts
 * @param {Object} terrainData
 * @param {Object} roadNetwork - existing nodes/edges (will be extended)
 * @param {number} organicness
 * @param {Object} rng
 */
function generateCollectorRoads(districts, terrainData, roadNetwork, organicness, rng) {
  const { heightmap, waterCells, waterExclusion, slopeMap } = terrainData;
  const gridWidth = heightmap.width;
  const gridHeight = heightmap.height;
  const cellSize = heightmap._cellSize;
  const worldExtent = (gridWidth - 1) * cellSize;

  // Use waterExclusion (superset of waterCells, includes floodplain) with
  // Infinity penalty so collectors never route through water.
  // Road avoidance: mark existing road cells so new collectors route away.
  const collectorRoadCells = new Set();
  // Pre-populate with existing road paths (arterials from phase2)
  for (const edge of roadNetwork.edges) {
    if (!edge.gridPath) continue;
    const buffer = Math.ceil(5 / cellSize);
    for (const { gx, gz } of edge.gridPath) {
      for (let dz = -buffer; dz <= buffer; dz++) {
        for (let dx = -buffer; dx <= buffer; dx++) {
          const nx = gx + dx;
          const nz = gz + dz;
          if (nx >= 0 && nx < gridWidth && nz >= 0 && nz < gridHeight) {
            collectorRoadCells.add(nz * gridWidth + nx);
          }
        }
      }
    }
  }
  const baseCostFn = terrainCostFunction(heightmap, {
    slopePenalty: 12,
    waterCells: waterExclusion || waterCells,
    waterPenalty: Infinity,
    edgeMargin: 2,
    edgePenalty: 2,
  });
  const costFn = (fromGx, fromGz, toGx, toGz) => {
    const base = baseCostFn(fromGx, fromGz, toGx, toGz);
    const key = toGz * gridWidth + toGx;
    return collectorRoadCells.has(key) ? base + 200 : base;
  };

  for (const district of districts) {
    if (district.character === CHARACTER.PARKLAND) continue;
    if (district.area < 5000) continue;

    const collectorRng = rng.fork(`collector-${district.id}`);

    // Determine collector strategy based on terrain and organicness
    const avgSlope = computeAvgSlope(district, slopeMap, heightmap);
    const isGrid = organicness < 0.3 || (organicness < 0.7 && avgSlope < 0.05);
    const isOrganic = organicness > 0.7 || avgSlope > 0.1;

    const cx = district.centroid.x;
    const cz = district.centroid.z;

    if (isGrid) {
      generateGridCollectors(district, heightmap, roadNetwork, costFn, cellSize, collectorRng);
    } else if (isOrganic) {
      generateOrganicCollectors(district, heightmap, roadNetwork, costFn, cellSize, collectorRng);
    } else {
      // Hybrid: grid in flat center, organic at edges
      generateGridCollectors(district, heightmap, roadNetwork, costFn, cellSize, collectorRng);
    }
  }
}

function computeAvgSlope(district, slopeMap, heightmap) {
  const cs = district.blockCellSize;
  const gw = district.blockGridWidth;
  const hmW = heightmap.width;
  const hmCS = heightmap._cellSize;
  let total = 0, count = 0;

  for (const cellIdx of district.cells) {
    const bx = cellIdx % gw;
    const bz = (cellIdx - bx) / gw;
    const hmGx = clamp(Math.round(bx * cs / hmCS), 0, hmW - 1);
    const hmGz = clamp(Math.round(bz * cs / hmCS), 0, hmW - 1);
    total += slopeMap[hmGz * hmW + hmGx];
    count++;
  }

  return count > 0 ? total / count : 0;
}

/**
 * Generate grid-aligned collector roads within a district.
 */
function generateGridCollectors(district, heightmap, roadNetwork, costFn, cellSize, rng) {
  const gridWidth = heightmap.width;
  const gridHeight = heightmap.height;
  const worldExtent = (gridWidth - 1) * cellSize;
  const { nodes, edges } = roadNetwork;
  const cx = district.centroid.x;
  const cz = district.centroid.z;

  // Determine grid spacing based on district density
  const spacing = lerp(120, 250, 1 - clamp(district.density || 0.5, 0, 1));

  // Determine grid orientation from nearest arterial
  let gridAngle = 0;
  let minDist = Infinity;
  for (const edge of edges) {
    if (edge.hierarchy !== 'primary' && edge.hierarchy !== 'secondary') continue;
    if (!edge.points || edge.points.length < 2) continue;
    for (let i = 0; i < edge.points.length - 1; i++) {
      const d = pointToSegmentDist(cx, cz, edge.points[i].x, edge.points[i].z, edge.points[i + 1].x, edge.points[i + 1].z);
      if (d < minDist) {
        minDist = d;
        gridAngle = Math.atan2(edge.points[i + 1].z - edge.points[i].z, edge.points[i + 1].x - edge.points[i].x);
      }
    }
  }

  // Generate grid lines through centroid
  const distSize = Math.sqrt(district.area);
  const halfExtent = distSize * 0.6;

  const cosA = Math.cos(gridAngle);
  const sinA = Math.sin(gridAngle);

  // Horizontal lines (along grid angle) — cap at 3 per direction
  const numH = Math.min(3, Math.max(1, Math.floor(halfExtent * 2 / spacing)));
  for (let i = -Math.floor(numH / 2); i <= Math.floor(numH / 2); i++) {
    const offset = i * spacing;
    const startX = cx + cosA * halfExtent + (-sinA) * offset;
    const startZ = cz + sinA * halfExtent + cosA * offset;
    const endX = cx - cosA * halfExtent + (-sinA) * offset;
    const endZ = cz - sinA * halfExtent + cosA * offset;

    addCollectorRoad(startX, startZ, endX, endZ, district, heightmap, roadNetwork, costFn, cellSize);
  }

  // Vertical lines (perpendicular) — cap at 3 per direction
  const numV = Math.min(3, Math.max(1, Math.floor(halfExtent * 2 / spacing)));
  for (let i = -Math.floor(numV / 2); i <= Math.floor(numV / 2); i++) {
    const offset = i * spacing;
    const startX = cx + (-sinA) * halfExtent + cosA * offset;
    const startZ = cz + cosA * halfExtent + sinA * offset;
    const endX = cx - (-sinA) * halfExtent + cosA * offset;
    const endZ = cz - cosA * halfExtent + sinA * offset;

    addCollectorRoad(startX, startZ, endX, endZ, district, heightmap, roadNetwork, costFn, cellSize);
  }
}

/**
 * Generate organic collector roads within a district using A* between random targets.
 */
function generateOrganicCollectors(district, heightmap, roadNetwork, costFn, cellSize, rng) {
  const gridWidth = heightmap.width;
  const worldExtent = (gridWidth - 1) * cellSize;
  const cx = district.centroid.x;
  const cz = district.centroid.z;

  const distSize = Math.sqrt(district.area);
  const numRoads = clamp(Math.floor(distSize / 120), 1, 4);

  // Generate random target points within the district
  const targets = [];
  for (let i = 0; i < numRoads * 2; i++) {
    const angle = rng.next() * Math.PI * 2;
    const dist = rng.next() * distSize * 0.4;
    const tx = clamp(cx + Math.cos(angle) * dist, 0, worldExtent);
    const tz = clamp(cz + Math.sin(angle) * dist, 0, worldExtent);
    targets.push({ x: tx, z: tz });
  }

  // Connect centroid to each target, and some targets to each other
  for (let i = 0; i < targets.length; i++) {
    // Connect to centroid
    if (i < numRoads) {
      addCollectorRoad(cx, cz, targets[i].x, targets[i].z, district, heightmap, roadNetwork, costFn, cellSize);
    }

    // Connect to nearest unconnected target
    if (i < targets.length - 1) {
      let bestJ = -1, bestDist = Infinity;
      for (let j = i + 1; j < targets.length; j++) {
        const d = distance2D(targets[i].x, targets[i].z, targets[j].x, targets[j].z);
        if (d < bestDist && d > 30) {
          bestDist = d;
          bestJ = j;
        }
      }
      if (bestJ >= 0 && bestDist < distSize * 0.8) {
        addCollectorRoad(targets[i].x, targets[i].z, targets[bestJ].x, targets[bestJ].z, district, heightmap, roadNetwork, costFn, cellSize);
      }
    }
  }
}

/**
 * Add a single collector road via A* routing.
 */
function addCollectorRoad(startX, startZ, endX, endZ, district, heightmap, roadNetwork, costFn, cellSize) {
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

  // Skip very short roads
  if (distance2D(sx, sz, ex, ez) < 30) return;

  const pathResult = findPath(sGx, sGz, eGx, eGz, gridWidth, gridHeight, costFn);
  if (!pathResult) return;

  const simplified = simplifyPath(pathResult.path, 1.5);
  const smoothed = smoothPath(simplified, cellSize, 2);

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
    width: COLLECTOR_WIDTH,
    hierarchy: 'collector',
    districtId: district.id,
  });

  snapEndpointsToNetwork(edgeId, roadNetwork.nodes, roadNetwork.edges);
}

// ---------------------------------------------------------------------------
// Plaza placement
// ---------------------------------------------------------------------------

/**
 * Place plazas at district centers by adding plaza nodes.
 */
function placePlazas(districts, roadNetwork) {
  for (const district of districts) {
    if (district.character === CHARACTER.PARKLAND) continue;
    if (district.character === CHARACTER.SUBURBAN_RESIDENTIAL) continue;

    // Find the nearest road intersection to district centroid
    let nearest = null;
    let nearestDist = Infinity;
    for (const node of roadNetwork.nodes.values()) {
      const d = distance2D(node.x, node.z, district.centroid.x, district.centroid.z);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = node;
      }
    }

    if (nearest && nearestDist < PLAZA_RADIUS * 3) {
      // Mark as plaza node
      const plazaId = newNodeId();
      roadNetwork.nodes.set(plazaId, {
        id: plazaId,
        gx: nearest.gx,
        gz: nearest.gz,
        x: nearest.x,
        z: nearest.z,
        type: 'plaza',
        districtId: district.id,
      });

      district.plazaNodeId = plazaId;
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 4 entry point
// ---------------------------------------------------------------------------

/**
 * Run Phase 4: District Division & Collector Roads.
 *
 * @param {Object} terrainData - from Phase 1
 * @param {Object} roadNetwork - from Phase 2 (will be extended with collector edges)
 * @param {Object} densityField - from Phase 3
 * @param {Object} cityContext
 * @param {Object} rng
 * @param {Object} [params]
 * @returns {Object} { districts, roadNetwork (extended) }
 */
export function runPhase4(terrainData, roadNetwork, densityField, cityContext, rng, params = {}) {
  const { organicness = 0.5 } = params;

  // 1. Extract raw districts from road network boundaries
  const rawDistricts = extractRawDistricts(
    roadNetwork.edges,
    terrainData.waterCells,
    terrainData.heightmap
  );

  // 2. Subdivide oversized districts
  const districts = subdivideOversizedDistricts(rawDistricts, densityField);

  // 3. Assign character to each district
  assignCharacter(districts, densityField, terrainData, cityContext);

  // 4. Generate collector roads within each district
  generateCollectorRoads(districts, terrainData, roadNetwork, organicness, rng);

  // 5. Place plazas at district centers
  placePlazas(districts, roadNetwork);

  return { districts, roadNetwork };
}
