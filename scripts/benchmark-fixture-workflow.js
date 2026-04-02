#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { generateRegionFromSeed } from '../src/ui/regionHelper.js';
import { buildCityMap } from '../src/city/buildCityMap.js';
import { saveMapFixture, loadMapFixture } from '../src/core/featureMapFixture.js';

const args = parseArgs(process.argv.slice(2));
const seed = Number(args.seed ?? 884469);
const gx = Number(args.gx ?? 27);
const gz = Number(args.gz ?? 95);
const step = String(args.step ?? 'spatial');
const archetype = String(args.archetype ?? 'auto');
const script = String(args.script ?? 'render-sector-ribbons.js');
const experiment = String(args.experiment ?? '031j');
const margin = Number(args.margin ?? 12);
const cropZone = args['crop-zone'] != null ? Number(args['crop-zone']) : 0;
const outPath = resolve(args.out ?? 'output/fixture-workflow-bench.json');

const tempRoot = join(tmpdir(), `fixture-bench-${Date.now()}`);
mkdirSync(tempRoot, { recursive: true });

const buildStart = performance.now();
const { layers, settlement } = generateRegionFromSeed(seed, gx, gz);
if (!settlement) {
  console.error(`No settlement at seed=${seed} gx=${gx} gz=${gz}`);
  process.exit(1);
}
const { map, archetype: resolvedArchetype, stepCount, lastStepId } = await buildCityMap({
  seed,
  layers,
  settlement,
  archetype,
  step,
});
const buildMs = performance.now() - buildStart;

const fullFixtureBase = join(tempRoot, `seed-${seed}-after-${step}`);
const fullSaveStart = performance.now();
await saveMapFixture(map, fullFixtureBase, {
  meta: {
    seed,
    gx,
    gz,
    settlementGx: settlement.gx,
    settlementGz: settlement.gz,
    afterStep: step,
    lastStepId,
    stepCount,
    archetypeId: resolvedArchetype?.id ?? null,
    archetype: resolvedArchetype?.name ?? null,
  },
});
const fullSaveMs = performance.now() - fullSaveStart;

const fullLoadStart = performance.now();
await loadMapFixture(`${fullFixtureBase}.json`);
const fullLoadMs = performance.now() - fullLoadStart;

const fullRenderDir = join(tempRoot, 'render-full');
const fullRenderMs = runFixtureRender({
  script,
  fixturePath: `${fullFixtureBase}.json`,
  outDir: fullRenderDir,
  experiment,
});

const crop = resolveZoneCrop(map, cropZone, margin);
const cropFixtureBase = join(tempRoot, `seed-${seed}-zone-${crop.zoneId ?? cropZone}-crop`);
const cropSaveStart = performance.now();
await saveMapFixture(map, cropFixtureBase, {
  crop,
  meta: {
    seed,
    gx,
    gz,
    settlementGx: settlement.gx,
    settlementGz: settlement.gz,
    afterStep: step,
    lastStepId,
    stepCount,
    archetypeId: resolvedArchetype?.id ?? null,
    archetype: resolvedArchetype?.name ?? null,
  },
});
const cropSaveMs = performance.now() - cropSaveStart;

const cropLoadStart = performance.now();
await loadMapFixture(`${cropFixtureBase}.json`);
const cropLoadMs = performance.now() - cropLoadStart;

const cropRenderDir = join(tempRoot, 'render-crop');
const cropRenderMs = runFixtureRender({
  script,
  fixturePath: `${cropFixtureBase}.json`,
  outDir: cropRenderDir,
  experiment,
});

const result = {
  generatedAt: new Date().toISOString(),
  seed,
  gx,
  gz,
  step,
  script,
  experiment,
  buildMs: round1(buildMs),
  fullFixture: {
    path: `${fullFixtureBase}.json`,
    saveMs: round1(fullSaveMs),
    loadMs: round1(fullLoadMs),
    renderMs: round1(fullRenderMs),
  },
  croppedFixture: {
    path: `${cropFixtureBase}.json`,
    crop,
    saveMs: round1(cropSaveMs),
    loadMs: round1(cropLoadMs),
    renderMs: round1(cropRenderMs),
  },
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(result, null, 2));

console.log(JSON.stringify(result, null, 2));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    out[key] = value;
  }
  return out;
}

function runFixtureRender({ script, fixturePath, outDir, experiment }) {
  const start = performance.now();
  execFileSync('bun', [
    `scripts/${script}`,
    '--fixture',
    fixturePath,
    '--out',
    outDir,
    '--experiment',
    experiment,
  ], { stdio: 'inherit' });
  return performance.now() - start;
}

function resolveZoneCrop(map, zoneRef, margin) {
  const zones = map.developmentZones || [];
  const zoneIndex = zones.findIndex(zone => zone?.id === zoneRef);
  const resolvedIndex = zoneIndex >= 0 ? zoneIndex : zoneRef;
  const zone = zones[resolvedIndex];
  if (!zone?.cells?.length) {
    throw new Error(`Could not find zone ${zoneRef} for crop benchmark`);
  }

  let minGx = Infinity;
  let minGz = Infinity;
  let maxGx = -Infinity;
  let maxGz = -Infinity;
  for (const cell of zone.cells) {
    if (cell.gx < minGx) minGx = cell.gx;
    if (cell.gz < minGz) minGz = cell.gz;
    if (cell.gx > maxGx) maxGx = cell.gx;
    if (cell.gz > maxGz) maxGz = cell.gz;
  }

  return {
    source: 'zone',
    zoneId: zone.id ?? null,
    zoneIndex: resolvedIndex,
    margin,
    minGx: Math.max(0, Math.floor(minGx - margin)),
    minGz: Math.max(0, Math.floor(minGz - margin)),
    maxGx: Math.min(map.width - 1, Math.ceil(maxGx + margin)),
    maxGz: Math.min(map.height - 1, Math.ceil(maxGz + margin)),
  };
}

function round1(value) {
  return Math.round(value * 10) / 10;
}
