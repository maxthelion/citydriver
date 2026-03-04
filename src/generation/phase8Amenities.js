/**
 * Phase 8: Amenity & Service Placement
 *
 * Places schools, healthcare, parks, and other amenities based on
 * population catchments:
 *   - Population calculation from density field
 *   - Catchment-based amenity placement
 *   - Betweenness centrality (Brandes algorithm) on road graph
 *   - Top 15-20% centrality edges → commercial frontage rezoning
 *   - Commercial clusters at density peaks
 */

import { clamp, distance2D } from '../core/math.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Amenity types with catchment populations and placement preferences.
 */
export const AMENITY_TYPES = [
  { type: 'park', catchmentPop: 0, catchmentRadius: 400, roadPref: 'any', siteSize: 1 },
  { type: 'primary_school', catchmentPop: 7500, catchmentRadius: 0, roadPref: 'collector', siteSize: 2 },
  { type: 'secondary_school', catchmentPop: 22000, catchmentRadius: 0, roadPref: 'primary', siteSize: 3 },
  { type: 'clinic', catchmentPop: 7500, catchmentRadius: 0, roadPref: 'collector', siteSize: 1 },
  { type: 'hospital', catchmentPop: 150000, catchmentRadius: 0, roadPref: 'primary', siteSize: 4 },
  { type: 'fire_station', catchmentPop: 20000, catchmentRadius: 0, roadPref: 'primary', siteSize: 2 },
  { type: 'place_of_worship', catchmentPop: 5000, catchmentRadius: 0, roadPref: 'any', siteSize: 1 },
];

/** Fraction of top-centrality edges to rezone as commercial */
const CENTRALITY_COMMERCIAL_FRACTION = 0.18;

// ---------------------------------------------------------------------------
// Population calculation
// ---------------------------------------------------------------------------

/**
 * Calculate total population from density field.
 *
 * @param {Object} densityField
 * @returns {number} estimated population
 */
function calculatePopulation(densityField) {
  const { grid, cellSize, gridWidth, gridHeight, scaleFactor } = densityField;
  const cellArea = cellSize * cellSize;
  let sum = 0;
  for (let i = 0; i < grid.length; i++) {
    sum += grid[i];
  }
  return sum * cellArea * scaleFactor;
}

// ---------------------------------------------------------------------------
// Betweenness centrality (Brandes algorithm)
// ---------------------------------------------------------------------------

/**
 * Compute betweenness centrality for each edge in the road graph.
 * Uses Brandes algorithm adapted for edges.
 *
 * @param {Map} nodes - road network nodes
 * @param {Array} edges - road network edges
 * @returns {Map<number, number>} edgeId → centrality score
 */
export function computeEdgeBetweenness(nodes, edges) {
  const centrality = new Map();
  for (const e of edges) {
    centrality.set(e.id, 0);
  }

  if (nodes.size === 0 || edges.length === 0) return centrality;

  // Build adjacency list
  const adj = new Map();
  for (const node of nodes.values()) {
    adj.set(node.id, []);
  }

  for (const edge of edges) {
    if (!adj.has(edge.from) || !adj.has(edge.to)) continue;

    // Edge weight = polyline length
    let len = 0;
    if (edge.points && edge.points.length >= 2) {
      for (let i = 0; i < edge.points.length - 1; i++) {
        len += distance2D(edge.points[i].x, edge.points[i].z,
                         edge.points[i + 1].x, edge.points[i + 1].z);
      }
    }
    if (len === 0) len = 1;

    adj.get(edge.from).push({ to: edge.to, edgeId: edge.id, weight: len });
    adj.get(edge.to).push({ to: edge.from, edgeId: edge.id, weight: len });
  }

  // Sample a subset of nodes as sources (for performance)
  const nodeIds = [...nodes.keys()];
  const maxSources = Math.min(nodeIds.length, 50);
  const step = Math.max(1, Math.floor(nodeIds.length / maxSources));
  const sources = [];
  for (let i = 0; i < nodeIds.length && sources.length < maxSources; i += step) {
    sources.push(nodeIds[i]);
  }

  // Brandes algorithm for each source
  for (const s of sources) {
    // Single-source shortest paths (Dijkstra)
    const dist = new Map();
    const sigma = new Map(); // number of shortest paths
    const pred = new Map();  // predecessor lists (with edge IDs)
    const stack = [];

    for (const nId of nodeIds) {
      dist.set(nId, Infinity);
      sigma.set(nId, 0);
      pred.set(nId, []);
    }

    dist.set(s, 0);
    sigma.set(s, 1);

    // Priority queue (simple sorted array for moderate graph sizes)
    const pq = [{ node: s, dist: 0 }];

    while (pq.length > 0) {
      // Find minimum
      let minIdx = 0;
      for (let i = 1; i < pq.length; i++) {
        if (pq[i].dist < pq[minIdx].dist) minIdx = i;
      }
      const { node: v, dist: dv } = pq[minIdx];
      pq.splice(minIdx, 1);

      if (dv > dist.get(v)) continue;
      stack.push(v);

      const neighbors = adj.get(v);
      if (!neighbors) continue;

      for (const { to: w, edgeId, weight } of neighbors) {
        const newDist = dv + weight;
        if (newDist < dist.get(w)) {
          dist.set(w, newDist);
          sigma.set(w, sigma.get(v));
          pred.set(w, [{ node: v, edgeId }]);
          pq.push({ node: w, dist: newDist });
        } else if (Math.abs(newDist - dist.get(w)) < 1e-6) {
          sigma.set(w, sigma.get(w) + sigma.get(v));
          pred.get(w).push({ node: v, edgeId });
        }
      }
    }

    // Back-propagation
    const delta = new Map();
    for (const nId of nodeIds) {
      delta.set(nId, 0);
    }

    while (stack.length > 0) {
      const w = stack.pop();
      for (const { node: v, edgeId } of pred.get(w)) {
        const contribution = (sigma.get(v) / sigma.get(w)) * (1 + delta.get(w));
        delta.set(v, delta.get(v) + contribution);

        // Add to edge centrality
        centrality.set(edgeId, (centrality.get(edgeId) || 0) + contribution);
      }
    }
  }

  // Normalize by number of sources (approximate)
  const normFactor = nodeIds.length / sources.length;
  for (const [edgeId, val] of centrality) {
    centrality.set(edgeId, val * normFactor);
  }

  return centrality;
}

// ---------------------------------------------------------------------------
// Amenity placement
// ---------------------------------------------------------------------------

/**
 * Place amenities based on catchment rules.
 *
 * @param {Array} plots
 * @param {Array} blocks
 * @param {Object} densityField
 * @param {Object} roadNetwork
 * @param {number} population
 * @returns {Array<Object>} amenity placements
 */
function placeAmenities(plots, blocks, densityField, roadNetwork, population) {
  const amenities = [];
  const usedPlotIds = new Set();

  for (const amenityType of AMENITY_TYPES) {
    // Determine how many of this amenity we need
    let count;
    if (amenityType.catchmentPop > 0) {
      count = Math.max(0, Math.floor(population / amenityType.catchmentPop));
    } else if (amenityType.catchmentRadius > 0) {
      // Parks: one per catchment radius in residential areas
      const residentialBlocks = blocks.filter(b =>
        b.districtCharacter === 'dense_residential' ||
        b.districtCharacter === 'suburban_residential' ||
        b.districtCharacter === 'mixed_use'
      );
      // Rough estimate: number of non-overlapping circles
      let totalResArea = 0;
      for (const b of residentialBlocks) totalResArea += b.area;
      const circleArea = Math.PI * amenityType.catchmentRadius * amenityType.catchmentRadius;
      count = Math.max(0, Math.floor(totalResArea / circleArea));
    } else {
      count = 0;
    }

    if (count === 0) continue;

    // Find suitable plots
    const candidates = [];
    for (const plot of plots) {
      if (usedPlotIds.has(plot.id)) continue;
      if (plot.districtCharacter === 'parkland') continue;

      // Road preference check
      let meetsRoadPref = amenityType.roadPref === 'any';
      if (!meetsRoadPref) {
        // Check if plot is near a road of the preferred hierarchy
        const frontMid = {
          x: (plot.frontEdge[0].x + plot.frontEdge[1].x) / 2,
          z: (plot.frontEdge[0].z + plot.frontEdge[1].z) / 2,
        };
        for (const edge of roadNetwork.edges) {
          if (!edge.points || edge.points.length < 2) continue;
          const h = edge.hierarchy;
          if (amenityType.roadPref === 'primary' && (h === 'primary' || h === 'secondary')) {
            for (const pt of edge.points) {
              if (distance2D(frontMid.x, frontMid.z, pt.x, pt.z) < 40) {
                meetsRoadPref = true;
                break;
              }
            }
          } else if (amenityType.roadPref === 'collector' && (h === 'primary' || h === 'secondary' || h === 'collector')) {
            for (const pt of edge.points) {
              if (distance2D(frontMid.x, frontMid.z, pt.x, pt.z) < 40) {
                meetsRoadPref = true;
                break;
              }
            }
          }
          if (meetsRoadPref) break;
        }
      }

      if (meetsRoadPref) {
        candidates.push(plot);
      }
    }

    // Place amenities spread out using greedy farthest-point selection
    const placed = [];
    for (let i = 0; i < Math.min(count, candidates.length); i++) {
      let bestPlot = null;
      let bestMinDist = -1;

      for (const plot of candidates) {
        if (usedPlotIds.has(plot.id)) continue;

        const frontMid = {
          x: (plot.frontEdge[0].x + plot.frontEdge[1].x) / 2,
          z: (plot.frontEdge[0].z + plot.frontEdge[1].z) / 2,
        };

        // Minimum distance to already-placed amenities of this type
        let minDist = Infinity;
        for (const p of placed) {
          const d = distance2D(frontMid.x, frontMid.z, p.x, p.z);
          if (d < minDist) minDist = d;
        }

        if (placed.length === 0) {
          // First placement: prefer high density
          minDist = plot.density || 0.5;
        }

        if (minDist > bestMinDist) {
          bestMinDist = minDist;
          bestPlot = plot;
        }
      }

      if (bestPlot) {
        const frontMid = {
          x: (bestPlot.frontEdge[0].x + bestPlot.frontEdge[1].x) / 2,
          z: (bestPlot.frontEdge[0].z + bestPlot.frontEdge[1].z) / 2,
        };

        amenities.push({
          type: amenityType.type,
          plotId: bestPlot.id,
          x: frontMid.x,
          z: frontMid.z,
          blockId: bestPlot.blockId,
          districtId: bestPlot.districtId,
        });

        usedPlotIds.add(bestPlot.id);
        placed.push(frontMid);
      }
    }
  }

  return amenities;
}

// ---------------------------------------------------------------------------
// Commercial frontage rezoning
// ---------------------------------------------------------------------------

/**
 * Rezone high-centrality edges' frontage plots to commercial/mixed_use.
 *
 * @param {Map<number, number>} edgeCentrality
 * @param {Array} edges
 * @param {Array} plots
 * @param {Array} buildings
 */
function rezoneHighCentrality(edgeCentrality, edges, plots, buildings) {
  if (edgeCentrality.size === 0) return;

  // Find threshold for top CENTRALITY_COMMERCIAL_FRACTION
  const values = [...edgeCentrality.values()].filter(v => v > 0);
  if (values.length === 0) return;

  values.sort((a, b) => b - a);
  const thresholdIdx = Math.floor(values.length * CENTRALITY_COMMERCIAL_FRACTION);
  const threshold = values[Math.min(thresholdIdx, values.length - 1)];

  // Collect high-centrality edge IDs
  const highCentralityEdges = new Set();
  for (const [edgeId, centrality] of edgeCentrality) {
    if (centrality >= threshold) {
      highCentralityEdges.add(edgeId);
    }
  }

  // Find plots along high-centrality edges and rezone to mixed_use
  for (const plot of plots) {
    if (plot.districtCharacter === 'commercial_core') continue;
    if (plot.districtCharacter === 'industrial_docks') continue;
    if (plot.districtCharacter === 'parkland') continue;

    const frontMid = {
      x: (plot.frontEdge[0].x + plot.frontEdge[1].x) / 2,
      z: (plot.frontEdge[0].z + plot.frontEdge[1].z) / 2,
    };

    for (const edge of edges) {
      if (!highCentralityEdges.has(edge.id)) continue;
      if (!edge.points || edge.points.length < 2) continue;

      for (const pt of edge.points) {
        if (distance2D(frontMid.x, frontMid.z, pt.x, pt.z) < 20) {
          plot.districtCharacter = 'mixed_use';
          plot.style = 'mixed';

          // Update corresponding building
          const building = buildings.find(b => b.plotId === plot.id);
          if (building) {
            building.districtCharacter = 'mixed_use';
            building.style = 'mixed';
          }
          break;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 8 entry point
// ---------------------------------------------------------------------------

/**
 * Run Phase 8: Amenity & Service Placement.
 *
 * @param {Array} plots - from Phase 6
 * @param {Array} blocks - from Phase 5
 * @param {Array} buildings - from Phase 7
 * @param {Object} roadNetwork
 * @param {Object} densityField
 * @param {Object} rng
 * @returns {Object} { amenities, edgeCentrality }
 */
export function runPhase8(plots, blocks, buildings, roadNetwork, densityField, rng) {
  // 1. Calculate population
  const population = calculatePopulation(densityField);

  // 2. Compute betweenness centrality
  const edgeCentrality = computeEdgeBetweenness(roadNetwork.nodes, roadNetwork.edges);

  // 3. Rezone high-centrality edges to commercial
  rezoneHighCentrality(edgeCentrality, roadNetwork.edges, plots, buildings);

  // 4. Place amenities
  const amenities = placeAmenities(plots, blocks, densityField, roadNetwork, population);

  return { amenities, edgeCentrality, population };
}
