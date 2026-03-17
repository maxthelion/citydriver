/**
 * Sort-and-claim allocation from precomputed value bitmaps.
 *
 * Selects cells from a value bitmap, respects zone eligibility and existing
 * reservations, and writes the chosen cells into resGrid. Contiguity is
 * encouraged by growing outward from the highest-scoring seed using a
 * priority-queue BFS (same pattern as spreadFromSeed).
 */

import { RESERVATION } from './growthAgents.js';

/**
 * Allocate cells of a single reservation type from a precomputed value bitmap.
 *
 * Algorithm:
 * 1. Collect all eligible cells: zoneGrid > 0, resGrid === NONE, and
 *    (if devProximity is provided) devProximity > 0 (i.e. near development).
 * 2. Sort descending by valueLayer score to find the best seed.
 * 3. BFS-expand from the seed, always picking the highest-value unvisited
 *    neighbour next, until `budget` cells are claimed or no more eligible
 *    cells remain reachable.
 * 4. Write resType into resGrid for every claimed cell.
 *
 * Contiguity note: the BFS only expands from claimed cells, so the result is
 * always a connected region. If the budget cannot be filled from one connected
 * component, the function returns what it can claim.
 *
 * @param {object} opts
 * @param {Float32Array} opts.valueLayer  - Per-cell value scores (length = w*h)
 * @param {Grid2D}       opts.resGrid     - Reservation grid (read + write, uint8)
 * @param {Grid2D}       opts.zoneGrid    - Zone eligibility (read only; > 0 = eligible)
 * @param {Float32Array|null} [opts.devProximity] - Development proximity blur;
 *   when provided, cells with devProximity === 0 are skipped (not near any
 *   development). Pass null to skip this filter entirely.
 * @param {number}       opts.resType     - RESERVATION value to write
 * @param {number}       opts.budget      - Max cells to claim
 * @param {number}       [opts.minFootprint=1] - Minimum cells; if fewer are
 *   reachable the allocation still proceeds (returns whatever it can)
 * @param {number}       opts.w           - Grid width
 * @param {number}       opts.h           - Grid height
 * @returns {Array<{gx:number, gz:number}>} Claimed cells
 */
export function allocateFromValueBitmap({
  valueLayer,
  resGrid,
  zoneGrid,
  devProximity = null,
  resType,
  budget,
  minFootprint = 1,
  w,
  h,
}) {
  // Step 1: build the eligible set and find the best seed
  // We need a fast lookup for eligibility so we use a Uint8 flat mask.
  const eligible = new Uint8Array(w * h); // 1 = eligible for BFS expansion
  let bestScore = -Infinity;
  let seedIdx = -1;

  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (zoneGrid.get(gx, gz) === 0) continue;
      if (resGrid.get(gx, gz) !== RESERVATION.NONE) continue;
      const idx = gz * w + gx;
      if (devProximity !== null && devProximity[idx] === 0) continue;
      eligible[idx] = 1;
      const score = valueLayer[idx];
      if (score > bestScore) {
        bestScore = score;
        seedIdx = idx;
      }
    }
  }

  if (seedIdx === -1 || budget <= 0) return [];

  // Step 2: BFS priority expansion from seed
  const claimed = [];
  const visited = new Uint8Array(w * h); // 1 = in frontier or claimed

  // Simple priority queue as a sorted array (adequate for cell-level budgets)
  const frontier = [];

  const enqueue = (idx) => {
    if (visited[idx]) return;
    if (!eligible[idx]) return;
    visited[idx] = 1;
    frontier.push({ idx, score: valueLayer[idx] });
  };

  enqueue(seedIdx);

  while (claimed.length < budget && frontier.length > 0) {
    // Pick highest-score candidate
    let bestI = 0;
    for (let i = 1; i < frontier.length; i++) {
      if (frontier[i].score > frontier[bestI].score) bestI = i;
    }
    const { idx } = frontier[bestI];
    // Remove from frontier (swap with last for O(1) removal)
    frontier[bestI] = frontier[frontier.length - 1];
    frontier.pop();

    const gx = idx % w;
    const gz = (idx - gx) / w;

    // Claim this cell
    resGrid.set(gx, gz, resType);
    claimed.push({ gx, gz });

    // Expand neighbours
    if (gx + 1 < w) enqueue(idx + 1);
    if (gx - 1 >= 0) enqueue(idx - 1);
    if (gz + 1 < h) enqueue(idx + w);
    if (gz - 1 >= 0) enqueue(idx - w);
  }

  return claimed;
}
