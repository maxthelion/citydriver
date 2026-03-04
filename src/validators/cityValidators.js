/**
 * City validators.
 * Validators for road networks, buildings, plots, amenities, and overall city quality.
 *
 * Each validator is { name, tier, fn(cityLayers) }.
 *   Tier 1: boolean (must pass)
 *   Tier 2: scored 0-1 (structural)
 *   Tier 3: scored 0-1 (quality)
 */

import { distance2D, pointInPolygon, pointToSegmentDist, polygonArea, polygonCentroid } from '../core/math.js';

// ============================================================
// Helpers
// ============================================================

/**
 * Get bounding box for a polygon [{x,z}, ...].
 */
function bbox(polygon) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of polygon) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  return { minX, maxX, minZ, maxZ };
}

/**
 * Check if two bounding boxes overlap.
 */
function bboxOverlap(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
}

/**
 * Check if two polygons overlap. Uses bounding box prefilter, then point-in-polygon.
 */
function polygonsOverlap(polyA, polyB) {
  const bbA = bbox(polyA);
  const bbB = bbox(polyB);
  if (!bboxOverlap(bbA, bbB)) return false;

  // Check if any vertex of A is inside B
  for (const p of polyA) {
    if (pointInPolygon(p.x, p.z, polyB)) return true;
  }
  // Check if any vertex of B is inside A
  for (const p of polyB) {
    if (pointInPolygon(p.x, p.z, polyA)) return true;
  }
  return false;
}

/**
 * Minimum distance from a point to any segment of a road edge polyline.
 */
function pointToPolylineDist(px, pz, polyline) {
  let minDist = Infinity;
  for (let i = 0; i < polyline.length - 1; i++) {
    const d = pointToSegmentDist(px, pz, polyline[i].x, polyline[i].z, polyline[i + 1].x, polyline[i + 1].z);
    if (d < minDist) minDist = d;
  }
  return minDist;
}

/**
 * Minimum distance from a point to any road edge in the graph.
 */
function pointToAnyRoadDist(px, pz, roadGraph) {
  let minDist = Infinity;
  for (const [edgeId] of roadGraph.edges) {
    const polyline = roadGraph.edgePolyline(edgeId);
    const d = pointToPolylineDist(px, pz, polyline);
    if (d < minDist) minDist = d;
  }
  return minDist;
}

/**
 * Compute total length of a polyline.
 */
function polylineLength(polyline) {
  let len = 0;
  for (let i = 0; i < polyline.length - 1; i++) {
    len += distance2D(polyline[i].x, polyline[i].z, polyline[i + 1].x, polyline[i + 1].z);
  }
  return len;
}

/**
 * Compute perimeter of a polygon.
 */
function polygonPerimeter(polygon) {
  let perim = 0;
  for (let i = 0; i < polygon.length; i++) {
    const j = (i + 1) % polygon.length;
    perim += distance2D(polygon[i].x, polygon[i].z, polygon[j].x, polygon[j].z);
  }
  return perim;
}

// ============================================================
// Tier 1 validators (must pass - return boolean)
// ============================================================

/**
 * V_noRoadsInWater (T1): Every road node's grid position is above sea level.
 */
export const V_noRoadsInWater = {
  name: 'V_noRoadsInWater',
  tier: 1,
  fn(cityLayers) {
    const roadGraph = cityLayers.getData('roadGraph');
    const elevation = cityLayers.getGrid('elevation');
    const params = cityLayers.getData('params');
    if (!roadGraph || !elevation || !params) return true;

    const seaLevel = params.seaLevel ?? 0;

    for (const [, node] of roadGraph.nodes) {
      const { gx, gz } = elevation.worldToGrid(node.x, node.z);
      const h = elevation.sample(gx, gz);
      if (h < seaLevel) return false;
    }
    return true;
  },
};

/**
 * V_noBuildingsInWater (T1): Every building centroid is above sea level.
 */
export const V_noBuildingsInWater = {
  name: 'V_noBuildingsInWater',
  tier: 1,
  fn(cityLayers) {
    const buildings = cityLayers.getData('buildings');
    const elevation = cityLayers.getGrid('elevation');
    const params = cityLayers.getData('params');
    if (!buildings || !elevation || !params) return true;

    const seaLevel = params.seaLevel ?? 0;

    for (const b of buildings) {
      const cx = b.centroid.x;
      const cz = b.centroid.z;
      const { gx, gz } = elevation.worldToGrid(cx, cz);
      const h = elevation.sample(gx, gz);
      if (h < seaLevel) return false;
    }
    return true;
  },
};

/**
 * V_noBuildingOverlaps (T1): No two building footprints overlap.
 * Uses bounding box prefilter, then point-in-polygon for overlapping boxes.
 */
export const V_noBuildingOverlaps = {
  name: 'V_noBuildingOverlaps',
  tier: 1,
  fn(cityLayers) {
    const buildings = cityLayers.getData('buildings');
    if (!buildings || buildings.length < 2) return true;

    // Precompute bounding boxes
    const bboxes = buildings.map(b => bbox(b.footprint));

    for (let i = 0; i < buildings.length; i++) {
      for (let j = i + 1; j < buildings.length; j++) {
        if (!bboxOverlap(bboxes[i], bboxes[j])) continue;
        if (polygonsOverlap(buildings[i].footprint, buildings[j].footprint)) return false;
      }
    }
    return true;
  },
};

/**
 * V_roadGraphConnected (T1): roadGraph.isConnected() is true.
 */
export const V_roadGraphConnected = {
  name: 'V_roadGraphConnected',
  tier: 1,
  fn(cityLayers) {
    const roadGraph = cityLayers.getData('roadGraph');
    if (!roadGraph) return true;
    return roadGraph.isConnected();
  },
};

/**
 * V_buildingsHaveRoadAccess (T1): Every building centroid within threshold distance of a road edge.
 * Threshold = 5 * cellSize.
 */
export const V_buildingsHaveRoadAccess = {
  name: 'V_buildingsHaveRoadAccess',
  tier: 1,
  fn(cityLayers) {
    const buildings = cityLayers.getData('buildings');
    const roadGraph = cityLayers.getData('roadGraph');
    const params = cityLayers.getData('params');
    if (!buildings || !roadGraph || !params) return true;
    if (buildings.length === 0 || roadGraph.edges.size === 0) return true;

    const threshold = 5 * (params.cellSize ?? 1);

    for (const b of buildings) {
      const dist = pointToAnyRoadDist(b.centroid.x, b.centroid.z, roadGraph);
      if (dist > threshold) return false;
    }
    return true;
  },
};

// ============================================================
// Tier 2 validators (scored 0-1)
// ============================================================

/**
 * S_deadEndFraction (T2): dead-end nodes / total nodes.
 * Score: 1.0 if fraction < 0.05, 0 if > 0.3, linear between.
 */
export const S_deadEndFraction = {
  name: 'S_deadEndFraction',
  tier: 2,
  fn(cityLayers) {
    const roadGraph = cityLayers.getData('roadGraph');
    if (!roadGraph || roadGraph.nodes.size === 0) return 0.5;

    const deadEnds = roadGraph.deadEnds().length;
    const total = roadGraph.nodes.size;
    const fraction = deadEnds / total;

    if (fraction < 0.05) return 1.0;
    if (fraction > 0.3) return 0.0;
    return (0.3 - fraction) / (0.3 - 0.05);
  },
};

/**
 * S_plotFrontageRate (T2): Fraction of plots whose centroid is within 3*cellSize of any road edge.
 * Score = that fraction.
 */
export const S_plotFrontageRate = {
  name: 'S_plotFrontageRate',
  tier: 2,
  fn(cityLayers) {
    const plots = cityLayers.getData('plots');
    const roadGraph = cityLayers.getData('roadGraph');
    const params = cityLayers.getData('params');
    if (!plots || !roadGraph || !params) return 0.5;
    if (plots.length === 0) return 0.5;

    const threshold = 3 * (params.cellSize ?? 1);
    let withFrontage = 0;

    for (const plot of plots) {
      const dist = pointToAnyRoadDist(plot.centroid.x, plot.centroid.z, roadGraph);
      if (dist <= threshold) withFrontage++;
    }

    return withFrontage / plots.length;
  },
};

/**
 * S_densityBuildingCorrelation (T2): Split city into quadrants.
 * For each, compute avg density and building count per area.
 * Score based on correlation (high density quadrant should have more buildings per area).
 */
export const S_densityBuildingCorrelation = {
  name: 'S_densityBuildingCorrelation',
  tier: 2,
  fn(cityLayers) {
    const buildings = cityLayers.getData('buildings');
    const density = cityLayers.getGrid('density');
    const params = cityLayers.getData('params');
    if (!buildings || !density || !params) return 0.5;
    if (buildings.length === 0) return 0.5;

    const w = params.width ?? density.width;
    const h = params.height ?? density.height;
    const cellSize = params.cellSize ?? 1;
    const halfW = (w * cellSize) / 2;
    const halfH = (h * cellSize) / 2;

    // Quadrant stats: [topLeft, topRight, bottomLeft, bottomRight]
    const quadrants = [
      { densitySum: 0, densityCount: 0, buildingCount: 0 },
      { densitySum: 0, densityCount: 0, buildingCount: 0 },
      { densitySum: 0, densityCount: 0, buildingCount: 0 },
      { densitySum: 0, densityCount: 0, buildingCount: 0 },
    ];

    // Accumulate density per quadrant
    density.forEach((gx, gz, val) => {
      const qi = (gx < density.width / 2 ? 0 : 1) + (gz < density.height / 2 ? 0 : 2);
      quadrants[qi].densitySum += val;
      quadrants[qi].densityCount++;
    });

    // Count buildings per quadrant
    for (const b of buildings) {
      const qi = (b.centroid.x < halfW ? 0 : 1) + (b.centroid.z < halfH ? 0 : 2);
      quadrants[qi].buildingCount++;
    }

    // Compute avg density and building density per quadrant
    const qData = quadrants.map(q => ({
      avgDensity: q.densityCount > 0 ? q.densitySum / q.densityCount : 0,
      buildingDensity: q.buildingCount,
    }));

    // Simple correlation check: rank correlation
    // Sort by density, check if building count follows same order
    const sorted = qData.map((q, i) => ({ ...q, i })).sort((a, b) => a.avgDensity - b.avgDensity);

    let concordant = 0;
    let total = 0;
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        total++;
        // Density is already sorted ascending; check if building density also ascending
        if (sorted[j].buildingDensity >= sorted[i].buildingDensity) concordant++;
      }
    }

    return total > 0 ? concordant / total : 0.5;
  },
};

/**
 * S_hierarchyRatios (T2): Compute total road length by hierarchy.
 * Target: ~15% arterial, ~25% collector, ~60% local.
 * Score based on how close to targets.
 */
export const S_hierarchyRatios = {
  name: 'S_hierarchyRatios',
  tier: 2,
  fn(cityLayers) {
    const roadGraph = cityLayers.getData('roadGraph');
    if (!roadGraph || roadGraph.edges.size === 0) return 0.5;

    const lengths = { arterial: 0, collector: 0, local: 0 };
    let totalLength = 0;

    for (const [edgeId, edge] of roadGraph.edges) {
      const polyline = roadGraph.edgePolyline(edgeId);
      const len = polylineLength(polyline);
      const h = edge.hierarchy || 'local';
      if (h in lengths) lengths[h] += len;
      else lengths.local += len;
      totalLength += len;
    }

    if (totalLength === 0) return 0.5;

    const targets = { arterial: 0.15, collector: 0.25, local: 0.60 };
    const actual = {
      arterial: lengths.arterial / totalLength,
      collector: lengths.collector / totalLength,
      local: lengths.local / totalLength,
    };

    // Score: average of per-category closeness
    let score = 0;
    for (const key of ['arterial', 'collector', 'local']) {
      const diff = Math.abs(actual[key] - targets[key]);
      // Perfect = 0 diff = 1.0 score; 0.3 diff = 0.0 score
      score += Math.max(0, 1 - diff / 0.3);
    }

    return score / 3;
  },
};

/**
 * S_blockCompactness (T2): Use graph.faces() to get blocks.
 * For each block, compute isoperimetric ratio = 4*PI*area / perimeter^2.
 * Average across blocks. Score = average ratio (1.0 = perfect circle).
 */
export const S_blockCompactness = {
  name: 'S_blockCompactness',
  tier: 2,
  fn(cityLayers) {
    const roadGraph = cityLayers.getData('roadGraph');
    if (!roadGraph || roadGraph.edges.size === 0) return 0.5;

    const faceNodeIds = roadGraph.faces();
    if (faceNodeIds.length === 0) return 0.5;

    let totalRatio = 0;
    let validFaces = 0;

    for (const nodeIds of faceNodeIds) {
      // Convert node IDs to polygon coordinates
      const polygon = nodeIds.map(id => {
        const node = roadGraph.getNode(id);
        return { x: node.x, z: node.z };
      });

      const area = Math.abs(polygonArea(polygon));
      const perim = polygonPerimeter(polygon);

      if (perim === 0) continue;

      const ratio = (4 * Math.PI * area) / (perim * perim);
      totalRatio += ratio;
      validFaces++;
    }

    return validFaces > 0 ? totalRatio / validFaces : 0.5;
  },
};

/**
 * S_populationBudgetMatch (T2): If cityLayers has 'population' and 'targetPopulation' data,
 * score = 1 - |actual/target - 1|, clamped 0-1.
 */
export const S_populationBudgetMatch = {
  name: 'S_populationBudgetMatch',
  tier: 2,
  fn(cityLayers) {
    const population = cityLayers.getData('population');
    const targetPopulation = cityLayers.getData('targetPopulation');
    if (population == null || targetPopulation == null || targetPopulation === 0) return 0.5;

    const ratio = population / targetPopulation;
    return Math.max(0, Math.min(1, 1 - Math.abs(ratio - 1)));
  },
};

// ============================================================
// Tier 3 validators (quality 0-1)
// ============================================================

/**
 * Q_frontageContinuity (T3): For arterial edges, check how much of their length has
 * buildings within 3*cellSize. Score = fraction of total arterial length that's covered.
 */
export const Q_frontageContinuity = {
  name: 'Q_frontageContinuity',
  tier: 3,
  fn(cityLayers) {
    const roadGraph = cityLayers.getData('roadGraph');
    const buildings = cityLayers.getData('buildings');
    const params = cityLayers.getData('params');
    if (!roadGraph || !buildings || !params) return 0.5;

    const cellSize = params.cellSize ?? 1;
    const threshold = 3 * cellSize;

    let totalArterialLength = 0;
    let coveredLength = 0;

    for (const [edgeId, edge] of roadGraph.edges) {
      if (edge.hierarchy !== 'arterial') continue;

      const polyline = roadGraph.edgePolyline(edgeId);

      // Sample points along the arterial edge
      for (let i = 0; i < polyline.length - 1; i++) {
        const segLen = distance2D(polyline[i].x, polyline[i].z, polyline[i + 1].x, polyline[i + 1].z);
        totalArterialLength += segLen;

        // Check midpoint of segment for building coverage
        const mx = (polyline[i].x + polyline[i + 1].x) / 2;
        const mz = (polyline[i].z + polyline[i + 1].z) / 2;

        let hasCoverage = false;
        for (const b of buildings) {
          const dist = distance2D(mx, mz, b.centroid.x, b.centroid.z);
          if (dist <= threshold) {
            hasCoverage = true;
            break;
          }
        }

        if (hasCoverage) coveredLength += segLen;
      }
    }

    if (totalArterialLength === 0) return 0.5;
    return coveredLength / totalArterialLength;
  },
};

/**
 * Q_junctionAngles (T3): For nodes with degree >= 3, check angles between adjacent edges.
 * Score = fraction of junctions where all angles > 30 degrees.
 */
export const Q_junctionAngles = {
  name: 'Q_junctionAngles',
  tier: 3,
  fn(cityLayers) {
    const roadGraph = cityLayers.getData('roadGraph');
    if (!roadGraph || roadGraph.nodes.size === 0) return 0.5;

    let totalJunctions = 0;
    let goodJunctions = 0;

    for (const [nodeId, node] of roadGraph.nodes) {
      const deg = roadGraph.degree(nodeId);
      if (deg < 3) continue;

      totalJunctions++;

      // Compute angles of each incident edge from this node
      const neighbors = roadGraph.neighbors(nodeId);
      const angles = [];

      for (const nId of neighbors) {
        const neighbor = roadGraph.getNode(nId);
        const angle = Math.atan2(neighbor.x - node.x, neighbor.z - node.z);
        angles.push(angle);
      }

      angles.sort((a, b) => a - b);

      // Check gaps between adjacent sorted angles
      let allGood = true;
      const minAngleRad = (30 * Math.PI) / 180;

      for (let i = 0; i < angles.length; i++) {
        const next = (i + 1) % angles.length;
        let gap = angles[next] - angles[i];
        if (gap < 0) gap += 2 * Math.PI;
        if (gap < minAngleRad) {
          allGood = false;
          break;
        }
      }

      if (allGood) goodJunctions++;
    }

    if (totalJunctions === 0) return 0.5;
    return goodJunctions / totalJunctions;
  },
};

/**
 * Q_heightGradient (T3): Check if building heights correlate with density at their locations.
 * Score based on correlation.
 */
export const Q_heightGradient = {
  name: 'Q_heightGradient',
  tier: 3,
  fn(cityLayers) {
    const buildings = cityLayers.getData('buildings');
    const density = cityLayers.getGrid('density');
    if (!buildings || !density) return 0.5;
    if (buildings.length === 0) return 0.5;

    // Collect pairs of (density, building height)
    const pairs = [];
    for (const b of buildings) {
      const { gx, gz } = density.worldToGrid(b.centroid.x, b.centroid.z);
      const d = density.sample(gx, gz);
      pairs.push({ density: d, height: b.height || 1 });
    }

    if (pairs.length < 2) return 0.5;

    // Compute Pearson correlation
    const n = pairs.length;
    let sumD = 0, sumH = 0, sumDD = 0, sumHH = 0, sumDH = 0;
    for (const p of pairs) {
      sumD += p.density;
      sumH += p.height;
      sumDD += p.density * p.density;
      sumHH += p.height * p.height;
      sumDH += p.density * p.height;
    }

    const numerator = n * sumDH - sumD * sumH;
    const denominator = Math.sqrt((n * sumDD - sumD * sumD) * (n * sumHH - sumH * sumH));

    if (denominator === 0) return 0.5;

    const r = numerator / denominator;
    // r ranges from -1 to 1. Positive correlation is good.
    // Score: map r from [-1,1] to [0,1], biased toward positive
    return Math.max(0, Math.min(1, (r + 1) / 2));
  },
};

/**
 * Q_amenityCatchment (T3): Fraction of residential buildings within 400m (40*cellSize) of an amenity park.
 * If no parks or no residential buildings, return 0.5.
 */
export const Q_amenityCatchment = {
  name: 'Q_amenityCatchment',
  tier: 3,
  fn(cityLayers) {
    const buildings = cityLayers.getData('buildings');
    const amenities = cityLayers.getData('amenities');
    const params = cityLayers.getData('params');
    if (!buildings || !amenities || !params) return 0.5;

    const cellSize = params.cellSize ?? 1;
    const threshold = 40 * cellSize;

    const parks = amenities.filter(a => a.type === 'park');
    const residential = buildings.filter(b => ['terrace', 'detached', 'semi-detached'].includes(b.type));

    if (parks.length === 0 || residential.length === 0) return 0.5;

    let withinCatchment = 0;
    for (const b of residential) {
      let nearPark = false;
      for (const park of parks) {
        const px = park.centroid?.x ?? park.x ?? 0;
        const pz = park.centroid?.z ?? park.z ?? 0;
        const dist = distance2D(b.centroid.x, b.centroid.z, px, pz);
        if (dist <= threshold) {
          nearPark = true;
          break;
        }
      }
      if (nearPark) withinCatchment++;
    }

    return withinCatchment / residential.length;
  },
};

// ============================================================
// Collection and runner
// ============================================================

/**
 * Get all city validators.
 */
export function getCityValidators() {
  return [
    V_noRoadsInWater,
    V_noBuildingsInWater,
    V_noBuildingOverlaps,
    V_roadGraphConnected,
    V_buildingsHaveRoadAccess,
    S_deadEndFraction,
    S_plotFrontageRate,
    S_densityBuildingCorrelation,
    S_hierarchyRatios,
    S_blockCompactness,
    S_populationBudgetMatch,
    Q_frontageContinuity,
    Q_junctionAngles,
    Q_heightGradient,
    Q_amenityCatchment,
  ];
}

/**
 * Run validators against city layers and compute scores.
 */
export function runValidators(cityLayers, validators) {
  const results = { tier1: [], tier2: [], tier3: [], valid: true, structural: 0, quality: 0, overall: 0 };

  for (const v of validators) {
    const value = v.fn(cityLayers);
    const entry = { name: v.name, tier: v.tier, value };

    if (v.tier === 1) {
      results.tier1.push(entry);
      if (!value) results.valid = false;
    } else if (v.tier === 2) {
      results.tier2.push(entry);
    } else {
      results.tier3.push(entry);
    }
  }

  if (results.tier2.length > 0) {
    results.structural = results.tier2.reduce((s, e) => s + e.value, 0) / results.tier2.length;
  }
  if (results.tier3.length > 0) {
    results.quality = results.tier3.reduce((s, e) => s + e.value, 0) / results.tier3.length;
  }
  results.overall = results.valid ? results.structural * 0.6 + results.quality * 0.4 : 0;

  return results;
}
