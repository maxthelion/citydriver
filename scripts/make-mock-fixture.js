#!/usr/bin/env bun

import { FeatureMap } from '../src/core/FeatureMap.js';
import { Grid2D } from '../src/core/Grid2D.js';
import { saveMapFixture } from '../src/core/featureMapFixture.js';
import { extractZones } from '../src/city/pipeline/extractZones.js';
import { computeSpatialLayers } from '../src/city/pipeline/computeSpatialLayers.js';
import { getHeadCommit } from './provenance.js';

const args = parseArgs(process.argv.slice(2));
const template = String(args.template ?? 'flat');
const width = Number(args.width ?? 128);
const height = Number(args.height ?? 128);
const cellSize = Number(args['cell-size'] ?? 5);
const outPath = args.out ?? `test/fixtures/mock-${template}`;

const map = buildMockMap({ template, width, height, cellSize });
await saveMapFixture(map, outPath, {
  meta: {
    seed: 0,
    gx: map.settlement?.gx ?? 0,
    gz: map.settlement?.gz ?? 0,
    settlementGx: map.settlement?.gx ?? 0,
    settlementGz: map.settlement?.gz ?? 0,
    afterStep: 'spatial',
    lastStepId: 'spatial',
    stepCount: 6,
    archetypeId: 'marketTown',
    archetype: 'Market Town',
    commitSha: getHeadCommit(),
    mockTemplate: template,
  },
});

console.log(`Mock fixture written: ${outPath}.json`);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    out[key] = value;
  }
  return out;
}

function buildMockMap({ template, width, height, cellSize }) {
  const map = new FeatureMap(width, height, cellSize);
  map.elevation = new Grid2D(width, height, { type: 'float32', cellSize });
  map.slope = new Grid2D(width, height, { type: 'float32', cellSize });
  map.waterMask = new Grid2D(width, height, { type: 'uint8', cellSize });
  map.waterDist = new Grid2D(width, height, { type: 'float32', cellSize });
  map.landValue = new Grid2D(width, height, { type: 'float32', cellSize });
  const terrainSuitability = new Grid2D(width, height, { type: 'float32', cellSize });
  map.setLayer('elevation', map.elevation);
  map.setLayer('slope', map.slope);
  map.setLayer('waterMask', map.waterMask);
  map.setLayer('waterDist', map.waterDist);
  map.setLayer('landValue', map.landValue);
  map.setLayer('terrainSuitability', terrainSuitability);
  map.setLayer('roadGrid', map.roadNetwork.roadGrid);
  map.setLayer('bridgeGrid', map.roadNetwork.bridgeGrid);
  map.seaLevel = 0;
  map.prevailingWindAngle = 0;
  map.settlement = { gx: Math.floor(width / 2), gz: Math.floor(height / 2), tier: 3, name: `mock-${template}` };
  map.nuclei = [{ gx: Math.floor(width / 2), gz: Math.floor(height / 2), type: 'market' }];

  fillTerrain(map, template);
  stampMockRoads(map, template);
  populateWaterDistance(map);
  extractZones(map);
  computeSpatialLayers(map);
  return map;
}

function fillTerrain(map, template) {
  const cx = map.width / 2;
  const cz = map.height / 2;
  for (let gz = 0; gz < map.height; gz++) {
    for (let gx = 0; gx < map.width; gx++) {
      let elevation = 20;
      let slope = 0;
      let water = 0;
      switch (template) {
        case 'sloped':
          elevation = gx * 0.8 + gz * 0.2;
          slope = 0.18;
          break;
        case 'coastal':
          elevation = (gx - map.width * 0.3) * 0.7;
          water = gx < map.width * 0.22 ? 1 : 0;
          slope = water ? 0 : 0.12;
          break;
        case 'cross-road':
        case 'grid-road':
          elevation = 10 + Math.hypot(gx - cx, gz - cz) * 0.05;
          slope = 0.06;
          break;
        case 'flat':
        default:
          elevation = 20;
          slope = 0.01;
          break;
      }
      map.elevation.set(gx, gz, elevation);
      map.slope.set(gx, gz, slope);
      map.waterMask.set(gx, gz, water);
      map.landValue.set(gx, gz, water ? 0 : 0.8);
      map.getLayer('terrainSuitability').set(gx, gz, water ? 0 : 1);
    }
  }
}

function stampMockRoads(map, template) {
  const left = map.originX + map.cellSize * 6;
  const right = map.originX + map.cellSize * (map.width - 7);
  const top = map.originZ + map.cellSize * 6;
  const bottom = map.originZ + map.cellSize * (map.height - 7);
  const midX = map.originX + map.cellSize * Math.floor(map.width / 2);
  const midZ = map.originZ + map.cellSize * Math.floor(map.height / 2);

  if (template === 'cross-road' || template === 'grid-road') {
    const horizontal = map.roadNetwork.add(
      [{ x: left, z: midZ }, { x: right, z: midZ }],
      { hierarchy: 'local', source: 'mock-fixture' },
    );
    const vertical = map.roadNetwork.add(
      [{ x: midX, z: top }, { x: midX, z: bottom }],
      { hierarchy: 'local', source: 'mock-fixture' },
    );
    map.roadNetwork.connectWaysAtPoint(horizontal.id, vertical.id, midX, midZ);
  }

  if (template === 'grid-road') {
    for (const t of [0.25, 0.75]) {
      const x = map.originX + map.cellSize * Math.floor(map.width * t);
      const z = map.originZ + map.cellSize * Math.floor(map.height * t);
      map.roadNetwork.add([{ x, z: top }, { x, z: bottom }], { hierarchy: 'local', source: 'mock-fixture' });
      map.roadNetwork.add([{ x: left, z }, { x: right, z }], { hierarchy: 'local', source: 'mock-fixture' });
    }
  }
}

function populateWaterDistance(map) {
  const waterCells = [];
  for (let gz = 0; gz < map.height; gz++) {
    for (let gx = 0; gx < map.width; gx++) {
      if (map.waterMask.get(gx, gz) > 0) {
        waterCells.push({ gx, gz });
      }
    }
  }

  for (let gz = 0; gz < map.height; gz++) {
    for (let gx = 0; gx < map.width; gx++) {
      if (waterCells.length === 0) {
        map.waterDist.set(gx, gz, map.width + map.height);
        continue;
      }
      let best = Infinity;
      for (const water of waterCells) {
        const dist = Math.hypot(gx - water.gx, gz - water.gz);
        if (dist < best) best = dist;
      }
      map.waterDist.set(gx, gz, best);
    }
  }
}
