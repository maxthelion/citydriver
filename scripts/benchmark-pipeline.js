#!/usr/bin/env bun
/**
 * benchmark-pipeline.js
 *
 * Runs the city pipeline for every settlement in a set of regions and records
 * per-step timings via PipelineRunner hooks. Writes aggregated JSON + prints
 * a console summary table.
 *
 * Usage:
 *   bun scripts/benchmark-pipeline.js [options]
 *
 * Options:
 *   --seeds 42,100,999        Comma-separated seeds (default: 42,100,255,999,12345)
 *   --settlements N           Run the first N settlements per region (default: all)
 *   --stop-after <step>       Stop pipeline after this step ID (e.g. 'skeleton', 'zones')
 *   --archetype <name>        Force a specific archetype for all cities (e.g. 'marketTown')
 *                             Default: auto-select best archetype per settlement.
 *                             Only 'marketTown' has the organic growth pipeline.
 *   --out <path>              Output JSON path (default: output/pipeline-perf.json)
 *   --quiet                   Suppress per-city console lines
 *
 * Examples:
 *   # Full pipeline, 5 seeds, all settlements
 *   bun scripts/benchmark-pipeline.js
 *
 *   # Only skeleton step, 20 seeds, 3 settlements each
 *   bun scripts/benchmark-pipeline.js --seeds $(seq -s, 1 20) --settlements 3 --stop-after skeleton
 *
 *   # 10 seeds, write to custom path
 *   bun scripts/benchmark-pipeline.js --seeds 1,2,3,4,5,6,7,8,9,10 --out output/my-bench.json
 *
 * How it works:
 *   LandFirstDevelopment wraps a PipelineRunner. We attach an onAfter hook that
 *   records { id, ms } after every named step. No bespoke wrapping needed —
 *   the hook system from the pipeline refactor makes this free.
 *
 *   Step IDs follow the cityPipeline sequence:
 *     setup (recorded manually before the runner starts)
 *     skeleton | land-value | zones | zone-boundary | zones-refine | spatial
 *     growth-N:influence | growth-N:value | growth-N:ribbons |
 *     growth-N:allocate  | growth-N:roads   (per growth tick N)
 *     connect
 *
 * Spec: specs/v5/macro-plan.md § Stage 3 (Benchmarking)
 */

import { generateRegion } from '../src/regional/pipeline.js';
import { setupCity } from '../src/city/setup.js';
import { scoreSettlement } from '../src/city/archetypeScoring.js';
import { ARCHETYPES } from '../src/city/archetypes.js';
import { LandFirstDevelopment } from '../src/city/strategies/landFirstDevelopment.js';
import { SeededRandom } from '../src/core/rng.js';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';

// ── Arg parsing ────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));
const seeds         = (args.seeds ?? '42,100,255,999,12345').split(',').map(Number);
const maxSettl      = args.settlements != null ? Number(args.settlements) : Infinity;
const stopAfter     = args['stop-after'] ?? null;
const outPath       = args.out ?? 'output/pipeline-perf.json';
const quiet         = 'quiet' in args;
const forceArchName = args.archetype ?? null; // e.g. 'marketTown' to force growth path

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    out[k] = v;
  }
  return out;
}

// ── Run benchmark ──────────────────────────────────────────────────────────

const allCities = [];
let totalCities = 0;

console.log(`Seeds: ${seeds.join(', ')} | maxSettl: ${maxSettl === Infinity ? 'all' : maxSettl} | stopAfter: ${stopAfter ?? 'none'} | archetype: ${forceArchName ?? 'auto'}`);
console.log('');

for (const seed of seeds) {
  const rng = new SeededRandom(seed);

  // Generate region (not part of city pipeline timing)
  process.stdout.write(`seed ${seed}: generating region... `);
  const t0Region = performance.now();
  const layers = generateRegion(
    { width: 128, height: 128, cellSize: 50, seaLevel: 0 },
    rng
  );
  const regionMs = Math.round(performance.now() - t0Region);
  const settlements = layers.getData('settlements') ?? [];
  const toRun = maxSettl === Infinity ? settlements : settlements.slice(0, maxSettl);
  console.log(`${regionMs}ms, ${settlements.length} settlements (running ${toRun.length})`);

  for (let si = 0; si < toRun.length; si++) {
    const settlement = toRun[si];
    const tier  = settlement.tier ?? '?';
    const label = `seed-${seed} s[${si}] tier-${tier}`;

    const timings = [];  // [{ id, ms }]
    let stopped = false;

    // ── Step 0: setup (outside PipelineRunner, record manually) ──
    const t0setup = performance.now();
    const cityRng = new SeededRandom(seed * 1000 + si);
    const map = setupCity(layers, settlement, cityRng);
    timings.push({ id: 'setup', ms: performance.now() - t0setup });

    // ── Pick archetype ──
    let archetype;
    if (forceArchName) {
      archetype = ARCHETYPES[forceArchName] ?? null;
      if (!archetype) {
        console.error(`Unknown archetype '${forceArchName}'. Available: ${Object.keys(ARCHETYPES).join(', ')}`);
        process.exit(1);
      }
    } else {
      const scores = scoreSettlement(map);
      archetype = scores[0]?.archetype ?? null;
    }

    // ── Build strategy + attach timing hook ──
    const strategy = new LandFirstDevelopment(map, { archetype });

    strategy.runner.addHook({
      onAfter(id, _result, ms) {
        timings.push({ id, ms });
        if (stopAfter && id === stopAfter) stopped = true;
      },
    });

    // ── Run pipeline ──
    if (stopAfter) {
      while (!stopped && strategy.tick()) {}
    } else {
      while (strategy.tick()) {}
    }

    const totalMs = timings.reduce((s, t) => s + t.ms, 0);
    allCities.push({
      label,
      seed,
      settlementIdx: si,
      tier,
      archetype: archetype?.name ?? null,
      totalMs,
      timings: timings.map(t => ({ id: t.id, ms: Math.round(t.ms * 10) / 10 })),
    });
    totalCities++;

    if (!quiet) {
      const line = timings
        .map(t => `${t.id}=${Math.round(t.ms)}ms`)
        .join('  ');
      console.log(`  ${label.padEnd(30)} total=${Math.round(totalMs)}ms  ${line}`);
    }
  }
}

// ── Aggregate ──────────────────────────────────────────────────────────────

// Collect all unique step IDs in encounter order
const stepOrder = [];
const stepSeen  = new Set();
for (const city of allCities) {
  for (const t of city.timings) {
    if (!stepSeen.has(t.id)) { stepOrder.push(t.id); stepSeen.add(t.id); }
  }
}

// Group growth sub-steps: growth-N:phase → growth:phase (aggregated across ticks)
// Also keep the full granularity. We produce both.
const aggregate = stepOrder.map(id => {
  const times = allCities
    .flatMap(c => c.timings.filter(t => t.id === id).map(t => t.ms))
    .sort((a, b) => a - b);
  if (times.length === 0) return null;
  return {
    id,
    n:      times.length,
    meanMs: round1(times.reduce((s, v) => s + v, 0) / times.length),
    p50Ms:  round1(times[Math.floor(times.length * 0.50)]),
    p95Ms:  round1(times[Math.floor(times.length * 0.95)]),
    p99Ms:  round1(times[Math.min(Math.floor(times.length * 0.99), times.length - 1)]),
    maxMs:  round1(times[times.length - 1]),
  };
}).filter(Boolean);

// Collapsed growth view: group growth-N:phase into phase totals per city,
// then aggregate those totals. This answers "how much total time did value
// composition take across all growth ticks?"
const growthPhases = ['influence', 'value', 'ribbons', 'allocate', 'roads'];
const growthAgg = growthPhases.map(phase => {
  const pattern = new RegExp(`^growth-\\d+:${phase}$`);
  const perCityTotals = allCities.map(c =>
    c.timings.filter(t => pattern.test(t.id)).reduce((s, t) => s + t.ms, 0)
  ).filter(v => v > 0).sort((a, b) => a - b);

  if (perCityTotals.length === 0) return null;
  return {
    id:     `growth:${phase} (all ticks)`,
    n:      perCityTotals.length,
    meanMs: round1(perCityTotals.reduce((s, v) => s + v, 0) / perCityTotals.length),
    p50Ms:  round1(perCityTotals[Math.floor(perCityTotals.length * 0.50)]),
    p95Ms:  round1(perCityTotals[Math.floor(perCityTotals.length * 0.95)]),
    maxMs:  round1(perCityTotals[perCityTotals.length - 1]),
  };
}).filter(Boolean);

function round1(v) { return Math.round(v * 10) / 10; }

// ── Write output ────────────────────────────────────────────────────────────

mkdirSync(dirname(outPath), { recursive: true });

const output = {
  generatedAt: new Date().toISOString(),
  seeds,
  maxSettl:   maxSettl === Infinity ? 'all' : maxSettl,
  stopAfter,
  totalCities,
  aggregate,
  growthAggregate: growthAgg,
  cities: allCities,
};

writeFileSync(outPath, JSON.stringify(output, null, 2));

// ── Print summary ───────────────────────────────────────────────────────────

console.log(`\n${totalCities} cities across ${seeds.length} seeds\n`);

// Top-level step summary (non-growth steps + growth total)
const summarySteps = aggregate.filter(a => !a.id.match(/^growth-\d+:/));
if (summarySteps.length > 0) {
  console.log('Per-step aggregate (ms):');
  console.table(summarySteps.map(a => ({
    step: a.id, n: a.n, mean: a.meanMs, p50: a.p50Ms, p95: a.p95Ms, p99: a.p99Ms, max: a.maxMs,
  })));
}

if (growthAgg.length > 0) {
  console.log('\nGrowth phase totals across all ticks (ms):');
  console.table(growthAgg.map(a => ({
    phase: a.id, n: a.n, mean: a.meanMs, p50: a.p50Ms, p95: a.p95Ms, max: a.maxMs,
  })));
}

console.log(`\nFull results: ${outPath}`);
