#!/usr/bin/env bun
/**
 * benchmark-road-transactions.js
 *
 * Focused benchmark for the road-transaction hot path used by the sector
 * ribbon experiments. This is intentionally narrower than benchmark-pipeline:
 * it measures repeated tentative road adds against a realistic city fixture
 * and breaks out how much time is spent inside RoadNetwork.rebuildDerived().
 *
 * Usage:
 *   bun scripts/benchmark-road-transactions.js [options]
 *
 * Options:
 *   --seed 884469          Region seed (default: 884469)
 *   --gx 27                Settlement gx (default: 27)
 *   --gz 95                Settlement gz (default: 95)
 *   --step spatial         Pipeline stop point for the fixture (default: spatial)
 *   --segments 12          Number of source segments to sample (default: 12)
 *   --iterations 3         Repetitions per candidate (default: 3)
 *   --out output/road-transaction-bench.json
 *                          Output JSON path
 *   --quiet                Suppress per-case console lines
 */

import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { generateRegionFromSeed } from '../src/ui/regionHelper.js';
import { setupCity } from '../src/city/setup.js';
import { LandFirstDevelopment } from '../src/city/strategies/landFirstDevelopment.js';
import { ARCHETYPES } from '../src/city/archetypes.js';
import { SeededRandom } from '../src/core/rng.js';
import { runToStep } from './pipeline-utils.js';
import { tryAddRoad } from '../src/city/incremental/roadTransaction.js';

const args = parseArgs(process.argv.slice(2));
const seed = Number(args.seed ?? 884469);
const gx = Number(args.gx ?? 27);
const gz = Number(args.gz ?? 95);
const stepId = String(args.step ?? 'spatial');
const maxSegments = Number(args.segments ?? 12);
const iterations = Number(args.iterations ?? 3);
const outPath = String(args.out ?? 'output/road-transaction-bench.json');
const quiet = 'quiet' in args;

const setupStart = performance.now();
const { layers, settlement } = generateRegionFromSeed(seed, gx, gz);
if (!settlement) {
  console.error(`No settlement at seed=${seed} gx=${gx} gz=${gz}`);
  process.exit(1);
}

const rng = new SeededRandom(seed);
const map = setupCity(layers, settlement, rng.fork('city'));
const strategy = new LandFirstDevelopment(map, { archetype: ARCHETYPES.marketTown });
runToStep(strategy, stepId);
const setupMs = performance.now() - setupStart;

const sourceSegments = collectSourceSegments(map, maxSegments);
if (sourceSegments.length === 0) {
  console.error('No suitable source segments found');
  process.exit(1);
}

const candidateGroups = buildCandidateGroups(sourceSegments);
const profiler = createRebuildProfiler(map.roadNetwork);

const results = [];
for (const group of candidateGroups) {
  const rawStats = [];
  const txnStats = [];

  for (let iter = 0; iter < iterations; iter++) {
    for (const candidate of group.candidates) {
      rawStats.push(benchmarkAddRemove(map, candidate.points, profiler));
      txnStats.push(benchmarkTryAddRoad(map, candidate.points, profiler));
    }
  }

  results.push({
    caseId: group.caseId,
    description: group.description,
    candidateCount: group.candidates.length,
    iterations,
    rawAddRemove: summarizeStats(rawStats),
    tryAddRoad: summarizeStats(txnStats),
  });

  if (!quiet) {
    const txn = summarizeStats(txnStats);
    console.log(
      `${group.caseId.padEnd(22)} n=${txn.n.toString().padStart(3)} ` +
      `mean=${txn.meanMs.toFixed(1)}ms p95=${txn.p95Ms.toFixed(1)}ms ` +
      `rebuild=${txn.meanRebuildMs.toFixed(1)}ms ` +
      `accept=${txn.accepted}/${txn.n}`,
    );
  }
}

profiler.restore();

mkdirSync(dirname(outPath), { recursive: true });
const output = {
  seed,
  gx,
  gz,
  stepId,
  setupMs: round1(setupMs),
  sourceSegmentCount: sourceSegments.length,
  wayCount: map.roadNetwork.wayCount,
  nodeCount: map.roadNetwork.nodes.length,
  generatedAt: new Date().toISOString(),
  results,
};
writeFileSync(outPath, JSON.stringify(output, null, 2));

console.log('');
console.log(`Fixture: seed=${seed} gx=${gx} gz=${gz} step=${stepId}`);
console.log(`Setup: ${round1(setupMs)}ms | ways=${map.roadNetwork.wayCount} nodes=${map.roadNetwork.nodes.length}`);
console.log(`Output: ${outPath}`);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    out[key] = value;
  }
  return out;
}

function collectSourceSegments(map, limit) {
  const segments = [];
  for (const way of map.roadNetwork.ways) {
    const pts = way.polyline || [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < 18) continue;
      segments.push({
        wayId: way.id,
        a: { x: a.x, z: a.z },
        b: { x: b.x, z: b.z },
        length,
      });
    }
  }
  segments.sort((lhs, rhs) => rhs.length - lhs.length);
  return segments.slice(0, limit);
}

function buildCandidateGroups(sourceSegments) {
  return [
    {
      caseId: 'parallel-near-reject',
      description: 'Offset 3m from an existing segment; should usually reject as parallel.',
      candidates: sourceSegments.map(seg => ({
        sourceWayId: seg.wayId,
        points: offsetSegment(seg, 3),
      })),
    },
    {
      caseId: 'parallel-far-accept',
      description: 'Offset 8m from an existing segment; often accepted.',
      candidates: sourceSegments.map(seg => ({
        sourceWayId: seg.wayId,
        points: offsetSegment(seg, 8),
      })),
    },
    {
      caseId: 'endpoint-through',
      description: 'Extend a segment beyond one endpoint; exercises shared-endpoint continuation.',
      candidates: sourceSegments.map(seg => ({
        sourceWayId: seg.wayId,
        points: extendSegmentFromEndpoint(seg, 28),
      })),
    },
    {
      caseId: 'midpoint-cross',
      description: 'Perpendicular cut through segment midpoint; likely crossing or junction case.',
      candidates: sourceSegments.map(seg => ({
        sourceWayId: seg.wayId,
        points: perpendicularThroughMidpoint(seg, 28),
      })),
    },
  ];
}

function offsetSegment(seg, offset) {
  const dx = seg.b.x - seg.a.x;
  const dz = seg.b.z - seg.a.z;
  const len = Math.hypot(dx, dz) || 1;
  const nx = -dz / len;
  const nz = dx / len;
  return [
    { x: seg.a.x + nx * offset, z: seg.a.z + nz * offset },
    { x: seg.b.x + nx * offset, z: seg.b.z + nz * offset },
  ];
}

function extendSegmentFromEndpoint(seg, distance) {
  const dx = seg.b.x - seg.a.x;
  const dz = seg.b.z - seg.a.z;
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len;
  const uz = dz / len;
  return [
    { x: seg.b.x, z: seg.b.z },
    { x: seg.b.x + ux * distance, z: seg.b.z + uz * distance },
  ];
}

function perpendicularThroughMidpoint(seg, halfLength) {
  const dx = seg.b.x - seg.a.x;
  const dz = seg.b.z - seg.a.z;
  const len = Math.hypot(dx, dz) || 1;
  const nx = -dz / len;
  const nz = dx / len;
  const mx = (seg.a.x + seg.b.x) * 0.5;
  const mz = (seg.a.z + seg.b.z) * 0.5;
  return [
    { x: mx - nx * halfLength, z: mz - nz * halfLength },
    { x: mx + nx * halfLength, z: mz + nz * halfLength },
  ];
}

function createRebuildProfiler(roadNetwork) {
  const original = roadNetwork.rebuildDerived.bind(roadNetwork);
  const stats = { calls: 0, ms: 0 };
  roadNetwork.rebuildDerived = function patchedRebuildDerived(...args) {
    const t0 = performance.now();
    try {
      return original(...args);
    } finally {
      stats.calls++;
      stats.ms += performance.now() - t0;
    }
  };
  return {
    snapshot() {
      return { calls: stats.calls, ms: stats.ms };
    },
    reset() {
      stats.calls = 0;
      stats.ms = 0;
    },
    restore() {
      roadNetwork.rebuildDerived = original;
    },
  };
}

function benchmarkAddRemove(map, points, profiler) {
  profiler.reset();
  const t0 = performance.now();
  const way = map.roadNetwork.add(points, { hierarchy: 'residential', source: 'bench-raw' });
  map.roadNetwork.remove(way.id);
  const totalMs = performance.now() - t0;
  const snapshot = profiler.snapshot();
  return {
    accepted: true,
    totalMs,
    rebuildCalls: snapshot.calls,
    rebuildMs: snapshot.ms,
  };
}

function benchmarkTryAddRoad(map, points, profiler) {
  profiler.reset();
  const t0 = performance.now();
  const result = tryAddRoad(map, points, { hierarchy: 'residential', source: 'bench-txn' });
  const totalMs = performance.now() - t0;
  const snapshot = profiler.snapshot();
  if (result.accepted && result.way) {
    map.roadNetwork.remove(result.way.id);
  }
  return {
    accepted: result.accepted,
    totalMs,
    rebuildCalls: snapshot.calls,
    rebuildMs: snapshot.ms,
  };
}

function summarizeStats(stats) {
  const sorted = [...stats].sort((lhs, rhs) => lhs.totalMs - rhs.totalMs);
  const rebuilds = stats.map(item => item.rebuildMs);
  const calls = stats.map(item => item.rebuildCalls);
  const accepted = stats.filter(item => item.accepted).length;
  return {
    n: stats.length,
    accepted,
    rejected: stats.length - accepted,
    meanMs: round1(mean(sorted.map(item => item.totalMs))),
    p50Ms: round1(percentile(sorted.map(item => item.totalMs), 0.5)),
    p95Ms: round1(percentile(sorted.map(item => item.totalMs), 0.95)),
    maxMs: round1(sorted[sorted.length - 1]?.totalMs ?? 0),
    meanRebuildMs: round1(mean(rebuilds)),
    p95RebuildMs: round1(percentile(rebuilds, 0.95)),
    meanRebuildCalls: round2(mean(calls)),
  };
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((lhs, rhs) => lhs - rhs);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[index];
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}
