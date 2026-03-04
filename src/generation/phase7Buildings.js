/**
 * Phase 7: Building Footprint & Massing
 *
 * Places building footprints on plots and determines heights:
 *   - Building type from district character + plot flags
 *   - Density-driven floor count
 *   - Street consistency (terraces match height)
 *   - Landmark rules (hilltop→church, plaza→town hall, bridge→inn, corner→pub)
 *   - Material and roof selection
 *   - Compatible with existing renderer interface
 */

import { clamp, lerp, distance2D, pointToSegmentDist } from '../core/math.js';
import { ZONE } from './phase1Terrain.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FLOOR_HEIGHT_RESIDENTIAL = 3.2;
const FLOOR_HEIGHT_COMMERCIAL = 4.0;
const FLOOR_HEIGHT_INDUSTRIAL = 5.0;

// ---------------------------------------------------------------------------
// Building templates by style
// ---------------------------------------------------------------------------

function templateTerrace(plot, density, rng) {
  const w = plot.frontage - plot.setbacks.side * 2;
  const d = Math.min(plot.depth - plot.setbacks.front - plot.setbacks.rear, 12);
  const floors = clamp(Math.round(lerp(2, 4, density)), 2, 4);
  const h = floors * FLOOR_HEIGHT_RESIDENTIAL;
  return {
    w: Math.max(4, w), d: Math.max(6, d), h, floors,
    roofType: rng.next() < 0.8 ? 'pitched' : 'flat',
    wallMaterial: 'building_brick',
    roofMaterial: 'roof_slate',
  };
}

function templateApartment(plot, density, rng) {
  const w = plot.frontage - plot.setbacks.side * 2;
  const d = Math.min(plot.depth - plot.setbacks.front - plot.setbacks.rear, 18);
  const floors = clamp(Math.round(lerp(3, 6, density)), 3, 6);
  const h = floors * FLOOR_HEIGHT_RESIDENTIAL;
  return {
    w: Math.max(6, w), d: Math.max(8, d), h, floors,
    roofType: rng.next() < 0.6 ? 'mansard' : 'pitched',
    wallMaterial: rng.next() < 0.5 ? 'building_stone' : 'building_white',
    roofMaterial: 'roof_slate',
  };
}

function templateSuburban(plot, density, rng) {
  const w = lerp(8, 12, rng.next());
  const d = lerp(8, 10, rng.next());
  const floors = rng.next() < 0.6 ? 2 : 1;
  const h = floors * FLOOR_HEIGHT_RESIDENTIAL;
  return {
    w, d, h, floors,
    roofType: 'pitched',
    wallMaterial: rng.pick(['building_brick', 'building_white', 'building_stone']),
    roofMaterial: rng.next() < 0.5 ? 'roof_slate' : 'roof_tile',
  };
}

function templateCommercial(plot, density, rng) {
  const w = plot.frontage - plot.setbacks.side * 2;
  const d = Math.min(plot.depth - plot.setbacks.front - plot.setbacks.rear, 25);
  const baseFloors = clamp(Math.round(lerp(2, 5, density)), 2, 5);
  const bonusFloors = Math.round(density * 2);
  const floors = baseFloors + bonusFloors;
  const h = floors * FLOOR_HEIGHT_COMMERCIAL;
  return {
    w: Math.max(6, w), d: Math.max(8, d), h, floors,
    roofType: 'flat',
    wallMaterial: density > 0.7 ? (rng.next() < 0.6 ? 'building_glass' : 'building_concrete') : 'building_stone',
    roofMaterial: 'roof_flat',
  };
}

function templateIndustrial(plot, density, rng) {
  const w = plot.frontage - plot.setbacks.side * 2;
  const d = Math.min(plot.depth - plot.setbacks.front - plot.setbacks.rear, 40);
  const floors = rng.next() < 0.7 ? 1 : 2;
  const h = floors * FLOOR_HEIGHT_INDUSTRIAL;
  return {
    w: Math.max(10, w), d: Math.max(10, d), h, floors,
    roofType: rng.next() < 0.6 ? 'flat' : 'sawtooth',
    wallMaterial: 'building_concrete',
    roofMaterial: 'roof_metal',
  };
}

function templateCivic(plot, density, rng) {
  const w = plot.frontage - plot.setbacks.side * 2;
  const d = Math.min(plot.depth - plot.setbacks.front - plot.setbacks.rear, 30);
  const floors = clamp(Math.round(lerp(2, 4, density)), 2, 4);
  const h = floors * FLOOR_HEIGHT_COMMERCIAL;
  return {
    w: Math.max(8, w), d: Math.max(8, d), h, floors,
    roofType: rng.next() < 0.5 ? 'pitched' : 'flat',
    wallMaterial: 'building_stone',
    roofMaterial: 'roof_slate',
  };
}

function templateMixed(plot, density, rng) {
  const w = plot.frontage - plot.setbacks.side * 2;
  const d = Math.min(plot.depth - plot.setbacks.front - plot.setbacks.rear, 20);
  const floors = clamp(Math.round(lerp(3, 5, density)), 3, 5);
  const h = floors * FLOOR_HEIGHT_COMMERCIAL;
  return {
    w: Math.max(5, w), d: Math.max(8, d), h, floors,
    roofType: rng.next() < 0.4 ? 'mansard' : 'flat',
    wallMaterial: rng.next() < 0.5 ? 'building_stone' : 'building_brick',
    roofMaterial: 'roof_slate',
  };
}

// ---------------------------------------------------------------------------
// Building collision helpers
// ---------------------------------------------------------------------------

/**
 * Get the four corners of an OBB (oriented bounding box) building footprint.
 */
function getBuildingCorners(cx, cz, w, d, rotation) {
  const cosR = Math.cos(rotation);
  const sinR = Math.sin(rotation);
  const hw = w / 2;
  const hd = d / 2;
  return [
    { x: cx + cosR * hw - sinR * hd, z: cz + sinR * hw + cosR * hd },
    { x: cx - cosR * hw - sinR * hd, z: cz - sinR * hw + cosR * hd },
    { x: cx - cosR * hw + sinR * hd, z: cz - sinR * hw - cosR * hd },
    { x: cx + cosR * hw + sinR * hd, z: cz + sinR * hw - cosR * hd },
  ];
}

/**
 * SAT (Separating Axis Theorem) overlap test for two convex polygons.
 * Returns true if they overlap (with 0.5m tolerance).
 */
function cornersOverlap(A, B) {
  const tolerance = 0.5;
  const polys = [A, B];
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const j = (i + 1) % poly.length;
      const edgeX = poly[j].x - poly[i].x;
      const edgeZ = poly[j].z - poly[i].z;
      // Normal axis
      const axisX = -edgeZ;
      const axisZ = edgeX;

      let minA = Infinity, maxA = -Infinity;
      for (const p of A) {
        const proj = p.x * axisX + p.z * axisZ;
        if (proj < minA) minA = proj;
        if (proj > maxA) maxA = proj;
      }
      let minB = Infinity, maxB = -Infinity;
      for (const p of B) {
        const proj = p.x * axisX + p.z * axisZ;
        if (proj < minB) minB = proj;
        if (proj > maxB) maxB = proj;
      }

      if (maxA <= minB + tolerance || maxB <= minA + tolerance) {
        return false; // separating axis found
      }
    }
  }
  return true; // no separating axis → overlap
}

const TEMPLATES = {
  terrace: templateTerrace,
  apartment: templateApartment,
  suburban: templateSuburban,
  commercial: templateCommercial,
  industrial: templateIndustrial,
  civic: templateCivic,
  mixed: templateMixed,
};

// ---------------------------------------------------------------------------
// Style determination from district character + density
// ---------------------------------------------------------------------------

function determineStyle(plot) {
  const character = plot.districtCharacter || 'suburban_residential';
  const density = plot.density || 0.3;

  switch (character) {
    case 'commercial_core':
      return density > 0.7 ? 'commercial' : 'mixed';
    case 'industrial_docks':
      return 'industrial';
    case 'mixed_use':
      return 'mixed';
    case 'dense_residential':
      return density > 0.5 ? 'apartment' : 'terrace';
    case 'suburban_residential':
      return 'suburban';
    case 'parkland':
      return null; // no building
    default:
      return 'suburban';
  }
}

// ---------------------------------------------------------------------------
// Landmark detection and overrides
// ---------------------------------------------------------------------------

function detectLandmark(plot, terrainData, roadNetwork) {
  const { terrainZones, heightmap } = terrainData;
  const cellSize = heightmap._cellSize;
  const gridWidth = heightmap.width;

  const frontMid = {
    x: (plot.frontEdge[0].x + plot.frontEdge[1].x) / 2,
    z: (plot.frontEdge[0].z + plot.frontEdge[1].z) / 2,
  };

  const hmGx = clamp(Math.round(frontMid.x / cellSize), 0, gridWidth - 1);
  const hmGz = clamp(Math.round(frontMid.z / cellSize), 0, gridWidth - 1);
  const zone = terrainZones[hmGz * gridWidth + hmGx];

  // Hilltop → church
  if (zone === ZONE.HILLTOP) {
    return { type: 'church', style: 'civic', extraFloors: 2 };
  }

  // Plaza-facing → town hall
  if (plot.flags.has('plaza_facing')) {
    return { type: 'town_hall', style: 'civic', extraFloors: 1 };
  }

  // Bridge approach → inn
  for (const node of roadNetwork.nodes.values()) {
    if (node.type === 'bridge') {
      if (distance2D(frontMid.x, frontMid.z, node.x, node.z) < 50) {
        return { type: 'inn', style: 'commercial', extraFloors: 1 };
      }
    }
  }

  // Corner plot → pub or bank
  if (plot.flags.has('corner') && plot.density > 0.3) {
    return { type: 'pub', style: 'commercial', extraFloors: 1 };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Phase 7 entry point
// ---------------------------------------------------------------------------

/**
 * Run Phase 7: Building Footprint & Massing.
 *
 * @param {Array} plots - from Phase 6
 * @param {Object} terrainData - from Phase 1
 * @param {Object} roadNetwork - from Phases 2+4+5
 * @param {Object} densityField - from Phase 3
 * @param {Object} cityContext
 * @param {Object} rng
 * @returns {Array<Object>} buildings (renderer-compatible)
 */
export function runPhase7(plots, terrainData, roadNetwork, densityField, cityContext, rng) {
  const buildRng = rng.fork('buildings');
  const { heightmap } = terrainData;
  const cellSize = heightmap._cellSize;
  const gridWidth = heightmap.width;
  const worldExtent = (gridWidth - 1) * cellSize;

  const buildings = [];

  // Group plots by block for street consistency
  const blockPlots = new Map();
  for (const plot of plots) {
    if (!blockPlots.has(plot.blockId)) {
      blockPlots.set(plot.blockId, []);
    }
    blockPlots.get(plot.blockId).push(plot);
  }

  for (const plot of plots) {
    const plotRng = buildRng.fork(`p${plot.id}`);
    const density = plot.density || 0.3;

    // Determine building style
    let style = determineStyle(plot);
    if (!style) continue;

    // Detect landmark
    const landmark = detectLandmark(plot, terrainData, roadNetwork);
    if (landmark) {
      style = landmark.style;
    }

    // Get template
    const templateFn = TEMPLATES[style];
    if (!templateFn) continue;

    const template = templateFn(plot, density, plotRng);
    if (!template) continue;

    // Apply landmark extra floors
    if (landmark) {
      template.floors += landmark.extraFloors;
      const floorH = style === 'industrial' ? FLOOR_HEIGHT_INDUSTRIAL
        : (style === 'commercial' || style === 'civic' || style === 'mixed')
          ? FLOOR_HEIGHT_COMMERCIAL : FLOOR_HEIGHT_RESIDENTIAL;
      template.h = template.floors * floorH;
    }

    // Corner plots get +1 floor
    if (plot.flags.has('corner') && !landmark) {
      template.floors += 1;
      const floorH = style === 'industrial' ? FLOOR_HEIGHT_INDUSTRIAL
        : (style === 'commercial' || style === 'civic' || style === 'mixed')
          ? FLOOR_HEIGHT_COMMERCIAL : FLOOR_HEIGHT_RESIDENTIAL;
      template.h = template.floors * floorH;
    }

    // Position: center of frontage, offset inward by front setback
    const f0 = plot.frontEdge[0];
    const f1 = plot.frontEdge[1];
    const frontMidX = (f0.x + f1.x) / 2;
    const frontMidZ = (f0.z + f1.z) / 2;

    // Rotation from front edge
    const edgeDx = f1.x - f0.x;
    const edgeDz = f1.z - f0.z;
    const rotation = Math.atan2(edgeDz, edgeDx);

    // Position: offset from front midpoint by setback + half depth
    const cosR = Math.cos(rotation + Math.PI / 2);
    const sinR = Math.sin(rotation + Math.PI / 2);

    // Determine inward direction (toward block centroid)
    const centroid = { x: 0, z: 0 };
    for (const pt of plot.polygon) { centroid.x += pt.x; centroid.z += pt.z; }
    centroid.x /= plot.polygon.length;
    centroid.z /= plot.polygon.length;

    const toCenter = {
      x: centroid.x - frontMidX,
      z: centroid.z - frontMidZ,
    };
    const dotInward = toCenter.x * cosR + toCenter.z * sinR;
    const sign = dotInward >= 0 ? 1 : -1;

    const inwardOffset = plot.setbacks.front + template.d / 2;
    const x = frontMidX + cosR * sign * inwardOffset;
    const z = frontMidZ + sinR * sign * inwardOffset;

    // Building collision check: overlap with recent buildings
    const newCorners = getBuildingCorners(x, z, template.w, template.d, rotation);
    let collides = false;
    const checkCount = Math.min(buildings.length, 50);
    for (let bi = buildings.length - checkCount; bi < buildings.length; bi++) {
      const other = buildings[bi];
      const otherCorners = getBuildingCorners(other.x, other.z, other.w, other.d, other.rotation);
      if (cornersOverlap(newCorners, otherCorners)) {
        collides = true;
        break;
      }
    }
    if (collides) continue;

    // Building-road clearance check: center and all corners must be outside road width + buffer
    let onRoad = false;
    const checkPoints = [{ x, z }, ...newCorners];
    for (const re of roadNetwork.edges) {
      if (!re.points || re.points.length < 2) continue;
      const halfW = (re.width || 6) / 2 + 0.5;
      for (const cp of checkPoints) {
        for (let ri = 0; ri < re.points.length - 1; ri++) {
          if (pointToSegmentDist(cp.x, cp.z, re.points[ri].x, re.points[ri].z, re.points[ri + 1].x, re.points[ri + 1].z) < halfW) {
            onRoad = true;
            break;
          }
        }
        if (onRoad) break;
      }
      if (onRoad) break;
    }
    if (onRoad) continue;

    // Door position: project front midpoint to nearest road edge, then pull 1m back
    let doorX = frontMidX;
    let doorZ = frontMidZ;
    {
      let bestDoorDist = Infinity;
      let bestProjX = doorX;
      let bestProjZ = doorZ;
      for (const re of roadNetwork.edges) {
        if (!re.points || re.points.length < 2) continue;
        for (let ri = 0; ri < re.points.length - 1; ri++) {
          const ax = re.points[ri].x;
          const az = re.points[ri].z;
          const bx = re.points[ri + 1].x;
          const bz = re.points[ri + 1].z;
          const d = pointToSegmentDist(doorX, doorZ, ax, az, bx, bz);
          if (d < bestDoorDist) {
            bestDoorDist = d;
            // Compute projection
            const dx = bx - ax;
            const dz = bz - az;
            const lenSq = dx * dx + dz * dz;
            if (lenSq > 0) {
              let t = ((doorX - ax) * dx + (doorZ - az) * dz) / lenSq;
              t = Math.max(0, Math.min(1, t));
              bestProjX = ax + t * dx;
              bestProjZ = az + t * dz;
            } else {
              bestProjX = ax;
              bestProjZ = az;
            }
          }
        }
      }
      // Place door 1m back from road toward building center
      const toCenterX = x - bestProjX;
      const toCenterZ = z - bestProjZ;
      const toCenterLen = Math.sqrt(toCenterX * toCenterX + toCenterZ * toCenterZ);
      if (toCenterLen > 0) {
        doorX = bestProjX + (toCenterX / toCenterLen) * 1;
        doorZ = bestProjZ + (toCenterZ / toCenterLen) * 1;
      } else {
        doorX = bestProjX;
        doorZ = bestProjZ;
      }
    }

    buildings.push({
      x,
      z,
      w: template.w,
      d: template.d,
      h: template.h,
      floors: template.floors,
      style,
      roofType: template.roofType,
      wallMaterial: template.wallMaterial,
      roofMaterial: template.roofMaterial,
      rotation,
      doorFace: 'front',
      doorPosition: { x: doorX, z: doorZ },
      landUse: plot.districtCharacter,
      districtCharacter: plot.districtCharacter,
      isCorner: plot.flags.has('corner'),
      isLandmark: !!landmark,
      landmarkType: landmark ? landmark.type : null,
      plotId: plot.id,
      blockId: plot.blockId,
      districtId: plot.districtId,
      density,
    });
  }

  return buildings;
}
