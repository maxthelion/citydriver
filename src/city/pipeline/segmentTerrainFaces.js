/**
 * Terrain face segmentation.
 *
 * Splits a development zone into terrain faces — groups of cells with consistent
 * slope direction (within ~45°) and steepness band. Each face gets its own ribbon
 * street layout with a direction suited to its terrain character.
 *
 * Algorithm (O(n) — no flood-fill merge):
 * 1. For each cell, compute slope direction octant (0–7) and steepness band (0–2).
 * 2. Group cells by (octant, steepnessBand) bucket directly — no BFS needed.
 * 3. Merge buckets smaller than MIN_FACE_CELLS into the largest adjacent bucket.
 * 4. Return at most MAX_FACES face objects (shaped like zones) for ribbon layout.
 *
 * Spec: specs/v5/next-steps.md § Step 5
 */

const SLOPE_FLAT     = 0.05;   // < 5%  → steepness band 0 (flat, regular grid)
const SLOPE_MODERATE = 0.20;   // < 20% → steepness band 1 (contour ribbons)
const SLOPE_STEEP    = 0.35;   // < 35% → steepness band 2 (tight terraces)
const N_OCTANTS      = 8;      // 45° resolution per octant
const MIN_FACE_CELLS = 300;    // merge faces smaller than this
const MAX_FACES      = 6;      // cap — never produce more than this many faces

/**
 * Segment a zone into terrain faces.
 *
 * @param {object} zone - Development zone with `cells` array and zone metadata.
 * @param {object} map  - FeatureMap with getLayer('elevation'), cellSize, etc.
 * @returns {object[]} Array of face objects shaped like zones.
 *                     Returns [zone] if elevation unavailable or zone is too small.
 */
export function segmentZoneIntoFaces(zone, map) {
  const elevation = map.hasLayer('elevation') ? map.getLayer('elevation') : null;
  if (!elevation || !zone.cells || zone.cells.length < MIN_FACE_CELLS * 2) {
    return [zone];
  }

  const w  = map.width;
  const h  = map.height;

  // ── Step 1: classify each cell into a bucket ──────────────────────────────
  // buckets[octant * 3 + steepnessBand] = { cells[], slopeSum, gradX, gradZ }
  const NUM_BUCKETS = N_OCTANTS * 3;
  const buckets = Array.from({ length: NUM_BUCKETS }, () => ({
    cells: [], slopeSum: 0, gradX: 0, gradZ: 0,
  }));

  for (const cell of zone.cells) {
    const { dx, dz, mag } = _slopeGradient(elevation, cell.gx, cell.gz, w, h);
    const octant       = _directionOctant(dx, dz);
    const steepnessBand = mag < SLOPE_FLAT ? 0 : mag < SLOPE_MODERATE ? 1 : mag < SLOPE_STEEP ? 2 : 2;
    const bi = octant * 3 + steepnessBand;
    const b  = buckets[bi];
    b.cells.push(cell);
    b.slopeSum += mag;
    b.gradX    += dx;
    b.gradZ    += dz;
  }

  // ── Step 2: merge small buckets into the adjacent octant bucket ─────────────
  // "Adjacent" means neighbouring octant (±1 wrap) with same steepness band.
  // We merge into the largest neighbour.
  // Run once — no while loop needed since adjacent buckets absorb small ones.
  let changed = true;
  const maxPasses = 4; // safety cap
  for (let pass = 0; pass < maxPasses && changed; pass++) {
    changed = false;
    for (let bi = 0; bi < NUM_BUCKETS; bi++) {
      const b = buckets[bi];
      if (b.cells.length === 0) continue;
      if (b.cells.length >= MIN_FACE_CELLS) continue;

      // Find the largest adjacent bucket (same steepnessBand, octant ±1)
      const octant       = Math.floor(bi / 3);
      const steepnessBand = bi % 3;
      let bestBi = -1, bestSize = 0;

      for (const dOct of [-1, 1]) {
        const adjOct = (octant + dOct + N_OCTANTS) % N_OCTANTS;
        const adjBi  = adjOct * 3 + steepnessBand;
        if (buckets[adjBi].cells.length > bestSize) {
          bestSize = buckets[adjBi].cells.length;
          bestBi   = adjBi;
        }
      }

      if (bestBi < 0) continue; // isolated bucket — keep as-is

      // Merge b into bestBi
      const target = buckets[bestBi];
      target.cells.push(...b.cells);
      target.slopeSum += b.slopeSum;
      target.gradX    += b.gradX;
      target.gradZ    += b.gradZ;
      b.cells    = [];
      b.slopeSum = 0;
      b.gradX    = 0;
      b.gradZ    = 0;
      changed = true;
    }
  }

  // ── Step 3: build face objects for non-empty buckets ──────────────────────
  const activeBuckets = buckets.filter(b => b.cells.length > 0);

  // If only one bucket (or zone is essentially uniform), return the whole zone.
  if (activeBuckets.length <= 1) return [zone];

  // Cap at MAX_FACES — merge the smallest buckets into their largest neighbour.
  while (activeBuckets.length > MAX_FACES) {
    activeBuckets.sort((a, b) => a.cells.length - b.cells.length);
    const smallest = activeBuckets.shift(); // remove smallest
    const largest  = activeBuckets[activeBuckets.length - 1];
    largest.cells.push(...smallest.cells);
    largest.slopeSum += smallest.slopeSum;
    largest.gradX    += smallest.gradX;
    largest.gradZ    += smallest.gradZ;
  }

  // ── Step 4: build face objects shaped like zones ───────────────────────────
  return activeBuckets.map((b, i) => {
    const n        = b.cells.length;
    const avgSlope = n > 0 ? b.slopeSum / n : zone.avgSlope;
    const gradLen  = Math.sqrt(b.gradX ** 2 + b.gradZ ** 2);
    const slopeDir = gradLen > 0.01
      ? { x: b.gradX / gradLen, z: b.gradZ / gradLen }
      : zone.slopeDir;

    let cx = 0, cz = 0;
    for (const c of b.cells) { cx += c.gx; cz += c.gz; }
    cx /= n; cz /= n;

    return {
      id:          `${zone.id}-f${i}`,
      cells:       b.cells,
      centroidGx:  cx,
      centroidGz:  cz,
      avgSlope,
      slopeDir,
      nucleusIdx:  zone.nucleusIdx,

      // Carry over zone fields needed by layoutRibbons / connectToNetwork
      avgLandValue:    zone.avgLandValue,
      totalLandValue:  zone.totalLandValue * (n / zone.cells.length),
      priority:        zone.priority,
      polygon:         zone.polygon,
      boundingEdgeIds: zone.boundingEdgeIds,
      boundary:        zone.boundary,
      _spine:          null,
      _streets:        null,
      _crossStreets:   null,
    };
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Compute slope gradient at (gx, gz) using central differences. */
function _slopeGradient(elevation, gx, gz, w, h) {
  const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
  const gxL = clamp(gx - 1, 0, w - 1), gxR = clamp(gx + 1, 0, w - 1);
  const gzL = clamp(gz - 1, 0, h - 1), gzR = clamp(gz + 1, 0, h - 1);
  const dx  = (elevation.get(gxR, gz) - elevation.get(gxL, gz)) / (gxR - gxL || 1);
  const dz  = (elevation.get(gx, gzR) - elevation.get(gx, gzL)) / (gzR - gzL || 1);
  const mag = Math.sqrt(dx * dx + dz * dz);
  return { dx, dz, mag };
}

/** Map gradient direction to one of N_OCTANTS (0 = +x, clockwise). */
function _directionOctant(dx, dz) {
  if (dx === 0 && dz === 0) return 0;
  const angle      = Math.atan2(dz, dx);          // -π..π
  const normalized = (angle + Math.PI) / (2 * Math.PI); // 0..1
  return Math.floor(normalized * N_OCTANTS) % N_OCTANTS;
}
