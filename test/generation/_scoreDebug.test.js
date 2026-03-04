import { it, expect } from 'vitest';
import { generateCity } from '../../src/generation/pipeline.js';
import { scoreCity } from '../../src/generation/scoreCity.js';
import { Heightmap } from '../../src/core/heightmap.js';
import { distance2D, pointToSegmentDist } from '../../src/core/math.js';

it('score debug', async () => {
  const gridSize = 32, cellSize = 10;
  const regionHm = new Heightmap(gridSize, gridSize, cellSize);
  for (let gz = 0; gz < gridSize; gz++)
    for (let gx = 0; gx < gridSize; gx++)
      regionHm.set(gx, gz, 50 - gx * 0.2 - gz * 0.1);
  regionHm.freeze();
  const ctx = {
    center: { x: 155, z: 155 }, settlement: { name: 'Test Town' },
    regionHeightmap: regionHm,
    cityBounds: { minX: 0, minZ: 0, maxX: 310, maxZ: 310 },
    seaLevel: 0, rivers: [], coastline: null,
    roadEntries: [
      { point: { x: 0, z: 155 }, hierarchy: 'primary', destination: 'N' },
      { point: { x: 310, z: 155 }, hierarchy: 'primary', destination: 'S' },
      { point: { x: 155, z: 0 }, hierarchy: 'secondary', destination: 'E' },
    ],
    economicRole: 'market', rank: 'town',
  };
  const city = await generateCity(ctx, { seed: 42, gridSize: 64, organicness: 0.5 });
  const report = scoreCity(city);

  console.log('\n=== VALIDITY ===');
  for (const [k, v] of Object.entries(report.validity))
    console.log(`  ${k}: ${v.pass ? 'PASS' : 'FAIL'} — ${v.details}`);

  console.log('\n=== STRUCTURAL ===');
  for (const [k, v] of Object.entries(report.structural))
    console.log(`  ${k}: ${v.score.toFixed(3)} (threshold ${v.threshold}) — ${v.details}`);

  console.log('\n=== QUALITY ===');
  for (const [k, v] of Object.entries(report.quality))
    console.log(`  ${k}: ${v.score.toFixed(3)} — ${v.details}`);

  console.log(`\nStructural: ${report.structuralScore.toFixed(3)}, Quality: ${report.qualityScore.toFixed(3)}, Overall: ${report.overallScore.toFixed(3)}`);

  // V2 debug
  const { nodes, edges } = city.network;
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to)) adj.set(e.to, []);
    adj.get(e.from).push(e.to);
    adj.get(e.to).push(e.from);
  }
  const connNodes = new Set();
  for (const e of edges) { connNodes.add(e.from); connNodes.add(e.to); }
  const allVisited = new Set();
  let components = 0;
  const compSizes = [];
  for (const nid of connNodes) {
    if (allVisited.has(nid)) continue;
    components++;
    let size = 0;
    const q = [nid]; allVisited.add(nid);
    while (q.length) { const c = q.shift(); size++; for (const nb of (adj.get(c)||[])) { if (!allVisited.has(nb)) { allVisited.add(nb); q.push(nb); } } }
    compSizes.push(size);
  }
  console.log(`\nV2: ${connNodes.size} nodes, ${components} components, sizes: ${compSizes.sort((a,b)=>b-a).join(', ')}`);

  // S8 debug
  const hCounts = {};
  for (const e of edges) hCounts[e.hierarchy] = (hCounts[e.hierarchy]||0) + 1;
  console.log(`\nS8 hierarchy counts:`, hCounts);

  // S1 debug — distance distribution
  const edgePts = edges.map(e => e.points).filter(p => p.length >= 2);
  const dists = [];
  for (const b of city.buildings) {
    if (!b.doorPosition) continue;
    let minD = Infinity;
    for (const pts of edgePts) {
      for (let i = 1; i < pts.length; i++) {
        const d = pointToSegmentDist(b.doorPosition.x, b.doorPosition.z, pts[i-1].x, pts[i-1].z, pts[i].x, pts[i].z);
        if (d < minD) minD = d;
      }
    }
    dists.push(minD);
  }
  dists.sort((a,b)=>a-b);
  console.log(`\nS1: ${dists.length} buildings, median dist ${dists[Math.floor(dists.length/2)]?.toFixed(1)}, max ${dists[dists.length-1]?.toFixed(1)}`);
  console.log(`  <=2m: ${dists.filter(d=>d<=2).length}, <=5m: ${dists.filter(d=>d<=5).length}, <=10m: ${dists.filter(d=>d<=10).length}`);

  // S7 debug
  const amenityTypes = {};
  for (const a of city.amenities) amenityTypes[a.type] = (amenityTypes[a.type]||0) + 1;
  console.log(`\nS7 amenities:`, amenityTypes);
  console.log(`  Residential: ${city.buildings.filter(b=>['terrace','suburban','apartment'].includes(b.style)).length}`);
  console.log(`  Commercial+mixed: ${city.buildings.filter(b=>b.style==='commercial'||b.style==='mixed').length}`);

  expect(true).toBe(true);
}, 30000);
