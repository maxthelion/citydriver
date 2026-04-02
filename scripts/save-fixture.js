#!/usr/bin/env bun

import { generateRegionFromSeed } from '../src/ui/regionHelper.js';
import { buildCityMap } from '../src/city/buildCityMap.js';
import { saveMapFixture } from '../src/core/featureMapFixture.js';

const args = parseArgs(process.argv.slice(2));
const seed = Number(args.seed ?? 42);
const gx = args.gx != null ? Number(args.gx) : null;
const gz = args.gz != null ? Number(args.gz) : null;
const step = String(args.step ?? 'spatial');
const archetype = args.archetype ?? 'auto';
const outPath = args.out ?? defaultFixturePath(seed, step);

const t0 = performance.now();
const { layers, settlement } = generateRegionFromSeed(seed, gx, gz);
if (!settlement) {
  console.error(`No settlement found for seed=${seed}${gx != null && gz != null ? ` near (${gx},${gz})` : ''}`);
  process.exit(1);
}

const { map, archetype: resolvedArchetype } = await buildCityMap({
  seed,
  layers,
  settlement,
  archetype,
  step,
});

const saved = await saveMapFixture(map, outPath, {
  meta: {
    seed,
    gx: settlement.gx,
    gz: settlement.gz,
    afterStep: step,
    archetype: resolvedArchetype?.name ?? null,
  },
});

console.log(`Fixture saved in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
console.log(`  JSON: ${saved.jsonPath}`);
console.log(`  BIN:  ${saved.binPath}`);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    out[key] = value;
  }
  return out;
}

function defaultFixturePath(seedValue, stepId) {
  return `test/fixtures/seed-${seedValue}-after-${stepId}`;
}
