#!/usr/bin/env bun
/**
 * render-sector-ribbons.js — Cross streets + ribbons per sector.
 *
 * Extends render-sector-cross-streets.js with ribbon streets between
 * adjacent cross streets. Ribbons run along the contour, connecting
 * points on adjacent cross streets to form parcels.
 *
 * Usage: bun scripts/render-sector-ribbons.js <seed> <gx> <gz> [outDir] [experiment]
 */

import { generateRegionFromSeed } from '../src/ui/regionHelper.js';
import { setupCity } from '../src/city/setup.js';
import { LandFirstDevelopment } from '../src/city/strategies/landFirstDevelopment.js';
import { ARCHETYPES } from '../src/city/archetypes.js';
import { SeededRandom } from '../src/core/rng.js';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { runToStep } from './pipeline-utils.js';
import { layCrossStreets } from '../src/city/incremental/crossStreets.js';
import { layRibbons } from '../src/city/incremental/ribbons.js';
import { segmentTerrainV2 } from '../src/city/incremental/ridgeSegmentationV2.js';
import { tryAddRoad } from '../src/city/incremental/roadTransaction.js';
import { NdjsonEventSink, FanoutEventSink, FilteredEventSink } from '../src/core/EventSink.js';

// === CLI ===
const seed = parseInt(process.argv[2]) || 42;
const gx = parseInt(process.argv[3]) || 27;
const gz = parseInt(process.argv[4]) || 95;
const outDir = process.argv[5] || 'experiments/022-output';
const experimentNum = process.argv[6] || null;
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

function ribbonParamsForExperiment(num) {
  switch (num) {
    case '030':
      return {
        maxRowsTotal: 5,
        initialSeedCount: 1,
        parallelReseedRows: true,
        parallelReseedSpacing: 32,
        parallelReseedMaxGeneration: 2,
      };
    case '030a':
      return {
        maxRowsTotal: 3,
        initialSeedCount: 1,
        parallelReseedRows: true,
        parallelReseedSpacing: 32,
        parallelReseedMaxGeneration: 1,
      };
    case '030b':
      return {
        maxRowsTotal: 3,
        initialSeedCount: 1,
        parallelReseedRows: true,
        parallelReseedSpacing: 32,
        parallelReseedMaxGeneration: 1,
        parallelMinRoadGap: 15,
      };
    case '030c':
      return {
        maxRowsTotal: 3,
        initialSeedCount: 1,
        parallelReseedRows: true,
        parallelReseedSpacing: 32,
        parallelReseedMaxGeneration: 1,
        parallelMinRoadGap: 15,
        parallelKeepSide: true,
        parallelRejectCrossovers: true,
      };
    case '030d':
      return {
        maxRowsTotal: 3,
        initialSeedCount: 1,
        parallelReseedRows: true,
        parallelReseedSpacing: 32,
        parallelReseedMaxGeneration: 1,
        parallelMinRoadGap: 15,
        parallelKeepSide: true,
        parallelRejectCrossovers: true,
        parallelMaxAngleDeltaDeg: 20,
      };
    case '030e':
      return {
        maxRowsTotal: 3,
        initialSeedCount: 1,
        parallelReseedRows: true,
        parallelReseedSpacing: 32,
        parallelReseedMaxGeneration: 1,
        parallelMinRoadGap: 15,
        parallelKeepSide: true,
        parallelRejectCrossovers: true,
        parallelMaxAngleDeltaDeg: 20,
        parallelInheritParentJunctions: true,
        parallelExtendPastParent: true,
      };
    case '031':
      return {
        maxRowsTotal: 12,
        initialSeedCount: 1,
        parallelReseedRows: true,
        parallelReseedSpacing: 32,
        parallelReseedMaxGeneration: 1,
        parallelMinRoadGap: 15,
        parallelKeepSide: true,
        parallelRejectCrossovers: true,
        parallelMaxAngleDeltaDeg: 20,
        parallelInheritParentJunctions: true,
        parallelExtendPastParent: true,
        fillRemainingStreetGaps: true,
        fillUnusedStreetSeedsOnly: true,
        fillGapThreshold: 38,
      };
    case '031a':
      return {
        maxRowsTotal: 20,
        initialSeedCount: 1,
        parallelReseedRows: true,
        parallelReseedSpacing: 32,
        parallelReseedMaxGeneration: 1,
        parallelMinRoadGap: 15,
        parallelKeepSide: true,
        parallelRejectCrossovers: true,
        parallelMaxAngleDeltaDeg: 20,
        parallelInheritParentJunctions: true,
        parallelExtendPastParent: true,
        fillRemainingStreetGaps: true,
        fillUnusedStreetSeedsOnly: false,
        fillGapThreshold: 60,
      };
    case '031b':
      return {
        maxRowsTotal: 20,
        initialSeedCount: 1,
        parallelReseedRows: true,
        parallelReseedSpacing: 32,
        parallelReseedMaxGeneration: 1,
        parallelMinRoadGap: 15,
        parallelKeepSide: true,
        parallelRejectCrossovers: true,
        parallelMaxAngleDeltaDeg: 20,
        parallelValidateAgainstAllRows: true,
        parallelInheritParentJunctions: true,
        parallelExtendPastParent: true,
        fillRemainingStreetGaps: true,
        fillUnusedStreetSeedsOnly: false,
        fillGapThreshold: 60,
      };
    case '031c':
      return {
        maxRowsTotal: 20,
        initialSeedCount: 1,
        parallelReseedRows: true,
        parallelReseedSpacing: 32,
        parallelReseedMaxGeneration: 1,
        parallelMinRoadGap: 15,
        parallelKeepSide: true,
        parallelRejectCrossovers: true,
        parallelMaxAngleDeltaDeg: 20,
        parallelValidateAgainstAllRows: true,
        parallelGlobalCheckCross: true,
        parallelGlobalCheckGap: true,
        parallelGlobalCheckSide: false,
        parallelGlobalCheckAngle: false,
        parallelInheritParentJunctions: true,
        parallelExtendPastParent: true,
        fillRemainingStreetGaps: true,
        fillUnusedStreetSeedsOnly: false,
        fillGapThreshold: 60,
      };
    case '031d':
      return {
        maxRowsTotal: 24,
        initialSeedCount: 1,
        parallelReseedRows: false,
        parallelReseedSpacing: 32,
        parallelMinRoadGap: 15,
        parallelKeepSide: true,
        parallelRejectCrossovers: true,
        parallelMaxAngleDeltaDeg: 20,
        parallelValidateAgainstAllRows: true,
        parallelGlobalCheckCross: true,
        parallelGlobalCheckGap: true,
        parallelGlobalCheckSide: false,
        parallelGlobalCheckAngle: false,
        parallelInheritParentJunctions: true,
        parallelExtendPastParent: true,
        parallelSlotFamilies: true,
        fillRemainingStreetGaps: true,
        fillUnusedStreetSeedsOnly: true,
        fillGapThreshold: 38,
      };
    case '031e':
      return {
        maxRowsTotal: 28,
        initialSeedCount: 1,
        parallelReseedRows: false,
        parallelReseedSpacing: 32,
        parallelMinRoadGap: 15,
        parallelKeepSide: true,
        parallelRejectCrossovers: true,
        parallelMaxAngleDeltaDeg: 20,
        parallelValidateAgainstAllRows: true,
        parallelGlobalCheckCross: true,
        parallelGlobalCheckGap: true,
        parallelGlobalCheckSide: false,
        parallelGlobalCheckAngle: false,
        parallelInheritParentJunctions: true,
        parallelExtendPastParent: true,
        parallelSlotFamilies: true,
        fillRemainingStreetGaps: true,
        fillUnusedStreetSeedsOnly: false,
        fillGapThreshold: 48,
      };
    case '031f':
      return {
        maxRowsTotal: 28,
        initialSeedCount: 1,
        parallelReseedRows: false,
        parallelReseedSpacing: 32,
        parallelMinRoadGap: 15,
        parallelKeepSide: true,
        parallelRejectCrossovers: true,
        parallelMaxAngleDeltaDeg: 20,
        parallelValidateAgainstAllRows: true,
        parallelGlobalCheckCross: true,
        parallelGlobalCheckGap: true,
        parallelGlobalCheckSide: false,
        parallelGlobalCheckAngle: false,
        parallelInheritParentJunctions: true,
        parallelExtendPastParent: true,
        parallelSlotFamilies: true,
        parallelInheritedTargetSearchRadius: 20,
        parallelInheritedTargetSearchStep: 4,
        parallelInheritedBaseOffsetWeight: 0.4,
        parallelInheritedParentDirWeight: 16,
        parallelInheritedTurnWeight: 18,
        parallelInheritedApproachWeight: 9,
        fillRemainingStreetGaps: true,
        fillUnusedStreetSeedsOnly: false,
        fillGapThreshold: 48,
      };
    case '031g':
      return {
        maxRowsTotal: 28,
        initialSeedCount: 1,
        parallelReseedRows: false,
        parallelReseedSpacing: 32,
        parallelMinRoadGap: 15,
        parallelKeepSide: true,
        parallelRejectCrossovers: true,
        parallelMaxAngleDeltaDeg: 20,
        parallelValidateAgainstAllRows: true,
        parallelGlobalCheckCross: true,
        parallelGlobalCheckGap: true,
        parallelGlobalCheckSide: false,
        parallelGlobalCheckAngle: false,
        parallelInheritParentJunctions: true,
        parallelExtendPastParent: true,
        parallelSlotFamilies: true,
        parallelInheritedMidpointGuide: true,
        fillRemainingStreetGaps: true,
        fillUnusedStreetSeedsOnly: false,
        fillGapThreshold: 48,
      };
    case '031h':
      return {
        maxRowsTotal: 28,
        initialSeedCount: 1,
        parallelReseedRows: false,
        parallelReseedSpacing: 32,
        parallelMinRoadGap: 15,
        parallelKeepSide: true,
        parallelRejectCrossovers: true,
        parallelMaxAngleDeltaDeg: 20,
        parallelValidateAgainstAllRows: true,
        parallelGlobalCheckCross: true,
        parallelGlobalCheckGap: true,
        parallelGlobalCheckSide: false,
        parallelGlobalCheckAngle: false,
        parallelInheritParentJunctions: true,
        parallelExtendPastParent: true,
        parallelSlotFamilies: true,
        parallelInheritedMidpointGuide: true,
        parallelTruncateViolatingTail: true,
        fillRemainingStreetGaps: true,
        fillUnusedStreetSeedsOnly: false,
        fillGapThreshold: 48,
      };
    case '031i':
      return {
        maxRowsTotal: 28,
        initialSeedCount: 1,
        parallelReseedRows: false,
        parallelReseedSpacing: 32,
        parallelMinRoadGap: 15,
        parallelKeepSide: true,
        parallelRejectCrossovers: true,
        parallelMaxAngleDeltaDeg: 20,
        parallelValidateAgainstAllRows: true,
        parallelGlobalCheckCross: true,
        parallelGlobalCheckGap: true,
        parallelGlobalCheckSide: false,
        parallelGlobalCheckAngle: false,
        parallelInheritParentJunctions: true,
        parallelExtendPastParent: true,
        parallelSlotFamilies: true,
        parallelInheritedMidpointGuide: true,
        parallelTruncateViolatingTail: true,
        gapSeedBorrowNearestRow: true,
        fillRemainingStreetGaps: true,
        fillUnusedStreetSeedsOnly: false,
        fillGapThreshold: 48,
      };
    case '031j':
    case '032':
    case '033':
    case '034':
    case '035':
    case '036':
      return {
        maxRowsTotal: 28,
        initialSeedCount: 1,
        parallelReseedRows: false,
        parallelReseedSpacing: 32,
        parallelMinRoadGap: 15,
        parallelKeepSide: true,
        parallelRejectCrossovers: true,
        parallelMaxAngleDeltaDeg: 20,
        parallelValidateAgainstAllRows: true,
        parallelGlobalCheckCross: true,
        parallelGlobalCheckGap: true,
        parallelGlobalCheckSide: false,
        parallelGlobalCheckAngle: false,
        parallelInheritParentJunctions: true,
        parallelExtendPastParent: true,
        parallelSlotFamilies: true,
        parallelInheritedMidpointGuide: true,
        parallelTruncateViolatingTail: true,
        gapSeedBorrowNearestRow: true,
        fillRemainingStreetGaps: true,
        fillGapPreferUsedStreet: true,
        fillUnusedStreetSeedsOnly: false,
        fillGapThreshold: 48,
      };
    case '031k':
      return {
        maxRowsTotal: 28,
        initialSeedCount: 1,
        parallelReseedRows: false,
        parallelReseedSpacing: 32,
        parallelMinRoadGap: 15,
        parallelKeepSide: true,
        parallelRejectCrossovers: true,
        parallelMaxAngleDeltaDeg: 20,
        parallelValidateAgainstAllRows: true,
        parallelGlobalCheckCross: true,
        parallelGlobalCheckGap: true,
        parallelGlobalCheckSide: false,
        parallelGlobalCheckAngle: false,
        parallelInheritParentJunctions: true,
        parallelExtendPastParent: true,
        parallelSlotFamilies: true,
        parallelInheritedMidpointGuide: true,
        parallelTruncateViolatingTail: true,
        gapSeedBorrowNearestRow: true,
        fillRemainingStreetGaps: true,
        fillGapPreferUsedStreet: true,
        fillUnusedStreetSeedsOnly: false,
        fillGapThreshold: 80,
      };
    default:
      return {};
  }
}

function crossStreetParamsForExperiment(num) {
  switch (num) {
    case '032':
      return {
        alignSharedBoundaryPhase: true,
        sharedBoundaryMinCells: 6,
        sharedBoundaryTangentThreshold: 0.72,
      };
    case '033':
      return {
        snapSharedBoundaryEndpoints: true,
        sharedBoundaryMinCells: 6,
        sharedBoundaryTangentThreshold: 0.72,
        boundarySnapBoundaryTolerance: 18,
        boundarySnapMaxDistance: 28,
        boundarySnapMaxAngleDeltaDeg: 18,
        boundarySnapMinImprovement: 3,
      };
    case '034':
      return {
        alignSharedBoundaryAnchor: true,
        sharedBoundaryMinCells: 6,
        sharedBoundaryTangentThreshold: 0.72,
        sharedBoundaryAnchorBoundaryTolerance: 18,
      };
    case '035':
      return {
        borrowSharedBoundaryPhase: true,
        sharedBoundaryMinCells: 6,
        sharedBoundaryTangentThreshold: 0.72,
        sharedGradientSimilarityThreshold: 0.92,
        phaseBorrowBoundaryTolerance: 18,
      };
    case '036':
      return {
        borrowSharedBoundaryPhase: true,
        connectBorrowedBoundaryPhase: true,
        connectBorrowedBoundaryPhaseRetry: true,
        connectBorrowedBoundaryPhaseRetryMaxDistance: 22,
        sharedBoundaryMinCells: 6,
        sharedBoundaryTangentThreshold: 0.72,
        sharedGradientSimilarityThreshold: 0.92,
        phaseBorrowBoundaryTolerance: 18,
        boundarySnapBoundaryTolerance: 18,
        boundarySnapMaxDistance: 36,
        boundarySnapMaxAngleDeltaDeg: 22,
        boundarySnapMinImprovement: 1,
        boundarySnapForceEndpoint: true,
        boundarySnapForceEndpointMaxDistance: 14,
      };
    case '037':
      return {
        borrowSharedBoundaryPhase: true,
        borrowSharedBoundaryExplicitOffsets: true,
        connectBorrowedBoundaryPhase: true,
        connectBorrowedBoundaryPhaseRetry: true,
        connectBorrowedBoundaryPhaseRetryMaxDistance: 22,
        sharedBoundaryMinCells: 6,
        sharedBoundaryTangentThreshold: 0.72,
        sharedGradientSimilarityThreshold: 0.92,
        phaseBorrowBoundaryTolerance: 18,
        boundarySnapBoundaryTolerance: 18,
        boundarySnapMaxDistance: 36,
        boundarySnapMaxAngleDeltaDeg: 22,
        boundarySnapMinImprovement: 1,
        boundarySnapForceEndpoint: true,
        boundarySnapForceEndpointMaxDistance: 14,
      };
    case '038':
      return {
        borrowSharedBoundaryPhase: true,
        borrowSharedBoundaryExplicitOffsets: true,
        connectBorrowedBoundaryPhase: true,
        connectBorrowedBoundaryPhasePreJoin: true,
        connectBorrowedBoundaryPhasePreJoinMaxDistance: 16,
        connectBorrowedBoundaryPhaseRetry: true,
        connectBorrowedBoundaryPhaseRetryMaxDistance: 22,
        sharedBoundaryMinCells: 6,
        sharedBoundaryTangentThreshold: 0.72,
        sharedGradientSimilarityThreshold: 0.92,
        phaseBorrowBoundaryTolerance: 18,
        boundarySnapBoundaryTolerance: 18,
        boundarySnapMaxDistance: 36,
        boundarySnapMaxAngleDeltaDeg: 22,
        boundarySnapMinImprovement: 1,
        boundarySnapForceEndpoint: true,
        boundarySnapForceEndpointMaxDistance: 14,
      };
    default:
      return {};
  }
}

const ribbonParams = ribbonParamsForExperiment(experimentNum);
const crossStreetParams = crossStreetParamsForExperiment(experimentNum);

// === Pipeline setup ===
const t0 = performance.now();
const { layers, settlement } = generateRegionFromSeed(seed, gx, gz);
if (!settlement) { console.error('No settlement'); process.exit(1); }

const rng = new SeededRandom(seed);
const map = setupCity(layers, settlement, rng.fork('city'));
const strategy = new LandFirstDevelopment(map, { archetype: ARCHETYPES.marketTown });
runToStep(strategy, 'spatial');

const zones = map.developmentZones;
const W = map.width, H = map.height;
const cs = map.cellSize;
const ox = map.originX, oz = map.originZ;
const elev = map.getLayer('elevation');
const roadGrid = map.getLayer('roadGrid');
const waterMask = map.getLayer('waterMask');
const eBounds = elev.bounds();
const eRange = eBounds.max - eBounds.min || 1;

// === Segment terrain into faces (once for whole map) ===
console.log('Segmenting terrain...');
const { faces } = segmentTerrainV2(map, {
  dirTolerance: Math.PI / 6,
  elevTolerance: 100,
  slopeBands: [0.3, 0.8],
});
console.log(`Terrain faces: ${faces.length}`);

// Build cellToFace lookup
const cellToFace = new Map();
for (let fi = 0; fi < faces.length; fi++) {
  for (const c of faces[fi].cells) {
    cellToFace.set(c.gz * W + c.gx, fi);
  }
}

// === Zone selection ===
const candidates = zones.filter(z =>
  z.cells.length > 500 &&
  z.boundary && z.boundary.length >= 4 && z.avgSlope !== undefined
);
candidates.sort((a, b) => {
  const ad = Math.abs(a.centroidGx - W / 2) + Math.abs(a.centroidGz - H / 2);
  const bd = Math.abs(b.centroidGx - W / 2) + Math.abs(b.centroidGz - H / 2);
  return ad - bd;
});
const selectedZones = candidates.slice(0, 3);

if (selectedZones.length === 0) {
  console.error('No suitable zones found');
  process.exit(1);
}

console.log(`Found ${candidates.length} candidate zones, rendering ${selectedZones.length}`);

// === HSL to RGB ===
function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

// === Process each zone ===
for (let zi = 0; zi < selectedZones.length; zi++) {
  const zone = selectedZones[zi];
  console.log(`\n=== Zone ${zi} ===`);
  console.log(`  ${zone.cells.length} cells, avgSlope=${zone.avgSlope.toFixed(3)}`);
  const combinedEventSink = new NdjsonEventSink(`${outDir}/events-zone${zi}-seed${seed}.ndjson`);
  const crossEventSink = new FilteredEventSink(
    new NdjsonEventSink(`${outDir}/cross-events-zone${zi}-seed${seed}.ndjson`),
    event => event.stepId === 'cross-streets',
  );
  const ribbonEventSink = new FilteredEventSink(
    new NdjsonEventSink(`${outDir}/ribbon-events-zone${zi}-seed${seed}.ndjson`),
    event => event.stepId === 'ribbons',
  );
  const zoneEventSink = new FanoutEventSink([combinedEventSink, crossEventSink, ribbonEventSink]);

  // Zone bounding box for cropped render
  let minGx = W, maxGx = 0, minGz = H, maxGz = 0;
  for (const c of zone.cells) {
    if (c.gx < minGx) minGx = c.gx;
    if (c.gx > maxGx) maxGx = c.gx;
    if (c.gz < minGz) minGz = c.gz;
    if (c.gz > maxGz) maxGz = c.gz;
  }
  const pad = 20;
  minGx = Math.max(0, minGx - pad);
  maxGx = Math.min(W - 1, maxGx + pad);
  minGz = Math.max(0, minGz - pad);
  maxGz = Math.min(H - 1, maxGz + pad);
  const cropW = maxGx - minGx + 1;
  const cropH = maxGz - minGz + 1;
  console.log(`  Crop: ${cropW}x${cropH} at (${minGx},${minGz})`);

  // === Build sectors (zone x face intersections) ===
  const sectorMap = new Map();
  for (const c of zone.cells) {
    const key = c.gz * W + c.gx;
    const fi = cellToFace.get(key);
    if (fi === undefined) continue;
    if (!sectorMap.has(fi)) sectorMap.set(fi, []);
    sectorMap.get(fi).push(c);
  }

  const MIN_SECTOR_CELLS = 50;
  const sectors = [];
  for (const [fi, cells] of sectorMap) {
    if (cells.length < MIN_SECTOR_CELLS) continue;
    let cx = 0, cz = 0;
    for (const c of cells) { cx += c.gx; cz += c.gz; }
    cx /= cells.length;
    cz /= cells.length;
    const face = faces[fi];
    sectors.push({
      cells,
      centroidGx: cx,
      centroidGz: cz,
      avgSlope: face ? face.avgSlope : zone.avgSlope,
      slopeDir: face ? face.slopeDir : zone.slopeDir,
      boundary: zone.boundary,
      faceIdx: fi,
    });
  }

  console.log(`  Sectors: ${sectors.length} (from ${sectorMap.size} face intersections, min ${MIN_SECTOR_CELLS} cells)`);

  const cellToSector = new Map();
  for (let si = 0; si < sectors.length; si++) {
    for (const c of sectors[si].cells) {
      cellToSector.set(c.gz * W + c.gx, si);
    }
  }
  const sharedBoundaryData = buildSectorSharedBoundaryData(sectors, cellToSector, W, cs, ox, oz);

  // Run cross streets and ribbons per sector, committing via tryAddRoad
  const allCrossStreets = [];
  const allRejectedCrossStreets = [];
  const allPrunedCrossStreets = [];
  const allMissingCrossStreetScanlines = [];
  const allCommitRejectedCrossStreets = [];
  const allRibbons = [];
  const allRibbonJunctions = [];
  const allFailedRibbons = [];
  const allSeedAnchors = [];
  let totalParcels = 0;
  let totalCsRejects = 0;
  let totalRibbonRejects = 0;

  for (let si = 0; si < sectors.length; si++) {
    const sector = sectors[si];
    const sectorFailureCounts = {};
    const sectorCrossParams = buildSectorCrossStreetParams(
      sector,
      sharedBoundaryData[si],
      crossStreetParams,
      allCrossStreets,
    );
    const { crossStreets, debug: crossDebug = {} } = layCrossStreets(sector, map, {
      ...sectorCrossParams,
      eventSink: zoneEventSink,
      eventStepId: 'cross-streets',
      eventContext: {
        experiment: experimentNum,
        seed,
        zoneIdx: zi,
        sectorIdx: si,
        faceIdx: sector.faceIdx,
      },
    });
    allRejectedCrossStreets.push(...(crossDebug.rejectedStreets || []).map(street => ({
      ...street,
      zoneIdx: zi,
      sectorIdx: si,
    })));
    allPrunedCrossStreets.push(...(crossDebug.prunedStreets || []).map(street => ({
      ...street,
      zoneIdx: zi,
      sectorIdx: si,
    })));
    allMissingCrossStreetScanlines.push(...(crossDebug.missingScanlines || []).map(scanline => ({
      ...scanline,
      zoneIdx: zi,
      sectorIdx: si,
    })));

    // Commit cross streets via tryAddRoad
    const committedCrossStreets = [];
    let csRejects = 0;
    for (const cs2 of crossStreets) {
      let attemptPoints = cs2.points;
      let preJoined = false;
      if (sectorCrossParams.connectBorrowedBoundaryPhasePreJoin) {
        const preJoin = connectCrossStreetToBoundarySnapPoint(attemptPoints, sectorCrossParams);
        if (preJoin) {
          emitZoneEvent(zoneEventSink, 'cross-streets', {
            experiment: experimentNum,
            seed,
            zoneIdx: zi,
            sectorIdx: si,
            faceIdx: sector.faceIdx,
          }, 'cross-street-prejoin', {
            streetKey: streetEventKey(cs2),
            ctOff: roundEventNumber(cs2.ctOff),
            snappedEndpoint: roundEventPoint(preJoin.snappedEndpoint),
            snapPoint: roundEventPoint(preJoin.snapPoint),
          });
          attemptPoints = preJoin.points;
          preJoined = true;
        }
      }
      let result = tryAddRoad(map, attemptPoints, { hierarchy: 'residential', source: 'cross-street' });
      let commitMeta = {
        preJoined,
        connectedRetry: false,
        conflictRoadIds: [],
        conflictPoints: [],
      };
      if (!result.accepted && sectorCrossParams.connectBorrowedBoundaryPhaseRetry) {
        const txnReason = classifyTransactionFailure(result.violations);
        if (txnReason === 'txn-parallel') {
          const retry = reconnectCrossStreetToConflictRoad(map, attemptPoints, result.violationDetails, sectorCrossParams);
          if (retry) {
            emitZoneEvent(zoneEventSink, 'cross-streets', {
              experiment: experimentNum,
              seed,
              zoneIdx: zi,
              sectorIdx: si,
              faceIdx: sector.faceIdx,
            }, 'cross-street-commit-retry', {
              streetKey: streetEventKey(cs2),
              ctOff: roundEventNumber(cs2.ctOff),
              conflictRoadIds: retry.conflictRoadIds,
              snappedEndpoint: roundEventPoint(retry.snappedEndpoint),
            });
            attemptPoints = retry.points;
            result = tryAddRoad(map, attemptPoints, { hierarchy: 'residential', source: 'cross-street' });
            commitMeta = {
              connectedRetry: true,
              conflictRoadIds: retry.conflictRoadIds,
              conflictPoints: retry.conflictPoints,
            };
          }
        }
      }
      if (result.accepted) {
        const committedStreet = {
          ...cs2,
          points: attemptPoints,
          roadId: result.road.id,
          preJoined: commitMeta.preJoined,
          connectedRetry: commitMeta.connectedRetry,
          conflictRoadIds: commitMeta.conflictRoadIds,
          conflictPoints: commitMeta.conflictPoints,
        };
        committedCrossStreets.push(committedStreet);
        emitZoneEvent(zoneEventSink, 'cross-streets', {
          experiment: experimentNum,
          seed,
          zoneIdx: zi,
          sectorIdx: si,
          faceIdx: sector.faceIdx,
        }, 'cross-street-committed', {
          streetKey: streetEventKey(committedStreet),
          roadId: result.road.id,
          ctOff: roundEventNumber(committedStreet.ctOff),
          length: roundEventNumber(committedStreet.length),
          startPoint: roundEventPoint(committedStreet.points[0]),
          endPoint: roundEventPoint(committedStreet.points[committedStreet.points.length - 1]),
          snapped: !!committedStreet.snapped,
          snapPoint: roundEventPoint(committedStreet.snapPoint),
          preJoined: committedStreet.preJoined || undefined,
          connectedRetry: committedStreet.connectedRetry || undefined,
          conflictRoadIds: committedStreet.conflictRoadIds?.length ? committedStreet.conflictRoadIds : undefined,
        });
      } else {
        csRejects++;
        const txnReason = classifyTransactionFailure(result.violations);
        const txnConflict = describeTransactionConflict(map, result.violationDetails);
        allCommitRejectedCrossStreets.push({
          ...cs2,
          points: attemptPoints,
          zoneIdx: zi,
          sectorIdx: si,
          reason: txnReason,
          conflictRoadIds: txnConflict.roadIds,
          conflictRoads: txnConflict.roads,
          conflictPoints: txnConflict.points,
          violationDetails: result.violationDetails || [],
        });
        emitZoneEvent(zoneEventSink, 'cross-streets', {
          experiment: experimentNum,
          seed,
          zoneIdx: zi,
          sectorIdx: si,
          faceIdx: sector.faceIdx,
        }, 'cross-street-commit-rejected', {
          streetKey: streetEventKey(cs2),
          ctOff: roundEventNumber(cs2.ctOff),
          length: roundEventNumber(arcLength(attemptPoints)),
          startPoint: roundEventPoint(attemptPoints[0]),
          endPoint: roundEventPoint(attemptPoints[attemptPoints.length - 1]),
          reason: txnReason,
          conflictRoadIds: txnConflict.roadIds,
          conflictPoints: txnConflict.points.map(roundEventPoint),
        });
      }
    }
    allCrossStreets.push(...committedCrossStreets.map(street => ({
      ...street,
      zoneIdx: zi,
      sectorIdx: si,
    })));
    totalCsRejects += csRejects;

    // Lay ribbons between committed cross streets
    if (committedCrossStreets.length >= 2) {
      const {
        ribbons,
        parcels,
        angleRejects,
        failedRibbons = [],
        seedAnchors = [],
        failureSummary = { reasons: {} },
      } = layRibbons(committedCrossStreets, sector, map, {
        ...ribbonParams,
        eventSink: zoneEventSink,
        eventStepId: 'ribbons',
        eventContext: {
          experiment: experimentNum,
          seed,
          zoneIdx: zi,
          sectorIdx: si,
          faceIdx: sector.faceIdx,
        },
      });
      allFailedRibbons.push(...failedRibbons.map((failure, index) => ({
        ...failure,
        zoneIdx: zi,
        sectorIdx: si,
        familyKey: `${si}:${failure.familyRootRowId ?? 'na'}`,
        failureIdx: allFailedRibbons.length + index,
      })));
    allSeedAnchors.push(...seedAnchors.map(anchor => ({
        ...anchor,
        zoneIdx: zi,
        sectorIdx: si,
        familyKey: `${si}:${anchor.familyRootRowId ?? anchor.rowId ?? 'na'}`,
      })));
      mergeCounts(sectorFailureCounts, failureSummary.reasons || {});

      // Commit ribbons via tryAddRoad
      let ribbonRejects = 0;
      const committedRibbons = [];
      for (const ribbon of ribbons) {
        const result = tryAddRoad(map, ribbon.points, { hierarchy: 'residential', source: 'ribbon' });
        if (result.accepted) {
          const junctions = splitRibbonHitJunctions(map, result.road.id, ribbon, committedCrossStreets);
          allRibbonJunctions.push(...junctions.map(junction => ({
            ...junction,
            zoneIdx: zi,
            sectorIdx: si,
            rowId: ribbon.rowId,
            familyRootRowId: ribbon.familyRootRowId ?? ribbon.rowId,
            familyKey: `${si}:${ribbon.familyRootRowId ?? ribbon.rowId}`,
          })));
          committedRibbons.push({
            ...ribbon,
            roadId: result.road.id,
            junctions,
            zoneIdx: zi,
            sectorIdx: si,
            familyKey: `${si}:${ribbon.familyRootRowId ?? ribbon.rowId}`,
          });
        } else {
          ribbonRejects++;
          const reason = classifyTransactionFailure(result.violations);
          addCount(sectorFailureCounts, reason);
          allFailedRibbons.push({
            points: ribbon.points,
            reason,
            source: 'transaction',
            corridorIdx: ribbon.corridorIdx,
            rowIdAttempt: ribbon.rowId,
            familyRootRowId: ribbon.familyRootRowId ?? ribbon.rowId,
            familyKey: `${si}:${ribbon.familyRootRowId ?? ribbon.rowId}`,
            zoneIdx: zi,
            sectorIdx: si,
          });
        }
      }
      allRibbons.push(...committedRibbons);
      totalParcels += parcels.length;
      totalRibbonRejects += ribbonRejects;

      const csStr = csRejects > 0 ? `, ${csRejects} cs rejected` : '';
      const ribStr = ribbonRejects > 0 ? `, ${ribbonRejects} ribbons rejected` : '';
      const angStr = angleRejects > 0 ? `, ${angleRejects} angle rejects` : '';
      const failStr = formatFailureCounts(sectorFailureCounts);
      console.log(`    Sector ${si}: ${committedCrossStreets.length}/${crossStreets.length} cross streets, ${committedRibbons.length}/${ribbons.length} ribbons, ${parcels.length} parcels${csStr}${ribStr}${angStr}${failStr ? `, failures ${failStr}` : ''}`);
    } else {
      const csStr = csRejects > 0 ? ` (${csRejects} rejected)` : '';
      console.log(`    Sector ${si}: ${committedCrossStreets.length} cross streets${csStr} (too few for ribbons)`);
    }
  }

  console.log(`  Total: ${allCrossStreets.length} cross streets (${totalCsRejects} rejected), ${allRibbons.length} ribbons (${totalRibbonRejects} rejected), ${totalParcels} parcels`);

  const sectorColors = sectors.map((_, i) => {
    const hue = (i * 137.508) % 360;
    return hslToRgb(hue, 0.6, 0.45);
  });

  // ===== Render =====
  const basePixels = new Uint8Array(cropW * cropH * 3);

  // Layer 1: Elevation grayscale base
  for (let z = 0; z < cropH; z++) {
    for (let x = 0; x < cropW; x++) {
      const gx2 = x + minGx, gz2 = z + minGz;
      const v = (elev.get(gx2, gz2) - eBounds.min) / eRange;
      const idx = (z * cropW + x) * 3;
      if (waterMask && waterMask.get(gx2, gz2) > 0) {
        basePixels[idx] = 15; basePixels[idx + 1] = 30; basePixels[idx + 2] = 80;
      } else {
        const grey = Math.round(40 + v * 80);
        basePixels[idx] = grey; basePixels[idx + 1] = grey; basePixels[idx + 2] = grey;
      }
    }
  }

  // Layer 2: Sector fills (semi-transparent)
  const ALPHA = 0.25;
  for (let si = 0; si < sectors.length; si++) {
    const color = sectorColors[si];
    for (const c of sectors[si].cells) {
      const px = c.gx - minGx;
      const pz = c.gz - minGz;
      if (px < 0 || px >= cropW || pz < 0 || pz >= cropH) continue;
      const idx = (pz * cropW + px) * 3;
      basePixels[idx]     = Math.round(basePixels[idx]     * (1 - ALPHA) + color[0] * ALPHA);
      basePixels[idx + 1] = Math.round(basePixels[idx + 1] * (1 - ALPHA) + color[1] * ALPHA);
      basePixels[idx + 2] = Math.round(basePixels[idx + 2] * (1 - ALPHA) + color[2] * ALPHA);
    }
  }

  // Layer 3: Contour lines (dark green, every 5m)
  const contourInterval = 5;
  for (let z = 0; z < cropH; z++) {
    for (let x = 0; x < cropW; x++) {
      const gx2 = x + minGx, gz2 = z + minGz;
      const e = elev.get(gx2, gz2);
      let isContour = false;
      const eBin = Math.floor(e / contourInterval);
      if (gx2 + 1 < W && Math.floor(elev.get(gx2 + 1, gz2) / contourInterval) !== eBin) isContour = true;
      if (gz2 + 1 < H && Math.floor(elev.get(gx2, gz2 + 1) / contourInterval) !== eBin) isContour = true;
      if (isContour) {
        const idx = (z * cropW + x) * 3;
        basePixels[idx] = Math.min(255, basePixels[idx] + 30);
        basePixels[idx + 1] = Math.min(255, basePixels[idx + 1] + 50);
        basePixels[idx + 2] = Math.min(255, basePixels[idx + 2] + 20);
      }
    }
  }

  // Layer 4: Roads (grey)
  if (roadGrid) {
    for (let z = 0; z < cropH; z++)
      for (let x = 0; x < cropW; x++)
        if (roadGrid.get(x + minGx, z + minGz) > 0) {
          const idx = (z * cropW + x) * 3;
          basePixels[idx] = 150; basePixels[idx + 1] = 150; basePixels[idx + 2] = 150;
        }
  }

  // Layer 5: Cross streets (magenta polylines)
  for (const street of allCrossStreets) {
    const pts = street.points;
    for (let i = 1; i < pts.length; i++) {
      bres(basePixels, cropW, cropH,
        Math.round((pts[i - 1].x - ox) / cs) - minGx, Math.round((pts[i - 1].z - oz) / cs) - minGz,
        Math.round((pts[i].x - ox) / cs) - minGx, Math.round((pts[i].z - oz) / cs) - minGz,
        255, 0, 255);
    }
  }

  // Layer 6: Sector boundaries (thin white)
  for (let si = 0; si < sectors.length; si++) {
    for (const c of sectors[si].cells) {
      for (const [dx, dz] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nk = (c.gz + dz) * W + (c.gx + dx);
        const nsi = cellToSector.get(nk);
        if (nsi !== undefined && nsi !== si) {
          const px = c.gx - minGx;
          const pz = c.gz - minGz;
          if (px >= 0 && px < cropW && pz >= 0 && pz < cropH) {
            const idx = (pz * cropW + px) * 3;
            basePixels[idx] = 200; basePixels[idx + 1] = 200; basePixels[idx + 2] = 200;
          }
          break;
        }
      }
    }
  }

  // Layer 7: Zone boundary (yellow, 2px thick)
  if (zone.boundary) {
    for (let i = 0; i < zone.boundary.length; i++) {
      const p1 = zone.boundary[i], p2 = zone.boundary[(i + 1) % zone.boundary.length];
      const x0 = Math.round((p1.x - ox) / cs) - minGx;
      const y0 = Math.round((p1.z - oz) / cs) - minGz;
      const x1 = Math.round((p2.x - ox) / cs) - minGx;
      const y1 = Math.round((p2.z - oz) / cs) - minGz;
      bres(basePixels, cropW, cropH, x0, y0, x1, y1, 255, 255, 0);
      bres(basePixels, cropW, cropH, x0 + 1, y0, x1 + 1, y1, 255, 255, 0);
      bres(basePixels, cropW, cropH, x0, y0 + 1, x1, y1 + 1, 255, 255, 0);
    }
  }

  const pixels = basePixels.slice();
  for (const ribbon of allRibbons) {
    drawRoad(pixels, ribbon.points, cropW, cropH, cs, ox, oz, minGx, minGz, [0, 255, 255]);
    drawEndpointDots(pixels, ribbon.points, cropW, cropH, cs, ox, oz, minGx, minGz, [255, 165, 0]);
    drawStreetHitPoints(pixels, ribbon.streetPoints || [], cropW, cropH, cs, ox, oz, minGx, minGz);
  }
  drawConfirmedJunctions(pixels, allRibbonJunctions, cropW, cropH, cs, ox, oz, minGx, minGz);
  for (const anchor of allSeedAnchors) {
    drawAnchorCircle(pixels, anchor.point, cropW, cropH, cs, ox, oz, minGx, minGz, anchor.accepted);
  }

  const failurePixels = basePixels.slice();
  for (const ribbon of allRibbons) {
    drawRoad(failurePixels, ribbon.points, cropW, cropH, cs, ox, oz, minGx, minGz, [80, 200, 200]);
    drawStreetHitPoints(failurePixels, ribbon.streetPoints || [], cropW, cropH, cs, ox, oz, minGx, minGz);
  }
  for (const street of allRejectedCrossStreets) {
    drawCrossStreetDebug(failurePixels, street, cropW, cropH, cs, ox, oz, minGx, minGz, crossStreetDebugColor(street.reason));
  }
  for (const street of allPrunedCrossStreets) {
    drawCrossStreetDebug(failurePixels, street, cropW, cropH, cs, ox, oz, minGx, minGz, crossStreetDebugColor(street.reason));
    if (street.conflictPoint) {
      drawMarker(failurePixels, street.conflictPoint, cropW, cropH, cs, ox, oz, minGx, minGz, [255, 255, 255], 2, [0, 0, 0]);
    }
  }
  for (const scanline of allMissingCrossStreetScanlines) {
    if (scanline.guidePoints?.length >= 2) {
      drawRoad(failurePixels, scanline.guidePoints, cropW, cropH, cs, ox, oz, minGx, minGz, [160, 160, 160]);
    }
    if (scanline.seedPoint) {
      drawMarker(failurePixels, scanline.seedPoint, cropW, cropH, cs, ox, oz, minGx, minGz, [255, 255, 255], 1, [0, 0, 0]);
    }
  }
  for (const street of allCommitRejectedCrossStreets) {
    drawCrossStreetDebug(failurePixels, street, cropW, cropH, cs, ox, oz, minGx, minGz, [255, 70, 70]);
    for (const road of street.conflictRoads || []) {
      drawRoad(failurePixels, road.points, cropW, cropH, cs, ox, oz, minGx, minGz, [255, 255, 255]);
    }
    for (const point of street.conflictPoints || []) {
      drawMarker(failurePixels, point, cropW, cropH, cs, ox, oz, minGx, minGz, [255, 255, 255], 2, [0, 0, 0]);
    }
  }
  drawConfirmedJunctions(failurePixels, allRibbonJunctions, cropW, cropH, cs, ox, oz, minGx, minGz);
  for (const failure of allFailedRibbons) {
    drawRoad(
      failurePixels,
      failure.attemptPath || failure.points,
      cropW,
      cropH,
      cs,
      ox,
      oz,
      minGx,
      minGz,
      failureColor(failure.reason),
    );
  }
  for (const failure of allFailedRibbons) {
    if (failure.guideLine && !samePolyline(failure.guideLine, failure.attemptPath || failure.points)) {
      drawRoad(
        failurePixels,
        failure.guideLine,
        cropW,
        cropH,
        cs,
        ox,
        oz,
        minGx,
        minGz,
        [255, 255, 255],
      );
    }
  }
  for (const failure of allFailedRibbons) {
    if (failure.startPoint) {
      drawMarker(failurePixels, failure.startPoint, cropW, cropH, cs, ox, oz, minGx, minGz, [220, 220, 220], 2);
    }
    if (failure.projectedPoint) {
      drawMarker(failurePixels, failure.projectedPoint, cropW, cropH, cs, ox, oz, minGx, minGz, [120, 255, 255], 2);
    }
    if (failure.stopPoint) {
      drawMarker(failurePixels, failure.stopPoint, cropW, cropH, cs, ox, oz, minGx, minGz, failureColor(failure.reason), 3, [0, 0, 0]);
    }
  }
  for (const anchor of allSeedAnchors) {
    drawAnchorCircle(failurePixels, anchor.point, cropW, cropH, cs, ox, oz, minGx, minGz, anchor.accepted);
  }

  writeRaster(`${outDir}/ribbons-zone${zi}-seed${seed}`, cropW, cropH, pixels);
  console.log(`  Written to ${outDir}/ribbons-zone${zi}-seed${seed}.png (${cropW}x${cropH})`);
  writeDebugSvg(
    `${outDir}/ribbons-zone${zi}-seed${seed}.svg`,
    {
      cropW,
      cropH,
      cs,
      ox,
      oz,
      minGx,
      minGz,
      zone,
      allCrossStreets,
      allRejectedCrossStreets: [],
      allPrunedCrossStreets: [],
      allMissingCrossStreetScanlines: [],
      allCommitRejectedCrossStreets: [],
      allRibbons,
      allRibbonJunctions,
      allSeedAnchors,
      allFailedRibbons: [],
      showFailures: false,
    },
  );
  console.log(`  Written to ${outDir}/ribbons-zone${zi}-seed${seed}.svg (${cropW}x${cropH})`);

  if (allFailedRibbons.length > 0) {
    writeRaster(`${outDir}/ribbon-failures-zone${zi}-seed${seed}`, cropW, cropH, failurePixels);
    console.log(`  Written to ${outDir}/ribbon-failures-zone${zi}-seed${seed}.png (${cropW}x${cropH})`);
    writeDebugSvg(
      `${outDir}/ribbon-failures-zone${zi}-seed${seed}.svg`,
      {
        cropW,
        cropH,
        cs,
        ox,
        oz,
        minGx,
        minGz,
        zone,
        allCrossStreets,
        allRejectedCrossStreets,
        allPrunedCrossStreets,
        allMissingCrossStreetScanlines,
        allCommitRejectedCrossStreets,
        allRibbons,
        allRibbonJunctions,
        allSeedAnchors,
        allFailedRibbons,
        showFailures: true,
      },
    );
    console.log(`  Written to ${outDir}/ribbon-failures-zone${zi}-seed${seed}.svg (${cropW}x${cropH})`);
  }

  const crossFailurePixels = basePixels.slice();
  for (const street of allCrossStreets) {
    drawRoad(crossFailurePixels, street.points, cropW, cropH, cs, ox, oz, minGx, minGz, [180, 80, 180]);
  }
  for (const street of allRejectedCrossStreets) {
    drawCrossStreetDebug(crossFailurePixels, street, cropW, cropH, cs, ox, oz, minGx, minGz, crossStreetDebugColor(street.reason));
  }
  for (const street of allPrunedCrossStreets) {
    drawCrossStreetDebug(crossFailurePixels, street, cropW, cropH, cs, ox, oz, minGx, minGz, crossStreetDebugColor(street.reason));
    if (street.conflictPoint) {
      drawMarker(crossFailurePixels, street.conflictPoint, cropW, cropH, cs, ox, oz, minGx, minGz, [255, 255, 255], 2, [0, 0, 0]);
    }
  }
  for (const street of allCommitRejectedCrossStreets) {
    drawCrossStreetDebug(crossFailurePixels, street, cropW, cropH, cs, ox, oz, minGx, minGz, [255, 70, 70]);
    for (const road of street.conflictRoads || []) {
      drawRoad(crossFailurePixels, road.points, cropW, cropH, cs, ox, oz, minGx, minGz, [255, 255, 255]);
    }
    for (const point of street.conflictPoints || []) {
      drawMarker(crossFailurePixels, point, cropW, cropH, cs, ox, oz, minGx, minGz, [255, 255, 255], 2, [0, 0, 0]);
    }
  }
  for (const scanline of allMissingCrossStreetScanlines) {
    if (scanline.guidePoints?.length >= 2) {
      drawRoad(crossFailurePixels, scanline.guidePoints, cropW, cropH, cs, ox, oz, minGx, minGz, [160, 160, 160]);
    }
    if (scanline.seedPoint) {
      drawMarker(crossFailurePixels, scanline.seedPoint, cropW, cropH, cs, ox, oz, minGx, minGz, [255, 255, 255], 1, [0, 0, 0]);
    }
  }

  if (allRejectedCrossStreets.length > 0 || allPrunedCrossStreets.length > 0 || allMissingCrossStreetScanlines.length > 0 || allCommitRejectedCrossStreets.length > 0) {
    writeRaster(`${outDir}/cross-failures-zone${zi}-seed${seed}`, cropW, cropH, crossFailurePixels);
    console.log(`  Written to ${outDir}/cross-failures-zone${zi}-seed${seed}.png (${cropW}x${cropH})`);
    writeDebugSvg(
      `${outDir}/cross-failures-zone${zi}-seed${seed}.svg`,
      {
        cropW,
        cropH,
        cs,
        ox,
        oz,
        minGx,
        minGz,
        zone,
        allCrossStreets,
        allRejectedCrossStreets,
        allPrunedCrossStreets,
        allMissingCrossStreetScanlines,
        allCommitRejectedCrossStreets,
        allRibbons: [],
        allRibbonJunctions: [],
        allSeedAnchors: [],
        allFailedRibbons: [],
        showFailures: true,
      },
    );
    console.log(`  Written to ${outDir}/cross-failures-zone${zi}-seed${seed}.svg (${cropW}x${cropH})`);
  }
  writeDebugJson(
    `${outDir}/ribbon-debug-zone${zi}-seed${seed}.json`,
    {
      experiment: experimentNum,
      seed,
      gx,
      gz,
      zoneIdx: zi,
      crop: { minGx, minGz, cropW, cropH, cellSize: cs, originX: ox, originZ: oz },
      ribbonParams,
      crossStreetParams,
      crossStreets: allCrossStreets,
      rejectedCrossStreets: allRejectedCrossStreets,
      prunedCrossStreets: allPrunedCrossStreets,
      missingCrossStreetScanlines: allMissingCrossStreetScanlines,
      commitRejectedCrossStreets: allCommitRejectedCrossStreets,
      ribbons: allRibbons,
      junctions: allRibbonJunctions,
      anchors: allSeedAnchors,
      failures: allFailedRibbons,
    },
  );
  console.log(`  Written to ${outDir}/ribbon-debug-zone${zi}-seed${seed}.json`);
  zoneEventSink.close();
  console.log(`  Written to ${outDir}/events-zone${zi}-seed${seed}.ndjson`);
  console.log(`  Written to ${outDir}/cross-events-zone${zi}-seed${seed}.ndjson`);
  console.log(`  Written to ${outDir}/ribbon-events-zone${zi}-seed${seed}.ndjson`);
}

console.log(`\nTotal time: ${((performance.now() - t0) / 1000).toFixed(1)}s`);

function buildSectorCrossStreetParams(sector, boundaryData, params, existingCrossStreets = []) {
  const result = {};
  if (!boundaryData?.midpoint || !boundaryData?.tangent) {
    return result;
  }

  const slopeDir = sector?.slopeDir || { x: 1, z: 0 };
  const contourDir = normalize2({ x: -slopeDir.z, z: slopeDir.x });
  const boundaryTangent = normalize2(boundaryData.tangent);
  if (!contourDir || !boundaryTangent) return result;

  const tangentAlignment = Math.abs(dot2(contourDir, boundaryTangent));
  if (tangentAlignment < (params.sharedBoundaryTangentThreshold ?? 0.72)) {
    return result;
  }
  if ((boundaryData.pointCount ?? 0) < (params.sharedBoundaryMinCells ?? 6)) {
    return result;
  }

  if (params?.borrowSharedBoundaryPhase) {
    const phaseBorrow = deriveSharedBoundaryPhaseBorrow(sector, boundaryData, existingCrossStreets, params);
    if (phaseBorrow) {
      result.phaseOrigin = phaseBorrow.phaseOrigin;
      result.phaseOffset = phaseBorrow.phaseOffset;
      result.phaseOriginSource = 'shared-boundary-borrowed-phase';
      result.phaseBorrowPointCount = phaseBorrow.pointCount;
      result.phaseBorrowExplicitCtOffsetCount = phaseBorrow.explicitCtOffsets?.length || 0;
      result.phaseBorrowBoundarySource = phaseBorrow.otherSectorIdx;
      if (params?.borrowSharedBoundaryExplicitOffsets && phaseBorrow.explicitCtOffsets?.length) {
        result.explicitCtOffsets = phaseBorrow.explicitCtOffsets;
      }
      result.connectBorrowedBoundaryPhasePreJoin = !!params.connectBorrowedBoundaryPhasePreJoin;
      result.connectBorrowedBoundaryPhasePreJoinMaxDistance = params.connectBorrowedBoundaryPhasePreJoinMaxDistance;
      result.connectBorrowedBoundaryPhaseRetry = !!params.connectBorrowedBoundaryPhaseRetry;
      result.connectBorrowedBoundaryPhaseRetryMaxDistance = params.connectBorrowedBoundaryPhaseRetryMaxDistance;
      if (params?.connectBorrowedBoundaryPhase) {
        const boundarySnapPoints = buildSharedBoundarySnapPoints(boundaryData, existingCrossStreets, params);
        if (boundarySnapPoints.length > 0) {
          result.boundarySnapPoints = boundarySnapPoints;
          result.boundarySnapMaxDistance = params.boundarySnapMaxDistance;
          result.boundarySnapMaxAngleDeltaDeg = params.boundarySnapMaxAngleDeltaDeg;
          result.boundarySnapMinImprovement = params.boundarySnapMinImprovement;
          result.boundarySnapForceEndpoint = params.boundarySnapForceEndpoint;
          result.boundarySnapForceEndpointMaxDistance = params.boundarySnapForceEndpointMaxDistance;
        }
      }
      return result;
    }
  }

  if (params?.alignSharedBoundaryAnchor) {
    const anchorPoint = buildSharedBoundaryAnchorPoint(boundaryData, existingCrossStreets, params);
    if (anchorPoint) {
      result.phaseOrigin = anchorPoint;
      result.phaseOriginSource = 'shared-boundary-anchor';
      return result;
    }
  }

  if (params?.alignSharedBoundaryPhase) {
    result.phaseOrigin = boundaryData.midpoint;
    result.phaseOriginSource = 'shared-boundary';
  }

  if (params?.snapSharedBoundaryEndpoints) {
    const boundarySnapPoints = buildSharedBoundarySnapPoints(boundaryData, existingCrossStreets, params);
    if (boundarySnapPoints.length > 0) {
      result.boundarySnapPoints = boundarySnapPoints;
      result.boundarySnapMaxDistance = params.boundarySnapMaxDistance;
      result.boundarySnapMaxAngleDeltaDeg = params.boundarySnapMaxAngleDeltaDeg;
      result.boundarySnapMinImprovement = params.boundarySnapMinImprovement;
    }
  }

  return result;
}

function buildSharedBoundaryAnchorPoint(boundaryData, existingCrossStreets, params) {
  const otherSectorIdx = boundaryData?.otherSectorIdx;
  if (otherSectorIdx === undefined || otherSectorIdx === null) return null;
  if (!Array.isArray(boundaryData?.points) || boundaryData.points.length === 0) return null;

  const toleranceSq = (params.sharedBoundaryAnchorBoundaryTolerance ?? 18) ** 2;
  const candidates = [];

  for (const street of existingCrossStreets) {
    if (street.sectorIdx !== otherSectorIdx || !street.points?.length) continue;
    const endpoints = [street.points[0], street.points[street.points.length - 1]];
    for (const endpoint of endpoints) {
      if (!boundaryData.points.some(point => dotDistSq(point, endpoint) <= toleranceSq)) continue;
      candidates.push(endpoint);
    }
  }

  if (candidates.length === 0) return null;
  let best = candidates[0];
  let bestScore = dotDistSq(best, boundaryData.midpoint);
  for (let i = 1; i < candidates.length; i++) {
    const score = dotDistSq(candidates[i], boundaryData.midpoint);
    if (score < bestScore) {
      best = candidates[i];
      bestScore = score;
    }
  }
  return { x: best.x, z: best.z };
}

function buildSectorSharedBoundaryData(sectors, cellToSector, W, cs, ox, oz) {
  const pairPoints = new Map();

  for (let si = 0; si < sectors.length; si++) {
    for (const cell of sectors[si].cells) {
      for (const [dx, dz] of [[1, 0], [0, 1]]) {
        const ngx = cell.gx + dx;
        const ngz = cell.gz + dz;
        const otherSectorIdx = cellToSector.get(ngz * W + ngx);
        if (otherSectorIdx === undefined || otherSectorIdx === si) continue;
        const pairKey = si < otherSectorIdx ? `${si}:${otherSectorIdx}` : `${otherSectorIdx}:${si}`;
        if (!pairPoints.has(pairKey)) pairPoints.set(pairKey, []);
        pairPoints.get(pairKey).push({
          x: ox + (cell.gx + ngx) * 0.5 * cs,
          z: oz + (cell.gz + ngz) * 0.5 * cs,
        });
      }
    }
  }

  const bestBySector = Array.from({ length: sectors.length }, () => null);
  for (const [pairKey, points] of pairPoints.entries()) {
    const descriptor = describeSharedBoundary(points);
    if (!descriptor) continue;
    const [a, b] = pairKey.split(':').map(Number);
    const shared = {
      ...descriptor,
      otherSectorIdx: b,
      otherSlopeDir: sectors[b]?.slopeDir ?? null,
    };
    if (!bestBySector[a] || shared.pointCount > bestBySector[a].pointCount) {
      bestBySector[a] = shared;
    }
    const reverseShared = {
      ...descriptor,
      otherSectorIdx: a,
      otherSlopeDir: sectors[a]?.slopeDir ?? null,
    };
    if (!bestBySector[b] || reverseShared.pointCount > bestBySector[b].pointCount) {
      bestBySector[b] = reverseShared;
    }
  }

  return bestBySector;
}

function describeSharedBoundary(points) {
  if (!points || points.length < 2) return null;

  let meanX = 0;
  let meanZ = 0;
  for (const point of points) {
    meanX += point.x;
    meanZ += point.z;
  }
  meanX /= points.length;
  meanZ /= points.length;

  let xx = 0;
  let zz = 0;
  let xz = 0;
  for (const point of points) {
    const dx = point.x - meanX;
    const dz = point.z - meanZ;
    xx += dx * dx;
    zz += dz * dz;
    xz += dx * dz;
  }

  const theta = 0.5 * Math.atan2(2 * xz, xx - zz);
  return {
    midpoint: { x: meanX, z: meanZ },
    tangent: { x: Math.cos(theta), z: Math.sin(theta) },
    pointCount: points.length,
    points,
  };
}

function buildSharedBoundarySnapPoints(boundaryData, existingCrossStreets, params) {
  const otherSectorIdx = boundaryData?.otherSectorIdx;
  if (otherSectorIdx === undefined || otherSectorIdx === null) return [];
  if (!Array.isArray(boundaryData?.points) || boundaryData.points.length === 0) return [];

  const toleranceSq = (params.boundarySnapBoundaryTolerance ?? 18) ** 2;
  const snapPoints = [];

  for (const street of existingCrossStreets) {
    if (street.sectorIdx !== otherSectorIdx || !street.points?.length) continue;
    const endpoints = [street.points[0], street.points[street.points.length - 1]];
    for (const endpoint of endpoints) {
      const nearBoundary = boundaryData.points.some(point => dotDistSq(point, endpoint) <= toleranceSq);
      if (nearBoundary) {
        snapPoints.push({ x: endpoint.x, z: endpoint.z });
      }
    }
  }

  return dedupeSnapPoints(snapPoints, 4);
}

function deriveSharedBoundaryPhaseBorrow(sector, boundaryData, existingCrossStreets, params) {
  const slopeDir = normalize2(sector?.slopeDir || { x: 1, z: 0 });
  const otherSlopeDir = normalize2(boundaryData?.otherSlopeDir);
  if (!slopeDir || !otherSlopeDir) return null;
  const gradientAlignment = Math.abs(dot2(slopeDir, otherSlopeDir));
  if (gradientAlignment < (params.sharedGradientSimilarityThreshold ?? 0.92)) return null;

  const phaseOrigin = boundaryData.midpoint;
  const contourDir = normalize2({ x: -slopeDir.z, z: slopeDir.x });
  if (!phaseOrigin || !contourDir) return null;

  const boundaryPoints = buildSharedBoundarySnapPoints({
    ...boundaryData,
    otherSectorIdx: boundaryData.otherSectorIdx,
  }, existingCrossStreets, {
    ...params,
    boundarySnapBoundaryTolerance: params.phaseBorrowBoundaryTolerance ?? 18,
  });
  if (boundaryPoints.length === 0) return null;

  const phaseOffset = averagePhaseOffset(
    boundaryPoints.map(point => dot2({
      x: point.x - phaseOrigin.x,
      z: point.z - phaseOrigin.z,
    }, contourDir)),
    params.spacing ?? 90,
  );
  if (phaseOffset === null || phaseOffset === undefined) return null;

  return {
    phaseOrigin,
    phaseOffset,
    pointCount: boundaryPoints.length,
    otherSectorIdx: boundaryData.otherSectorIdx,
    explicitCtOffsets: dedupePhaseCtOffsets(
      boundaryPoints.map(point => dot2({
        x: point.x - phaseOrigin.x,
        z: point.z - phaseOrigin.z,
      }, contourDir)),
      4,
    ),
  };
}

function averagePhaseOffset(values, spacing) {
  if (!Array.isArray(values) || values.length === 0 || !Number.isFinite(spacing) || spacing <= 0) return null;
  let sumSin = 0;
  let sumCos = 0;
  for (const value of values) {
    const normalized = ((value % spacing) + spacing) % spacing;
    const angle = (normalized / spacing) * Math.PI * 2;
    sumCos += Math.cos(angle);
    sumSin += Math.sin(angle);
  }
  if (Math.abs(sumSin) < 1e-9 && Math.abs(sumCos) < 1e-9) return null;
  let angle = Math.atan2(sumSin, sumCos);
  if (angle < 0) angle += Math.PI * 2;
  return (angle / (Math.PI * 2)) * spacing;
}

function dedupeSnapPoints(points, tolerance) {
  const tolSq = tolerance * tolerance;
  const kept = [];
  for (const point of points) {
    if (!kept.some(existing => dotDistSq(existing, point) <= tolSq)) {
      kept.push(point);
    }
  }
  return kept;
}

function dedupePhaseCtOffsets(values, tolerance) {
  const tol = Math.max(tolerance || 0, 1e-6);
  const kept = [];
  const sorted = (values || []).filter(Number.isFinite).sort((a, b) => a - b);
  for (const value of sorted) {
    if (!kept.some(existing => Math.abs(existing - value) <= tol)) {
      kept.push(value);
    }
  }
  return kept;
}

function normalize2(vector) {
  if (!vector) return null;
  const mag = Math.hypot(vector.x, vector.z);
  if (mag < 1e-9) return null;
  return { x: vector.x / mag, z: vector.z / mag };
}

function dot2(a, b) {
  return a.x * b.x + a.z * b.z;
}

function dotDistSq(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

// === Bresenham line draw ===
function bres(pixels, w, h, x0, y0, x1, y1, r, g, b) {
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, x = x0, y = y0;
  for (let i = 0; i < dx + dy + 2; i++) {
    if (x >= 0 && x < w && y >= 0 && y < h) {
      const idx = (y * w + x) * 3;
      pixels[idx] = r; pixels[idx + 1] = g; pixels[idx + 2] = b;
    }
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
}

function drawRoad(pixels, points, cropW, cropH, cs, ox, oz, minGx, minGz, color) {
  for (let i = 1; i < points.length; i++) {
    bres(
      pixels,
      cropW,
      cropH,
      Math.round((points[i - 1].x - ox) / cs) - minGx,
      Math.round((points[i - 1].z - oz) / cs) - minGz,
      Math.round((points[i].x - ox) / cs) - minGx,
      Math.round((points[i].z - oz) / cs) - minGz,
      color[0],
      color[1],
      color[2],
    );
  }
}

function drawCrossStreetDebug(pixels, street, cropW, cropH, cs, ox, oz, minGx, minGz, color) {
  if (street?.points?.length >= 2) {
    drawRoad(pixels, street.points, cropW, cropH, cs, ox, oz, minGx, minGz, color);
  } else if (street?.points?.length === 1) {
    drawMarker(pixels, street.points[0], cropW, cropH, cs, ox, oz, minGx, minGz, color, 1, [0, 0, 0]);
  }
}

function crossStreetDebugColor(reason) {
  switch (reason) {
    case 'min-separation':
      return [255, 185, 80];
    case 'too-few-samples':
      return [180, 150, 255];
    case 'too-short':
      return [150, 110, 255];
    default:
      return [210, 140, 255];
  }
}

function splitRibbonHitJunctions(map, ribbonRoadId, ribbon, crossStreets) {
  if (!map?.roadNetwork || ribbonRoadId === null || ribbonRoadId === undefined) return [];
  const hits = ribbon?.streetPoints || [];
  const junctions = [];
  const seenNodeIds = new Set();
  for (const entry of hits) {
    if (!entry || !entry.pt || !Number.isInteger(entry.streetIdx)) continue;
    const crossStreet = crossStreets[entry.streetIdx];
    if (!crossStreet || crossStreet.roadId === null || crossStreet.roadId === undefined) continue;
    const junctionId = map.roadNetwork.connectRoadsAtPoint(
      ribbonRoadId,
      crossStreet.roadId,
      entry.pt.x,
      entry.pt.z,
      { nodeAttrs: { type: 'ribbon-hit', source: 'ribbon-hit' } },
    );
    if (junctionId === null || junctionId === undefined || seenNodeIds.has(junctionId)) continue;
    const node = map.graph?.getNode ? map.graph.getNode(junctionId) : null;
    if (!node) continue;
    seenNodeIds.add(junctionId);
    junctions.push({
      id: junctionId,
      x: node.x,
      z: node.z,
      streetIdx: entry.streetIdx,
    });
  }
  return junctions;
}

function drawEndpointDots(pixels, points, cropW, cropH, cs, ox, oz, minGx, minGz, color) {
  for (const pt of [points[0], points[points.length - 1]]) {
    const px = Math.round((pt.x - ox) / cs) - minGx;
    const pz = Math.round((pt.z - oz) / cs) - minGz;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (px + dx >= 0 && px + dx < cropW && pz + dz >= 0 && pz + dz < cropH) {
          const idx = ((pz + dz) * cropW + (px + dx)) * 3;
          pixels[idx] = color[0];
          pixels[idx + 1] = color[1];
          pixels[idx + 2] = color[2];
        }
      }
    }
  }
}

function drawAnchorCircle(pixels, point, cropW, cropH, cs, ox, oz, minGx, minGz, accepted) {
  const px = Math.round((point.x - ox) / cs) - minGx;
  const pz = Math.round((point.z - oz) / cs) - minGz;
  const ringColor = accepted ? [255, 215, 0] : [255, 120, 0];

  stampCircle(pixels, cropW, cropH, px, pz, 4, [0, 0, 0]);
  stampCircle(pixels, cropW, cropH, px, pz, 3, ringColor);
}

function drawStreetHitPoints(pixels, streetPoints, cropW, cropH, cs, ox, oz, minGx, minGz) {
  for (const entry of streetPoints) {
    const pt = entry && entry.pt ? entry.pt : entry;
    if (!pt) continue;
    drawMarker(pixels, pt, cropW, cropH, cs, ox, oz, minGx, minGz, [180, 255, 80], 1, [0, 0, 0]);
  }
}

function drawConfirmedJunctions(pixels, junctions, cropW, cropH, cs, ox, oz, minGx, minGz) {
  for (const node of junctions) {
    if (!node) continue;
    drawMarker(pixels, node, cropW, cropH, cs, ox, oz, minGx, minGz, [80, 200, 255], 2, [255, 255, 255]);
  }
}

function drawMarker(pixels, point, cropW, cropH, cs, ox, oz, minGx, minGz, color, radius = 2, outline = null) {
  const px = Math.round((point.x - ox) / cs) - minGx;
  const pz = Math.round((point.z - oz) / cs) - minGz;
  if (outline) stampFilledCircle(pixels, cropW, cropH, px, pz, radius + 1, outline);
  stampFilledCircle(pixels, cropW, cropH, px, pz, radius, color);
}

function stampCircle(pixels, cropW, cropH, cx, cz, radius, color) {
  const rOuterSq = radius * radius;
  const rInnerSq = (radius - 1) * (radius - 1);
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const dSq = dx * dx + dz * dz;
      if (dSq > rOuterSq || dSq < rInnerSq) continue;
      const px = cx + dx;
      const pz = cz + dz;
      if (px < 0 || px >= cropW || pz < 0 || pz >= cropH) continue;
      const idx = (pz * cropW + px) * 3;
      pixels[idx] = color[0];
      pixels[idx + 1] = color[1];
      pixels[idx + 2] = color[2];
    }
  }
}

function stampFilledCircle(pixels, cropW, cropH, cx, cz, radius, color) {
  const rSq = radius * radius;
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const dSq = dx * dx + dz * dz;
      if (dSq > rSq) continue;
      const px = cx + dx;
      const pz = cz + dz;
      if (px < 0 || px >= cropW || pz < 0 || pz >= cropH) continue;
      const idx = (pz * cropW + px) * 3;
      pixels[idx] = color[0];
      pixels[idx + 1] = color[1];
      pixels[idx + 2] = color[2];
    }
  }
}

function writeRaster(basePath, width, height, pixels) {
  const header = `P6\n${width} ${height}\n255\n`;
  writeFileSync(`${basePath}.ppm`, Buffer.concat([Buffer.from(header), Buffer.from(pixels)]));
  try { execSync(`convert "${basePath}.ppm" "${basePath}.png" 2>/dev/null`); } catch {}
}

function writeDebugSvg(filePath, {
  cropW,
  cropH,
  cs,
  ox,
  oz,
  minGx,
  minGz,
  zone,
  allCrossStreets,
  allRejectedCrossStreets,
  allPrunedCrossStreets,
  allMissingCrossStreetScanlines,
  allCommitRejectedCrossStreets,
  allRibbons,
  allRibbonJunctions,
  allSeedAnchors,
  allFailedRibbons,
  showFailures,
}) {
  const parts = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${cropW}" height="${cropH}" viewBox="0 0 ${cropW} ${cropH}">`);
  parts.push(`<rect width="${cropW}" height="${cropH}" fill="#262626" />`);
  parts.push(`<g fill="none" stroke-linecap="round" stroke-linejoin="round">`);

  if (zone.boundary?.length) {
    parts.push(polylineSvg(zone.boundary, {
      cs, ox, oz, minGx, minGz,
      stroke: '#ffff00',
      strokeWidth: 1.8,
      closed: true,
      title: 'zone boundary',
      attrs: {
        class: 'debug-zone-boundary',
        'data-kind': 'zone-boundary',
        'data-label': 'Zone boundary',
        'data-tooltip': 'Zone boundary',
      },
    }));
  }

  for (const street of allCrossStreets) {
    const tooltip = `Cross street\nSector ${street.sectorIdx ?? '?'}\nRoad ${street.roadId ?? 'n/a'}`;
    parts.push(polylineSvg(street.points, {
      cs, ox, oz, minGx, minGz,
      stroke: '#ff00ff',
      strokeWidth: 1.1,
      opacity: 0.95,
      title: tooltip,
      attrs: {
        class: 'debug-cross-street',
        'data-kind': 'cross-street',
        'data-label': 'Cross street',
        'data-tooltip': tooltip,
        'data-sector-idx': street.sectorIdx ?? '',
        'data-road-id': street.roadId ?? '',
        'data-street-key': streetEventKey(street),
        'data-ct-off': roundNumber(street.ctOff ?? 0),
      },
    }));
  }

  if (showFailures) {
    for (const street of allRejectedCrossStreets) {
      const tooltip = [
        'Rejected cross street',
        `Sector ${street.sectorIdx ?? '?'}`,
        `Candidate ${street.candidateKey ?? 'n/a'}`,
        `Reason ${street.reason ?? 'unknown'}`,
        `ct ${roundNumber(street.ctOff ?? 0)}`,
        `Length ${roundNumber(street.length ?? 0)}`,
      ].join('\n');
      const points = street.points?.length >= 2 ? street.points : (street.points || []);
      if (points.length >= 2) {
        parts.push(polylineSvg(points, {
          cs, ox, oz, minGx, minGz,
          stroke: rgbCss(crossStreetDebugColor(street.reason)),
          strokeWidth: 1,
          opacity: 0.9,
          dashArray: '3 2',
          title: tooltip,
          attrs: {
            class: 'debug-cross-street-rejected',
            'data-kind': 'cross-street-rejected',
            'data-label': 'Rejected cross street',
            'data-tooltip': tooltip,
            'data-sector-idx': street.sectorIdx ?? '',
            'data-candidate-key': street.candidateKey ?? '',
            'data-ct-off': roundNumber(street.ctOff ?? 0),
            'data-reason': street.reason ?? '',
          },
        }));
      } else if (points.length === 1) {
        parts.push(circleSvg(points[0], {
          cs, ox, oz, minGx, minGz,
          radius: 1.6,
          fill: rgbCss(crossStreetDebugColor(street.reason)),
          stroke: '#000000',
          strokeWidth: 0.8,
          title: tooltip,
          attrs: {
            class: 'debug-cross-street-rejected',
            'data-kind': 'cross-street-rejected',
            'data-label': 'Rejected cross street',
            'data-tooltip': tooltip,
            'data-sector-idx': street.sectorIdx ?? '',
            'data-candidate-key': street.candidateKey ?? '',
            'data-ct-off': roundNumber(street.ctOff ?? 0),
            'data-reason': street.reason ?? '',
          },
        }));
      }
    }

    for (const street of allPrunedCrossStreets) {
      const tooltip = [
        'Pruned cross street',
        `Sector ${street.sectorIdx ?? '?'}`,
        `Candidate ${street.candidateKey ?? 'n/a'}`,
        `Reason ${street.reason ?? 'unknown'}`,
        `Conflict ${street.conflictCandidateKey ?? 'n/a'}`,
      ].join('\n');
      if (street.points?.length >= 2) {
        parts.push(polylineSvg(street.points, {
          cs, ox, oz, minGx, minGz,
          stroke: rgbCss(crossStreetDebugColor(street.reason)),
          strokeWidth: 1.1,
          opacity: 0.95,
          dashArray: '4 2',
          title: tooltip,
          attrs: {
            class: 'debug-cross-street-pruned',
            'data-kind': 'cross-street-pruned',
            'data-label': 'Pruned cross street',
            'data-tooltip': tooltip,
            'data-sector-idx': street.sectorIdx ?? '',
            'data-candidate-key': street.candidateKey ?? '',
            'data-conflict-candidate-key': street.conflictCandidateKey ?? '',
            'data-ct-off': roundNumber(street.ctOff ?? 0),
            'data-reason': street.reason ?? '',
          },
        }));
      }
      if (street.conflictPoint) {
        parts.push(circleSvg(street.conflictPoint, {
          cs, ox, oz, minGx, minGz,
          radius: 1.8,
          fill: '#ffffff',
          stroke: '#000000',
          strokeWidth: 0.8,
          title: `Cross-street conflict point\n${tooltip}`,
          attrs: {
            class: 'debug-cross-street-pruned-point',
            'data-kind': 'cross-street-pruned-point',
            'data-label': 'Cross-street conflict point',
            'data-tooltip': `Cross-street conflict point\n${tooltip}`,
            'data-sector-idx': street.sectorIdx ?? '',
            'data-candidate-key': street.candidateKey ?? '',
            'data-conflict-candidate-key': street.conflictCandidateKey ?? '',
          },
        }));
      }
    }

    for (const street of allCommitRejectedCrossStreets) {
      const tooltip = [
        'Commit-rejected cross street',
        `Sector ${street.sectorIdx ?? '?'}`,
        `Candidate ${street.candidateKey ?? 'n/a'}`,
        `Reason ${street.reason ?? 'unknown'}`,
        `ct ${roundNumber(street.ctOff ?? 0)}`,
        `Length ${roundNumber(street.length ?? 0)}`,
        `Conflicts ${street.conflictRoadIds?.join(', ') || 'n/a'}`,
      ].join('\n');
      if (street.points?.length >= 2) {
        parts.push(polylineSvg(street.points, {
          cs, ox, oz, minGx, minGz,
          stroke: '#ff4646',
          strokeWidth: 1.2,
          opacity: 0.95,
          dashArray: '5 2',
          title: tooltip,
          attrs: {
            class: 'debug-cross-street-commit-rejected',
            'data-kind': 'cross-street-commit-rejected',
            'data-label': 'Commit-rejected cross street',
            'data-tooltip': tooltip,
            'data-sector-idx': street.sectorIdx ?? '',
            'data-candidate-key': street.candidateKey ?? '',
            'data-ct-off': roundNumber(street.ctOff ?? 0),
            'data-reason': street.reason ?? '',
            'data-conflict-road-ids': (street.conflictRoadIds || []).join(','),
          },
        }));
      }
      for (const road of street.conflictRoads || []) {
        parts.push(polylineSvg(road.points, {
          cs, ox, oz, minGx, minGz,
          stroke: '#ffffff',
          strokeWidth: 1,
          opacity: 0.9,
          dashArray: '1 2',
          title: `Conflicting road\nRoad ${road.id}\nSource ${road.source ?? 'n/a'}`,
          attrs: {
            class: 'debug-cross-street-conflict-road',
            'data-kind': 'cross-street-conflict-road',
            'data-label': 'Conflicting road',
            'data-tooltip': `Conflicting road\nRoad ${road.id}\nSource ${road.source ?? 'n/a'}`,
            'data-road-id': road.id ?? '',
            'data-conflict-for': street.candidateKey ?? '',
          },
        }));
      }
      for (const point of street.conflictPoints || []) {
        parts.push(circleSvg(point, {
          cs, ox, oz, minGx, minGz,
          radius: 1.9,
          fill: '#ffffff',
          stroke: '#000000',
          strokeWidth: 0.8,
          title: `Transaction conflict point\n${tooltip}`,
          attrs: {
            class: 'debug-cross-street-conflict-point',
            'data-kind': 'cross-street-conflict-point',
            'data-label': 'Transaction conflict point',
            'data-tooltip': `Transaction conflict point\n${tooltip}`,
            'data-conflict-for': street.candidateKey ?? '',
          },
        }));
      }
    }

    for (const scanline of allMissingCrossStreetScanlines) {
      const tooltip = [
        'Missing cross street scanline',
        `Sector ${scanline.sectorIdx ?? '?'}`,
        `ct ${roundNumber(scanline.ctOff ?? 0)}`,
        `Runs ${scanline.runCount ?? 0}`,
        `Candidates ${scanline.candidateCount ?? 0}`,
        `Rejected ${scanline.rejectedCount ?? 0}`,
        `Pruned ${scanline.prunedCount ?? 0}`,
      ].join('\n');
      if (scanline.guidePoints?.length >= 2) {
        parts.push(polylineSvg(scanline.guidePoints, {
          cs, ox, oz, minGx, minGz,
          stroke: '#a8a8a8',
          strokeWidth: 0.8,
          opacity: 0.8,
          dashArray: '2 2',
          title: tooltip,
          attrs: {
            class: 'debug-cross-street-missing',
            'data-kind': 'cross-street-missing',
            'data-label': 'Missing cross street scanline',
            'data-tooltip': tooltip,
            'data-sector-idx': scanline.sectorIdx ?? '',
            'data-ct-off': roundNumber(scanline.ctOff ?? 0),
          },
        }));
      }
      if (scanline.seedPoint) {
        parts.push(circleSvg(scanline.seedPoint, {
          cs, ox, oz, minGx, minGz,
          radius: 1.4,
          fill: '#ffffff',
          stroke: '#000000',
          strokeWidth: 0.8,
          title: tooltip,
          attrs: {
            class: 'debug-cross-street-missing-point',
            'data-kind': 'cross-street-missing-point',
            'data-label': 'Missing cross street seed',
            'data-tooltip': tooltip,
            'data-sector-idx': scanline.sectorIdx ?? '',
            'data-ct-off': roundNumber(scanline.ctOff ?? 0),
          },
        }));
      }
    }
  }

  for (const ribbon of allRibbons) {
    const familyColor = ribbonFamilyColor(ribbon.familyRootRowId ?? ribbon.rowId);
    const tooltip = [
      'Ribbon row',
      `Sector ${ribbon.sectorIdx ?? '?'}`,
      `Row ${ribbon.rowId}`,
      `Family ${ribbon.familyKey ?? (ribbon.familyRootRowId ?? ribbon.rowId)}`,
      `Source ${ribbon.source}`,
      `Generation ${ribbon.generation ?? 0}`,
      `Slot ${ribbon.slotIndex ?? 'n/a'}`,
    ].join('\n');
    parts.push(polylineSvg(ribbon.points, {
      cs, ox, oz, minGx, minGz,
      stroke: familyColor,
      strokeWidth: 1.6,
      opacity: showFailures ? 0.75 : 0.95,
      title: tooltip,
      attrs: {
        class: 'debug-ribbon',
        'data-kind': 'ribbon-row',
        'data-label': 'Ribbon row',
        'data-tooltip': tooltip,
        'data-row-id': ribbon.rowId,
        'data-family-key': ribbon.familyKey ?? (ribbon.familyRootRowId ?? ribbon.rowId),
        'data-family-root-row-id': ribbon.familyRootRowId ?? ribbon.rowId,
        'data-parent-row-id': ribbon.parentRowId ?? '',
        'data-source': ribbon.source ?? '',
        'data-sector-idx': ribbon.sectorIdx ?? '',
        'data-generation': ribbon.generation ?? 0,
        'data-slot-index': ribbon.slotIndex ?? '',
      },
    }));
  }

  if (showFailures) {
    for (const failure of allFailedRibbons) {
      const failureMeta = {
        'data-failure-idx': failure.failureIdx ?? '',
        'data-reason': failure.reason ?? '',
        'data-source': failure.source ?? '',
        'data-sector-idx': failure.sectorIdx ?? '',
        'data-row-id-attempt': failure.rowIdAttempt ?? '',
        'data-family-key': failure.familyKey ?? (failure.familyRootRowId ?? ''),
        'data-family-root-row-id': failure.familyRootRowId ?? '',
        'data-conflict-row-id': failure.parentRowId ?? '',
        'data-from-street-idx': failure.fromStreetIdx ?? '',
        'data-to-street-idx': failure.toStreetIdx ?? '',
        'data-anchor-source': failure.anchorSource ?? '',
        'data-anchor-street-idx': failure.anchorStreetIdx ?? '',
        'data-anchor-t': roundNumber(failure.anchorT ?? 0),
        'data-anchor-generation': failure.anchorGeneration ?? '',
        'data-anchor-slot-index': failure.anchorSlotIndex ?? '',
      };
      if (failure.guideLine && !samePolyline(failure.guideLine, failure.attemptPath || failure.points)) {
        parts.push(polylineSvg(failure.guideLine, {
          cs, ox, oz, minGx, minGz,
          stroke: '#ffffff',
          strokeWidth: 0.7,
          opacity: 0.75,
          dashArray: '2 2',
          title: `Guide line\n${failureTitle(failure)}`,
          attrs: {
            class: 'debug-failure-guide',
            'data-kind': 'failure-guide',
            'data-label': 'Guide line',
            'data-tooltip': `Guide line\n${failureTitle(failure)}`,
            ...failureMeta,
          },
        }));
      }
      parts.push(polylineSvg(failure.attemptPath || failure.points, {
        cs, ox, oz, minGx, minGz,
        stroke: rgbCss(failureColor(failure.reason)),
        strokeWidth: 1.2,
        opacity: 0.95,
        title: failureTitle(failure),
        attrs: {
          class: 'debug-failure-path',
          'data-kind': 'failure-path',
          'data-label': 'Failed attempt',
          'data-tooltip': failureTitle(failure),
          ...failureMeta,
        },
      }));
      if (failure.startPoint) {
        parts.push(circleSvg(failure.startPoint, {
          cs, ox, oz, minGx, minGz,
          radius: 1.8,
          fill: '#dcdcdc',
          stroke: '#000000',
          title: `Failure start\n${failureTitle(failure)}`,
          attrs: {
            class: 'debug-failure-start',
            'data-kind': 'failure-start',
            'data-label': 'Failure start',
            'data-tooltip': `Failure start\n${failureTitle(failure)}`,
            ...failureMeta,
          },
        }));
      }
      if (failure.projectedPoint) {
        parts.push(circleSvg(failure.projectedPoint, {
          cs, ox, oz, minGx, minGz,
          radius: 1.8,
          fill: '#78ffff',
          stroke: '#000000',
          title: `Projected landing\n${failureTitle(failure)}`,
          attrs: {
            class: 'debug-failure-projected',
            'data-kind': 'failure-projected',
            'data-label': 'Projected landing',
            'data-tooltip': `Projected landing\n${failureTitle(failure)}`,
            ...failureMeta,
          },
        }));
      }
      if (failure.stopPoint) {
        parts.push(circleSvg(failure.stopPoint, {
          cs, ox, oz, minGx, minGz,
          radius: 2.1,
          fill: rgbCss(failureColor(failure.reason)),
          stroke: '#000000',
          title: `Failure stop\n${failureTitle(failure)}`,
          attrs: {
            class: 'debug-failure-stop',
            'data-kind': 'failure-stop',
            'data-label': 'Failure stop',
            'data-tooltip': `Failure stop\n${failureTitle(failure)}`,
            ...failureMeta,
          },
        }));
        if (failure.reason === 'parallel-cross') {
          parts.push(crossMarkerSvg(failure.stopPoint, {
            cs, ox, oz, minGx, minGz,
            radius: 4.2,
            stroke: '#ffffff',
            strokeWidth: 1.4,
            title: `Conflict point\n${failureTitle(failure)}`,
            attrs: {
              class: 'debug-conflict-point',
              'data-kind': 'conflict-point',
              'data-label': 'Conflict point',
              'data-tooltip': `Conflict point\n${failureTitle(failure)}`,
              ...failureMeta,
            },
          }));
        }
      }
    }
  }

  for (const anchor of allSeedAnchors) {
    const anchorShape = anchorShapeForSource(anchor.source);
    const anchorRole = anchorRoleLabel(anchor.source);
    const tooltip = [
      anchor.accepted ? `Accepted ${anchorRole}` : `Failed ${anchorRole}`,
      `Sector ${anchor.sectorIdx ?? '?'}`,
      `Seq ${anchor.rowId ?? 'n/a'}`,
      `Street ${anchor.streetIdx ?? '?'}`,
      `Source ${anchor.source ?? 'n/a'}`,
      `Family ${anchor.familyKey ?? (anchor.familyRootRowId ?? 'n/a')}`,
      `Generation ${anchor.generation ?? 0}`,
      `Slot ${anchor.slotIndex ?? 'n/a'}`,
      `t ${roundNumber(anchor.t ?? 0)}`,
    ].join('\n');
    parts.push(markerSvg(anchor.point, {
      cs, ox, oz, minGx, minGz,
      shape: anchorShape,
      radius: 2.8,
      fill: 'none',
      stroke: anchor.accepted ? '#ffd700' : '#ff7800',
      strokeWidth: 1.2,
      title: tooltip,
      attrs: {
        class: 'debug-anchor',
        'data-kind': 'anchor',
        'data-label': anchor.accepted ? `Accepted ${anchorRole}` : `Failed ${anchorRole}`,
        'data-tooltip': tooltip,
        'data-accepted': anchor.accepted ? 'true' : 'false',
        'data-source': anchor.source ?? '',
        'data-anchor-role': anchorRole,
        'data-anchor-shape': anchorShape,
        'data-family-key': anchor.familyKey ?? (anchor.familyRootRowId ?? ''),
        'data-family-root-row-id': anchor.familyRootRowId ?? '',
        'data-parent-row-id': anchor.parentRowId ?? '',
        'data-generation': anchor.generation ?? 0,
        'data-slot-index': anchor.slotIndex ?? '',
        'data-sector-idx': anchor.sectorIdx ?? '',
        'data-street-idx': anchor.streetIdx ?? '',
        'data-sequence': anchor.rowId ?? '',
        'data-t': roundNumber(anchor.t ?? 0),
      },
    }));
    if (anchor.rowId !== undefined && anchor.rowId !== null) {
      parts.push(textSvg(anchor.point, {
        cs, ox, oz, minGx, minGz,
        text: String(anchor.rowId),
        dx: 4.5,
        dy: -4.5,
        fill: '#ffffff',
        stroke: '#000000',
        strokeWidth: 1.3,
        fontSize: 6.2,
        title: tooltip,
        attrs: {
          class: 'debug-anchor-sequence',
          'data-kind': 'anchor-sequence',
          'data-label': 'Anchor sequence',
          'data-tooltip': tooltip,
          'data-sequence': anchor.rowId,
          'data-source': anchor.source ?? '',
          'data-anchor-role': anchorRole,
          'data-family-key': anchor.familyKey ?? (anchor.familyRootRowId ?? ''),
          'data-family-root-row-id': anchor.familyRootRowId ?? '',
          'data-parent-row-id': anchor.parentRowId ?? '',
          'data-generation': anchor.generation ?? 0,
          'data-slot-index': anchor.slotIndex ?? '',
          'data-sector-idx': anchor.sectorIdx ?? '',
          'data-street-idx': anchor.streetIdx ?? '',
          'data-t': roundNumber(anchor.t ?? 0),
        },
      }));
    }
  }

  for (const junction of allRibbonJunctions) {
    const tooltip = [
      'Confirmed junction',
      `Sector ${junction.sectorIdx ?? '?'}`,
      `Street ${junction.streetIdx ?? '?'}`,
      `Row ${junction.rowId ?? 'n/a'}`,
      `Family ${junction.familyKey ?? (junction.familyRootRowId ?? 'n/a')}`,
    ].join('\n');
    parts.push(circleSvg(junction, {
      cs, ox, oz, minGx, minGz,
      radius: 1.8,
      fill: '#50c8ff',
      stroke: '#ffffff',
      strokeWidth: 0.8,
      title: tooltip,
      attrs: {
        class: 'debug-junction',
        'data-kind': 'junction',
        'data-label': 'Confirmed junction',
        'data-tooltip': tooltip,
        'data-row-id': junction.rowId ?? '',
        'data-family-key': junction.familyKey ?? (junction.familyRootRowId ?? ''),
        'data-family-root-row-id': junction.familyRootRowId ?? '',
        'data-sector-idx': junction.sectorIdx ?? '',
        'data-street-idx': junction.streetIdx ?? '',
      },
    }));
  }

  parts.push(`</g>`);
  parts.push(`</svg>`);
  writeFileSync(filePath, parts.join('\n'));
}

function writeDebugJson(filePath, data) {
  const payload = {
    experiment: data.experiment,
    seed: data.seed,
    grid: { gx: data.gx, gz: data.gz },
    zoneIdx: data.zoneIdx,
    crop: data.crop,
    ribbonParams: data.ribbonParams,
    crossStreetParams: data.crossStreetParams,
    familySummary: summarizeFamilies(data.ribbons),
    crossStreets: data.crossStreets.map(street => ({
      sectorIdx: street.sectorIdx ?? null,
      roadId: street.roadId ?? null,
      points: serializePoints(street.points),
    })),
    rejectedCrossStreets: (data.rejectedCrossStreets || []).map(street => ({
      sectorIdx: street.sectorIdx ?? null,
      candidateKey: street.candidateKey ?? null,
      reason: street.reason ?? null,
      ctOff: roundNullable(street.ctOff),
      runIdx: street.runIdx ?? null,
      snapped: !!street.snapped,
      length: roundNullable(street.length),
      points: serializePoints(street.points || []),
    })),
    prunedCrossStreets: (data.prunedCrossStreets || []).map(street => ({
      sectorIdx: street.sectorIdx ?? null,
      candidateKey: street.candidateKey ?? null,
      reason: street.reason ?? null,
      ctOff: roundNullable(street.ctOff),
      runIdx: street.runIdx ?? null,
      snapped: !!street.snapped,
      length: roundNullable(street.length),
      conflictCandidateKey: street.conflictCandidateKey ?? null,
      conflictCtOff: roundNullable(street.conflictCtOff),
      conflictPoint: serializeNullablePoint(street.conflictPoint),
      conflictDistance: roundNullable(street.conflictDistance),
      points: serializePoints(street.points || []),
    })),
    missingCrossStreetScanlines: (data.missingCrossStreetScanlines || []).map(scanline => ({
      sectorIdx: scanline.sectorIdx ?? null,
      ctOff: roundNullable(scanline.ctOff),
      seedPoint: serializeNullablePoint(scanline.seedPoint),
      runCount: scanline.runCount ?? 0,
      breakCount: scanline.breakCount ?? 0,
      breakReasons: scanline.breakReasons || {},
      candidateCount: scanline.candidateCount ?? 0,
      rejectedCount: scanline.rejectedCount ?? 0,
      rejectedReasons: scanline.rejectedReasons || {},
      prunedCount: scanline.prunedCount ?? 0,
      prunedReasons: scanline.prunedReasons || {},
      guidePoints: serializePoints(scanline.guidePoints || []),
    })),
    commitRejectedCrossStreets: (data.commitRejectedCrossStreets || []).map(street => ({
      sectorIdx: street.sectorIdx ?? null,
      candidateKey: street.candidateKey ?? null,
      reason: street.reason ?? null,
      ctOff: roundNullable(street.ctOff),
      length: roundNullable(street.length),
      conflictRoadIds: street.conflictRoadIds || [],
      conflictPoints: (street.conflictPoints || []).map(serializePoint),
      points: serializePoints(street.points || []),
    })),
    ribbons: data.ribbons.map(ribbon => ({
      rowId: ribbon.rowId,
      familyKey: ribbon.familyKey ?? `${ribbon.sectorIdx ?? 'na'}:${ribbon.familyRootRowId ?? ribbon.rowId}`,
      familyRootRowId: ribbon.familyRootRowId ?? ribbon.rowId,
      parentRowId: ribbon.parentRowId ?? null,
      source: ribbon.source,
      generation: ribbon.generation ?? 0,
      slotIndex: ribbon.slotIndex ?? null,
      sectorIdx: ribbon.sectorIdx ?? null,
      streetOrder: (ribbon.streetPoints || []).map(point => ({
        streetIdx: point.streetIdx,
        t: roundNumber(point.t),
        point: serializePoint(point.pt),
      })),
      points: serializePoints(ribbon.points),
    })),
    anchors: data.anchors.map(anchor => ({
      rowId: anchor.rowId,
      familyKey: anchor.familyKey ?? `${anchor.sectorIdx ?? 'na'}:${anchor.familyRootRowId ?? 'na'}`,
      familyRootRowId: anchor.familyRootRowId ?? null,
      parentRowId: anchor.parentRowId ?? null,
      source: anchor.source,
      generation: anchor.generation ?? 0,
      slotIndex: anchor.slotIndex ?? null,
      accepted: !!anchor.accepted,
      sectorIdx: anchor.sectorIdx ?? null,
      streetIdx: anchor.streetIdx,
      t: roundNumber(anchor.t),
      point: serializePoint(anchor.point),
    })),
    failures: data.failures.map((failure, index) => ({
      id: index,
      reason: failure.reason,
      source: failure.source ?? null,
      sectorIdx: failure.sectorIdx ?? null,
      rowIdAttempt: failure.rowIdAttempt ?? null,
      familyKey: failure.familyKey ?? `${failure.sectorIdx ?? 'na'}:${failure.familyRootRowId ?? 'na'}`,
      familyRootRowId: failure.familyRootRowId ?? null,
      conflictRowId: failure.parentRowId ?? null,
      anchor: {
        streetIdx: failure.anchorStreetIdx ?? null,
        t: roundNullable(failure.anchorT),
        source: failure.anchorSource ?? null,
        generation: failure.anchorGeneration ?? null,
        parentRowId: failure.anchorParentRowId ?? null,
        slotIndex: failure.anchorSlotIndex ?? null,
      },
      fromStreetIdx: failure.fromStreetIdx ?? null,
      fromStreetT: roundNullable(failure.fromStreetT),
      toStreetIdx: failure.toStreetIdx ?? null,
      startPoint: serializeNullablePoint(failure.startPoint),
      projectedPoint: serializeNullablePoint(failure.projectedPoint),
      stopPoint: serializeNullablePoint(failure.stopPoint),
      stopCell: failure.stopCell ?? null,
      hitStreetIds: failure.hitStreetIds ?? null,
      travelled: roundNullable(failure.travelled),
      estimatedGap: roundNullable(failure.estimatedGap),
      attemptPath: serializePoints(failure.attemptPath || failure.points || []),
      guideLine: serializePoints(failure.guideLine || []),
      replayHint: {
        mode: failure.anchorParentRowId === null || failure.anchorParentRowId === undefined
          ? 'seed-row-step'
          : 'family-child-step',
        canReplayFromParent: failure.anchorParentRowId !== null && failure.anchorParentRowId !== undefined,
        suggestedStartStreetIdx: failure.fromStreetIdx ?? failure.anchorStreetIdx ?? null,
        suggestedTargetStreetIdx: failure.toStreetIdx ?? null,
      },
    })),
    junctions: data.junctions.map(junction => ({
      id: junction.id ?? null,
      rowId: junction.rowId ?? null,
      familyKey: junction.familyKey ?? `${junction.sectorIdx ?? 'na'}:${junction.familyRootRowId ?? 'na'}`,
      familyRootRowId: junction.familyRootRowId ?? null,
      sectorIdx: junction.sectorIdx ?? null,
      streetIdx: junction.streetIdx ?? null,
      point: serializePoint(junction),
    })),
  };
  writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function summarizeFamilies(ribbons) {
  const byFamily = new Map();
  for (const ribbon of ribbons) {
    const key = ribbon.familyKey ?? `${ribbon.sectorIdx ?? 'na'}:${ribbon.familyRootRowId ?? ribbon.rowId}`;
    if (!byFamily.has(key)) {
      byFamily.set(key, {
        familyKey: key,
        familyRootRowId: ribbon.familyRootRowId ?? ribbon.rowId,
        rowIds: [],
        sectors: new Set(),
      });
    }
    const family = byFamily.get(key);
    family.rowIds.push(ribbon.rowId);
    if (ribbon.sectorIdx !== undefined && ribbon.sectorIdx !== null) {
      family.sectors.add(ribbon.sectorIdx);
    }
  }
  return [...byFamily.values()].map(family => ({
    familyKey: family.familyKey,
    familyRootRowId: family.familyRootRowId,
    rowIds: family.rowIds.sort((a, b) => a - b),
    sectors: [...family.sectors].sort((a, b) => a - b),
  }));
}

function polylineSvg(points, { cs, ox, oz, minGx, minGz, stroke, strokeWidth = 1, opacity = 1, dashArray = null, closed = false, title = '', attrs = {} }) {
  if (!points || points.length === 0) return '';
  const svgPoints = points
    .map(point => worldToSvg(point, cs, ox, oz, minGx, minGz))
    .map(point => `${point.x},${point.y}`)
    .join(' ');
  const dashAttr = dashArray ? ` stroke-dasharray="${dashArray}"` : '';
  const extraAttrs = attrsToSvg(attrs);
  const fill = closed ? 'none' : 'none';
  return `<polyline points="${svgPoints}${closed ? ` ${svgPoints.split(' ')[0]}` : ''}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" opacity="${opacity}" pointer-events="stroke"${dashAttr}${extraAttrs}>${title ? `<title>${escapeXml(title)}</title>` : ''}</polyline>`;
}

function circleSvg(point, { cs, ox, oz, minGx, minGz, radius = 2, fill = 'none', stroke = '#ffffff', strokeWidth = 1, title = '', attrs = {} }) {
  const p = worldToSvg(point, cs, ox, oz, minGx, minGz);
  const extraAttrs = attrsToSvg(attrs);
  return `<circle cx="${p.x}" cy="${p.y}" r="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" pointer-events="visiblePainted"${extraAttrs}>${title ? `<title>${escapeXml(title)}</title>` : ''}</circle>`;
}

function markerSvg(point, { cs, ox, oz, minGx, minGz, shape = 'circle', radius = 2, fill = 'none', stroke = '#ffffff', strokeWidth = 1, title = '', attrs = {} }) {
  if (shape === 'circle') {
    return circleSvg(point, { cs, ox, oz, minGx, minGz, radius, fill, stroke, strokeWidth, title, attrs });
  }
  const p = worldToSvg(point, cs, ox, oz, minGx, minGz);
  const extraAttrs = attrsToSvg(attrs);
  if (shape === 'diamond') {
    const points = [
      `${p.x},${roundNumber(p.y - radius)}`,
      `${roundNumber(p.x + radius)},${p.y}`,
      `${p.x},${roundNumber(p.y + radius)}`,
      `${roundNumber(p.x - radius)},${p.y}`,
    ].join(' ');
    return `<polygon points="${points}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" pointer-events="visiblePainted"${extraAttrs}>${title ? `<title>${escapeXml(title)}</title>` : ''}</polygon>`;
  }
  if (shape === 'square') {
    return `<rect x="${roundNumber(p.x - radius)}" y="${roundNumber(p.y - radius)}" width="${roundNumber(radius * 2)}" height="${roundNumber(radius * 2)}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" pointer-events="visiblePainted"${extraAttrs}>${title ? `<title>${escapeXml(title)}</title>` : ''}</rect>`;
  }
  return circleSvg(point, { cs, ox, oz, minGx, minGz, radius, fill, stroke, strokeWidth, title, attrs });
}

function textSvg(point, { cs, ox, oz, minGx, minGz, text, dx = 0, dy = 0, fill = '#ffffff', stroke = '#000000', strokeWidth = 1.2, fontSize = 6, title = '', attrs = {} }) {
  const p = worldToSvg(point, cs, ox, oz, minGx, minGz);
  const extraAttrs = attrsToSvg(attrs);
  return `<text x="${roundNumber(p.x + dx)}" y="${roundNumber(p.y + dy)}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" paint-order="stroke fill" font-family="monospace" font-size="${fontSize}" pointer-events="visiblePainted"${extraAttrs}>${escapeXml(text)}${title ? `<title>${escapeXml(title)}</title>` : ''}</text>`;
}

function crossMarkerSvg(point, { cs, ox, oz, minGx, minGz, radius = 4, stroke = '#ffffff', strokeWidth = 1.2, title = '', attrs = {} }) {
  const p = worldToSvg(point, cs, ox, oz, minGx, minGz);
  const extraAttrs = attrsToSvg(attrs);
  return [
    `<g pointer-events="visiblePainted"${extraAttrs}>`,
    title ? `<title>${escapeXml(title)}</title>` : '',
    `<line x1="${roundNumber(p.x - radius)}" y1="${roundNumber(p.y - radius)}" x2="${roundNumber(p.x + radius)}" y2="${roundNumber(p.y + radius)}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round"/>`,
    `<line x1="${roundNumber(p.x - radius)}" y1="${roundNumber(p.y + radius)}" x2="${roundNumber(p.x + radius)}" y2="${roundNumber(p.y - radius)}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round"/>`,
    `<circle cx="${p.x}" cy="${p.y}" r="${roundNumber(radius + 1.2)}" fill="none" stroke="${stroke}" stroke-width="${roundNumber(strokeWidth * 0.8)}"/>`,
    `</g>`,
  ].join('');
}

function attrsToSvg(attrs = {}) {
  const parts = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === '') continue;
    parts.push(` ${key}="${escapeXml(value)}"`);
  }
  return parts.join('');
}

function worldToSvg(point, cs, ox, oz, minGx, minGz) {
  return {
    x: roundNumber((point.x - ox) / cs - minGx),
    y: roundNumber((point.z - oz) / cs - minGz),
  };
}

function ribbonFamilyColor(familyRootRowId) {
  const hue = ((familyRootRowId || 0) * 137.508) % 360;
  const [r, g, b] = hslToRgb(hue, 0.75, 0.6);
  return rgbCss([r, g, b]);
}

function rgbCss(color) {
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

function failureTitle(failure) {
  return [
    `Reason ${failure.reason}`,
    `Source ${failure.source ?? 'unknown'}`,
    `Sector ${failure.sectorIdx ?? '?'}`,
    `Row ${failure.rowIdAttempt ?? 'n/a'}`,
    `Family ${failure.familyKey ?? (failure.familyRootRowId ?? 'n/a')}`,
    `From street ${failure.fromStreetIdx ?? 'n/a'}`,
    `To street ${failure.toStreetIdx ?? 'n/a'}`,
    `Anchor street ${failure.anchorStreetIdx ?? 'n/a'}`,
    `Anchor source ${failure.anchorSource ?? 'n/a'}`,
    `Slot ${failure.anchorSlotIndex ?? 'n/a'}`,
  ].join('\n');
}

function anchorShapeForSource(source) {
  if (source === 'seed-gap') return 'diamond';
  if (source === 'parallel-slot' || source === 'parallel-reseed') return 'square';
  return 'circle';
}

function anchorRoleLabel(source) {
  if (source === 'seed-gap') return 'new family anchor';
  if (source === 'parallel-slot' || source === 'parallel-reseed') return 'follow-on anchor';
  return 'starting seed';
}

function serializePoints(points) {
  return (points || []).map(serializePoint);
}

function serializePoint(point) {
  return {
    x: roundNumber(point.x),
    z: roundNumber(point.z),
  };
}

function serializeNullablePoint(point) {
  return point ? serializePoint(point) : null;
}

function roundNullable(value) {
  return Number.isFinite(value) ? roundNumber(value) : null;
}

function roundNumber(value) {
  return Math.round(value * 100) / 100;
}

function roundEventNumber(value) {
  return Number.isFinite(value) ? roundNumber(value) : null;
}

function roundEventPoint(point) {
  return point ? { x: roundNumber(point.x), z: roundNumber(point.z) } : null;
}

function streetEventKey(street) {
  if (!street?.points?.length) return '';
  const start = street.points[0];
  const end = street.points[street.points.length - 1];
  return [
    roundNumber(street.ctOff ?? 0),
    roundNumber(start.x),
    roundNumber(start.z),
    roundNumber(end.x),
    roundNumber(end.z),
  ].join('|');
}

function emitZoneEvent(sink, stepId, context, type, payload) {
  if (!sink?.emit || !sink?.next) return;
  sink.emit({
    seq: sink.next(),
    stepId,
    ...context,
    type,
    payload,
  });
}

function escapeXml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function classifyTransactionFailure(violations) {
  const first = violations && violations[0] ? violations[0] : '';
  if (first.includes('crosses existing road')) return 'txn-crossing';
  if (first.includes('crosses water')) return 'txn-water';
  if (first.includes('parallel to existing road')) return 'txn-parallel';
  return 'txn-other';
}

function describeTransactionConflict(map, violationDetails = []) {
  const roadIds = [];
  const roads = [];
  const points = [];
  const seenRoadIds = new Set();
  const seenPoints = new Set();

  for (const detail of violationDetails || []) {
    if (Number.isInteger(detail?.roadId) && !seenRoadIds.has(detail.roadId)) {
      seenRoadIds.add(detail.roadId);
      roadIds.push(detail.roadId);
      const road = map?.roadNetwork?.getRoad ? map.roadNetwork.getRoad(detail.roadId) : null;
      if (road?.polyline?.length >= 2) {
        roads.push({
          id: road.id,
          source: road.source ?? road.attrs?.source ?? null,
          hierarchy: road.hierarchy ?? road.attrs?.hierarchy ?? null,
          points: road.polyline,
        });
      }
    }
    const point = detail?.point || detail?.midpoint || null;
    if (point) {
      const key = `${roundNumber(point.x)},${roundNumber(point.z)}`;
      if (!seenPoints.has(key)) {
        seenPoints.add(key);
        points.push({ x: point.x, z: point.z });
      }
    }
  }

  return { roadIds, roads, points };
}

function connectCrossStreetToBoundarySnapPoint(points, params = {}) {
  if (!Array.isArray(points) || points.length < 2) return null;
  if (!Array.isArray(params.boundarySnapPoints) || params.boundarySnapPoints.length === 0) return null;
  const maxDistance = params.connectBorrowedBoundaryPhasePreJoinMaxDistance ?? 16;
  const maxDistanceSq = maxDistance * maxDistance;

  let best = null;
  const candidateEndpoints = [
    { index: 0, point: points[0] },
    { index: points.length - 1, point: points[points.length - 1] },
  ];

  for (const candidate of candidateEndpoints) {
    for (const snapPoint of params.boundarySnapPoints) {
      const dSq = dotDistSq(candidate.point, snapPoint);
      if (dSq > maxDistanceSq) continue;
      if (!best || dSq < best.distanceSq) {
        best = {
          distanceSq: dSq,
          candidateIndex: candidate.index,
          snapPoint,
        };
      }
    }
  }

  if (!best) return null;
  const adjusted = points.map(point => ({ x: point.x, z: point.z }));
  adjusted[best.candidateIndex] = { x: best.snapPoint.x, z: best.snapPoint.z };
  return {
    points: adjusted,
    snappedEndpoint: adjusted[best.candidateIndex],
    snapPoint: best.snapPoint,
  };
}

function reconnectCrossStreetToConflictRoad(map, points, violationDetails = [], params = {}) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const maxDistance = params.connectBorrowedBoundaryPhaseRetryMaxDistance ?? 18;
  const maxDistanceSq = maxDistance * maxDistance;

  let best = null;
  for (const detail of violationDetails || []) {
    if (detail?.type !== 'parallel' || !Number.isInteger(detail.roadId)) continue;
    const road = map?.roadNetwork?.getRoad ? map.roadNetwork.getRoad(detail.roadId) : null;
    if (!road?.polyline?.length) continue;
    const roadEndpoints = [road.polyline[0], road.polyline[road.polyline.length - 1]];
    const candidateEndpoints = [
      { index: 0, point: points[0] },
      { index: points.length - 1, point: points[points.length - 1] },
    ];
    for (const candidate of candidateEndpoints) {
      for (const endpoint of roadEndpoints) {
        const dSq = dotDistSq(candidate.point, endpoint);
        if (dSq > maxDistanceSq) continue;
        if (!best || dSq < best.distanceSq) {
          best = {
            distanceSq: dSq,
            roadId: road.id,
            road,
            endpoint,
            candidateIndex: candidate.index,
          };
        }
      }
    }
  }

  if (!best) return null;
  const adjusted = points.map(point => ({ x: point.x, z: point.z }));
  adjusted[best.candidateIndex] = { x: best.endpoint.x, z: best.endpoint.z };
  return {
    points: adjusted,
    conflictRoadIds: [best.roadId],
    conflictPoints: [{ x: best.endpoint.x, z: best.endpoint.z }],
    snappedEndpoint: { x: best.endpoint.x, z: best.endpoint.z },
  };
}

function arcLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  }
  return total;
}

function failureColor(reason) {
  if (reason === 'wrong-street') return [255, 120, 0];
  if (reason === 'ray-miss') return [255, 210, 120];
  if (reason === 'guide-direction') return [255, 40, 40];
  if (reason === 'guide-offset') return [255, 120, 120];
  if (reason === 'angle') return [190, 60, 255];
  if (reason === 'parallel-side-flip') return [255, 70, 200];
  if (reason === 'parallel-cross') return [255, 40, 40];
  if (reason === 'parallel-angle') return [255, 190, 70];
  if (reason === 'too-short') return [255, 170, 0];
  if (reason === 'too-long') return [255, 120, 0];
  if (reason === 'water' || reason === 'txn-water') return [80, 160, 255];
  if (reason === 'out-of-zone') return [255, 255, 90];
  if (reason === 'off-map') return [255, 255, 255];
  if (reason === 'too-close' || reason === 'txn-parallel' || reason === 'parallel-gap') return [200, 110, 255];
  if (reason === 'txn-crossing') return [255, 0, 0];
  return [255, 180, 180];
}

function formatFailureCounts(counts) {
  const entries = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);
  if (entries.length === 0) return '';
  return entries.map(([reason, count]) => `${reason}=${count}`).join(', ');
}

function mergeCounts(target, counts) {
  for (const [reason, count] of Object.entries(counts)) {
    target[reason] = (target[reason] || 0) + count;
  }
}

function addCount(target, key) {
  target[key] = (target[key] || 0) + 1;
}

function samePolyline(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i].x - b[i].x) > 0.01 || Math.abs(a[i].z - b[i].z) > 0.01) return false;
  }
  return true;
}
