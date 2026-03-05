/**
 * C6b. Place large institutional plots.
 *
 * Before fine-grained frontage plots fill every road edge, this step
 * reserves large contiguous areas for parks, churches, markets,
 * schools, and hospitals. These institutions are placed first because
 * they need space that won't be available once smaller plots fill in.
 *
 * Placement order follows a land-scarcity model:
 *   1. Central market square (at old town nucleus)
 *   2. Church/cathedral (near old town, slightly offset)
 *   3. Parks/commons (edges of neighborhoods, low-value land)
 *   4. Schools (one per 2-3 neighborhoods)
 *   5. Hospital (periphery, one per city)
 */

import { distance2D } from '../core/math.js';

const INSTITUTION_TYPES = {
  market: {
    width: 40, depth: 40,        // metres
    minCount: 1, maxCount: 1,
    placementPreference: 'center',
    district: 0, // commercial
  },
  church: {
    width: 25, depth: 35,
    minCount: 1, maxCount: 3,
    placementPreference: 'neighborhood',
    district: 0,
  },
  park: {
    width: 50, depth: 50,
    minCount: 2, maxCount: 6,
    placementPreference: 'lowDensityEdge',
    district: 4, // parkland
  },
  school: {
    width: 35, depth: 40,
    minCount: 1, maxCount: 3,
    placementPreference: 'neighborhood',
    district: 2, // suburban
  },
  hospital: {
    width: 50, depth: 60,
    minCount: 0, maxCount: 1,
    placementPreference: 'periphery',
    district: 2,
  },
};

/**
 * @param {import('../core/LayerStack.js').LayerStack} cityLayers
 * @param {import('../core/PlanarGraph.js').PlanarGraph} roadGraph
 * @param {import('../core/rng.js').SeededRandom} rng
 * @returns {Array<object>} institutional plots
 */
export function generateInstitutionalPlots(cityLayers, roadGraph, rng) {
  const params = cityLayers.getData('params');
  const neighborhoods = cityLayers.getData('neighborhoods');
  const density = cityLayers.getGrid('density');
  const elevation = cityLayers.getGrid('elevation');
  const waterMask = cityLayers.getGrid('waterMask');
  const slope = cityLayers.getGrid('slope');

  if (!params || !neighborhoods || !density) return [];

  const w = params.width;
  const h = params.height;
  const cs = params.cellSize;
  const seaLevel = params.seaLevel ?? 0;
  const tier = params.settlement?.tier ?? 3;

  // Claimed cells at 3m resolution (same as frontage plots)
  const claimedCells = new Set();
  const plots = [];

  // Scale institution count by city tier
  const countScale = tier === 1 ? 1.0 : tier === 2 ? 0.6 : 0.3;

  // Place institutions in order of priority
  const order = ['market', 'church', 'park', 'school', 'hospital'];

  for (const type of order) {
    const spec = INSTITUTION_TYPES[type];
    const maxCount = Math.max(spec.minCount, Math.round(spec.maxCount * countScale));

    const candidates = findCandidateLocations(
      type, spec, neighborhoods, density, elevation, waterMask, slope,
      roadGraph, w, h, cs, seaLevel, claimedCells, plots, rng,
    );

    let placed = 0;
    for (const candidate of candidates) {
      if (placed >= maxCount) break;

      const plot = tryPlaceInstitution(
        candidate, spec, type, elevation, waterMask, slope,
        seaLevel, w, h, cs, claimedCells, roadGraph, rng,
      );

      if (plot) {
        plots.push(plot);
        claimPlotCells(plot.vertices, cs, claimedCells);
        placed++;
      }
    }
  }

  return plots;
}

function findCandidateLocations(type, spec, neighborhoods, density, elevation, waterMask, slope, roadGraph, w, h, cs, seaLevel, claimedCells, existingPlots, rng) {
  const candidates = [];
  const centerGx = Math.floor(w / 2);
  const centerGz = Math.floor(h / 2);
  const maxRadius = Math.min(w, h) * 0.45;

  if (spec.placementPreference === 'center') {
    // Market: near old town nucleus, close to road intersections
    const oldTown = neighborhoods[0];
    if (oldTown) {
      // Search around the old town for a good spot near roads
      const searchRadius = 8; // grid cells
      for (let dz = -searchRadius; dz <= searchRadius; dz += 2) {
        for (let dx = -searchRadius; dx <= searchRadius; dx += 2) {
          const gx = oldTown.gx + dx;
          const gz = oldTown.gz + dz;
          if (!isBuildable(gx, gz, elevation, waterMask, slope, seaLevel, w, h)) continue;
          const dist = Math.sqrt(dx * dx + dz * dz);
          const score = 1.0 - dist / searchRadius;
          candidates.push({ gx, gz, x: gx * cs, z: gz * cs, score });
        }
      }
    }
  } else if (spec.placementPreference === 'neighborhood') {
    // Church/school: near neighborhood nuclei
    for (let i = 0; i < neighborhoods.length; i++) {
      const n = neighborhoods[i];
      // Offset from nucleus center (not right on top of it)
      const offsets = [
        { dx: 3, dz: 0 }, { dx: -3, dz: 0 },
        { dx: 0, dz: 3 }, { dx: 0, dz: -3 },
        { dx: 3, dz: 3 }, { dx: -3, dz: -3 },
      ];
      for (const off of offsets) {
        const gx = n.gx + off.dx;
        const gz = n.gz + off.dz;
        if (!isBuildable(gx, gz, elevation, waterMask, slope, seaLevel, w, h)) continue;

        // Prefer nuclei with matching types
        let score = n.importance;
        if (type === 'church' && (n.type === 'oldTown' || n.type === 'market')) score += 0.3;
        if (type === 'school' && (n.type === 'suburban' || n.type === 'roadside')) score += 0.2;

        // Penalize if too close to existing institutions
        const tooClose = existingPlots.some(p =>
          distance2D(gx * cs, gz * cs, p.centroid.x, p.centroid.z) < 60,
        );
        if (tooClose) score -= 0.5;

        candidates.push({ gx, gz, x: gx * cs, z: gz * cs, score, neighborhoodIdx: i });
      }
    }
  } else if (spec.placementPreference === 'lowDensityEdge') {
    // Parks: low-density areas, edges of neighborhoods, flat terrain
    const step = 4;
    for (let gz = step; gz < h - step; gz += step) {
      for (let gx = step; gx < w - step; gx += step) {
        if (!isBuildable(gx, gz, elevation, waterMask, slope, seaLevel, w, h)) continue;

        const d = density.get(gx, gz);
        if (d < 0.05 || d > 0.5) continue; // want edges of developed areas, not wilderness

        const s = slope ? slope.get(gx, gz) : 0;
        if (s > 0.1) continue;

        // Score: prefer lower density, gentler slope, moderate distance from center
        const distFromCenter = distance2D(gx, gz, centerGx, centerGz);
        const distScore = distFromCenter < maxRadius * 0.8 ? 1.0 : 0.3;
        const score = (0.5 - d) * 2.0 + (0.1 - s) * 5.0 + distScore * 0.3;

        if (score > 0.3) {
          candidates.push({ gx, gz, x: gx * cs, z: gz * cs, score });
        }
      }
    }
  } else if (spec.placementPreference === 'periphery') {
    // Hospital: on the edge of the city, near roads, flat
    const step = 4;
    for (let gz = step; gz < h - step; gz += step) {
      for (let gx = step; gx < w - step; gx += step) {
        if (!isBuildable(gx, gz, elevation, waterMask, slope, seaLevel, w, h)) continue;

        const d = density.get(gx, gz);
        if (d < 0.1 || d > 0.4) continue;

        const s = slope ? slope.get(gx, gz) : 0;
        if (s > 0.08) continue;

        const distFromCenter = distance2D(gx, gz, centerGx, centerGz);
        // Prefer moderate-to-far from center
        const distScore = distFromCenter / maxRadius;
        const score = distScore * 0.5 + (0.4 - d) + (0.08 - s) * 5;

        if (score > 0.3) {
          candidates.push({ gx, gz, x: gx * cs, z: gz * cs, score });
        }
      }
    }
  }

  // Sort by score descending, with some randomness
  candidates.sort((a, b) => (b.score + rng.range(-0.1, 0.1)) - (a.score + rng.range(-0.1, 0.1)));

  return candidates;
}

function tryPlaceInstitution(candidate, spec, type, elevation, waterMask, slope, seaLevel, w, h, cs, claimedCells, roadGraph, rng) {
  const { gx, gz, x, z } = candidate;

  // Try several orientations to find one that fits
  const halfW = spec.width / 2;
  const halfD = spec.depth / 2;
  const angles = [0, Math.PI / 4, Math.PI / 2, Math.PI * 3 / 4];

  // If near a road, align to the nearest road direction
  const nearestEdgeDir = findNearestRoadDirection(x, z, roadGraph, cs * 5);
  if (nearestEdgeDir) {
    angles.unshift(nearestEdgeDir.angle);
  }

  for (const angle of angles) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    // Four corners of the institutional plot
    const corners = [
      { x: x + (-halfW * cos - (-halfD) * sin), z: z + (-halfW * sin + (-halfD) * cos) },
      { x: x + (halfW * cos - (-halfD) * sin), z: z + (halfW * sin + (-halfD) * cos) },
      { x: x + (halfW * cos - halfD * sin), z: z + (halfW * sin + halfD * cos) },
      { x: x + (-halfW * cos - halfD * sin), z: z + (-halfW * sin + halfD * cos) },
    ];

    // Validate all corners are buildable
    let valid = true;
    for (const c of corners) {
      const cgx = Math.round(c.x / cs);
      const cgz = Math.round(c.z / cs);
      if (!isBuildable(cgx, cgz, elevation, waterMask, slope, seaLevel, w, h)) {
        valid = false;
        break;
      }
    }
    if (!valid) continue;

    // Check overlap with existing claimed cells
    if (isAreaOverlapping(corners, cs, claimedCells)) continue;

    // Check the interior is mostly buildable
    if (!isInteriorBuildable(corners, elevation, waterMask, slope, seaLevel, w, h, cs, 0.95)) continue;

    const centroid = {
      x: (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4,
      z: (corners[0].z + corners[1].z + corners[2].z + corners[3].z) / 4,
    };

    return {
      vertices: corners,
      area: spec.width * spec.depth,
      centroid,
      frontageWidth: spec.width,
      depth: spec.depth,
      setback: 3,
      rearGarden: 5,
      density: 0,
      district: spec.district,
      neighborhoodIdx: candidate.neighborhoodIdx ?? 0,
      neighborhoodType: 'institutional',
      side: 'none',
      buildingCoverage: type === 'park' ? 0.05 : 0.4,
      institutionType: type,
      isInstitutional: true,
    };
  }

  return null;
}

function findNearestRoadDirection(x, z, roadGraph, maxDist) {
  let bestDist = maxDist;
  let bestAngle = null;

  for (const [, edge] of roadGraph.edges) {
    const fromNode = roadGraph.getNode(edge.from);
    const toNode = roadGraph.getNode(edge.to);
    if (!fromNode || !toNode) continue;

    const mx = (fromNode.x + toNode.x) / 2;
    const mz = (fromNode.z + toNode.z) / 2;
    const d = distance2D(x, z, mx, mz);
    if (d < bestDist) {
      bestDist = d;
      bestAngle = Math.atan2(toNode.z - fromNode.z, toNode.x - fromNode.x);
    }
  }

  return bestAngle !== null ? { angle: bestAngle } : null;
}

function isBuildable(gx, gz, elevation, waterMask, slope, seaLevel, w, h) {
  if (gx < 2 || gx >= w - 2 || gz < 2 || gz >= h - 2) return false;
  if (elevation && elevation.get(gx, gz) < seaLevel) return false;
  if (slope && slope.get(gx, gz) > 0.2) return false;
  // Check cell and immediate neighbors for water (buffer against coarse grid)
  if (waterMask) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (waterMask.get(gx + dx, gz + dz) > 0) return false;
      }
    }
  }
  return true;
}

function isInteriorBuildable(corners, elevation, waterMask, slope, seaLevel, w, h, cs, threshold) {
  let total = 0;
  let buildable = 0;
  const step = 5; // sample every 5m

  const minX = Math.min(...corners.map(c => c.x));
  const maxX = Math.max(...corners.map(c => c.x));
  const minZ = Math.min(...corners.map(c => c.z));
  const maxZ = Math.max(...corners.map(c => c.z));

  for (let px = minX; px <= maxX; px += step) {
    for (let pz = minZ; pz <= maxZ; pz += step) {
      if (!pointInQuad(px, pz, corners)) continue;
      total++;
      const gx = Math.round(px / cs);
      const gz = Math.round(pz / cs);
      if (isBuildable(gx, gz, elevation, waterMask, slope, seaLevel, w, h)) buildable++;
    }
  }

  return total > 0 && (buildable / total) >= threshold;
}

function pointInQuad(px, pz, corners) {
  // Simple winding number test for convex quad
  let inside = true;
  for (let i = 0; i < corners.length; i++) {
    const j = (i + 1) % corners.length;
    const ex = corners[j].x - corners[i].x;
    const ez = corners[j].z - corners[i].z;
    const tx = px - corners[i].x;
    const tz = pz - corners[i].z;
    if (ex * tz - ez * tx < 0) { inside = false; break; }
  }
  return inside;
}

function isAreaOverlapping(corners, cs, claimedCells) {
  const step = 3;
  let total = 0;
  let hits = 0;

  const minX = Math.min(...corners.map(c => c.x));
  const maxX = Math.max(...corners.map(c => c.x));
  const minZ = Math.min(...corners.map(c => c.z));
  const maxZ = Math.max(...corners.map(c => c.z));

  for (let px = minX; px <= maxX; px += step) {
    for (let pz = minZ; pz <= maxZ; pz += step) {
      if (!pointInQuad(px, pz, corners)) continue;
      total++;
      const key = `${Math.round(px / 3)},${Math.round(pz / 3)}`;
      if (claimedCells.has(key)) hits++;
    }
  }

  return total > 0 && (hits / total) > 0.1;
}

function claimPlotCells(corners, cs, claimedCells) {
  const step = 3;
  const minX = Math.min(...corners.map(c => c.x));
  const maxX = Math.max(...corners.map(c => c.x));
  const minZ = Math.min(...corners.map(c => c.z));
  const maxZ = Math.max(...corners.map(c => c.z));

  for (let px = minX; px <= maxX; px += step) {
    for (let pz = minZ; pz <= maxZ; pz += step) {
      if (!pointInQuad(px, pz, corners)) continue;
      claimedCells.add(`${Math.round(px / 3)},${Math.round(pz / 3)}`);
    }
  }
}
