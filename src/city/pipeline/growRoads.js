// src/city/pipeline/growRoads.js
/**
 * Incremental road growth during ticks.
 * - Marks ribbon gaps as road cells
 * - Extends cross streets from ribbon endpoints
 * - Closes paths between nearby road endpoints
 */

/**
 * Grow roads from ribbon allocation results.
 *
 * @param {object} opts
 * @param {Grid2D} opts.roadGrid - road grid (read + write when no roadNetwork)
 * @param {Grid2D|null} opts.waterMask - water mask (read only, skip water cells)
 * @param {Array<{gx,gz}>} opts.ribbonGaps - gap cells from ribbon allocation
 * @param {Array<{gx,gz,dx,dz}>} opts.ribbonEndpoints - cross street start points
 * @param {number} opts.w - grid width
 * @param {number} opts.h - grid height
 * @param {number} opts.maxCrossStreetLength - max cells for cross streets
 * @param {number} opts.pathClosingDistance - max gap to bridge between endpoints
 * @param {RoadNetwork|null} [opts.roadNetwork] - when provided, roads are added
 *   as proper Road objects via addFromCells() instead of direct grid writes
 */
export function growRoads({
  roadGrid, waterMask, ribbonGaps, ribbonEndpoints, w, h,
  maxCrossStreetLength, pathClosingDistance, roadNetwork,
}) {
  const isWater = (gx, gz) =>
    waterMask && gx >= 0 && gx < w && gz >= 0 && gz < h && waterMask.get(gx, gz) > 0;

  const canPlace = (gx, gz) =>
    gx >= 0 && gx < w && gz >= 0 && gz < h && !isWater(gx, gz);

  // Step 1: Mark ribbon gaps as road cells (skip water)
  if (roadNetwork) {
    const gapCells = [];
    for (const g of ribbonGaps) {
      if (canPlace(g.gx, g.gz)) {
        gapCells.push({ gx: g.gx, gz: g.gz });
      }
    }
    if (gapCells.length >= 2) {
      roadNetwork.addFromCells(gapCells, { hierarchy: 'local', source: 'growth-ribbon' });
    }
  } else {
    for (const g of ribbonGaps) {
      if (canPlace(g.gx, g.gz)) {
        roadGrid.set(g.gx, g.gz, 1);
      }
    }
  }

  // Step 2: Extend cross streets from ribbon endpoints (stop at water)
  for (const ep of ribbonEndpoints) {
    let gx = ep.gx;
    let gz = ep.gz;
    const dx = Math.round(ep.dx);
    const dz = Math.round(ep.dz);

    if (dx === 0 && dz === 0) continue;

    const streetCells = [];

    if (canPlace(gx, gz) && roadGrid.get(gx, gz) === 0) {
      if (roadNetwork) {
        streetCells.push({ gx, gz });
      } else {
        roadGrid.set(gx, gz, 1);
      }
    }

    for (let i = 0; i < maxCrossStreetLength; i++) {
      gx += dx;
      gz += dz;

      if (!canPlace(gx, gz)) break;
      if (roadGrid.get(gx, gz) > 0) break;

      // Check if close to an existing road — bridge the gap
      let nearRoad = false;
      for (let d = 1; d <= Math.min(3, pathClosingDistance); d++) {
        const nx = gx + dx * d, nz = gz + dz * d;
        if (nx >= 0 && nx < w && nz >= 0 && nz < h && roadGrid.get(nx, nz) > 0) {
          let bridgeOk = true;
          for (let b = 0; b < d; b++) {
            if (!canPlace(gx + dx * b, gz + dz * b)) { bridgeOk = false; break; }
          }
          if (bridgeOk) {
            if (roadNetwork) {
              for (let b = 0; b < d; b++) streetCells.push({ gx: gx + dx * b, gz: gz + dz * b });
            } else {
              for (let b = 0; b < d; b++) roadGrid.set(gx + dx * b, gz + dz * b, 1);
            }
            nearRoad = true;
          }
          break;
        }
      }
      if (nearRoad) break;

      if (roadNetwork) {
        streetCells.push({ gx, gz });
      } else {
        roadGrid.set(gx, gz, 1);
      }
    }

    if (roadNetwork && streetCells.length >= 2) {
      roadNetwork.addFromCells(streetCells, { hierarchy: 'local', source: 'growth-cross' });
    }
  }

  // Step 3: Path closing — connect nearby dead ends (skip water)
  const deadEnds = [];
  for (let gz = 1; gz < h - 1; gz++) {
    for (let gx = 1; gx < w - 1; gx++) {
      if (roadGrid.get(gx, gz) === 0) continue;
      let neighbours = 0;
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        if (roadGrid.get(gx + dx, gz + dz) > 0) neighbours++;
      }
      if (neighbours === 1) deadEnds.push({ gx, gz });
    }
  }

  const maxDistSq = pathClosingDistance * pathClosingDistance;
  const connected = new Set();

  for (let i = 0; i < deadEnds.length; i++) {
    if (connected.has(i)) continue;
    const a = deadEnds[i];

    for (let j = i + 1; j < deadEnds.length; j++) {
      if (connected.has(j)) continue;
      const b = deadEnds[j];

      const dx = b.gx - a.gx, dz = b.gz - a.gz;
      const distSq = dx * dx + dz * dz;
      if (distSq > maxDistSq || distSq < 4) continue;

      // Check line doesn't cross water
      const steps = Math.max(Math.abs(dx), Math.abs(dz));
      let blocked = false;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const rx = Math.round(a.gx + dx * t);
        const rz = Math.round(a.gz + dz * t);
        if (!canPlace(rx, rz)) { blocked = true; break; }
      }
      if (blocked) continue;

      if (roadNetwork) {
        const closingCells = [];
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          closingCells.push({ gx: Math.round(a.gx + dx * t), gz: Math.round(a.gz + dz * t) });
        }
        if (closingCells.length >= 2) {
          roadNetwork.addFromCells(closingCells, { hierarchy: 'local', source: 'growth-closing' });
        }
      } else {
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          roadGrid.set(Math.round(a.gx + dx * t), Math.round(a.gz + dz * t), 1);
        }
      }

      connected.add(i);
      connected.add(j);
      break;
    }
  }
}
