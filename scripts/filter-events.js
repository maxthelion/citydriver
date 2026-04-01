#!/usr/bin/env bun

import { existsSync, readFileSync } from 'fs';

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

const logPath = resolveLogPath(args);
const events = readEvents(logPath);
const filtered = filterEvents(events, args);

if (args.seq !== undefined) {
  printSequenceWindow(filtered, args);
} else if (args.json) {
  for (const event of filtered) {
    console.log(JSON.stringify(event, null, 2));
  }
} else {
  for (const event of filtered) {
    console.log(formatEventLine(event));
  }
}

function parseArgs(argv) {
  const options = {
    window: 4,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key?.startsWith('--')) {
      throw new Error(`Unexpected argument: ${key}`);
    }
    const name = key.slice(2);
    if (name === 'json' || name === 'help') {
      options[name] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for --${name}`);
    }
    options[name] = value;
    i++;
  }

  if (options.seq !== undefined) options.seq = Number(options.seq);
  if (options.window !== undefined) options.window = Number(options.window);
  return options;
}

function resolveLogPath(options) {
  if (options.log) return options.log;

  if (!options.experiment || options.zone === undefined || options.seed === undefined) {
    throw new Error('Usage requires either --log path or --experiment NNN --zone Z --seed S');
  }

  const num = String(options.experiment).padStart(3, '0');
  const zone = String(options.zone);
  const seed = String(options.seed);
  const base = `/Users/maxwilliams/dev/citygenerator/experiments/${num}-output`;

  const candidates = [];
  if (options.step === 'cross-streets') {
    candidates.push(`${base}/cross-events-zone${zone}-seed${seed}.ndjson`);
  } else if (options.step === 'ribbons') {
    candidates.push(`${base}/ribbon-events-zone${zone}-seed${seed}.ndjson`);
  } else {
    candidates.push(`${base}/events-zone${zone}-seed${seed}.ndjson`);
    candidates.push(`${base}/ribbon-events-zone${zone}-seed${seed}.ndjson`);
    candidates.push(`${base}/cross-events-zone${zone}-seed${seed}.ndjson`);
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error(`No matching event log found. Tried:\n${candidates.join('\n')}`);
}

function readEvents(logPath) {
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function filterEvents(events, options) {
  return events.filter(event => {
    if (options.step && event.stepId !== options.step) return false;
    if (options.type && event.type !== options.type) return false;
    if (options.family && String(event.familyKey ?? event.payload?.familyKey ?? '') !== String(options.family)) return false;
    if (options.row && String(event.rowIdAttempt ?? event.payload?.rowIdAttempt ?? '') !== String(options.row)) return false;
    if (options['anchor-source'] && String(event.anchorSource ?? event.payload?.anchorSource ?? '') !== String(options['anchor-source'])) return false;
    if (options['sector-idx'] !== undefined && String(event.sectorIdx ?? '') !== String(options['sector-idx'])) return false;
    if (options.seq !== undefined && !Number.isNaN(options.seq)) {
      const minSeq = options.seq - (options.window ?? 0);
      const maxSeq = options.seq + (options.window ?? 0);
      if (event.seq < minSeq || event.seq > maxSeq) return false;
    }
    return true;
  });
}

function printSequenceWindow(events, options) {
  const targetSeq = options.seq;
  const target = events.find(event => event.seq === targetSeq) || null;

  for (const event of events) {
    const marker = event.seq === targetSeq ? '>' : ' ';
    console.log(`${marker} ${formatEventLine(event)}`);
  }

  if (target) {
    console.log('\nTarget event:\n');
    console.log(JSON.stringify(target, null, 2));
  } else {
    console.log(`\nNo event with seq ${targetSeq} in filtered result.`);
  }
}

function formatEventLine(event) {
  const parts = [
    `#${event.seq}`,
    event.stepId,
    event.type,
  ];

  if (event.sectorIdx !== undefined) parts.push(`sector=${event.sectorIdx}`);
  if (event.rowIdAttempt !== undefined) parts.push(`row=${event.rowIdAttempt}`);
  if (event.anchorSource !== undefined) parts.push(`anchor=${event.anchorSource}`);

  const summary = summarizeEvent(event);
  if (summary) parts.push(summary);
  return parts.join(' | ');
}

function summarizeEvent(event) {
  const payload = event.payload || {};
  switch (event.type) {
    case 'sweep-plan':
      return `phase=${payload.phaseOriginSource || 'n/a'} @ ${formatPoint(payload.phaseOrigin)}${payload.phaseBorrowPointCount ? ` borrow=${payload.phaseBorrowPointCount}` : ''}`;
    case 'scanline-start':
      return `ct=${formatNumber(payload.ctOff)} seed=${formatPoint(payload.seedPoint)}`;
    case 'scanline-runs':
      return `ct=${formatNumber(payload.ctOff)} runs=${payload.runCount ?? 0} breaks=${payload.breakCount ?? 0}`;
    case 'scanline-break':
      return `ct=${formatNumber(payload.ctOff)} ${payload.reason || 'break'} at ${formatPoint(payload.point)} cell=${formatCell(payload.cell)}`;
    case 'scanline-no-street':
      return `ct=${formatNumber(payload.ctOff)} none kept candidates=${payload.candidateCount ?? 0} rejected=${payload.rejectedCount ?? 0} pruned=${payload.prunedCount ?? 0}`;
    case 'street-candidate':
      return `${payload.candidateKey || 'candidate'} ct=${formatNumber(payload.ctOff)} len=${formatNumber(payload.length)}${payload.snapped ? ' snapped' : ''}`;
    case 'street-snapped':
      return `${payload.side || 'boundary'} ${formatPoint(payload.originalEndpoint)} -> ${formatPoint(payload.snappedEndpoint)} via ${formatPoint(payload.snapPoint)}`;
    case 'street-rejected':
      return `${payload.candidateKey || 'candidate'} ct=${formatNumber(payload.ctOff)} reason=${payload.reason || 'unknown'}${payload.length !== undefined ? ` len=${formatNumber(payload.length)}` : ''}`;
    case 'street-accepted':
      return `${payload.candidateKey || 'candidate'} ct=${formatNumber(payload.ctOff)} len=${formatNumber(payload.length)}`;
    case 'street-pruned':
      return `${payload.candidateKey || 'candidate'} ct=${formatNumber(payload.ctOff)} reason=${payload.reason || 'pruned'}${payload.conflictCandidateKey ? ` vs ${payload.conflictCandidateKey}` : ''}`;
    case 'cross-street-committed':
      return `road=${payload.roadId ?? 'n/a'} len=${formatNumber(payload.length)}${payload.snapped ? ' snapped' : ''}`;
    case 'cross-street-prejoin':
      return `prejoin to ${formatPoint(payload.snapPoint)} via ${formatPoint(payload.snappedEndpoint)}`;
    case 'cross-street-commit-retry':
      return `retry via roads ${(payload.conflictRoadIds || []).join(',') || 'n/a'} to ${formatPoint(payload.snappedEndpoint)}`;
    case 'cross-street-commit-rejected':
      return `reason=${payload.reason || 'unknown'} len=${formatNumber(payload.length)}${Array.isArray(payload.conflictRoadIds) && payload.conflictRoadIds.length ? ` vs roads ${payload.conflictRoadIds.join(',')}` : ''}`;
    case 'anchor-enqueued':
    case 'anchor-dequeued':
      return `street=${event.anchorStreetIdx ?? 'n/a'} t=${formatNumber(event.anchorT)}`;
    case 'row-build-start':
      return `row=${event.rowIdAttempt ?? 'n/a'} source=${event.anchorSource || 'n/a'}`;
    case 'row-accepted':
      return `row=${event.rowIdAttempt ?? 'n/a'} streets=${payload.streetCount ?? '?'}`;
    case 'row-rejected':
      return `row=${event.rowIdAttempt ?? 'n/a'} reason=${payload.reason || 'unknown'}`;
    default:
      if (payload.reason) return `reason=${payload.reason}`;
      if (payload.ctOff !== undefined) return `ct=${formatNumber(payload.ctOff)}`;
      return '';
  }
}

function formatPoint(point) {
  if (!point) return 'n/a';
  return `(${formatNumber(point.x)}, ${formatNumber(point.z)})`;
}

function formatCell(cell) {
  if (!cell) return 'n/a';
  return `(${cell.gx}, ${cell.gz})`;
}

function formatNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(2) : 'n/a';
}

function printHelp() {
  console.log(`Usage:
  bun scripts/filter-events.js --log /abs/path/to/events.ndjson [filters...]
  bun scripts/filter-events.js --experiment 031j --zone 0 --seed 884469 [filters...]

Useful filters:
  --seq 61           Show a window around one sequence number
  --window 5         Context size around --seq (default 4)
  --step ribbons     Filter to one step: ribbons | cross-streets
  --type row-rejected
  --family 0:0
  --row 7
  --anchor-source seed-gap
  --sector-idx 0
  --json             Print full matching events as JSON
  --help
`);
}
