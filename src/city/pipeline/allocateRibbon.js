// src/city/pipeline/allocateRibbon.js
/**
 * Residential ribbon allocation.
 * Claims strips of cells perpendicular to roads, with gaps between
 * strips that become streets. Respects terrain contours.
 */

import { RESERVATION } from './growthAgents.js';

const CONTOUR_SLOPE_THRESHOLD = 0.1;

/**
 * Compute ribbon direction at a point.
 * On slopes: perpendicular to slope (follow contours).
 * On flat: along the road direction.
 */
function ribbonDirection(gx, gz, roadGrid, slope, w, h) {
  // Check if terrain is sloped
  const s = slope ? slope.get(gx, gz) : 0;
  if (s > CONTOUR_SLOPE_THRESHOLD && slope) {
    // Estimate slope direction from gradient
    const sl = gx > 0 ? slope.get(gx - 1, gz) : s;
    const sr = gx < w - 1 ? slope.get(gx + 1, gz) : s;
    const su = gz > 0 ? slope.get(gx, gz - 1) : s;
    const sd = gz < h - 1 ? slope.get(gx, gz + 1) : s;
    const gradX = sr - sl;
    const gradZ = sd - su;
    const glen = Math.sqrt(gradX * gradX + gradZ * gradZ);
    if (glen > 0.001) {
      // Perpendicular to slope = contour-following
      return { dx: -gradZ / glen, dz: gradX / glen };
    }
  }

  // Flat: follow road direction
  let rdx = 0, rdz = 0;
  for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
    const nx = gx + dx, nz = gz + dz;
    if (nx >= 0 && nx < w && nz >= 0 && nz < h && roadGrid.get(nx, nz) > 0) {
      rdx += dx; rdz += dz;
    }
  }
  const rlen = Math.sqrt(rdx * rdx + rdz * rdz);
  if (rlen > 0.01) return { dx: rdx / rlen, dz: rdz / rlen };
  return { dx: 1, dz: 0 };
}

/**
 * Allocate residential ribbons along roads.
 *
 * @param {object} opts
 * @param {Float32Array} opts.valueLayer - residential value bitmap
 * @param {Grid2D} opts.resGrid - reservation grid (read + write)
 * @param {Grid2D} opts.zoneGrid - zone eligibility
 * @param {Grid2D} opts.roadGrid - road cells
 * @param {Grid2D} opts.slope - slope grid
 * @param {Float32Array|null} opts.devProximity
 * @param {number} opts.resType - reservation type to write
 * @param {number} opts.budget - max cells to claim
 * @param {number} opts.plotDepth - cells per strip
 * @param {number} opts.gapWidth - cells between strips (becomes street)
 * @param {number} opts.maxRibbonLength - max cells along road before cross street
 * @param {number} opts.seedCount - number of road seed locations
 * @param {number} opts.noise - random noise for organic shapes
 * @param {number} opts.w - grid width
 * @param {number} opts.h - grid height
 * @param {number} opts.cellSize
 * @returns {{ claimed: Array<{gx,gz}>, ribbonGaps: Array<{gx,gz}>, ribbonEndpoints: Array<{gx,gz,dx,dz}> }}
 */
export function allocateRibbon({
  valueLayer, resGrid, zoneGrid, roadGrid, slope, devProximity,
  resType, budget, plotDepth, gapWidth, maxRibbonLength,
  seedCount, noise, w, h, cellSize,
}) {
  const claimed = [];
  const ribbonGaps = [];
  const ribbonEndpoints = [];

  if (budget <= 0) return { claimed, ribbonGaps, ribbonEndpoints };

  // Step 1: Find road-adjacent cells with high value as seed points
  const seeds = [];
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (roadGrid.get(gx, gz) === 0) continue;
      // Check if this road cell has unclaimed zone cells nearby
      let hasSpace = false;
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = gx + dx, nz = gz + dz;
        if (nx >= 0 && nx < w && nz >= 0 && nz < h &&
            zoneGrid.get(nx, nz) > 0 &&
            resGrid.get(nx, nz) === RESERVATION.NONE &&
            roadGrid.get(nx, nz) === 0) {
          hasSpace = true;
          break;
        }
      }
      if (!hasSpace) continue;

      // Average value of nearby non-road cells
      let sum = 0, count = 0;
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = gx + dx, nz = gz + dz;
        if (nx >= 0 && nx < w && nz >= 0 && nz < h && roadGrid.get(nx, nz) === 0) {
          sum += valueLayer[nz * w + nx];
          count++;
        }
      }
      if (count > 0) seeds.push({ gx, gz, value: sum / count });
    }
  }

  seeds.sort((a, b) => b.value - a.value);

  // Pick spaced seeds
  const selectedSeeds = [];
  // Seeds need to be at least maxRibbonLength/2 apart to avoid overlapping ribbons
  const spacing = Math.max(5, Math.floor(maxRibbonLength / 2));
  const minSpacingSq = spacing * spacing;
  for (const s of seeds) {
    if (selectedSeeds.length >= seedCount) break;
    let tooClose = false;
    for (const sel of selectedSeeds) {
      const dx = s.gx - sel.gx, dz = s.gz - sel.gz;
      if (dx * dx + dz * dz < minSpacingSq) { tooClose = true; break; }
    }
    if (!tooClose) selectedSeeds.push(s);
  }

  // Step 2: For each seed, lay out ribbon strips on both sides of the road
  for (const seed of selectedSeeds) {
    if (claimed.length >= budget) break;

    const dir = ribbonDirection(seed.gx, seed.gz, roadGrid, slope, w, h);
    // Perpendicular to ribbon direction = perpendicular to road = into the plots
    const perpX = -dir.dz;
    const perpZ = dir.dx;

    // Lay ribbons on both sides of the road
    for (const side of [1, -1]) {
      if (claimed.length >= budget) break;

      let ribbonLen = 0;

      // Walk along the road from the seed
      for (let along = -Math.floor(maxRibbonLength / 2); along <= Math.floor(maxRibbonLength / 2); along++) {
        if (claimed.length >= budget) break;

        const roadX = seed.gx + Math.round(dir.dx * along);
        const roadZ = seed.gz + Math.round(dir.dz * along);

        if (roadX < 0 || roadX >= w || roadZ < 0 || roadZ >= h) continue;
        if (roadGrid.get(roadX, roadZ) === 0) continue; // only along road

        // Lay strips perpendicular: plot, plot..., gap, plot, plot..., gap...
        let d = 1; // start 1 cell from road
        let stripCount = 0;

        const maxDist = plotDepth * 8 + gapWidth * 7; // up to 8 strips
        while (d < maxDist) {
          // Claim plotDepth cells
          const stripStart = claimed.length;
          for (let pd = 0; pd < plotDepth; pd++) {
            if (claimed.length >= budget) break;
            const gx = roadX + Math.round(perpX * side * (d + pd));
            const gz = roadZ + Math.round(perpZ * side * (d + pd));

            if (gx < 0 || gx >= w || gz < 0 || gz >= h) break;
            if (zoneGrid.get(gx, gz) === 0) break;
            if (resGrid.get(gx, gz) !== RESERVATION.NONE) break;
            if (roadGrid.get(gx, gz) > 0) break;
            if (devProximity !== null && devProximity[gz * w + gx] === 0) break;

            const val = valueLayer[gz * w + gx];
            if (val <= 0) break;

            resGrid.set(gx, gz, resType);
            claimed.push({ gx, gz });
          }
          const stripClaimed = claimed.length - stripStart;
          d += plotDepth;

          // If the strip didn't claim anything, stop — no point adding gaps beyond
          if (stripClaimed === 0) break;

          // Leave gap (future street) — only if strip above actually claimed cells
          for (let gd = 0; gd < gapWidth; gd++) {
            const gx = roadX + Math.round(perpX * side * (d + gd));
            const gz = roadZ + Math.round(perpZ * side * (d + gd));
            if (gx >= 0 && gx < w && gz >= 0 && gz < h &&
                zoneGrid.get(gx, gz) > 0 &&
                resGrid.get(gx, gz) === RESERVATION.NONE &&
                roadGrid.get(gx, gz) === 0) {
              ribbonGaps.push({ gx, gz });
            }
          }
          d += gapWidth;

          stripCount++;
        }

        ribbonLen++;
      }

      // Record endpoints for cross streets
      const startX = seed.gx + Math.round(dir.dx * (-Math.floor(maxRibbonLength / 2)));
      const startZ = seed.gz + Math.round(dir.dz * (-Math.floor(maxRibbonLength / 2)));
      const endX = seed.gx + Math.round(dir.dx * Math.floor(maxRibbonLength / 2));
      const endZ = seed.gz + Math.round(dir.dz * Math.floor(maxRibbonLength / 2));

      // Cross street perpendicular at ribbon start and end
      ribbonEndpoints.push(
        { gx: startX, gz: startZ, dx: perpX * side, dz: perpZ * side },
        { gx: endX, gz: endZ, dx: perpX * side, dz: perpZ * side },
      );
    }
  }

  return { claimed, ribbonGaps, ribbonEndpoints };
}
