#!/usr/bin/env bun
/**
 * Diagnostic script for the zones-refine bug.
 * Runs the pipeline step-by-step and gathers evidence at each stage.
 *
 * Usage: bun scripts/diagnose-zones-refine.js [--seed 884469] [--gx 27] [--gz 95]
 */

import { generateRegionFromSeed } from '../src/ui/regionHelper.js';
import { SeededRandom } from '../src/core/rng.js';
import { setupCity } from '../src/city/setup.js';
import { LandFirstDevelopment } from '../src/city/strategies/landFirstDevelopment.js';

function getArg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const seed = parseInt(getArg('seed', '884469'));
const gx = parseInt(getArg('gx', '27'));
const gz = parseInt(getArg('gz', '95'));

console.log(`\n=== Diagnosing zones-refine bug ===`);
console.log(`Seed: ${seed}, Settlement: (${gx}, ${gz})\n`);

// Setup
const { layers, settlement } = generateRegionFromSeed(seed, gx, gz);
const rng = new SeededRandom(seed);
const map = setupCity(layers, settlement, rng.fork('city'));
const strategy = new LandFirstDevelopment(map, { archetype: 'auto' });

// Run to zones step
let currentStep = null;
strategy.runner.addHook({
  onAfter(id) { currentStep = id; }
});

while (strategy.tick()) {
  if (currentStep === 'zones') break;
}

// ── Step 1: Face-level data AFTER zones (before zone-boundary) ──────────
console.log(`\n────────── STEP 1: After 'zones' step ──────────`);
logGraphTopology(map, 'zones');
logFaceDistribution(map, 'zones');
logZoneSummary(map, 'zones');

// ── Run zone-boundary step ──────────────────────────────────────────────
while (strategy.tick()) {
  if (currentStep === 'zone-boundary') break;
}

// ── Step 2: Graph topology AFTER zone-boundary ──────────────────────────
console.log(`\n────────── STEP 2: After 'zone-boundary' step ──────────`);
logGraphTopology(map, 'zone-boundary');
logDanglingEdges(map);

// ── Run zones-refine step ───────────────────────────────────────────────
while (strategy.tick()) {
  if (currentStep === 'zones-refine') break;
}

// ── Step 3: Face-level data AFTER zones-refine ──────────────────────────
console.log(`\n────────── STEP 3: After 'zones-refine' step ──────────`);
logGraphTopology(map, 'zones-refine');
logFaceDistribution(map, 'zones-refine');
logZoneSummary(map, 'zones-refine');

// ── Step 4: Compare polygon area vs cell count ──────────────────────────
console.log(`\n────────── STEP 4: Polygon area vs cell count ──────────`);
logAreaVsCells(map);

console.log('\n=== Diagnosis complete ===\n');

// ════════════════════════════════════════════════════════════════════════════
// Diagnostic functions
// ════════════════════════════════════════════════════════════════════════════

function logGraphTopology(map, label) {
  const graph = map.graph;
  const nodeCount = graph.nodes.size;
  const edgeCount = graph.edges.size;

  let degree0 = 0, degree1 = 0, degree2 = 0, degree3plus = 0;
  for (const [id] of graph.nodes) {
    const d = graph.degree(id);
    if (d === 0) degree0++;
    else if (d === 1) degree1++;
    else if (d === 2) degree2++;
    else degree3plus++;
  }

  console.log(`[${label}] Graph: ${nodeCount} nodes, ${edgeCount} edges`);
  console.log(`  Degree-0 (orphan): ${degree0}`);
  console.log(`  Degree-1 (dangling): ${degree1}`);
  console.log(`  Degree-2 (pass-through): ${degree2}`);
  console.log(`  Degree-3+ (junction): ${degree3plus}`);
}

function logDanglingEdges(map) {
  const graph = map.graph;
  const danglingNodes = [];
  for (const [id] of graph.nodes) {
    if (graph.degree(id) === 1) {
      const node = graph.nodes.get(id);
      const adj = graph._adjacency.get(id);
      const edgeId = adj[0]?.edgeId;
      const edge = edgeId != null ? graph.edges.get(edgeId) : null;
      danglingNodes.push({
        nodeId: id,
        x: Math.round(node.x),
        z: Math.round(node.z),
        edgeHierarchy: edge?.hierarchy || '?',
        edgeSource: edge?.attrs?.source || '?',
      });
    }
  }

  console.log(`\n  Dangling endpoints (degree-1): ${danglingNodes.length}`);
  // Group by source
  const bySource = {};
  for (const d of danglingNodes) {
    const key = d.edgeSource;
    bySource[key] = (bySource[key] || 0) + 1;
  }
  for (const [src, count] of Object.entries(bySource)) {
    console.log(`    source="${src}": ${count} dangling nodes`);
  }

  // Show first 10
  if (danglingNodes.length > 0) {
    console.log(`  First ${Math.min(10, danglingNodes.length)} dangling nodes:`);
    for (const d of danglingNodes.slice(0, 10)) {
      console.log(`    node ${d.nodeId} @ (${d.x}, ${d.z}) — ${d.edgeHierarchy} [${d.edgeSource}]`);
    }
  }
}

function logFaceDistribution(map, label) {
  const graph = map.graph;
  const faces = graph.facesWithEdges();
  const mapAreaM2 = map.width * map.height * map.cellSize * map.cellSize;

  const areas = [];
  let tooSmall = 0, tooLarge = 0, validFaces = 0;

  for (const { nodeIds } of faces) {
    const polygon = nodeIds.map(id => {
      const n = graph.getNode(id);
      return n ? { x: n.x, z: n.z } : null;
    }).filter(Boolean);

    if (polygon.length < 3) continue;

    let area = 0;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      area += (polygon[j].x + polygon[i].x) * (polygon[j].z - polygon[i].z);
    }
    area = Math.abs(area / 2);

    if (area < 500) { tooSmall++; areas.push({ area, status: 'too-small' }); }
    else if (area > mapAreaM2 * 0.4) { tooLarge++; areas.push({ area, status: 'outer-face' }); }
    else { validFaces++; areas.push({ area, status: 'valid' }); }
  }

  areas.sort((a, b) => b.area - a.area);

  console.log(`\n[${label}] Faces: ${faces.length} total`);
  console.log(`  Valid (500m² < area < 40% map): ${validFaces}`);
  console.log(`  Too small (<500m²): ${tooSmall}`);
  console.log(`  Outer face / too large: ${tooLarge}`);

  if (areas.length > 0) {
    const validAreas = areas.filter(a => a.status === 'valid').map(a => a.area);
    if (validAreas.length > 0) {
      console.log(`  Valid area range: ${Math.round(Math.min(...validAreas))} – ${Math.round(Math.max(...validAreas))} m²`);
      const median = validAreas.sort((a, b) => a - b)[Math.floor(validAreas.length / 2)];
      console.log(`  Median valid area: ${Math.round(median)} m²`);
    }

    // Show largest faces (to see if outer face is absorbing everything)
    console.log(`  Top 5 faces by area:`);
    for (const f of areas.slice(0, 5)) {
      console.log(`    ${Math.round(f.area)} m² [${f.status}]`);
    }
  }
}

function logZoneSummary(map, label) {
  const zones = map.developmentZones;
  if (!zones) {
    console.log(`\n[${label}] No development zones!`);
    return;
  }

  const totalCells = zones.reduce((sum, z) => sum + z.cells.length, 0);
  console.log(`\n[${label}] Zones: ${zones.length}, total cells: ${totalCells}`);

  // Top 5 zones by cells
  const sorted = [...zones].sort((a, b) => b.cells.length - a.cells.length);
  console.log(`  Top 5 zones by cell count:`);
  for (const z of sorted.slice(0, 5)) {
    console.log(`    Zone ${z.id}: ${z.cells.length} cells, area=${Math.round(z.area)}m², lv=${z.avgLandValue.toFixed(2)}`);
  }
}

function logAreaVsCells(map) {
  const zones = map.developmentZones;
  if (!zones) return;

  const cs = map.cellSize;
  const roadGrid = map.hasLayer('roadGrid') ? map.getLayer('roadGrid') : null;

  console.log(`  Zone polygon-area vs rasterized-cells comparison:`);
  for (const z of zones) {
    const expectedCells = z.area / (cs * cs);
    const actualCells = z.cells.length;
    const ratio = actualCells / Math.max(1, expectedCells);

    // Count how many polygon cells overlap roadGrid
    let roadOverlapCount = 0;
    if (roadGrid && z.polygon) {
      // Rasterize polygon and count road overlaps
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const p of z.polygon) {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
      }
      const gxMin = Math.max(0, Math.floor((minX - map.originX) / cs));
      const gxMax = Math.min(map.width - 1, Math.ceil((maxX - map.originX) / cs));
      const gzMin = Math.max(0, Math.floor((minZ - map.originZ) / cs));
      const gzMax = Math.min(map.height - 1, Math.ceil((maxZ - map.originZ) / cs));

      for (let pgz = gzMin; pgz <= gzMax; pgz++) {
        for (let pgx = gxMin; pgx <= gxMax; pgx++) {
          if (roadGrid.get(pgx, pgz) > 0) roadOverlapCount++;
        }
      }
    }

    console.log(`    Zone ${z.id}: poly=${Math.round(z.area)}m², expected=${Math.round(expectedCells)} cells, actual=${actualCells} cells, ratio=${ratio.toFixed(2)}, road-overlap-in-bbox=${roadOverlapCount}`);
  }
}
