/**
 * C7. Streets and Plots (merged, frontage-first).
 *
 * Instead of generating streets first and extracting plots from graph faces,
 * this module generates plots directly from road frontage. Streets are added
 * where they create useful new frontage (back lanes and cross streets).
 *
 * Algorithm:
 *   Phase 1: Generate frontage plots along all arterial/collector edges
 *   Phase 2: Add back-lane streets where plots are deep enough and density warrants
 *   Phase 3: Add cross streets to break long blocks into walkable lengths
 *   Phase 4: Generate frontage plots along all new streets
 *   Phase 5: Fill remaining arterial/collector frontage gaps
 */

import { distance2D } from '../core/math.js';

// -- Plot dimension tables by neighborhood type --

const PLOT_CONFIG = {
  oldTown: {
    frontageWidth: 8,    // metres
    plotDepth: 30,
    frontSetback: 1,
    rearGarden: 6,
    backLane: true,
    crossStreetSpacing: 55,
    buildingCoverage: 0.80,
  },
  waterfront: {
    frontageWidth: 14,
    plotDepth: 35,
    frontSetback: 2,
    rearGarden: 8,
    backLane: true,
    crossStreetSpacing: 65,
    buildingCoverage: 0.65,
  },
  market: {
    frontageWidth: 7,
    plotDepth: 20,
    frontSetback: 0,
    rearGarden: 4,
    backLane: false,
    crossStreetSpacing: 50,
    buildingCoverage: 0.85,
  },
  roadside: {
    frontageWidth: 10,
    plotDepth: 35,
    frontSetback: 3,
    rearGarden: 10,
    backLane: true,
    crossStreetSpacing: 65,
    buildingCoverage: 0.55,
  },
  hilltop: {
    frontageWidth: 18,
    plotDepth: 45,
    frontSetback: 8,
    rearGarden: 15,
    backLane: false,
    crossStreetSpacing: 80,
    buildingCoverage: 0.30,
  },
  valley: {
    frontageWidth: 12,
    plotDepth: 35,
    frontSetback: 5,
    rearGarden: 10,
    backLane: true,
    crossStreetSpacing: 70,
    buildingCoverage: 0.45,
  },
  suburban: {
    frontageWidth: 16,
    plotDepth: 45,
    frontSetback: 8,
    rearGarden: 16,
    backLane: false,
    crossStreetSpacing: 85,
    buildingCoverage: 0.30,
  },
  industrial: {
    frontageWidth: 28,
    plotDepth: 50,
    frontSetback: 5,
    rearGarden: 10,
    backLane: false,
    crossStreetSpacing: 70,
    buildingCoverage: 0.55,
  },
};

// Road widths include sidewalks/verges on both sides
const ROAD_WIDTHS = {
  arterial: 16,   // 7m carriageway + 2x 3m sidewalk + 2x 1.5m verge
  collector: 12,  // 6m carriageway + 2x 2m sidewalk + 2x 1m verge
  structural: 14, // similar to arterial
  local: 9,       // 5m carriageway + 2x 2m sidewalk
  backLane: 7,    // 4m carriageway + 2x 1.5m sidewalk
};

/**
 * @param {import('../core/LayerStack.js').LayerStack} cityLayers
 * @param {import('../core/PlanarGraph.js').PlanarGraph} graph
 * @param {import('../core/rng.js').SeededRandom} rng
 * @returns {{ plots: Array, newEdgeIds: Set<number> }}
 */
export function generateStreetsAndPlots(cityLayers, graph, rng) {
  const params = cityLayers.getData('params');
  const neighborhoods = cityLayers.getData('neighborhoods');
  const ownership = cityLayers.getData('ownership');
  const density = cityLayers.getGrid('density');
  const elevation = cityLayers.getGrid('elevation');
  const waterMask = cityLayers.getGrid('waterMask');

  if (!params || !neighborhoods || !ownership || !density) {
    return { plots: [], newEdgeIds: new Set() };
  }

  const w = params.width;
  const h = params.height;
  const cs = params.cellSize;
  const seaLevel = params.seaLevel ?? 0;

  const edgeIdsBefore = new Set(graph.edges.keys());

  // Track which side of which edge already has plots to avoid overlap
  const claimedCells = new Set(); // Set of "gx,gz" strings for plot cells

  const allPlots = [];

  // Phase 1: Frontage plots along existing arterials and collectors
  const arterialEdges = [];
  for (const [edgeId, edge] of graph.edges) {
    if (edge.hierarchy === 'arterial' || edge.hierarchy === 'collector' || edge.hierarchy === 'structural') {
      arterialEdges.push(edgeId);
    }
  }

  for (const edgeId of arterialEdges) {
    const plots = generateFrontagePlots(graph, edgeId, ownership, neighborhoods, density, elevation, waterMask, seaLevel, w, h, cs, claimedCells, rng);
    allPlots.push(...plots);
  }

  // Phase 2: Back lanes — where density is high enough and plots are deep
  const backLaneEdges = generateBackLanes(graph, allPlots, ownership, neighborhoods, density, w, h, cs, claimedCells, rng);

  // Phase 3: Cross streets — break long blocks
  const crossStreetEdges = generateCrossStreets(graph, allPlots, ownership, neighborhoods, density, elevation, waterMask, seaLevel, w, h, cs, claimedCells, rng);

  // Phase 4: Frontage plots along new streets (back lanes and cross streets)
  const newStreetEdges = [...backLaneEdges, ...crossStreetEdges];
  for (const edgeId of newStreetEdges) {
    const plots = generateFrontagePlots(graph, edgeId, ownership, neighborhoods, density, elevation, waterMask, seaLevel, w, h, cs, claimedCells, rng);
    allPlots.push(...plots);
  }

  // Phase 5: Fill remaining frontage gaps on all local streets
  for (const [edgeId, edge] of graph.edges) {
    if (edgeIdsBefore.has(edgeId)) continue; // already processed arterials
    if (newStreetEdges.includes(edgeId)) continue; // already processed
    const plots = generateFrontagePlots(graph, edgeId, ownership, neighborhoods, density, elevation, waterMask, seaLevel, w, h, cs, claimedCells, rng);
    allPlots.push(...plots);
  }

  const newEdgeIds = new Set();
  for (const edgeId of graph.edges.keys()) {
    if (!edgeIdsBefore.has(edgeId)) newEdgeIds.add(edgeId);
  }

  return { plots: allPlots, newEdgeIds };
}

/**
 * Generate frontage plots along both sides of a road edge.
 */
function generateFrontagePlots(graph, edgeId, ownership, neighborhoods, density, elevation, waterMask, seaLevel, w, h, cs, claimedCells, rng) {
  const edge = graph.getEdge(edgeId);
  if (!edge) return [];

  const polyline = graph.edgePolyline(edgeId);
  if (polyline.length < 2) return [];

  const plots = [];

  // Process each segment of the polyline
  for (let seg = 0; seg < polyline.length - 1; seg++) {
    const p0 = polyline[seg];
    const p1 = polyline[seg + 1];

    const dx = p1.x - p0.x;
    const dz = p1.z - p0.z;
    const segLen = Math.sqrt(dx * dx + dz * dz);
    if (segLen < 3) continue;

    // Unit direction along road
    const dirX = dx / segLen;
    const dirZ = dz / segLen;

    // Perpendicular normals (left and right)
    const leftNX = -dirZ;
    const leftNZ = dirX;

    // Generate plots on both sides
    for (const side of ['left', 'right']) {
      const nx = side === 'left' ? leftNX : -leftNX;
      const nz = side === 'left' ? leftNZ : -leftNZ;

      const hierarchy = edge.hierarchy || 'local';
      const sidePlots = generateSidePlots(
        p0, segLen, dirX, dirZ, nx, nz, side, hierarchy,
        edgeId, ownership, neighborhoods, density, elevation, waterMask,
        seaLevel, w, h, cs, claimedCells, rng,
      );
      plots.push(...sidePlots);
    }
  }

  return plots;
}

/**
 * Generate plots along one side of a road segment.
 */
function generateSidePlots(p0, segLen, dirX, dirZ, nx, nz, side, hierarchy, edgeId, ownership, neighborhoods, density, elevation, waterMask, seaLevel, w, h, cs, claimedCells, rng) {
  const plots = [];

  // Sample neighborhood type at segment midpoint
  const midX = p0.x + dirX * segLen * 0.5 + nx * 5;
  const midZ = p0.z + dirZ * segLen * 0.5 + nz * 5;
  const midGx = Math.round(midX / cs);
  const midGz = Math.round(midZ / cs);

  if (midGx < 0 || midGx >= ownership.width || midGz < 0 || midGz >= ownership.height) return plots;

  const ownerIdx = ownership.get(midGx, midGz);
  if (ownerIdx < 0 || ownerIdx >= neighborhoods.length) return plots;

  const hood = neighborhoods[ownerIdx];
  const config = PLOT_CONFIG[hood.type] || PLOT_CONFIG.suburban;
  const d = density.get(midGx, midGz);
  if (d < 0.05) return plots;

  // Adjust plot depth by density: denser = shallower (more streets, less depth)
  const plotDepth = config.plotDepth * (0.7 + (1 - d) * 0.3);
  const frontageWidth = config.frontageWidth * (0.8 + rng.range(-0.1, 0.1));

  // How many plots fit along this segment?
  const numPlots = Math.max(1, Math.floor(segLen / frontageWidth));
  const actualWidth = segLen / numPlots;

  // Offset from road centerline (half road width including sidewalks)
  const roadTotalWidth = ROAD_WIDTHS[hierarchy] || ROAD_WIDTHS.local;
  const roadOffset = roadTotalWidth / 2 + 1; // +1m buffer

  for (let i = 0; i < numPlots; i++) {
    const t0 = (i * actualWidth) / segLen;
    const t1 = ((i + 1) * actualWidth) / segLen;
    const tMid = (t0 + t1) / 2;

    // Front corners (at road edge + offset)
    const f0 = {
      x: p0.x + dirX * segLen * t0 + nx * roadOffset,
      z: p0.z + dirZ * segLen * t0 + nz * roadOffset,
    };
    const f1 = {
      x: p0.x + dirX * segLen * t1 + nx * roadOffset,
      z: p0.z + dirZ * segLen * t1 + nz * roadOffset,
    };

    // Rear corners (offset + depth)
    const r0 = {
      x: f0.x + nx * plotDepth,
      z: f0.z + nz * plotDepth,
    };
    const r1 = {
      x: f1.x + nx * plotDepth,
      z: f1.z + nz * plotDepth,
    };

    // Validate all corners
    if (!validatePlotCorners([f0, f1, r1, r0], elevation, waterMask, seaLevel, w, h, cs)) continue;

    // Check for overlap with existing plots (sample multiple points)
    if (isPlotOverlapping(f0, f1, r0, r1, cs, claimedCells)) continue;

    // Claim cells under this plot
    claimPlotCells(f0, f1, r0, r1, cs, claimedCells);

    // Get district at plot center
    const districts = null; // Will be derived from neighborhood type
    const district = getDistrictFromHood(hood, d);

    plots.push({
      vertices: [f0, f1, r1, r0],
      area: actualWidth * plotDepth,
      centroid: {
        x: (f0.x + f1.x + r0.x + r1.x) / 4,
        z: (f0.z + f1.z + r0.z + r1.z) / 4,
      },
      frontageEdgeId: edgeId,
      frontageDirection: { x: dirX, z: dirZ },
      frontageWidth: actualWidth,
      depth: plotDepth,
      setback: config.frontSetback,
      rearGarden: config.rearGarden,
      density: d,
      district,
      neighborhoodIdx: ownerIdx,
      neighborhoodType: hood.type,
      side,
      buildingCoverage: config.buildingCoverage,
    });
  }

  return plots;
}

/**
 * Generate back-lane streets parallel to existing roads, behind plots.
 * A back lane gives access to the rear of deep plots and creates new frontage.
 */
function generateBackLanes(graph, existingPlots, ownership, neighborhoods, density, w, h, cs, claimedCells, rng) {
  const newEdgeIds = [];

  // Group plots by frontage edge and side
  const plotsByEdgeSide = new Map();
  for (const plot of existingPlots) {
    const key = `${plot.frontageEdgeId}-${plot.side}`;
    if (!plotsByEdgeSide.has(key)) plotsByEdgeSide.set(key, []);
    plotsByEdgeSide.get(key).push(plot);
  }

  for (const [key, plots] of plotsByEdgeSide) {
    if (plots.length < 3) continue;

    const hood = neighborhoods[plots[0].neighborhoodIdx];
    if (!hood) continue;
    const config = PLOT_CONFIG[hood.type] || PLOT_CONFIG.suburban;
    if (!config.backLane) continue;

    const avgDensity = plots.reduce((s, p) => s + p.density, 0) / plots.length;
    if (avgDensity < 0.4) continue; // Only add back lanes in moderate+ density areas

    // Find the back edge of the plot strip
    // Back corners are vertices[2] (r1) and vertices[3] (r0)
    // We need to create a street along these back edges

    // Sort plots along their frontage direction
    const dir = plots[0].frontageDirection;
    plots.sort((a, b) => {
      const da = a.centroid.x * dir.x + a.centroid.z * dir.z;
      const db = b.centroid.x * dir.x + b.centroid.z * dir.z;
      return da - db;
    });

    // Create nodes along the back boundary at intervals (not every plot)
    // Use cross-street spacing to determine how many back-lane nodes we need
    const nodeInterval = Math.max(2, Math.floor(config.crossStreetSpacing / config.frontageWidth));
    const backNodes = [];
    for (let i = 0; i < plots.length; i += Math.max(1, Math.floor(nodeInterval / 2))) {
      const p = plots[i];
      // Midpoint of the rear edge (between r0 and r1)
      const backMid = {
        x: (p.vertices[2].x + p.vertices[3].x) / 2,
        z: (p.vertices[2].z + p.vertices[3].z) / 2,
      };

      // Validate the back lane position
      const gx = Math.round(backMid.x / cs);
      const gz = Math.round(backMid.z / cs);
      if (gx < 0 || gx >= w || gz < 0 || gz >= h) continue;

      const nodeId = findOrCreateNode(graph, backMid.x, backMid.z, cs * 2.0);
      backNodes.push(nodeId);
    }
    // Always include the last plot's back boundary
    if (plots.length > 1) {
      const lastPlot = plots[plots.length - 1];
      const backMid = {
        x: (lastPlot.vertices[2].x + lastPlot.vertices[3].x) / 2,
        z: (lastPlot.vertices[2].z + lastPlot.vertices[3].z) / 2,
      };
      const gx = Math.round(backMid.x / cs);
      const gz = Math.round(backMid.z / cs);
      if (gx >= 0 && gx < w && gz >= 0 && gz < h) {
        const nodeId = findOrCreateNode(graph, backMid.x, backMid.z, cs * 2.0);
        if (backNodes[backNodes.length - 1] !== nodeId) {
          backNodes.push(nodeId);
        }
      }
    }

    // Connect consecutive back-lane nodes
    for (let i = 0; i < backNodes.length - 1; i++) {
      if (backNodes[i] === backNodes[i + 1]) continue;
      // Check we don't already have this edge
      const neighbors = graph.neighbors(backNodes[i]);
      if (neighbors.includes(backNodes[i + 1])) continue;

      const edgeId = graph.addEdge(backNodes[i], backNodes[i + 1], {
        width: ROAD_WIDTHS.backLane,
        hierarchy: 'local',
      });
      newEdgeIds.push(edgeId);
    }
  }

  return newEdgeIds;
}

/**
 * Generate cross streets perpendicular to existing roads, connecting
 * the front road to the back of plots, breaking long blocks into walkable chunks.
 *
 * Cross streets are short — they span from the road edge to just past the
 * back of the deepest plot on each side (typically 1-2 plot depths).
 */
function generateCrossStreets(graph, existingPlots, ownership, neighborhoods, density, elevation, waterMask, seaLevel, w, h, cs, claimedCells, rng) {
  const newEdgeIds = [];

  // Group plots by frontage edge AND side
  const plotsByEdgeSide = new Map();
  for (const plot of existingPlots) {
    const key = `${plot.frontageEdgeId}-${plot.side}`;
    if (!plotsByEdgeSide.has(key)) plotsByEdgeSide.set(key, []);
    plotsByEdgeSide.get(key).push(plot);
  }

  // Process each edge-side group independently
  for (const [key, plots] of plotsByEdgeSide) {
    if (plots.length < 3) continue;

    const hood = neighborhoods[plots[0].neighborhoodIdx];
    if (!hood) continue;
    const config = PLOT_CONFIG[hood.type] || PLOT_CONFIG.suburban;

    const dir = plots[0].frontageDirection;

    // Sort plots along frontage direction
    plots.sort((a, b) => {
      const da = a.centroid.x * dir.x + a.centroid.z * dir.z;
      const db = b.centroid.x * dir.x + b.centroid.z * dir.z;
      return da - db;
    });

    // Measure total frontage length
    const firstPlot = plots[0];
    const lastPlot = plots[plots.length - 1];
    const totalLen = distance2D(
      firstPlot.centroid.x, firstPlot.centroid.z,
      lastPlot.centroid.x, lastPlot.centroid.z,
    );

    const spacing = config.crossStreetSpacing;
    if (totalLen < spacing * 1.3) continue;

    const numCross = Math.max(1, Math.floor(totalLen / spacing));

    for (let c = 1; c <= numCross; c++) {
      const t = c / (numCross + 1);

      // Interpolate position along the frontage
      const idx = Math.floor(t * (plots.length - 1));
      const nearPlot = plots[Math.min(idx, plots.length - 1)];

      // Cross street starts at the front of the plot (on the road edge)
      // and ends at the back of the plot (rear boundary)
      // Using this specific plot's geometry to keep it short and local
      const frontMid = {
        x: (nearPlot.vertices[0].x + nearPlot.vertices[1].x) / 2,
        z: (nearPlot.vertices[0].z + nearPlot.vertices[1].z) / 2,
      };
      const rearMid = {
        x: (nearPlot.vertices[2].x + nearPlot.vertices[3].x) / 2,
        z: (nearPlot.vertices[2].z + nearPlot.vertices[3].z) / 2,
      };

      // Extend slightly past the rear to connect to any back lane
      const extendFactor = 1.15;
      const endX = frontMid.x + (rearMid.x - frontMid.x) * extendFactor;
      const endZ = frontMid.z + (rearMid.z - frontMid.z) * extendFactor;

      // Validate endpoints
      const startGx = Math.round(frontMid.x / cs);
      const startGz = Math.round(frontMid.z / cs);
      const endGx = Math.round(endX / cs);
      const endGz = Math.round(endZ / cs);

      if (startGx < 0 || startGx >= w || startGz < 0 || startGz >= h) continue;
      if (endGx < 0 || endGx >= w || endGz < 0 || endGz >= h) continue;
      if (elevation && elevation.get(endGx, endGz) < seaLevel) continue;
      if (waterMask && waterMask.get(endGx, endGz) > 0) continue;

      const startNode = findOrCreateNode(graph, frontMid.x, frontMid.z, cs * 1.5);
      const endNode = findOrCreateNode(graph, endX, endZ, cs * 1.5);
      if (startNode === endNode) continue;
      if (graph.neighbors(startNode).includes(endNode)) continue;

      const crossEdgeId = graph.addEdge(startNode, endNode, {
        width: ROAD_WIDTHS.backLane,
        hierarchy: 'local',
      });
      newEdgeIds.push(crossEdgeId);
    }
  }

  return newEdgeIds;
}

// -- Helpers --

function validatePlotCorners(corners, elevation, waterMask, seaLevel, w, h, cs) {
  for (const c of corners) {
    const gx = Math.round(c.x / cs);
    const gz = Math.round(c.z / cs);
    if (gx < 0 || gx >= w || gz < 0 || gz >= h) return false;
    if (elevation && elevation.get(gx, gz) < seaLevel) return false;
    if (waterMask && waterMask.get(gx, gz) > 0) return false;
  }
  return true;
}

/** Check if a plot overlaps already-claimed cells. Reject if >30% overlap. */
function isPlotOverlapping(f0, f1, r0, r1, cs, claimedCells) {
  const step = 3; // sample every 3m
  const corners = [f0, f1, r1, r0];
  let samples = 0;
  let hits = 0;

  // Walk the quad using bilinear interpolation
  for (let u = 0; u <= 1; u += step / Math.max(1, dist(f0, f1))) {
    for (let v = 0; v <= 1; v += step / Math.max(1, dist(f0, r0))) {
      const x = f0.x * (1 - u) * (1 - v) + f1.x * u * (1 - v) + r1.x * u * v + r0.x * (1 - u) * v;
      const z = f0.z * (1 - u) * (1 - v) + f1.z * u * (1 - v) + r1.z * u * v + r0.z * (1 - u) * v;
      const key = `${Math.round(x / 3)},${Math.round(z / 3)}`;
      samples++;
      if (claimedCells.has(key)) hits++;
    }
  }
  return samples > 0 && (hits / samples) > 0.3;
}

function dist(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
}

/** Claim a fine grid of cells under the plot footprint. */
function claimPlotCells(f0, f1, r0, r1, cs, claimedCells) {
  const step = 3; // 3m resolution
  for (let u = 0; u <= 1; u += step / Math.max(1, dist(f0, f1))) {
    for (let v = 0; v <= 1; v += step / Math.max(1, dist(f0, r0))) {
      const x = f0.x * (1 - u) * (1 - v) + f1.x * u * (1 - v) + r1.x * u * v + r0.x * (1 - u) * v;
      const z = f0.z * (1 - u) * (1 - v) + f1.z * u * (1 - v) + r1.z * u * v + r0.z * (1 - u) * v;
      claimedCells.add(`${Math.round(x / 3)},${Math.round(z / 3)}`);
    }
  }
}

function getDistrictFromHood(hood, density) {
  // Map neighborhood type + density to district enum
  // 0=commercial, 1=dense_residential, 2=suburban, 3=industrial, 4=parkland
  const typeMap = {
    oldTown: density > 0.5 ? 0 : 1,
    waterfront: 3,
    market: 0,
    roadside: density > 0.6 ? 0 : 1,
    hilltop: 2,
    valley: 2,
    suburban: 2,
    industrial: 3,
  };
  return typeMap[hood.type] ?? 2;
}

function findOrCreateNode(graph, x, z, threshold) {
  const nearest = graph.nearestNode(x, z);
  if (nearest && nearest.dist < threshold) {
    return nearest.id;
  }
  return graph.addNode(x, z, { type: 'street' });
}
