#!/usr/bin/env bun

import { generateRegionFromSeed } from '../src/ui/regionHelper.js';
import { buildCityMap } from '../src/city/buildCityMap.js';
import { saveMapFixture } from '../src/core/featureMapFixture.js';
import { getHeadCommit } from './provenance.js';

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

const { map, archetype: resolvedArchetype, stepCount, lastStepId } = await buildCityMap({
  seed,
  layers,
  settlement,
  archetype,
  step,
});

const crop = resolveCropArgs(map, args);

const saved = await saveMapFixture(map, outPath, {
  crop,
  meta: {
    seed,
    gx: gx ?? settlement.gx,
    gz: gz ?? settlement.gz,
    settlementGx: settlement.gx,
    settlementGz: settlement.gz,
    afterStep: step,
    lastStepId,
    stepCount,
    archetypeId: resolvedArchetype?.id ?? null,
    archetype: resolvedArchetype?.name ?? null,
    commitSha: getHeadCommit(),
    crop: crop ? {
      minGx: crop.minGx,
      minGz: crop.minGz,
      maxGx: crop.maxGx,
      maxGz: crop.maxGz,
      source: crop.source ?? null,
      zoneId: crop.zoneId ?? null,
      zoneIndex: crop.zoneIndex ?? null,
      margin: crop.margin ?? null,
    } : undefined,
  },
});

console.log(`Fixture saved in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
console.log(`  JSON: ${saved.jsonPath}`);
console.log(`  BIN:  ${saved.binPath}`);
if (crop) {
  console.log(`  Crop: (${crop.minGx},${crop.minGz}) → (${crop.maxGx},${crop.maxGz})`);
}

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

function resolveCropArgs(map, args) {
  const explicitCrop = args.crop;
  const cropZone = args['crop-zone'];
  if (explicitCrop && cropZone) {
    throw new Error('Use either --crop or --crop-zone, not both');
  }
  if (explicitCrop) {
    const parts = String(explicitCrop).split(',').map(Number);
    if (parts.length !== 4 || parts.some(value => !Number.isFinite(value))) {
      throw new Error(`Invalid --crop value: ${explicitCrop}`);
    }
    const [rawMinGx, rawMinGz, rawMaxGx, rawMaxGz] = parts;
    return {
      source: 'bounds',
      minGx: Math.max(0, Math.min(rawMinGx, rawMaxGx)),
      minGz: Math.max(0, Math.min(rawMinGz, rawMaxGz)),
      maxGx: Math.min(map.width - 1, Math.max(rawMinGx, rawMaxGx)),
      maxGz: Math.min(map.height - 1, Math.max(rawMinGz, rawMaxGz)),
    };
  }
  if (!cropZone) return null;

  const zoneKey = Number(cropZone);
  if (!Number.isFinite(zoneKey)) {
    throw new Error(`Invalid --crop-zone value: ${cropZone}`);
  }
  const margin = Math.max(0, Number(args.margin ?? 50));
  const zones = map.developmentZones || [];
  const zoneIndex = zones.findIndex(zone => zone?.id === zoneKey);
  const resolvedIndex = zoneIndex >= 0 ? zoneIndex : zoneKey;
  const zone = zones[resolvedIndex];
  if (!zone?.cells?.length) {
    throw new Error(`Could not find zone ${cropZone} for --crop-zone`);
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
