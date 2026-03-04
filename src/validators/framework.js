/**
 * Validation framework.
 * Three tiers:
 *   Tier 1 (validity) — boolean, must pass
 *   Tier 2 (structure) — scored 0.0–1.0, thresholds
 *   Tier 3 (quality) — scored 0.0–1.0, soft
 */

/**
 * Run a set of validators against a LayerStack.
 *
 * Each check is: { name, tier, fn }
 *   tier 1: fn(layers) => boolean
 *   tier 2: fn(layers) => number (0-1)
 *   tier 3: fn(layers) => number (0-1)
 *
 * @param {import('../core/LayerStack.js').LayerStack} layers
 * @param {Array<{name: string, tier: number, fn: Function}>} checks
 * @returns {{ results: Array<{name, tier, value}>, valid: boolean, structural: number, quality: number, overall: number }}
 */
export function runValidators(layers, checks) {
  const results = [];

  for (const check of checks) {
    try {
      const value = check.fn(layers);
      results.push({ name: check.name, tier: check.tier, value });
    } catch (err) {
      // A crashing validator counts as failure
      results.push({
        name: check.name,
        tier: check.tier,
        value: check.tier === 1 ? false : 0,
        error: err.message,
      });
    }
  }

  return computeScores(results);
}

/**
 * Compute composite scores from validator results.
 */
export function computeScores(results) {
  // Tier 1: all must be true
  const tier1 = results.filter(r => r.tier === 1);
  const valid = tier1.every(r => r.value === true);

  // Tier 2: weighted mean (equal weights for now)
  const tier2 = results.filter(r => r.tier === 2);
  const structural = tier2.length > 0
    ? tier2.reduce((sum, r) => sum + r.value, 0) / tier2.length
    : 1;

  // Tier 3: weighted mean
  const tier3 = results.filter(r => r.tier === 3);
  const quality = tier3.length > 0
    ? tier3.reduce((sum, r) => sum + r.value, 0) / tier3.length
    : 1;

  // Overall: gated by validity
  const overall = valid ? structural * 0.6 + quality * 0.4 : 0;

  return { results, valid, structural, quality, overall };
}

/**
 * Format validator results for display.
 */
export function formatResults({ results, valid, structural, quality, overall }) {
  const lines = [];
  lines.push(`Valid: ${valid ? 'PASS' : 'FAIL'}`);
  lines.push(`Structural: ${(structural * 100).toFixed(1)}%`);
  lines.push(`Quality: ${(quality * 100).toFixed(1)}%`);
  lines.push(`Overall: ${(overall * 100).toFixed(1)}%`);
  lines.push('');

  for (const r of results) {
    const prefix = `T${r.tier}`;
    const val = r.tier === 1
      ? (r.value ? 'PASS' : 'FAIL')
      : `${(r.value * 100).toFixed(1)}%`;
    lines.push(`  [${prefix}] ${r.name}: ${val}${r.error ? ` (ERROR: ${r.error})` : ''}`);
  }

  return lines.join('\n');
}
