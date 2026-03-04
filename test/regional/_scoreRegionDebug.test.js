import { describe, it, expect } from 'vitest';
import { generateRegion } from '../../src/regional/region.js';
import { scoreRegion } from '../../src/regional/scoreRegion.js';

// ---------------------------------------------------------------------------
// Debug test: generates a region and prints all score details for tuning.
// Run: npx vitest run test/regional/_scoreRegionDebug.test.js
// ---------------------------------------------------------------------------

const SEED = 42;
const GRID_SIZE = 64;

function makeRegion(overrides = {}) {
  return generateRegion({
    seed: SEED,
    gridSize: GRID_SIZE,
    cellSize: 200,
    mountainousness: 0.4,
    roughness: 0.5,
    coastEdges: ['south'],
    seaLevelPercentile: 0.35,
    maxCities: 3,
    maxTowns: 5,
    maxVillages: 10,
    minCitySpacing: 12,
    minTownSpacing: 6,
    minVillageSpacing: 4,
    streamThreshold: 20,
    riverThreshold: 80,
    majorRiverThreshold: 300,
    geology: false,
    ...overrides,
  });
}

describe('scoreRegion debug output', () => {
  it('prints all check results for default region', () => {
    const region = makeRegion();
    const result = scoreRegion(region);

    console.log('\n=== Region Summary ===');
    console.log(`Settlements: ${region.settlements.length} (${region.settlements.map(s => s.rank).join(', ')})`);
    console.log(`Roads: ${region.roads.length}`);
    console.log(`Stream roots: ${region.drainage.streams.length}`);
    console.log(`Water cells: ${region.drainage.waterCells.size}`);
    console.log(`Crossings: ${region.drainage.crossings ? region.drainage.crossings.length : 0}`);

    console.log('\n=== Validity ===');
    for (const [k, v] of Object.entries(result.validity)) {
      console.log(`  ${k}: ${v.pass ? 'PASS' : 'FAIL'} — ${v.details}`);
    }

    console.log('\n=== Structural ===');
    for (const [k, v] of Object.entries(result.structural)) {
      console.log(`  ${k}: ${v.score.toFixed(3)} (thr=${v.threshold}) — ${v.details}`);
    }

    console.log('\n=== Quality ===');
    for (const [k, v] of Object.entries(result.quality)) {
      console.log(`  ${k}: ${v.score.toFixed(3)} — ${v.details}`);
    }

    console.log('\n=== Composite ===');
    console.log(`  valid: ${result.valid}`);
    console.log(`  structuralScore: ${result.structuralScore.toFixed(3)}`);
    console.log(`  qualityScore: ${result.qualityScore.toFixed(3)}`);
    console.log(`  overallScore: ${result.overallScore.toFixed(3)}`);

    // This test always passes — it's for visual inspection
    expect(result).toHaveProperty('valid');
    expect(result).toHaveProperty('overallScore');
  });

  it('prints results for different seeds', () => {
    for (const seed of [1, 99, 7777]) {
      const region = makeRegion({ seed });
      const result = scoreRegion(region);
      console.log(`\n--- Seed ${seed}: valid=${result.valid} structural=${result.structuralScore.toFixed(3)} quality=${result.qualityScore.toFixed(3)} overall=${result.overallScore.toFixed(3)}`);
      for (const [k, v] of Object.entries(result.validity)) {
        if (!v.pass) console.log(`  ${k}: FAIL — ${v.details}`);
      }
      for (const [k, v] of Object.entries(result.structural)) {
        if (v.score < v.threshold) console.log(`  ${k}: ${v.score.toFixed(3)} < ${v.threshold} — ${v.details}`);
      }
    }
    expect(true).toBe(true);
  });
});
