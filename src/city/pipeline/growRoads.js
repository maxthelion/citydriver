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
 * @param {Grid2D} opts.roadGrid - road grid (read + write)
 * @param {Array<{gx,gz}>} opts.ribbonGaps - gap cells from ribbon allocation
 * @param {Array<{gx,gz,dx,dz}>} opts.ribbonEndpoints - cross street start points
 * @param {number} opts.w - grid width
 * @param {number} opts.h - grid height
 * @param {number} opts.maxCrossStreetLength - max cells for cross streets
 * @param {number} opts.pathClosingDistance - max gap to bridge between endpoints
 */
export function growRoads({
  roadGrid, ribbonGaps, ribbonEndpoints, w, h,
  maxCrossStreetLength, pathClosingDistance,
}) {
  // Step 1: Mark ribbon gaps as road cells
  for (const g of ribbonGaps) {
    if (g.gx >= 0 && g.gx < w && g.gz >= 0 && g.gz < h) {
      roadGrid.set(g.gx, g.gz, 1);
    }
  }

  // Step 2: Extend cross streets from ribbon endpoints
  for (const ep of ribbonEndpoints) {
    let gx = ep.gx;
    let gz = ep.gz;
    const dx = Math.round(ep.dx);
    const dz = Math.round(ep.dz);

    if (dx === 0 && dz === 0) continue;

    // Place road at the starting endpoint cell itself if not already a road
    if (gx >= 0 && gx < w && gz >= 0 && gz < h && roadGrid.get(gx, gz) === 0) {
      roadGrid.set(gx, gz, 1);
    }

    for (let i = 0; i < maxCrossStreetLength; i++) {
      gx += dx;
      gz += dz;

      if (gx < 0 || gx >= w || gz < 0 || gz >= h) break;

      // Hit an existing road — form junction and stop
      if (roadGrid.get(gx, gz) > 0) break;

      // Check if close to an existing road — bridge the gap
      let nearRoad = false;
      for (let d = 1; d <= Math.min(3, pathClosingDistance); d++) {
        const nx = gx + dx * d;
        const nz = gz + dz * d;
        if (nx >= 0 && nx < w && nz >= 0 && nz < h && roadGrid.get(nx, nz) > 0) {
          // Bridge to it
          for (let b = 0; b < d; b++) {
            const bx = gx + dx * b;
            const bz = gz + dz * b;
            if (bx >= 0 && bx < w && bz >= 0 && bz < h) {
              roadGrid.set(bx, bz, 1);
            }
          }
          nearRoad = true;
          break;
        }
      }
      if (nearRoad) break;

      // Place road cell
      roadGrid.set(gx, gz, 1);
    }
  }

  // Step 3: Path closing — find pairs of dead-end road cells and connect them
  // Collect road endpoints (cells with exactly 1 road neighbour)
  const deadEnds = [];
  for (let gz = 1; gz < h - 1; gz++) {
    for (let gx = 1; gx < w - 1; gx++) {
      if (roadGrid.get(gx, gz) === 0) continue;
      let neighbours = 0;
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        if (roadGrid.get(gx + dx, gz + dz) > 0) neighbours++;
      }
      if (neighbours === 1) {
        deadEnds.push({ gx, gz });
      }
    }
  }

  // Try to connect nearby dead ends
  const maxDistSq = pathClosingDistance * pathClosingDistance;
  const connected = new Set();

  for (let i = 0; i < deadEnds.length; i++) {
    if (connected.has(i)) continue;
    const a = deadEnds[i];

    for (let j = i + 1; j < deadEnds.length; j++) {
      if (connected.has(j)) continue;
      const b = deadEnds[j];

      const dx = b.gx - a.gx;
      const dz = b.gz - a.gz;
      const distSq = dx * dx + dz * dz;

      if (distSq > maxDistSq || distSq < 4) continue; // too far or too close

      // Draw a straight line between them
      const steps = Math.max(Math.abs(dx), Math.abs(dz));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const rx = Math.round(a.gx + dx * t);
        const rz = Math.round(a.gz + dz * t);
        if (rx >= 0 && rx < w && rz >= 0 && rz < h) {
          roadGrid.set(rx, rz, 1);
        }
      }

      connected.add(i);
      connected.add(j);
      break; // each dead end connects to at most one other
    }
  }
}
