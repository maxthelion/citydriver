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
 * 1. Collect eligible cells and score them from the value bitmap.
 * 2. Pick multiple seed locations (top-scoring, spaced apart by minSpacing).
 * 3. BFS-expand from ALL seeds simultaneously, always picking the
 *    highest-value frontier cell next. This produces multiple organic
 *    clusters that grow in parallel.
 * 4. Add noise to scores for irregular shapes.
 *
 * @param {object} opts
 * @param {Float32Array} opts.valueLayer  - Per-cell value scores (length = w*h)
 * @param {Grid2D}       opts.resGrid     - Reservation grid (read + write, uint8)
 * @param {Grid2D}       opts.zoneGrid    - Zone eligibility (read only; > 0 = eligible)
 * @param {Float32Array|null} [opts.devProximity] - Development proximity blur;
 *   when provided, cells with devProximity === 0 are skipped.
 * @param {number}       opts.resType     - RESERVATION value to write
 * @param {number}       opts.budget      - Max cells to claim
 * @param {number}       [opts.minFootprint=1] - Minimum cluster size
 * @param {number}       [opts.seedCount=3] - Number of seed locations
 * @param {number}       [opts.minSpacing=20] - Min distance between seeds (cells)
 * @param {number}       [opts.noise=0.15] - Random noise added to BFS scores for organic shapes
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
  seedCount = 3,
  minSpacing = 20,
  noise = 0.15,
  w,
  h,
}) {
  if (budget <= 0) return [];

  // Step 1: collect eligible cells with positive value
  const eligible = new Uint8Array(w * h);
  const candidates = []; // for seed selection

  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (zoneGrid.get(gx, gz) === 0) continue;
      if (resGrid.get(gx, gz) !== RESERVATION.NONE) continue;
      const idx = gz * w + gx;
      if (devProximity !== null && devProximity[idx] === 0) continue;
      const score = valueLayer[idx];
      if (score <= 0) continue;
      eligible[idx] = 1;
      candidates.push({ idx, score });
    }
  }

  if (candidates.length === 0) return [];

  // Step 2: pick multiple seeds, spaced apart
  candidates.sort((a, b) => b.score - a.score);
  const seeds = [];
  const minSpacingSq = minSpacing * minSpacing;

  for (const c of candidates) {
    if (seeds.length >= seedCount) break;
    const gx = c.idx % w;
    const gz = (c.idx - gx) / w;
    let tooClose = false;
    for (const s of seeds) {
      const sx = s.idx % w;
      const sz = (s.idx - sx) / w;
      const dx = gx - sx, dz = gz - sz;
      if (dx * dx + dz * dz < minSpacingSq) { tooClose = true; break; }
    }
    if (!tooClose) seeds.push(c);
  }

  if (seeds.length === 0) return [];

  // Step 3: BFS from all seeds simultaneously
  const claimed = [];
  const visited = new Uint8Array(w * h);
  const frontier = [];

  const enqueue = (idx) => {
    if (visited[idx]) return;
    if (!eligible[idx]) return;
    visited[idx] = 1;
    // Add noise for organic shapes
    const score = valueLayer[idx] + Math.random() * noise;
    frontier.push({ idx, score });
  };

  // Seed the frontier from all seeds
  for (const s of seeds) {
    enqueue(s.idx);
  }

  while (claimed.length < budget && frontier.length > 0) {
    // Pick highest-score candidate
    let bestI = 0;
    for (let i = 1; i < frontier.length; i++) {
      if (frontier[i].score > frontier[bestI].score) bestI = i;
    }
    const { idx } = frontier[bestI];
    frontier[bestI] = frontier[frontier.length - 1];
    frontier.pop();

    // Double-check still eligible (another agent may have claimed between enqueue and now)
    if (resGrid.data[idx] !== RESERVATION.NONE) continue;

    const gx = idx % w;
    const gz = (idx - gx) / w;

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
