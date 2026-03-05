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

  // Build fine-resolution availability grid (3m cells)
  // 0 = available, 1 = water/sea, 2 = road corridor, 3 = claimed by plot
  const RES = 3; // metres per availability cell
  const availW = Math.ceil((w * cs) / RES);
  const availH = Math.ceil((h * cs) / RES);
  const avail = new Uint8Array(availW * availH); // 0 = available

  // Mark water as unavailable — use smooth polygons if available, fall back to grid
  const waterPolygons = cityLayers.getData('waterPolygons');
  if (waterPolygons && waterPolygons.length > 0) {
    for (const poly of waterPolygons) {
      stampPolyOnAvail(poly, avail, availW, availH, RES, 1);
    }
  } else {
    for (let az = 0; az < availH; az++) {
      for (let ax = 0; ax < availW; ax++) {
        const wx = ax * RES, wz = az * RES;
        const gx = Math.round(wx / cs), gz = Math.round(wz / cs);
        if (gx < 0 || gx >= w || gz < 0 || gz >= h) { avail[az * availW + ax] = 1; continue; }
        if (elevation && elevation.get(gx, gz) < seaLevel) { avail[az * availW + ax] = 1; continue; }
        if (waterMask && waterMask.get(gx, gz) > 0) { avail[az * availW + ax] = 1; }
      }
    }
  }
  // Also mark out-of-bounds cells
  for (let az = 0; az < availH; az++) {
    for (let ax = 0; ax < availW; ax++) {
      const wx = ax * RES, wz = az * RES;
      const gx = Math.round(wx / cs), gz = Math.round(wz / cs);
      if (gx < 0 || gx >= w || gz < 0 || gz >= h) avail[az * availW + ax] = 1;
    }
  }
  // Buffer: expand water boundary by 2 cells (6m) for plot setback from water
  const waterBuf = 2;
  const availCopy = new Uint8Array(avail);
  for (let az = 0; az < availH; az++) {
    for (let ax = 0; ax < availW; ax++) {
      if (availCopy[az * availW + ax] !== 1) continue;
      for (let dz = -waterBuf; dz <= waterBuf; dz++) {
        for (let dx = -waterBuf; dx <= waterBuf; dx++) {
          const bx = ax + dx, bz = az + dz;
          if (bx < 0 || bx >= availW || bz < 0 || bz >= availH) continue;
          if (avail[bz * availW + bx] === 0) avail[bz * availW + bx] = 1;
        }
      }
    }
  }

  // Mark road corridors as unavailable (stamp each edge polyline with its width)
  for (const [edgeId, edge] of graph.edges) {
    const polyline = graph.edgePolyline(edgeId);
    const halfW = ((edge.width || 12) / 2) + 2; // +2m buffer
    stampPolylineOnAvail(polyline, halfW, avail, availW, availH, RES, 2);
  }

  // Extra buffer around junction nodes (nodes with 3+ edges)
  for (const [nodeId, node] of graph.nodes) {
    const degree = graph.neighbors(nodeId).length;
    if (degree >= 3) {
      const junctionRadius = 15; // generous clearing around junctions
      stampCircleOnAvail(node.x, node.z, junctionRadius, avail, availW, availH, RES, 2);
    }
  }

  // Pre-claim cells from institutional plots placed in C6b
  const institutionalPlots = cityLayers.getData('institutionalPlots') || [];
  for (const ip of institutionalPlots) {
    if (ip.vertices) {
      stampPolyOnAvail(ip.vertices, avail, availW, availH, RES, 3);
    }
  }

  // Store availability grid for debug rendering
  cityLayers.setData('availGrid', { data: avail, width: availW, height: availH, res: RES });

  const allPlots = [];

  // Phase 1: Frontage plots along existing arterials and collectors
  const arterialEdges = [];
  for (const [edgeId, edge] of graph.edges) {
    if (edge.hierarchy === 'arterial' || edge.hierarchy === 'collector' || edge.hierarchy === 'structural') {
      arterialEdges.push(edgeId);
    }
  }

  for (const edgeId of arterialEdges) {
    const plots = generateFrontagePlots(graph, edgeId, ownership, neighborhoods, density, elevation, waterMask, seaLevel, w, h, cs, avail, availW, availH, RES, rng);
    allPlots.push(...plots);
  }

  const newEdgeIds = new Set();

  return { plots: allPlots, newEdgeIds };
}

/**
 * Generate frontage plots along both sides of a road edge.
 * Plots follow the road curve — each plot's front edge sits on the polyline,
 * rear edge is offset perpendicular to the local road direction.
 */
function generateFrontagePlots(graph, edgeId, ownership, neighborhoods, density, elevation, waterMask, seaLevel, w, h, cs, avail, availW, availH, RES, rng) {
  const edge = graph.getEdge(edgeId);
  if (!edge) return [];

  const polyline = graph.edgePolyline(edgeId);
  if (polyline.length < 2) return [];

  // Build cumulative distance table along polyline
  const cumDist = [0];
  for (let i = 1; i < polyline.length; i++) {
    const dx = polyline[i].x - polyline[i - 1].x;
    const dz = polyline[i].z - polyline[i - 1].z;
    cumDist.push(cumDist[i - 1] + Math.sqrt(dx * dx + dz * dz));
  }
  const totalLen = cumDist[cumDist.length - 1];
  if (totalLen < 5) return [];

  // Trim start/end near junctions
  const fromDegree = graph.neighbors(edge.from).length;
  const toDegree = graph.neighbors(edge.to).length;
  const startTrim = fromDegree >= 3 ? 15 : 0; // skip 15m near junctions
  const endTrim = toDegree >= 3 ? 15 : 0;
  const usableStart = startTrim;
  const usableEnd = totalLen - endTrim;
  if (usableEnd - usableStart < 5) return [];

  const plots = [];
  const hierarchy = edge.hierarchy || 'local';
  const roadTotalWidth = ROAD_WIDTHS[hierarchy] || ROAD_WIDTHS.local;
  const roadOffset = roadTotalWidth / 2 + 1;

  for (const side of ['left', 'right']) {
    const sign = side === 'left' ? 1 : -1;

    // Sample neighborhood config at edge midpoint
    const midPt = samplePolyline(polyline, cumDist, totalLen * 0.5);
    const midDir = samplePolylineDir(polyline, cumDist, totalLen * 0.5);
    const sampleX = midPt.x + (-midDir.z * sign) * 10;
    const sampleZ = midPt.z + (midDir.x * sign) * 10;
    const midGx = Math.round(sampleX / cs);
    const midGz = Math.round(sampleZ / cs);

    if (midGx < 0 || midGx >= ownership.width || midGz < 0 || midGz >= ownership.height) continue;
    const ownerIdx = ownership.get(midGx, midGz);
    if (ownerIdx < 0 || ownerIdx >= neighborhoods.length) continue;

    const hood = neighborhoods[ownerIdx];
    const config = PLOT_CONFIG[hood.type] || PLOT_CONFIG.suburban;
    const d = density.get(midGx, midGz);
    if (d < 0.05) continue;

    const plotDepth = config.plotDepth * (0.7 + (1 - d) * 0.3);
    const frontageWidth = config.frontageWidth * (0.8 + rng.range(-0.1, 0.1));

    // Walk along usable length placing plots
    let along = usableStart;
    while (along + frontageWidth * 0.5 < usableEnd) {
      const plotEnd = Math.min(along + frontageWidth, usableEnd);
      const actualWidth = plotEnd - along;
      if (actualWidth < frontageWidth * 0.4) break;

      // Sample front corners on the polyline, offset by road width
      const pt0 = samplePolyline(polyline, cumDist, along);
      const dir0 = samplePolylineDir(polyline, cumDist, along);
      const n0x = -dir0.z * sign, n0z = dir0.x * sign;

      const pt1 = samplePolyline(polyline, cumDist, plotEnd);
      const dir1 = samplePolylineDir(polyline, cumDist, plotEnd);
      const n1x = -dir1.z * sign, n1z = dir1.x * sign;

      const f0 = { x: pt0.x + n0x * roadOffset, z: pt0.z + n0z * roadOffset };
      const f1 = { x: pt1.x + n1x * roadOffset, z: pt1.z + n1z * roadOffset };
      const r0 = { x: pt0.x + n0x * (roadOffset + plotDepth), z: pt0.z + n0z * (roadOffset + plotDepth) };
      const r1 = { x: pt1.x + n1x * (roadOffset + plotDepth), z: pt1.z + n1z * (roadOffset + plotDepth) };

      along = plotEnd;

      // Validate against availability grid — reject if any unavailable
      if (!isPlotAvailable([f0, f1, r1, r0], avail, availW, availH, RES, 0.0)) continue;

      // Claim cells
      stampPolyOnAvail([f0, f1, r1, r0], avail, availW, availH, RES, 3);

      const cx = (f0.x + f1.x + r0.x + r1.x) / 4;
      const cz = (f0.z + f1.z + r0.z + r1.z) / 4;
      const district = getDistrictFromHood(hood, d);
      const midDirPlot = samplePolylineDir(polyline, cumDist, (along + plotEnd) / 2);

      plots.push({
        vertices: [f0, f1, r1, r0],
        area: actualWidth * plotDepth,
        centroid: { x: cx, z: cz },
        frontageEdgeId: edgeId,
        frontageDirection: { x: midDirPlot.x, z: midDirPlot.z },
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
  }

  return plots;
}

/** Sample a point along a polyline at distance `d` from start. */
function samplePolyline(polyline, cumDist, d) {
  d = Math.max(0, Math.min(d, cumDist[cumDist.length - 1]));
  for (let i = 1; i < cumDist.length; i++) {
    if (cumDist[i] >= d) {
      const segLen = cumDist[i] - cumDist[i - 1];
      const t = segLen > 0 ? (d - cumDist[i - 1]) / segLen : 0;
      return {
        x: polyline[i - 1].x + (polyline[i].x - polyline[i - 1].x) * t,
        z: polyline[i - 1].z + (polyline[i].z - polyline[i - 1].z) * t,
      };
    }
  }
  return { x: polyline[polyline.length - 1].x, z: polyline[polyline.length - 1].z };
}

/** Sample the unit direction of the polyline at distance `d`. */
function samplePolylineDir(polyline, cumDist, d) {
  d = Math.max(0, Math.min(d, cumDist[cumDist.length - 1]));
  for (let i = 1; i < cumDist.length; i++) {
    if (cumDist[i] >= d) {
      const dx = polyline[i].x - polyline[i - 1].x;
      const dz = polyline[i].z - polyline[i - 1].z;
      const len = Math.sqrt(dx * dx + dz * dz);
      return len > 0 ? { x: dx / len, z: dz / len } : { x: 1, z: 0 };
    }
  }
  return { x: 1, z: 0 };
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

// -- Availability grid helpers --

/** Check if a polygon's area is mostly available. Returns false if >threshold fraction is unavailable. */
function isPlotAvailable(verts, avail, availW, availH, RES, threshold) {
  const xs = verts.map(v => v.x);
  const zs = verts.map(v => v.z);
  const minAx = Math.max(0, Math.floor(Math.min(...xs) / RES));
  const maxAx = Math.min(availW - 1, Math.ceil(Math.max(...xs) / RES));
  const minAz = Math.max(0, Math.floor(Math.min(...zs) / RES));
  const maxAz = Math.min(availH - 1, Math.ceil(Math.max(...zs) / RES));

  let samples = 0, blocked = 0;
  for (let az = minAz; az <= maxAz; az++) {
    const wz = az * RES;
    const intersections = [];
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      if ((a.z <= wz && b.z > wz) || (b.z <= wz && a.z > wz)) {
        const t = (wz - a.z) / (b.z - a.z);
        intersections.push(a.x + t * (b.x - a.x));
      }
    }
    intersections.sort((a, b) => a - b);
    for (let i = 0; i < intersections.length - 1; i += 2) {
      const xStart = Math.max(minAx, Math.ceil(intersections[i] / RES));
      const xEnd = Math.min(maxAx, Math.floor(intersections[i + 1] / RES));
      for (let ax = xStart; ax <= xEnd; ax++) {
        samples++;
        if (avail[az * availW + ax] !== 0) blocked++;
      }
    }
  }
  return samples > 0 && (blocked / samples) <= threshold;
}

/** Stamp a polygon onto the availability grid (works for convex and concave). */
function stampPolyOnAvail(verts, avail, availW, availH, RES, value) {
  if (verts.length < 3) return;
  const xs = verts.map(v => v.x);
  const zs = verts.map(v => v.z);
  const minAx = Math.max(0, Math.floor(Math.min(...xs) / RES));
  const maxAx = Math.min(availW - 1, Math.ceil(Math.max(...xs) / RES));
  const minAz = Math.max(0, Math.floor(Math.min(...zs) / RES));
  const maxAz = Math.min(availH - 1, Math.ceil(Math.max(...zs) / RES));

  // Use scanline fill for efficiency
  for (let az = minAz; az <= maxAz; az++) {
    const wz = az * RES;
    // Find all x-intersections of the polygon edges with this scanline
    const intersections = [];
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      if ((a.z <= wz && b.z > wz) || (b.z <= wz && a.z > wz)) {
        const t = (wz - a.z) / (b.z - a.z);
        intersections.push(a.x + t * (b.x - a.x));
      }
    }
    intersections.sort((a, b) => a - b);
    // Fill between pairs
    for (let i = 0; i < intersections.length - 1; i += 2) {
      const xStart = Math.max(minAx, Math.ceil(intersections[i] / RES));
      const xEnd = Math.min(maxAx, Math.floor(intersections[i + 1] / RES));
      for (let ax = xStart; ax <= xEnd; ax++) {
        avail[az * availW + ax] = value;
      }
    }
  }
}

/** Stamp a polyline corridor (line with half-width) onto the availability grid. */
function stampPolylineOnAvail(polyline, halfWidth, avail, availW, availH, RES, value) {
  for (let i = 0; i < polyline.length - 1; i++) {
    const p0 = polyline[i], p1 = polyline[i + 1];
    const dx = p1.x - p0.x, dz = p1.z - p0.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 0.1) continue;

    const ux = dx / len, uz = dz / len;
    const nx = -uz, nz = ux;

    // Build quad for this segment
    const verts = [
      { x: p0.x + nx * halfWidth, z: p0.z + nz * halfWidth },
      { x: p1.x + nx * halfWidth, z: p1.z + nz * halfWidth },
      { x: p1.x - nx * halfWidth, z: p1.z - nz * halfWidth },
      { x: p0.x - nx * halfWidth, z: p0.z - nz * halfWidth },
    ];
    stampPolyOnAvail(verts, avail, availW, availH, RES, value);
  }
}

/** Stamp a circle onto the availability grid. */
function stampCircleOnAvail(cx, cz, radius, avail, availW, availH, RES, value) {
  const minAx = Math.max(0, Math.floor((cx - radius) / RES));
  const maxAx = Math.min(availW - 1, Math.ceil((cx + radius) / RES));
  const minAz = Math.max(0, Math.floor((cz - radius) / RES));
  const maxAz = Math.min(availH - 1, Math.ceil((cz + radius) / RES));
  const r2 = radius * radius;

  for (let az = minAz; az <= maxAz; az++) {
    for (let ax = minAx; ax <= maxAx; ax++) {
      const dx = ax * RES - cx, dz = az * RES - cz;
      if (dx * dx + dz * dz <= r2) {
        avail[az * availW + ax] = value;
      }
    }
  }
}

function pointInConvexPoly(px, pz, verts) {
  for (let i = 0; i < verts.length; i++) {
    const j = (i + 1) % verts.length;
    const ex = verts[j].x - verts[i].x;
    const ez = verts[j].z - verts[i].z;
    const tx = px - verts[i].x;
    const tz = pz - verts[i].z;
    if (ex * tz - ez * tx < 0) return false;
  }
  return true;
}

function getDistrictFromHood(hood, density) {
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
