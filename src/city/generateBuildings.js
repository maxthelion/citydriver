/**
 * B10. Building placement.
 * Footprints oriented to frontage, density-driven skip rates, directional
 * setbacks, block-level height coherence, population accounting, and
 * material variation from geology.
 */

import { polygonArea, polygonCentroid } from '../core/math.js';
import { getRockInfo } from '../regional/generateGeology.js';
import { DISTRICT } from './generateDistricts.js';

/**
 * Generate buildings from plots.
 *
 * @param {import('../core/LayerStack.js').LayerStack} cityLayers
 * @param {Array} plots
 * @param {import('../core/rng.js').SeededRandom} rng
 * @returns {Array<{footprint, height, groundHeight, floors, material, materialShade, type, centroid, district, people}>}
 */
export function generateBuildings(cityLayers, plots, rng) {
  const elevation = cityLayers.getGrid('elevation');
  const rockType = cityLayers.getGrid('rockType');
  const density = cityLayers.getGrid('density');
  const params = cityLayers.getData('params');
  const cs = params.cellSize;
  const targetPopulation = cityLayers.getData('targetPopulation') || Infinity;

  const buildings = [];
  let totalPopulation = 0;

  for (const plot of plots) {
    if (!plot.vertices || plot.vertices.length < 3) continue;
    if (totalPopulation >= targetPopulation) break;

    const area = plot.area || Math.abs(polygonArea(plot.vertices));
    if (area < cs * cs * 0.3) continue;

    const centroid = plot.centroid || polygonCentroid(plot.vertices);
    const gx = Math.round(centroid.x / cs);
    const gz = Math.round(centroid.z / cs);

    // Get terrain height at building location
    const groundHeight = elevation ? elevation.get(gx, gz) : 0;
    if (groundHeight < (params.seaLevel || 0)) continue; // No buildings in water

    const d = plot.density ?? (density ? density.get(gx, gz) : 0.3);
    const district = plot.district ?? 0;

    // ---- Building type from district/plot ----
    let type, maxFloors;

    // ---- Institutional plot handling ----
    if (plot.isInstitutional) {
      if (plot.institutionType === 'park') continue; // Parks get no buildings
      // Other institutions get a single building with appropriate type
      type = plot.institutionType === 'church' ? 'church'
        : plot.institutionType === 'hospital' ? 'hospital'
        : plot.institutionType === 'school' ? 'school'
        : plot.institutionType === 'market' ? 'market_hall'
        : 'civic';
      maxFloors = plot.institutionType === 'church' ? 3
        : plot.institutionType === 'hospital' ? 4
        : 2;
    } else {
      // ---- Density-driven skip ----
      let skipChance;
      if (d < 0.3) skipChance = 0.3;       // Suburban: skip 30%
      else if (d < 0.7) skipChance = 0.05;  // Urban: skip 5%
      else skipChance = 0;                   // Core: skip 0%
      if (rng.next() < skipChance) continue;

      // ---- Building type from district ----
      switch (district) {
        case DISTRICT.COMMERCIAL:
          type = 'commercial';
          maxFloors = 5;
          break;
        case DISTRICT.DENSE_RESIDENTIAL:
          type = 'terrace';
          maxFloors = 3;
          break;
        case DISTRICT.SUBURBAN:
          type = rng.next() > 0.5 ? 'detached' : 'semi-detached';
          maxFloors = 2;
          break;
        case DISTRICT.INDUSTRIAL:
          type = 'warehouse';
          maxFloors = 2;
          break;
        case DISTRICT.PARKLAND:
          continue; // No buildings in parkland plots
        default:
          type = 'detached';
          maxFloors = 2;
      }
    }

    // ---- Height with block-level coherence ----
    const blockSeed = plot.frontageEdgeId ?? 0;
    const blockNoise = ((blockSeed * 1337 + 7) % 100) / 100; // 0-1 deterministic noise
    const baseFloors = Math.max(1, Math.round(d * maxFloors));
    let floors;
    if (type === 'terrace') {
      // Same height for whole terrace row (same frontage edge)
      floors = baseFloors;
    } else {
      floors = Math.max(1, baseFloors + Math.round((blockNoise - 0.5) * 2));
    }
    const floorHeight = 3; // metres per floor
    const height = floors * floorHeight;

    // ---- Material from geology with variation ----
    let material = 'brick'; // default
    if (rockType) {
      const rockId = rockType.get(gx, gz);
      const rockInfo = getRockInfo(rockId);
      material = rockInfo.material;
    }
    const materialShade = rng.range(-0.15, 0.15); // ±15% brightness variation

    // ---- Directional setbacks ----
    // Prefer plot-level setback data from frontage-first generation
    const setbacks = plot.setback !== undefined
      ? getSetbacksFromPlot(plot, type)
      : getSetbacks(type, cs);
    const footprint = applyDirectionalSetbacks(
      plot.vertices, plot.frontageDirection, setbacks,
    );
    if (footprint.length < 3) continue;

    const footprintArea = Math.abs(polygonArea(footprint));
    if (footprintArea < cs * cs * 0.2) continue;

    // ---- Population accounting ----
    let people = 0;
    if (type === 'terrace' || type === 'detached' || type === 'semi-detached') {
      people = floors * footprintArea * 0.04; // 0.04 people per m² per floor
    }
    totalPopulation += people;

    buildings.push({
      footprint,
      height,
      groundHeight,
      floors,
      material,
      materialShade,
      type,
      centroid,
      district,
      people,
    });
  }

  cityLayers.setData('population', totalPopulation);
  return buildings;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive setbacks from the plot's own frontage-first data.
 * Front setback and rear garden come from the plot config.
 * Side gaps are derived from buildingCoverage.
 */
function getSetbacksFromPlot(plot, type) {
  const front = plot.setback || 0;
  const rear = plot.rearGarden || (plot.depth * 0.2);
  const frontageWidth = plot.frontageWidth || 10;
  const coverage = plot.buildingCoverage || 0.5;

  // Side gap: distribute remaining width evenly
  const buildingWidth = frontageWidth * coverage;
  const totalSideGap = Math.max(0, frontageWidth - buildingWidth);

  let sideLeft, sideRight;
  if (type === 'terrace' || type === 'commercial') {
    // Party walls: no side gaps
    sideLeft = 0;
    sideRight = 0;
  } else if (type === 'semi-detached') {
    // One shared wall, one gap
    sideLeft = totalSideGap;
    sideRight = 0;
  } else {
    // Detached: gaps on both sides
    sideLeft = totalSideGap / 2;
    sideRight = totalSideGap / 2;
  }

  return { front, rear, sideLeft, sideRight };
}

/**
 * Return directional setback distances for a given building type.
 *
 * @param {string} type  - building type name
 * @param {number} cs    - cell size
 * @returns {{ front: number, rear: number, sideLeft: number, sideRight: number }}
 */
function getSetbacks(type, cs) {
  switch (type) {
    case 'terrace':
      return { front: 0, rear: cs * 0.3, sideLeft: 0, sideRight: 0 };
    case 'semi-detached':
      return { front: cs * 0.3, rear: cs * 0.3, sideLeft: cs * 0.2, sideRight: 0 };
    case 'detached':
      return { front: cs * 0.4, rear: cs * 0.4, sideLeft: cs * 0.3, sideRight: cs * 0.3 };
    case 'commercial':
      return { front: 0, rear: cs * 0.2, sideLeft: 0, sideRight: 0 };
    case 'warehouse':
      return { front: cs * 0.2, rear: cs * 0.3, sideLeft: cs * 0.2, sideRight: cs * 0.2 };
    default:
      return { front: cs * 0.2, rear: cs * 0.2, sideLeft: cs * 0.15, sideRight: cs * 0.15 };
  }
}

/**
 * Apply directional setbacks to a plot's vertices.
 *
 * vertices = [f0, f1, r1, r0] where f = front (road side), r = rear.
 * frontageDir = unit vector along the road (f0 -> f1 direction).
 *
 * When the plot has exactly 4 oriented corners we move each corner
 * independently; otherwise we fall back to a simple centroid inset.
 *
 * @param {Array<{x,z}>} vertices
 * @param {{x,z}|undefined} frontageDir
 * @param {{ front: number, rear: number, sideLeft: number, sideRight: number }} setbacks
 * @returns {Array<{x,z}>}
 */
function applyDirectionalSetbacks(vertices, frontageDir, setbacks) {
  if (vertices.length !== 4 || !frontageDir) {
    // Fallback: simple centroid inset
    return insetPolygon(vertices, Math.max(setbacks.front, setbacks.sideLeft));
  }

  const fd = frontageDir;

  // Inward direction: from front edge toward rear (f0 -> r0)
  const inward = {
    x: vertices[3].x - vertices[0].x,
    z: vertices[3].z - vertices[0].z,
  };
  const inLen = Math.sqrt(inward.x * inward.x + inward.z * inward.z);
  if (inLen === 0) return insetPolygon(vertices, setbacks.front);
  const inDir = { x: inward.x / inLen, z: inward.z / inLen };

  // Apply setbacks to each corner
  const f0 = {
    x: vertices[0].x + inDir.x * setbacks.front + fd.x * setbacks.sideLeft,
    z: vertices[0].z + inDir.z * setbacks.front + fd.z * setbacks.sideLeft,
  };
  const f1 = {
    x: vertices[1].x + inDir.x * setbacks.front - fd.x * setbacks.sideRight,
    z: vertices[1].z + inDir.z * setbacks.front - fd.z * setbacks.sideRight,
  };
  const r1 = {
    x: vertices[2].x - inDir.x * setbacks.rear - fd.x * setbacks.sideRight,
    z: vertices[2].z - inDir.z * setbacks.rear - fd.z * setbacks.sideRight,
  };
  const r0 = {
    x: vertices[3].x - inDir.x * setbacks.rear + fd.x * setbacks.sideLeft,
    z: vertices[3].z - inDir.z * setbacks.rear + fd.z * setbacks.sideLeft,
  };

  return [f0, f1, r1, r0];
}

/**
 * Inset a polygon toward its centroid by a distance (fallback for non-quad plots).
 *
 * @param {Array<{x,z}>} vertices
 * @param {number} amount
 * @returns {Array<{x,z}>}
 */
function insetPolygon(vertices, amount) {
  if (amount <= 0) return vertices.slice();

  const centroid = polygonCentroid(vertices);
  return vertices.map(v => {
    const dx = v.x - centroid.x;
    const dz = v.z - centroid.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len === 0) return v;
    const factor = Math.max(0, (len - amount) / len);
    return {
      x: centroid.x + dx * factor,
      z: centroid.z + dz * factor,
    };
  });
}
