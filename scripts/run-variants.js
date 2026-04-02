#!/usr/bin/env bun

import { cpus } from 'node:os';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { describeFixture, getHeadCommit } from './provenance.js';

const args = parseArgs(process.argv.slice(2));
const variantsPath = args.variants ?? null;
const fixturePath = args.fixture ?? null;
const defaultScript = args.script ?? 'render-sector-ribbons.js';
const experiment = args.experiment ? String(args.experiment).padStart(3, '0') : null;
const outDir = resolve(args.out ?? (experiment ? `experiments/${experiment}-output` : 'output/variants'));
const parallel = Math.max(1, Number(args.parallel ?? Math.min(4, cpus().length || 1)));

if (!variantsPath) {
  console.error('Usage: bun scripts/run-variants.js --variants variants.json --fixture fixture.json [--script render-sector-ribbons.js] [--experiment 040] [--out output/dir]');
  process.exit(1);
}
if (!fixturePath) {
  console.error('run-variants currently requires --fixture <path>.');
  process.exit(1);
}

const fixture = describeFixture(fixturePath);
const variants = JSON.parse(readFileSync(resolve(variantsPath), 'utf8'));
if (!Array.isArray(variants) || variants.length === 0) {
  console.error(`No variants found in ${variantsPath}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

console.log(`Variants: ${variants.length} | fixture=${fixture.path} | parallel=${parallel}`);
console.log(`Output: ${outDir}`);

const queue = variants.map((variant, index) => ({ variant, index }));
const failures = [];
await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, async () => {
  while (queue.length > 0) {
    const job = queue.shift();
    if (!job) break;
    const { variant, index } = job;
    const name = variant.name ?? `variant-${index + 1}`;
    const prefix = `${sanitizeVariantName(name)}__`;
    const script = variant.script ?? defaultScript;
    const variantExperiment = variant.experiment ?? variant.experimentNum ?? variant.experimentId ?? null;
    const extraArgs = buildExtraArgs(variant.args);
    const cmd = [
      'scripts/' + script,
      '--fixture', fixture.path,
      '--out', outDir,
      '--output-prefix', prefix,
      ...(variantExperiment != null ? ['--experiment', String(variantExperiment)] : []),
      ...extraArgs,
    ];

    process.stdout.write(`→ ${name} (${script})\n`);
    const result = await runBunCommand(cmd);
    if (result.code !== 0) {
      failures.push({ name, script, code: result.code });
    }
  }
}));

if (failures.length > 0) {
  console.error(`Failed variants: ${failures.map(f => `${f.name}(${f.code})`).join(', ')}`);
  process.exit(1);
}

const images = collectVariantImages(outDir);
const manifest = {
  experiment,
  generated: new Date().toISOString(),
  commitSha: getHeadCommit(),
  fixture,
  script: defaultScript,
  variants: variants.map((variant, index) => ({
    name: variant.name ?? `variant-${index + 1}`,
    script: variant.script ?? defaultScript,
    args: variant.args ?? null,
    experiment: variant.experiment ?? variant.experimentNum ?? variant.experimentId ?? null,
  })),
  images,
};
writeFileSync(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 2));
console.log(`Manifest written: ${outDir}/manifest.json (${images.length} images)`);

if (experiment) {
  const rootManifestPath = resolve('experiments/manifest.json');
  const rootManifest = existsSync(rootManifestPath)
    ? JSON.parse(readFileSync(rootManifestPath, 'utf8'))
    : [];
  const mdFile = `variants-${experiment}.md`;
  const entry = {
    num: experiment,
    slug: `variants-${experiment}`,
    md: null,
    images: images.map(image => ({
      path: image.path,
      layer: image.layer,
      seed: image.seed,
      tick: image.tick,
      variant: image.variant,
    })),
  };
  const existingIdx = rootManifest.findIndex(item => item.num === experiment);
  if (existingIdx >= 0) rootManifest[existingIdx] = entry;
  else rootManifest.push(entry);
  rootManifest.sort((a, b) => a.num.localeCompare(b.num));
  writeFileSync(rootManifestPath, JSON.stringify(rootManifest, null, 2));
  console.log(`Root manifest updated: ${rootManifest.length} experiments`);
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

function buildExtraArgs(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'object') {
    const out = [];
    for (const [key, raw] of Object.entries(value)) {
      if (raw === false || raw == null) continue;
      out.push(`--${key}`);
      if (raw !== true) out.push(String(raw));
    }
    return out;
  }
  return [];
}

function sanitizeVariantName(name) {
  return String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'variant';
}

function runBunCommand(args) {
  return new Promise(resolveResult => {
    const child = spawn('bun', args, { stdio: 'inherit' });
    child.on('exit', code => resolveResult({ code: code ?? 1 }));
  });
}

function collectVariantImages(rootDir) {
  const files = readdirSync(rootDir).filter(file => file.endsWith('.png') || file.endsWith('.svg'));
  return files.map(file => {
    const formatMatch = file.match(/\.(png|svg)$/);
    const format = formatMatch ? formatMatch[1] : null;
    const baseName = format ? file.slice(0, -(format.length + 1)) : file;
    const [variantPrefix, rawBaseName] = baseName.includes('__') ? baseName.split(/__(.+)/) : [null, baseName];
    const match = rawBaseName.match(/^(.+)-seed(\d+)(?:-tick(\d+))?$/);
    return {
      file,
      path: relativeToRepo(rootDir, file),
      variant: variantPrefix,
      layer: match ? match[1] : rawBaseName,
      seed: match ? match[2] : null,
      tick: match ? match[3] || null : null,
      format,
    };
  });
}

function relativeToRepo(rootDir, file) {
  const absolute = resolve(rootDir, file);
  const experimentsRoot = resolve(process.cwd(), 'experiments');
  if (absolute.startsWith(`${experimentsRoot}/`)) {
    return relative(experimentsRoot, absolute);
  }
  return absolute;
}
