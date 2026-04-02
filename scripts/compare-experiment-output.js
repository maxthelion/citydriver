#!/usr/bin/env bun

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';

const args = parseArgs(process.argv.slice(2));
const leftDir = args.left ?? args._[0];
const rightDir = args.right ?? args._[1];

if (!leftDir || !rightDir) {
  console.error('Usage: bun scripts/compare-experiment-output.js --left <dir> --right <dir>');
  process.exit(1);
}

const leftFiles = listFiles(leftDir);
const rightFiles = listFiles(rightDir);
const allFiles = [...new Set([...leftFiles.keys(), ...rightFiles.keys()])].sort();
const diffs = [];

for (const relPath of allFiles) {
  if (shouldIgnorePath(relPath, leftFiles, rightFiles)) continue;
  const leftPath = leftFiles.get(relPath);
  const rightPath = rightFiles.get(relPath);

  if (!leftPath || !rightPath) {
    diffs.push(`${relPath}: missing on ${leftPath ? 'right' : 'left'}`);
    continue;
  }

  const ext = extname(relPath).toLowerCase();
  if (ext === '.json') {
    const diff = compareJsonFile(leftPath, rightPath);
    if (diff) diffs.push(`${relPath}: ${diff}`);
    continue;
  }

  const same = readFileSync(leftPath).equals(readFileSync(rightPath));
  if (!same) {
    diffs.push(`${relPath}: byte content differs`);
  }
}

if (diffs.length > 0) {
  console.error(`Found ${diffs.length} semantic differences:`);
  for (const diff of diffs) console.error(`- ${diff}`);
  process.exit(1);
}

console.log(`Outputs match semantically: ${leftDir} == ${rightDir}`);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[key] = value;
    } else {
      out._.push(arg);
    }
  }
  return out;
}

function listFiles(root, current = root, out = new Map()) {
  for (const name of readdirSync(current)) {
    const path = join(current, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      listFiles(root, path, out);
      continue;
    }
    out.set(relative(root, path), path);
  }
  return out;
}

function shouldIgnorePath(relPath, leftFiles, rightFiles) {
  if (extname(relPath).toLowerCase() !== '.png') return false;
  const ppmPath = relPath.replace(/\.png$/i, '.ppm');
  return leftFiles.has(ppmPath) && rightFiles.has(ppmPath);
}

function compareJsonFile(leftPath, rightPath) {
  const left = normalizeJsonForComparison(basename(leftPath), JSON.parse(readFileSync(leftPath, 'utf8')));
  const right = normalizeJsonForComparison(basename(rightPath), JSON.parse(readFileSync(rightPath, 'utf8')));
  return compareJsonValue(left, right, 'root');
}

function compareJsonValue(left, right, path) {
  if (typeof left !== typeof right || Array.isArray(left) !== Array.isArray(right) || isNullish(left) !== isNullish(right)) {
    return `${path}: type mismatch`;
  }

  if (isNullish(left) || typeof left !== 'object') {
    return left === right ? null : `${path}: ${formatValue(left)} != ${formatValue(right)}`;
  }

  if (Array.isArray(left)) {
    if (left.length !== right.length) {
      return `${path}: array length ${left.length} != ${right.length}`;
    }
    for (let i = 0; i < left.length; i++) {
      const diff = compareJsonValue(left[i], right[i], `${path}[${i}]`);
      if (diff) return diff;
    }
    return null;
  }

  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, idx) => key !== rightKeys[idx])) {
    return `${path}: object keys differ`;
  }
  for (const key of leftKeys) {
    const diff = compareJsonValue(left[key], right[key], `${path}.${key}`);
    if (diff) return diff;
  }
  return null;
}

function isNullish(value) {
  return value === null;
}

function formatValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

function normalizeJsonForComparison(fileName, value) {
  if (!value || typeof value !== 'object') return value;
  const copy = JSON.parse(JSON.stringify(value));
  if (fileName === 'manifest.json') {
    delete copy.generated;
    delete copy.fixture;
    delete copy.fixtureDir;
    delete copy.fixtureStep;
    delete copy.commitSha;
  }
  return copy;
}
