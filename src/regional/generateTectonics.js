/**
 * A0. Tectonic context generation.
 *
 * Two random variables drive the macro-scale character of the region:
 *   plateAngle:  direction compression comes FROM (radians, 0–2π)
 *   intensity:   0 (passive margin) to 1 (active collision)
 *
 * Everything else — coast placement, ridge direction, geology bias,
 * mountain amplitude — is derived from these two values.
 */

// --- Tuning constants ---
// All derived values are linear interpolations: BASE + intensity * SCALE

// Intensity random range
const INTENSITY_MIN = 0.1;
const INTENSITY_MAX = 0.9;

// Band direction jitter (radians) around ridge angle
const BAND_DIRECTION_JITTER = 0.2;

// Igneous intrusion count: 1 (passive) to 4 (active)
const INTRUSION_BASE = 1;
const INTRUSION_SCALE = 3;

// Geology band count: 4 (passive) to 7 (active)
const BAND_COUNT_BASE = 4;
const BAND_COUNT_SCALE = 3;

// Large-scale mountain ridge amplitude (meters)
const RIDGE_AMP_BASE = 80;
const RIDGE_AMP_SCALE = 1120;  // 80–1200m

// Detail ridge strength multiplier: 0.3 (passive) to 1.0 (active)
const DETAIL_STRENGTH_BASE = 0.3;
const DETAIL_STRENGTH_SCALE = 0.7;

// Coastal shelf width (normalized): 0.35 (passive, wide) to 0.10 (active, narrow)
const SHELF_WIDTH_BASE = 0.35;
const SHELF_WIDTH_SCALE = -0.25;

// Rock type hard/soft bias: 0.2 (passive, sedimentary) to 0.8 (active, igneous)
const HARD_BIAS_BASE = 0.2;
const HARD_BIAS_SCALE = 0.6;

// Treeline: base elevation + fraction of ridge amplitude
const TREELINE_BASE = 80;
const TREELINE_RIDGE_FRACTION = 0.6;

// Probability of a second adjacent coast edge
const SECOND_COAST_PROB = 0.2;

/**
 * @param {object} params
 * @param {string[]} [params.coastEdges] - Override coast edges (skip derivation)
 * @param {number} [params.plateAngle] - Override plate angle
 * @param {number} [params.intensity] - Override tectonic intensity
 * @param {import('../core/rng.js').SeededRandom} rng
 * @returns {TectonicContext}
 */
export function generateTectonics(params, rng) {
  const tecRng = rng.fork('tectonics');

  const plateAngle = params.plateAngle ?? tecRng.range(0, Math.PI * 2);
  const intensity = params.intensity ?? tecRng.range(INTENSITY_MIN, INTENSITY_MAX);

  const ridgeAngle = plateAngle + Math.PI / 2;

  const asymmetryDir = {
    x: Math.cos(plateAngle),
    z: Math.sin(plateAngle),
  };

  const coastEdges = params.coastEdges ?? _deriveCoastEdges(plateAngle, tecRng);

  const bandDirection = ridgeAngle + tecRng.range(-BAND_DIRECTION_JITTER, BAND_DIRECTION_JITTER);
  const intrusionCount = Math.round(INTRUSION_BASE + intensity * INTRUSION_SCALE);
  const bandCount = Math.round(BAND_COUNT_BASE + intensity * BAND_COUNT_SCALE);
  const ridgeAmplitude = RIDGE_AMP_BASE + intensity * RIDGE_AMP_SCALE;
  const detailRidgeStrength = DETAIL_STRENGTH_BASE + intensity * DETAIL_STRENGTH_SCALE;
  const coastalShelfWidth = SHELF_WIDTH_BASE + intensity * SHELF_WIDTH_SCALE;
  const rockBias = { hardBias: HARD_BIAS_BASE + intensity * HARD_BIAS_SCALE };
  const treeline = TREELINE_BASE + ridgeAmplitude * TREELINE_RIDGE_FRACTION;

  return {
    plateAngle,
    intensity,
    ridgeAngle,
    asymmetryDir,
    coastEdges,
    bandDirection,
    bandCount,
    intrusionCount,
    ridgeAmplitude,
    detailRidgeStrength,
    coastalShelfWidth,
    rockBias,
    treeline,
  };
}

/**
 * Derive which map edge(s) are coastline from the plate angle.
 * The coast faces the compression source direction.
 */
function _deriveCoastEdges(plateAngle, rng) {
  // Normalize to 0–2π
  const a = ((plateAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

  // Map angle to primary edge:
  // 0 (east) → east coast, π/2 → south, π → west, 3π/2 → north
  const edges = ['east', 'south', 'west', 'north'];
  const idx = Math.round(a / (Math.PI / 2)) % 4;

  const result = [edges[idx]];
  if (rng.range(0, 1) < SECOND_COAST_PROB) {
    const adj = edges[(idx + (rng.range(0, 1) < 0.5 ? 1 : 3)) % 4];
    result.push(adj);
  }

  return result;
}
