#!/usr/bin/env bun
/**
 * render-sector-micro-allocation.js
 *
 * Micro-sector land allocation prototype:
 * - choose one "prime" road-facing sector per candidate zone
 * - reserve shallow commercial frontage along road-adjacent edges
 * - leave periodic access gaps and stubs
 * - place a first internal service road one block depth behind frontage
 * - fill the remaining reachable area with residential
 *
 * Usage:
 *   bun scripts/render-sector-micro-allocation.js <seed> <gx> <gz> [outDir] [experiment]
 *   bun scripts/render-sector-micro-allocation.js --fixture path --out outDir --experiment 040
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { loadMapForStep } from './fixture-bootstrap.js';
import { segmentTerrainV2 } from '../src/city/incremental/ridgeSegmentationV2.js';
import { layCrossStreets } from '../src/city/incremental/crossStreets.js';
import { layRibbons } from '../src/city/incremental/ribbons.js';
import { tryAddRoad } from '../src/city/incremental/roadTransaction.js';
import {
  FrontageSpan,
  PlannedRoad,
  ReservationLayout,
  ReservationParcel,
} from '../src/city/land/microReservationModel.js';
import {
  arcLengths,
  buildPerpendicularCutLine,
  buildPerpendicularStrip,
  buildStripPolygon,
  dedupePolyline,
  offsetPolylineWithHint,
  sampleAtDistance,
  slicePolyline,
  subdivideDistanceRange,
  splitDistanceRange,
  smoothPolylineChaikin,
} from '../src/city/land/geometryPrimitives.js';

const cliArgs = process.argv.slice(2);
const getArg = (name, def = null) => {
  const idx = cliArgs.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < cliArgs.length ? cliArgs[idx + 1] : def;
};

const fixturePath = getArg('fixture', null);
const seed = fixturePath ? NaN : (parseInt(process.argv[2], 10) || 42);
const gx = fixturePath ? NaN : (parseInt(process.argv[3], 10) || 27);
const gz = fixturePath ? NaN : (parseInt(process.argv[4], 10) || 95);
const outDir = fixturePath ? (getArg('out', 'experiments/040-output')) : (process.argv[5] || 'experiments/040-output');
const experimentNum = fixturePath ? getArg('experiment', null) : (process.argv[6] || null);
const outputPrefix = getArg('output-prefix', '');

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const PARAMS = {
  minSectorCells: 80,
  commercialDepthCells: 2,
  blockDepthCells: 4,
  cornerClearanceCells: 4,
  accessGapSpacingCells: 10,
  accessGapWidthCells: 3,
  minAnchorRunCells: 8,
  cropPad: 14,
  parkMinWidthCells: 10,
  parkMaxWidthCells: 20,
  parkMinHeightCells: 10,
  parkMaxHeightCells: 20,
  parkTargetWidthRatio: 0.18,
  parkTargetHeightRatio: 0.16,
  parkTerraceGapSpacingCells: 12,
  parkTerraceGapWidthCells: 3,
  residualBlockLabelMinCells: 20,
  residualFillMinBlockCells: 120,
  viewVillaMinWidthCells: 6,
  viewVillaMaxWidthCells: 10,
  viewVillaMinHeightCells: 4,
  viewVillaMaxHeightCells: 8,
  viewVillaTargetWidthRatio: 0.12,
  viewVillaTargetHeightRatio: 0.1,
};

const RESIDUAL_CROSS_PARAMS = {
  spacing: 70,
  stepSize: 2.5,
  minLength: 18,
  minSeparation: 5,
};

const RESIDUAL_RIBBON_PARAMS = {
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

const MICRO_BUYER_PROGRAM_044 = {
  name: 'market-town-micro-buyers-v1',
  families: [
    {
      key: 'commercial',
      label: 'Commercial',
      macroSearch: {
        targetSectors: 'road-facing-prime',
        cityPreference: 'high-centrality-near-main-roads',
      },
      familyGoals: {
        preserveRearAccess: true,
      },
      variants: [
        {
          key: 'frontage-strip',
          kind: 'frontage-strip',
          microClaim: {
            shape: 'frontage-strip',
            frontageDepth: 'half-block',
            emitRoads: ['access-gaps', 'stubs', 'service-road'],
          },
        },
      ],
    },
    {
      key: 'civic',
      label: 'Civic',
      macroSearch: {
        targetSectors: 'interior-buildable',
        cityPreference: 'distributed-across-city',
      },
      familyGoals: {
        distributeClaims: true,
      },
      variants: [
        {
          key: 'park',
          kind: 'central-park',
          microClaim: {
            shape: 'rectangle',
            emitRoads: ['perimeter-road', 'connector-road'],
          },
        },
      ],
    },
    {
      key: 'residential',
      label: 'Residential',
      macroSearch: {
        targetSectors: 'residual-after-primary-buyers',
        cityPreference: 'near-commercial-and-existing-roads',
      },
      familyGoals: {
        requireRoadFrontage: true,
      },
      variants: [
        {
          key: 'residual-fill',
          kind: 'residual-fill',
          microClaim: {
            shape: 'residual-fill',
            streetLayout: 'cross-streets-plus-ribbons',
          },
        },
      ],
    },
  ],
};

const MICRO_BUYER_PROGRAM_045 = {
  name: 'market-town-micro-buyers-v2',
  families: [
    MICRO_BUYER_PROGRAM_044.families[0],
    MICRO_BUYER_PROGRAM_044.families[1],
    {
      key: 'residential',
      label: 'Residential',
      macroSearch: {
        targetSectors: 'high-amenity-and-residual',
        cityPreference: 'hilltops-waterfront-quiet-edges',
      },
      familyGoals: {
        requireRoadFrontage: true,
        varyDensityByAmenity: true,
      },
      variants: [
        {
          key: 'view-villa',
          kind: 'view-villa',
          microClaim: {
            shape: 'loose-cluster',
            density: 'low',
            preferredAmenity: ['sea-view', 'hilltop', 'quiet-edge', 'park-edge'],
            emitRoads: ['access-lane'],
          },
        },
        {
          key: 'residual-fill',
          kind: 'residual-fill',
          microClaim: {
            shape: 'residual-fill',
            streetLayout: 'cross-streets-plus-ribbons',
          },
        },
      ],
    },
  ],
};

const MICRO_BUYER_PROGRAM_046 = {
  name: 'market-town-micro-buyers-v3',
  families: [
    MICRO_BUYER_PROGRAM_044.families[0],
    MICRO_BUYER_PROGRAM_044.families[1],
    {
      key: 'residential',
      label: 'Residential',
      macroSearch: {
        targetSectors: 'park-edge-and-residual',
        cityPreference: 'park-frontage-then-general-fill',
      },
      familyGoals: {
        requireRoadFrontage: true,
        prioritizeParkEdges: true,
      },
      variants: [
        {
          key: 'park-edge-terrace',
          kind: 'park-edge-terrace',
          microClaim: {
            shape: 'single-row-edge',
            frontage: 'park-ring-road',
            density: 'terrace',
            emitRoads: [],
          },
        },
        {
          key: 'residual-fill',
          kind: 'residual-fill',
          microClaim: {
            shape: 'residual-fill',
            streetLayout: 'cross-streets-plus-ribbons',
          },
        },
      ],
    },
  ],
};

const MICRO_BUYER_PROGRAM_047 = {
  name: 'market-town-micro-buyers-v4',
  families: [
    MICRO_BUYER_PROGRAM_044.families[0],
    MICRO_BUYER_PROGRAM_044.families[1],
    {
      key: 'residential',
      label: 'Residential',
      macroSearch: {
        targetSectors: 'park-edge-and-residual',
        cityPreference: 'park-frontage-with-access-slots',
      },
      familyGoals: {
        requireRoadFrontage: true,
        prioritizeParkEdges: true,
        keepResidualPermeable: true,
      },
      variants: [
        {
          key: 'park-edge-terrace',
          kind: 'park-edge-terrace',
          microClaim: {
            shape: 'single-row-edge',
            frontage: 'park-ring-road',
            density: 'terrace',
            accessSlots: 'periodic-breaks',
            emitRoads: [],
          },
        },
        {
          key: 'residual-fill',
          kind: 'residual-fill',
          microClaim: {
            shape: 'residual-fill',
            streetLayout: 'cross-streets-plus-ribbons',
          },
        },
      ],
    },
  ],
};

const MICRO_BUYER_PROGRAM_048 = {
  name: 'market-town-micro-buyers-v5',
  families: [
    MICRO_BUYER_PROGRAM_044.families[0],
    MICRO_BUYER_PROGRAM_044.families[1],
    {
      key: 'residential',
      label: 'Residential',
      macroSearch: {
        targetSectors: 'park-edge-first',
        cityPreference: 'inspect-remaining-blocks-before-fill',
      },
      familyGoals: {
        requireRoadFrontage: true,
        prioritizeParkEdges: true,
        keepResidualPermeable: true,
      },
      variants: [
        {
          key: 'park-edge-terrace',
          kind: 'park-edge-terrace',
          microClaim: {
            shape: 'single-row-edge',
            frontage: 'park-ring-road',
            density: 'terrace',
            accessSlots: 'periodic-breaks',
            emitRoads: [],
          },
        },
      ],
    },
  ],
};

const { map, runSeed, runGx, runGz, fixtureMeta } = await loadMapForStep({
  fixturePath,
  seed,
  gx,
  gz,
  step: 'spatial',
  archetype: 'marketTown',
});

if (fixturePath) {
  console.log(`Loaded fixture: ${fixturePath}`);
  console.log(`Fixture step: ${fixtureMeta?.afterStep ?? 'unknown'}`);
}

const zones = map.developmentZones || [];
const W = map.width;
const H = map.height;
const cs = map.cellSize;
const ox = map.originX;
const oz = map.originZ;
const elev = map.getLayer('elevation');
const roadGrid = map.getLayer('roadGrid');
const waterMask = map.getLayer('waterMask');
const eBounds = elev.bounds();
const eRange = eBounds.max - eBounds.min || 1;

console.log('Segmenting terrain...');
const { faces } = segmentTerrainV2(map, {
  dirTolerance: Math.PI / 6,
  elevTolerance: 100,
  slopeBands: [0.3, 0.8],
});
console.log(`Terrain faces: ${faces.length}`);

const cellToFace = new Map();
for (let fi = 0; fi < faces.length; fi++) {
  for (const c of faces[fi].cells) {
    cellToFace.set(c.gz * W + c.gx, fi);
  }
}

const candidates = zones.filter(zone =>
  zone.cells?.length > 500 &&
  zone.boundary?.length >= 4 &&
  zone.avgSlope !== undefined,
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

const runResidualStreetLayout = experimentNum === '041' || experimentNum === '042' || experimentNum === '043' || experimentNum === '044' || experimentNum === '045' || experimentNum === '046' || experimentNum === '047' || experimentNum === '049';
const includeCentralPark = experimentNum === '043' || experimentNum === '044' || experimentNum === '045' || experimentNum === '046' || experimentNum === '047' || experimentNum === '048' || experimentNum === '049';
const includePremiumResidential = experimentNum === '045';
const useBuyerProgram = experimentNum === '044' || experimentNum === '045' || experimentNum === '046' || experimentNum === '047' || experimentNum === '048' || experimentNum === '049';
const useVectorReservationPrototype = experimentNum === '050' || experimentNum === '051' || experimentNum === '052';
const vectorPrototypeMode = experimentNum === '052'
  ? 'hierarchical-access'
  : (experimentNum === '051' ? 'perpendicular-cuts' : 'parallel-strip');
const buyerProgram = experimentNum === '049'
  ? MICRO_BUYER_PROGRAM_048
  : (experimentNum === '048'
  ? MICRO_BUYER_PROGRAM_048
  : (experimentNum === '047'
  ? MICRO_BUYER_PROGRAM_047
  : (experimentNum === '046'
  ? MICRO_BUYER_PROGRAM_046
  : (experimentNum === '045' ? MICRO_BUYER_PROGRAM_045 : MICRO_BUYER_PROGRAM_044))));
const residualCrossPhaseMode = experimentNum === '042' || experimentNum === '043' || experimentNum === '044' || experimentNum === '045' || experimentNum === '046' || experimentNum === '047' || experimentNum === '049' ? 'phase-only' : 'explicit-offsets';
const commitBuyerRoads = experimentNum === '048' || experimentNum === '049';
const inspectResidualBlocksOnly = experimentNum === '048';
const fillMeaningfulResidualBlocks = experimentNum === '049';

for (let zi = 0; zi < selectedZones.length; zi++) {
  const zone = selectedZones[zi];
  console.log(`\n=== Zone ${zi} ===`);

  const sectors = buildSectors(zone, cellToFace, faces, W, PARAMS.minSectorCells);
  console.log(`  Sectors: ${sectors.length}`);

  const scoredSectors = sectors
    .map((sector, sectorIdx) => {
      const analysis = useVectorReservationPrototype
        ? analyzeSectorVectorPrototype(sector, roadGrid, W, H, PARAMS, map, vectorPrototypeMode)
        : (useBuyerProgram
        ? analyzeSectorWithBuyerProgram(sector, roadGrid, W, H, PARAMS, buyerProgram, {
          waterMask,
          elevation: elev,
        })
        : analyzeSector(sector, roadGrid, W, H, PARAMS, {
          includeCentralPark,
          includePremiumResidential,
          waterMask,
          elevation: elev,
        }));
      const score = analysis.anchorCellCount * 4 + analysis.anchorRuns.length * 20 + Math.min(sector.cells.length * 0.1, 40);
      return { sector, sectorIdx, analysis, score };
    })
    .filter(entry => entry.analysis.anchorRuns.length > 0)
    .sort((a, b) => b.score - a.score);

  if (scoredSectors.length === 0) {
    console.log('  No road-facing sector found');
    continue;
  }

  const selected = scoredSectors[0];
  const { sector, sectorIdx, analysis } = selected;
  const crop = computeSectorCrop(sector, W, H, PARAMS.cropPad);
  const basePixels = buildBasePixels({
    crop,
    elev,
    eBounds,
    eRange,
    waterMask,
    roadGrid,
    zone,
    sector,
    sectorIdx,
    cs,
    ox,
    oz,
    W,
  });
  const pixels = basePixels.slice();

  if (useVectorReservationPrototype) {
    const workingMap = map.clone();
    const committedBuyerRoads = commitPlannedReservationRoads(workingMap, analysis.layout.roads);
    drawCells(pixels, crop, sector.cells, [70, 210, 255]);
    drawCells(pixels, crop, analysis.anchorCells, [255, 0, 255]);
    for (const road of committedBuyerRoads) {
      drawWorldPolyline(
        pixels,
        crop,
        road.points,
        cs,
        ox,
        oz,
        road.type === 'stub-road' ? [255, 235, 80] : [255, 245, 120],
      );
    }
    for (const gap of analysis.gapMarkers) {
      drawWorldMarker(pixels, crop, gap, cs, ox, oz, [255, 255, 255], 1);
    }

    const basePath = outputPath(`micro-allocation-zone${zi}-seed${runSeed}`);
    writeRaster(basePath, crop.width, crop.height, pixels);
    writeVectorReservationSvg(`${basePath}.svg`, {
      crop,
      zoneBoundary: zone.boundary || [],
      sectorCells: sector.cells,
      anchorCells: analysis.anchorCells,
      layout: analysis.layout,
      committedBuyerRoads,
      gapMarkers: analysis.gapMarkers,
      cs,
      ox,
      oz,
    });
    writeDebugJson(`${basePath}.json`, {
      experiment: experimentNum,
      seed: runSeed,
      gx: runGx,
      gz: runGz,
      zoneIdx: zi,
      sectorIdx,
      crop,
      params: PARAMS,
      sectorCells: sector.cells.length,
      anchorCellCount: analysis.anchorCellCount,
      anchorRuns: analysis.anchorRuns.map(run => ({
        cellCount: run.cells.length,
        tangent: roundVector(run.tangent),
        inward: roundVector(run.inward),
        gapCenterCount: run.gapCenters.length,
      })),
      counts: {
        frontageSpans: analysis.layout.frontageSpans.length,
        commercialParcels: analysis.layout.parcels.length,
        plannedRoads: analysis.layout.roads.length,
        committedBuyerRoads: committedBuyerRoads.length,
        gapMarkers: analysis.gapMarkers.length,
      },
      layout: analysis.layout.toJSON(),
    });

    console.log(`  Sector ${sectorIdx}: ${sector.cells.length} cells`);
    console.log(`    anchor runs: ${analysis.anchorRuns.length}`);
    console.log(`    frontage spans: ${analysis.layout.frontageSpans.length}`);
    console.log(`    commercial parcels: ${analysis.layout.parcels.length}`);
    console.log(`    planned roads: ${analysis.layout.roads.length}`);
    console.log(`    committed buyer roads: ${committedBuyerRoads.length}`);
    console.log(`  Written to ${basePath}.png`);
    console.log(`  Written to ${basePath}.svg`);
    continue;
  }

  let workingMap = null;
  let committedBuyerRoads = [];
  let residualBlocks = [];
  let meaningfulResidualBlocks = [];
  if (commitBuyerRoads) {
    workingMap = map.clone();
    committedBuyerRoads = commitMicroBuyerRoads(workingMap, analysis, map);
    residualBlocks = buildResidualBlocks({
      sectorCells: sector.cells,
      blockedCells: unionCellArrays(
        analysis.commercialCells,
        analysis.parkCells,
        analysis.terraceResidentialCells,
        analysis.premiumResidentialCells,
      ),
      roadGrid: workingMap.getLayer('roadGrid'),
      waterMask: workingMap.getLayer('waterMask'),
      width: W,
      height: H,
    });
    meaningfulResidualBlocks = residualBlocks.filter(block => block.length >= PARAMS.residualFillMinBlockCells);
  }

  if (inspectResidualBlocksOnly) {
    drawResidualBlocks(pixels, crop, meaningfulResidualBlocks);
  } else if (fillMeaningfulResidualBlocks) {
    drawResidualBlocks(pixels, crop, meaningfulResidualBlocks);
  } else {
    drawCells(pixels, crop, analysis.residentialCells, [70, 210, 255]);
  }
  drawCells(pixels, crop, analysis.terraceResidentialCells, [255, 190, 210]);
  if (!inspectResidualBlocksOnly) {
    drawCells(pixels, crop, analysis.unreachableCells, [180, 60, 60]);
  }
  drawCells(pixels, crop, analysis.commercialCells, [255, 170, 60]);
  drawCells(pixels, crop, analysis.parkCells, [60, 150, 80]);
  drawCells(pixels, crop, analysis.parkRoadCells, [160, 240, 160]);
  drawCells(pixels, crop, analysis.premiumResidentialCells, [196, 150, 255]);
  drawCells(pixels, crop, analysis.premiumAccessRoadCells, [216, 186, 255]);
  drawCells(pixels, crop, analysis.gapCells, [40, 40, 40]);
  drawCells(pixels, crop, analysis.serviceRoadCells, [255, 245, 120]);
  drawCells(pixels, crop, analysis.stubCells, [255, 235, 80]);
  drawCells(pixels, crop, analysis.anchorCells, [255, 0, 255]);

  let residualCrossStreets = [];
  let residualRibbons = [];
  let residualRibbonFailures = [];
  if (runResidualStreetLayout) {
    const baseResidualMap = fillMeaningfulResidualBlocks && workingMap ? workingMap : map;
    const overlayRoadGrid = fillMeaningfulResidualBlocks
      ? null
      : buildOverlayRoadGrid(
        map,
        analysis.serviceRoadCells,
        analysis.stubCells,
        unionCellArrays(analysis.parkRoadCells, analysis.premiumAccessRoadCells),
      );
    const overlayBarrierMask = buildOverlayBarrierMask(
      baseResidualMap,
      unionCellArrays(
        analysis.commercialCells,
        analysis.parkCells,
        analysis.premiumResidentialCells,
        analysis.terraceResidentialCells,
      ),
    );
    const residualMap = createLayerOverrideMap(baseResidualMap, fillMeaningfulResidualBlocks
      ? { waterMask: overlayBarrierMask }
      : {
        roadGrid: overlayRoadGrid,
        waterMask: overlayBarrierMask,
      });
    const residualSectors = fillMeaningfulResidualBlocks
      ? meaningfulResidualBlocks.map(block => buildResidualSector(block, sector))
      : buildResidualSectors(analysis.residualResidentialCells, sector, W);
    for (const residualSector of residualSectors) {
      if (!residualSector.cells?.length || residualSector.cells.length < PARAMS.residualFillMinBlockCells && fillMeaningfulResidualBlocks) continue;
      const residualCrossParams = {
        ...RESIDUAL_CROSS_PARAMS,
        ...deriveGapPhaseParams(analysis.gapCenters, residualSector, baseResidualMap, RESIDUAL_CROSS_PARAMS.spacing, residualCrossPhaseMode),
      };
      const componentCrossStreets = layCrossStreets(residualSector, residualMap, residualCrossParams).crossStreets || [];
      residualCrossStreets.push(...componentCrossStreets);
      if (componentCrossStreets.length >= 2) {
        const ribbonResult = layRibbons(componentCrossStreets, residualSector, residualMap, RESIDUAL_RIBBON_PARAMS);
        residualRibbons.push(...(ribbonResult.ribbons || []));
        residualRibbonFailures.push(...(ribbonResult.failedRibbons || []));
      }
    }
  }

  for (const street of residualCrossStreets) {
    drawWorldPolyline(pixels, crop, street.points, cs, ox, oz, [255, 0, 255]);
  }
  for (const ribbon of residualRibbons) {
    drawWorldPolyline(pixels, crop, ribbon.points, cs, ox, oz, [0, 255, 255]);
    if (ribbon.points?.length) {
      drawWorldMarker(pixels, crop, ribbon.points[0], cs, ox, oz, [255, 165, 0], 1);
      drawWorldMarker(pixels, crop, ribbon.points[ribbon.points.length - 1], cs, ox, oz, [255, 165, 0], 1);
    }
  }

  for (const center of analysis.gapCenters) {
    drawGridMarker(pixels, crop, center.gx, center.gz, [255, 255, 255], 2);
  }
  for (const road of committedBuyerRoads) {
    drawWorldPolyline(
      pixels,
      crop,
      road.points,
      cs,
      ox,
      oz,
      road.type === 'park-road' ? [160, 240, 160] : [255, 245, 120],
    );
  }

  const basePath = outputPath(`micro-allocation-zone${zi}-seed${runSeed}`);
  writeRaster(basePath, crop.width, crop.height, pixels);
  writeAllocationSvg(`${basePath}.svg`, {
    crop,
    zoneBoundary: zone.boundary || [],
    sectorBoundary: extractCellBoundary(sector.cells, W),
    anchorCells: analysis.anchorCells,
    commercialCells: analysis.commercialCells,
    parkCells: analysis.parkCells,
    parkRoadCells: analysis.parkRoadCells,
    premiumResidentialCells: analysis.premiumResidentialCells,
    premiumAccessRoadCells: analysis.premiumAccessRoadCells,
    terraceResidentialCells: analysis.terraceResidentialCells,
    committedBuyerRoads,
    residualBlocks: inspectResidualBlocksOnly || fillMeaningfulResidualBlocks ? meaningfulResidualBlocks : residualBlocks,
    gapCells: analysis.gapCells,
    serviceRoadCells: analysis.serviceRoadCells,
    stubCells: analysis.stubCells,
    residentialCells: analysis.residentialCells,
    unreachableCells: analysis.unreachableCells,
    gapCenters: analysis.gapCenters,
    residualCrossStreets,
    residualRibbons,
    cs,
    ox,
    oz,
    labelMinCells: PARAMS.residualBlockLabelMinCells,
    W,
    H,
  });
  writeDebugJson(`${basePath}.json`, {
    experiment: experimentNum,
    seed: runSeed,
    gx: runGx,
    gz: runGz,
    zoneIdx: zi,
    sectorIdx,
    crop,
    params: PARAMS,
    sectorCells: sector.cells.length,
    anchorCellCount: analysis.anchorCellCount,
    anchorRuns: analysis.anchorRuns.map(run => ({
      cellCount: run.cells.length,
      tangent: roundVector(run.tangent),
      inward: roundVector(run.inward),
      gapCenterCount: run.gapCenters.length,
    })),
    counts: {
      commercial: analysis.commercialCells.length,
      park: analysis.parkCells.length,
      parkRoad: analysis.parkRoadCells.length,
      premiumResidential: analysis.premiumResidentialCells.length,
      premiumAccessRoad: analysis.premiumAccessRoadCells.length,
      terraceResidential: analysis.terraceResidentialCells.length,
      committedBuyerRoads: committedBuyerRoads.length,
      residualBlocks: residualBlocks.length,
      meaningfulResidualBlocks: meaningfulResidualBlocks.length,
      serviceRoad: analysis.serviceRoadCells.length,
      stubs: analysis.stubCells.length,
      residential: analysis.residentialCells.length,
      unreachable: analysis.unreachableCells.length,
      residualCrossStreets: residualCrossStreets.length,
      residualRibbons: residualRibbons.length,
      residualRibbonFailures: residualRibbonFailures.length,
    },
    residualCrossPhaseMode: runResidualStreetLayout ? residualCrossPhaseMode : null,
    residualBlockSizes: residualBlocks.slice(0, 20).map(block => block.length),
    meaningfulResidualBlockSizes: meaningfulResidualBlocks.slice(0, 20).map(block => block.length),
    residualMeaningfulBlockSizes: residualBlocks.filter(block => block.length >= PARAMS.residualBlockLabelMinCells).slice(0, 20).map(block => block.length),
    buyerProgram: analysis.buyerProgram || null,
  });

  console.log(`  Sector ${sectorIdx}: ${sector.cells.length} cells`);
  console.log(`    anchor runs: ${analysis.anchorRuns.length}`);
  console.log(`    commercial: ${analysis.commercialCells.length} cells`);
  if (includeCentralPark) {
    console.log(`    park: ${analysis.parkCells.length} cells`);
    console.log(`    park road: ${analysis.parkRoadCells.length} cells`);
  }
  if (analysis.premiumResidentialCells.length > 0) {
    console.log(`    premium residential: ${analysis.premiumResidentialCells.length} cells`);
    console.log(`    premium access road: ${analysis.premiumAccessRoadCells.length} cells`);
  }
  if (analysis.terraceResidentialCells.length > 0) {
    console.log(`    terrace residential: ${analysis.terraceResidentialCells.length} cells`);
  }
  if (commitBuyerRoads) {
    console.log(`    committed buyer roads: ${committedBuyerRoads.length}`);
    console.log(`    residual blocks: ${residualBlocks.length}`);
    console.log(`    meaningful residual blocks: ${meaningfulResidualBlocks.length}`);
  }
  if (analysis.buyerProgram) {
    console.log(`    buyer program: ${analysis.buyerProgram.name}`);
  }
  console.log(`    service road: ${analysis.serviceRoadCells.length} cells`);
  console.log(`    stubs: ${analysis.stubCells.length} cells`);
  console.log(`    residential: ${analysis.residentialCells.length} cells`);
  console.log(`    unreachable: ${analysis.unreachableCells.length} cells`);
  if (runResidualStreetLayout) {
    console.log(`    residual cross streets: ${residualCrossStreets.length}`);
    console.log(`    residual ribbons: ${residualRibbons.length}`);
    console.log(`    residual ribbon failures: ${residualRibbonFailures.length}`);
  }
  console.log(`  Written to ${basePath}.png`);
  console.log(`  Written to ${basePath}.svg`);
}

function buildSectors(zone, cellToFace, faces, width, minSectorCells) {
  const sectorMap = new Map();
  for (const c of zone.cells) {
    const fi = cellToFace.get(c.gz * width + c.gx);
    if (fi === undefined) continue;
    if (!sectorMap.has(fi)) sectorMap.set(fi, []);
    sectorMap.get(fi).push(c);
  }

  const sectors = [];
  for (const [fi, cells] of sectorMap) {
    if (cells.length < minSectorCells) continue;
    let cx = 0;
    let cz = 0;
    for (const c of cells) {
      cx += c.gx;
      cz += c.gz;
    }
    cx /= cells.length;
    cz /= cells.length;
    sectors.push({
      cells,
      centroidGx: cx,
      centroidGz: cz,
      faceIdx: fi,
      avgSlope: faces[fi]?.avgSlope ?? zone.avgSlope,
      slopeDir: faces[fi]?.slopeDir ?? zone.slopeDir,
      boundary: zone.boundary,
    });
  }
  return sectors;
}

function buildResidualSector(cells, parentSector) {
  let cx = 0;
  let cz = 0;
  for (const cell of cells) {
    cx += cell.gx;
    cz += cell.gz;
  }
  cx /= cells.length;
  cz /= cells.length;
  return {
    cells,
    centroidGx: cx,
    centroidGz: cz,
    faceIdx: parentSector.faceIdx,
    avgSlope: parentSector.avgSlope,
    slopeDir: parentSector.slopeDir,
    boundary: parentSector.boundary,
  };
}

function buildResidualSectors(cells, parentSector, width) {
  const components = splitConnectedCellComponents(cells, width);
  return components.map(component => buildResidualSector(component, parentSector));
}

function splitConnectedCellComponents(cells, width) {
  if (!Array.isArray(cells) || cells.length === 0) return [];
  const cellMap = new Map(cells.map(cell => [cell.gz * width + cell.gx, cell]));
  const seen = new Set();
  const components = [];
  for (const cell of cells) {
    const startKey = cell.gz * width + cell.gx;
    if (seen.has(startKey)) continue;
    const queue = [cell];
    seen.add(startKey);
    const component = [];
    while (queue.length > 0) {
      const current = queue.pop();
      component.push(current);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = current.gx + dx;
        const nz = current.gz + dz;
        const key = nz * width + nx;
        if (!cellMap.has(key) || seen.has(key)) continue;
        seen.add(key);
        queue.push(cellMap.get(key));
      }
    }
    components.push(component);
  }
  return components;
}

function buildOverlayRoadGrid(map, serviceRoadCells, stubCells, extraRoadCells = []) {
  const overlay = map.getLayer('roadGrid').clone();
  for (const cell of serviceRoadCells) overlay.set(cell.gx, cell.gz, 255);
  for (const cell of stubCells) overlay.set(cell.gx, cell.gz, 255);
  for (const cell of extraRoadCells) overlay.set(cell.gx, cell.gz, 255);
  return overlay;
}

function buildOverlayBarrierMask(map, blockedCells = []) {
  const overlay = map.getLayer('waterMask').clone();
  for (const cell of blockedCells) overlay.set(cell.gx, cell.gz, 1);
  return overlay;
}

function commitMicroBuyerRoads(workingMap, analysis, sourceMap) {
  const plans = [
    ...(analysis.parkRoadLines || []).map(points => ({ type: 'park-road', points })),
    ...(analysis.serviceRoadLines || []).map(points => ({ type: 'service-road', points })),
    ...(analysis.stubLines || []).map(points => ({ type: 'stub-road', points })),
    ...(analysis.premiumAccessRoadLines || []).map(points => ({ type: 'premium-access-road', points })),
  ];
  const committed = [];
  for (const plan of plans) {
    const worldPolyline = gridLineToWorldPolyline(plan.points, sourceMap);
    if (worldPolyline.length < 2) continue;
    const result = tryAddRoad(workingMap, worldPolyline, {
      hierarchy: plan.type === 'park-road' ? 'civic' : 'residential',
      source: `micro-${plan.type}`,
    });
    if (result.accepted && result.way) {
      committed.push({
        type: plan.type,
        wayId: result.way.id,
        points: result.way.polyline.map(point => ({ x: point.x, z: point.z })),
      });
    }
  }
  return committed;
}

function commitPlannedReservationRoads(workingMap, plannedRoads = []) {
  const committed = [];
  for (const road of plannedRoads) {
    if (!road?.centerline || road.centerline.length < 2) continue;
    const result = tryAddRoad(workingMap, road.centerline, {
      hierarchy: road.kind === 'stub-road' ? 'residential' : 'commercial',
      source: `micro-vector-${road.kind}`,
    });
    if (result.accepted && result.way) {
      committed.push({
        id: road.id,
        type: road.kind,
        wayId: result.way.id,
        points: result.way.polyline.map(point => ({ x: point.x, z: point.z })),
      });
    }
  }
  return committed;
}

function gridLineToWorldPolyline(points, map) {
  if (!Array.isArray(points)) return [];
  return points.map(point => ({
    x: map.originX + point.gx * map.cellSize,
    z: map.originZ + point.gz * map.cellSize,
  }));
}

function buildResidualBlocks({ sectorCells, blockedCells, roadGrid, waterMask, width, height }) {
  const sectorSet = new Set(sectorCells.map(cell => cell.gz * width + cell.gx));
  const blockedSet = new Set(blockedCells.map(cell => cell.gz * width + cell.gx));
  const seen = new Set();
  const blocks = [];
  for (const cell of sectorCells) {
    const startKey = cell.gz * width + cell.gx;
    if (seen.has(startKey) || blockedSet.has(startKey)) continue;
    if (roadGrid.get(cell.gx, cell.gz) > 0) continue;
    if (waterMask && waterMask.get(cell.gx, cell.gz) > 0) continue;
    const queue = [cell];
    seen.add(startKey);
    const block = [];
    while (queue.length > 0) {
      const current = queue.pop();
      block.push(current);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = current.gx + dx;
        const nz = current.gz + dz;
        if (nx < 0 || nx >= width || nz < 0 || nz >= height) continue;
        const key = nz * width + nx;
        if (seen.has(key) || !sectorSet.has(key) || blockedSet.has(key)) continue;
        if (roadGrid.get(nx, nz) > 0) continue;
        if (waterMask && waterMask.get(nx, nz) > 0) continue;
        seen.add(key);
        queue.push({ gx: nx, gz: nz });
      }
    }
    if (block.length > 0) blocks.push(block);
  }
  return blocks.sort((a, b) => b.length - a.length);
}

function drawResidualBlocks(pixels, crop, residualBlocks) {
  const palette = [
    [90, 210, 255],
    [90, 255, 180],
    [255, 210, 90],
    [255, 140, 140],
    [180, 140, 255],
    [140, 240, 200],
    [255, 170, 90],
    [120, 200, 255],
  ];
  residualBlocks.forEach((block, index) => {
    const color = index < palette.length ? palette[index] : [80, 120, 150];
    drawCells(pixels, crop, block, color);
  });
}

function createLayerOverrideMap(map, overrides) {
  return {
    ...map,
    hasLayer(name) {
      if (Object.prototype.hasOwnProperty.call(overrides, name)) return true;
      return map.hasLayer(name);
    },
    getLayer(name) {
      if (Object.prototype.hasOwnProperty.call(overrides, name)) return overrides[name];
      return map.getLayer(name);
    },
  };
}

function deriveGapPhaseParams(gapCenters, sector, map, spacing, mode = 'explicit-offsets') {
  if (!Array.isArray(gapCenters) || gapCenters.length === 0) return {};
  const slopeDir = normalize2(sector.slopeDir || { x: 1, z: 0 });
  if (!slopeDir) return {};
  const contourDir = normalize2({ x: -slopeDir.z, z: slopeDir.x });
  if (!contourDir) return {};

  const phaseOrigin = {
    x: map.originX + sector.centroidGx * map.cellSize,
    z: map.originZ + sector.centroidGz * map.cellSize,
  };
  const explicitCtOffsets = dedupeNumbers(
    gapCenters.map(center => {
      const wx = map.originX + center.gx * map.cellSize;
      const wz = map.originZ + center.gz * map.cellSize;
      return (wx - phaseOrigin.x) * contourDir.x + (wz - phaseOrigin.z) * contourDir.z;
    }),
    map.cellSize * 2,
  );
  if (explicitCtOffsets.length === 0) return {};

  if (mode === 'phase-only') {
    const phaseOffset = bestFitPhaseOffset(explicitCtOffsets, spacing, map.cellSize * 0.5);
    if (!Number.isFinite(phaseOffset)) return {};
    return {
      phaseOrigin,
      phaseOriginSource: 'micro-frontage-gap-best-fit-phase',
      phaseOffset,
    };
  }

  return {
    phaseOrigin,
    phaseOriginSource: 'micro-frontage-gap-phase',
    explicitCtOffsets,
  };
}

function bestFitPhaseOffset(ctOffsets, spacing, resolution = 1) {
  if (!Array.isArray(ctOffsets) || ctOffsets.length === 0 || !Number.isFinite(spacing) || spacing <= 0) return null;
  const step = Math.max(0.25, Math.min(resolution, spacing / 16));
  let bestOffset = 0;
  let bestScore = Infinity;
  for (let offset = 0; offset < spacing; offset += step) {
    let score = 0;
    for (const ct of ctOffsets) {
      const delta = distanceToPhaseLattice(ct, offset, spacing);
      score += delta * delta;
    }
    if (score < bestScore) {
      bestScore = score;
      bestOffset = offset;
    }
  }
  return roundNumber(bestOffset);
}

function distanceToPhaseLattice(value, phaseOffset, spacing) {
  const wrapped = positiveModulo(value - phaseOffset, spacing);
  return Math.min(wrapped, spacing - wrapped);
}

function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function analyzeSector(sector, roadGrid, width, height, params, options = {}) {
  const anchorAnalysis = buildAnchorAnalysis(sector, roadGrid, width, height, params);
  const claimState = createBuyerClaimState();
  applyCommercialFrontageVariant(anchorAnalysis.anchorRuns, claimState, anchorAnalysis, width, params);

  let parkSet = new Set();
  let parkRoadSet = new Set();
  let parkRoadLines = [];
  const initialRoadSet = unionSets(claimState.serviceRoadSet, claimState.stubSet);
  if (options.includeCentralPark) {
    const parkReservation = applyParkVariant({
      sector,
      sectorSet: anchorAnalysis.sectorSet,
      blockedSet: unionSets(claimState.commercialSet, initialRoadSet),
      plannedRoadSet: initialRoadSet,
      width,
      params,
    });
    parkSet = parkReservation.parkSet;
    parkRoadSet = parkReservation.parkRoadSet;
    parkRoadLines = parkReservation.parkRoadLines || [];
  }

  let premiumResidentialSet = new Set();
  let premiumAccessRoadSet = new Set();
  if (options.includePremiumResidential) {
    const premiumReservation = applyViewVillaVariant({
      sector,
      sectorSet: anchorAnalysis.sectorSet,
      blockedSet: unionSets(claimState.commercialSet, parkSet, initialRoadSet, parkRoadSet),
      plannedRoadSet: unionSets(initialRoadSet, parkRoadSet),
      width,
      params,
      roadGrid,
      waterMask: options.waterMask,
      elevation: options.elevation,
    });
    premiumResidentialSet = premiumReservation.premiumResidentialSet;
    premiumAccessRoadSet = premiumReservation.premiumAccessRoadSet;
  }

  const plannedRoadSet = unionSets(initialRoadSet, parkRoadSet, premiumAccessRoadSet);
  const nonResidentialSet = unionSets(claimState.commercialSet, parkSet, premiumResidentialSet);
  const residentialSet = applyResidentialResidualVariant({
    sectorSet: anchorAnalysis.sectorSet,
    nonResidentialSet,
    plannedRoadSet,
    roadGrid,
    width,
    height,
  });

  const unreachableCells = [];
  const commercialCells = keysToCells(claimState.commercialSet, width);
  const parkCells = keysToCells(parkSet, width);
  const parkRoadCells = keysToCells(parkRoadSet, width);
  const premiumResidentialCells = keysToCells(premiumResidentialSet, width);
  const premiumAccessRoadCells = keysToCells(premiumAccessRoadSet, width);
  const terraceResidentialCells = [];
  const serviceRoadCells = keysToCells(claimState.serviceRoadSet, width);
  const stubCells = keysToCells(claimState.stubSet, width);
  const residentialCells = keysToCells(residentialSet, width);
  const residualResidentialCells = keysToCells(residentialSet, width);
  const gapCells = keysToCells(claimState.gapSet, width);

  for (const cell of sector.cells) {
    const key = cell.gz * width + cell.gx;
    if (nonResidentialSet.has(key) || plannedRoadSet.has(key) || residentialSet.has(key)) continue;
    unreachableCells.push(cell);
  }

  return {
    anchorCellCount: anchorAnalysis.anchorCells.length,
    anchorCells: anchorAnalysis.anchorCells,
    anchorRuns: anchorAnalysis.anchorRuns,
    gapCenters: claimState.gapCenters,
    commercialCells,
    parkCells,
    parkRoadCells,
    premiumResidentialCells,
    premiumAccessRoadCells,
    terraceResidentialCells,
    serviceRoadCells,
    stubCells,
    gapCells,
    residentialCells,
    serviceRoadLines: claimState.serviceRoadLines,
    stubLines: claimState.stubLines,
    parkRoadLines,
    premiumAccessRoadLines: [],
    buyerRoadLines: [
      ...claimState.serviceRoadLines,
      ...claimState.stubLines,
      ...parkRoadLines,
    ],
    residualResidentialCells,
    unreachableCells,
  };
}

function analyzeSectorWithBuyerProgram(sector, roadGrid, width, height, params, buyerProgram, environment = {}) {
  const anchorAnalysis = buildAnchorAnalysis(sector, roadGrid, width, height, params);
  const claimState = createBuyerClaimState();

  for (const family of buyerProgram.families || []) {
    for (const variant of family.variants || []) {
      if (variant.kind === 'frontage-strip') {
        applyCommercialFrontageVariant(anchorAnalysis.anchorRuns, claimState, anchorAnalysis, width, params);
        continue;
      }
      if (variant.kind === 'central-park') {
        const plannedRoadSet = unionSets(claimState.serviceRoadSet, claimState.stubSet, claimState.parkRoadSet, claimState.premiumAccessRoadSet);
        const blockedSet = unionSets(claimState.commercialSet, claimState.parkSet, claimState.premiumResidentialSet, plannedRoadSet);
        const parkReservation = applyParkVariant({
          sector,
          sectorSet: anchorAnalysis.sectorSet,
          blockedSet,
          plannedRoadSet,
          width,
          params,
        });
        claimState.parkSet = parkReservation.parkSet;
        claimState.parkRoadSet = parkReservation.parkRoadSet;
        claimState.parkRoadLines = parkReservation.parkRoadLines || [];
        continue;
      }
      if (variant.kind === 'view-villa') {
        const plannedRoadSet = unionSets(claimState.serviceRoadSet, claimState.stubSet, claimState.parkRoadSet, claimState.premiumAccessRoadSet);
        const blockedSet = unionSets(claimState.commercialSet, claimState.parkSet, claimState.premiumResidentialSet, plannedRoadSet);
        const premiumReservation = applyViewVillaVariant({
          sector,
          sectorSet: anchorAnalysis.sectorSet,
          blockedSet,
          plannedRoadSet,
          width,
          params,
          roadGrid,
          waterMask: environment.waterMask,
          elevation: environment.elevation,
        });
        claimState.premiumResidentialSet = premiumReservation.premiumResidentialSet;
        claimState.premiumAccessRoadSet = premiumReservation.premiumAccessRoadSet;
        continue;
      }
      if (variant.kind === 'park-edge-terrace') {
        const plannedRoadSet = unionSets(claimState.serviceRoadSet, claimState.stubSet, claimState.parkRoadSet, claimState.premiumAccessRoadSet);
        const blockedSet = unionSets(
          claimState.commercialSet,
          claimState.parkSet,
          claimState.premiumResidentialSet,
          claimState.terraceResidentialSet,
          plannedRoadSet,
        );
        claimState.terraceResidentialSet = applyParkEdgeTerraceVariant({
          parkSet: claimState.parkSet,
          parkRoadSet: claimState.parkRoadSet,
          sectorSet: anchorAnalysis.sectorSet,
          blockedSet,
          width,
          params,
        });
        continue;
      }
      if (variant.kind === 'residual-fill') {
        const plannedRoadSet = unionSets(claimState.serviceRoadSet, claimState.stubSet, claimState.parkRoadSet, claimState.premiumAccessRoadSet);
        const nonResidentialSet = unionSets(
          claimState.commercialSet,
          claimState.parkSet,
          claimState.premiumResidentialSet,
          claimState.terraceResidentialSet,
        );
        claimState.residentialSet = applyResidentialResidualVariant({
          sectorSet: anchorAnalysis.sectorSet,
          nonResidentialSet,
          plannedRoadSet,
          roadGrid,
          width,
          height,
        });
      }
    }
  }

  const plannedRoadSet = unionSets(claimState.serviceRoadSet, claimState.stubSet, claimState.parkRoadSet, claimState.premiumAccessRoadSet);
  const nonResidentialSet = unionSets(
    claimState.commercialSet,
    claimState.parkSet,
    claimState.premiumResidentialSet,
    claimState.terraceResidentialSet,
  );
  const residualResidentialSet = claimState.residentialSet || new Set();
  const residentialSet = unionSets(claimState.terraceResidentialSet, residualResidentialSet);
  const unreachableCells = [];
  for (const cell of sector.cells) {
    const key = cell.gz * width + cell.gx;
    if (nonResidentialSet.has(key) || plannedRoadSet.has(key) || residentialSet.has(key)) continue;
    unreachableCells.push(cell);
  }

  return {
    anchorCellCount: anchorAnalysis.anchorCells.length,
    anchorCells: anchorAnalysis.anchorCells,
    anchorRuns: anchorAnalysis.anchorRuns,
    gapCenters: claimState.gapCenters,
    commercialCells: keysToCells(claimState.commercialSet, width),
    parkCells: keysToCells(claimState.parkSet, width),
    parkRoadCells: keysToCells(claimState.parkRoadSet, width),
    premiumResidentialCells: keysToCells(claimState.premiumResidentialSet, width),
    premiumAccessRoadCells: keysToCells(claimState.premiumAccessRoadSet, width),
    terraceResidentialCells: keysToCells(claimState.terraceResidentialSet, width),
    serviceRoadCells: keysToCells(claimState.serviceRoadSet, width),
    stubCells: keysToCells(claimState.stubSet, width),
    gapCells: keysToCells(claimState.gapSet, width),
    residentialCells: keysToCells(residentialSet, width),
    serviceRoadLines: claimState.serviceRoadLines,
    stubLines: claimState.stubLines,
    parkRoadLines: claimState.parkRoadLines,
    premiumAccessRoadLines: claimState.premiumAccessRoadLines,
    buyerRoadLines: [
      ...claimState.serviceRoadLines,
      ...claimState.stubLines,
      ...claimState.parkRoadLines,
      ...claimState.premiumAccessRoadLines,
    ],
    residualResidentialCells: keysToCells(residualResidentialSet, width),
    unreachableCells,
    buyerProgram: summarizeBuyerProgram(buyerProgram),
  };
}

function analyzeSectorVectorPrototype(sector, roadGrid, width, height, params, map, mode = 'parallel-strip') {
  const anchorAnalysis = buildAnchorAnalysis(sector, roadGrid, width, height, params);
  const hierarchicalAccess = mode === 'hierarchical-access';
  const layout = new ReservationLayout({
    kind: 'vector-frontage-parcels',
    meta: {
      strategy: hierarchicalAccess
        ? 'polygon-first-frontage-hierarchical-access'
        : (mode === 'perpendicular-cuts' ? 'polygon-first-frontage-perpendicular-cuts' : 'polygon-first-frontage'),
      depthMeters: roundNumber(params.blockDepthCells * map.cellSize),
    },
  });
  const gapMarkers = [];

  const accessSpacing = hierarchicalAccess ? 28 * map.cellSize : params.accessGapSpacingCells * map.cellSize;
  const accessGapWidth = hierarchicalAccess ? 4 * map.cellSize : params.accessGapWidthCells * map.cellSize;
  const parcelTargetLength = hierarchicalAccess ? 7 * map.cellSize : null;
  const minFrontageLength = hierarchicalAccess ? 14 * map.cellSize : 0;
  const minParcelLength = 3.5 * map.cellSize;

  for (const run of anchorAnalysis.anchorRuns) {
    const activeCells = run.sortedCells.filter(cell => !anchorAnalysis.cornerClearanceSet.has(cell.gz * width + cell.gx));
    if (activeCells.length < 3) continue;

    const rawFrontage = dedupePolyline(activeCells.map(cell => ({
      x: map.originX + cell.gx * map.cellSize,
      z: map.originZ + cell.gz * map.cellSize,
    })));
    if (rawFrontage.length < 2) continue;

    const smoothedFrontage = smoothPolylineChaikin(rawFrontage, 2);
    const depthMeters = params.blockDepthCells * map.cellSize;
    const frontageLengths = arcLengths(smoothedFrontage);
    const totalLength = frontageLengths[frontageLengths.length - 1];
    if (totalLength < map.cellSize * 4) continue;
    if (totalLength < minFrontageLength) continue;

    const inwardHint = {
      x: run.inward.x,
      z: run.inward.z,
    };
    const serviceCenterline = offsetPolylineWithHint(smoothedFrontage, depthMeters, inwardHint);
    const serviceLengths = arcLengths(serviceCenterline);
    const frontageTotal = frontageLengths[frontageLengths.length - 1];
    const serviceTotal = serviceLengths[serviceLengths.length - 1];
    const serviceRoad = layout.addRoad(new PlannedRoad({
      kind: 'service-road',
      centerline: serviceCenterline,
      width: 8,
      meta: {
        source: 'vector-frontage',
        anchorCells: activeCells.length,
      },
    }));

    const gapDistances = [];
    const cutRanges = [];
    if (totalLength >= accessSpacing * 0.8) {
      for (let center = accessSpacing * 0.5; center < totalLength; center += accessSpacing) {
        gapDistances.push(center);
      }
    }

    const span = layout.addFrontageSpan(new FrontageSpan({
      frontage: smoothedFrontage,
      inward: inwardHint,
      depth: depthMeters,
      serviceRoadId: serviceRoad.id,
      gapDistances,
      meta: {
        anchorRunCells: activeCells.length,
      },
    }));

    const gapHalfWidth = accessGapWidth * 0.5;
    for (const gapDistance of gapDistances) {
      const from = Math.max(0, gapDistance - gapHalfWidth);
      const to = Math.min(totalLength, gapDistance + gapHalfWidth);
      if (to - from > map.cellSize * 0.5) {
        cutRanges.push({ from, to });
        const frontageGapPoint = sampleAtDistance(smoothedFrontage, frontageLengths, gapDistance);
        const serviceGapPoint = mode === 'perpendicular-cuts'
          ? buildPerpendicularCutLine(smoothedFrontage, gapDistance, depthMeters, inwardHint)[1]
          : sampleAtDistance(serviceCenterline, serviceLengths, gapDistance / frontageTotal * serviceTotal);
        gapMarkers.push(frontageGapPoint);
        layout.addRoad(new PlannedRoad({
          kind: 'stub-road',
          centerline: [frontageGapPoint, serviceGapPoint],
          width: 6,
          meta: {
            source: 'vector-frontage-gap',
            parentSpanId: span.id,
          },
        }));
      }
    }
    const segments = splitDistanceRange(0, totalLength, cutRanges, map.cellSize * 2);
    for (const accessSegment of segments) {
      const parcelSegments = hierarchicalAccess
        ? subdivideDistanceRange(accessSegment.from, accessSegment.to, parcelTargetLength, minParcelLength)
        : [accessSegment];
      for (const { from, to } of parcelSegments) {
        const strip = mode === 'perpendicular-cuts' || hierarchicalAccess
          ? buildPerpendicularStrip(smoothedFrontage, from, to, depthMeters, inwardHint, map.cellSize)
          : (() => {
              const frontageSlice = slicePolyline(smoothedFrontage, from, to, map.cellSize);
              const serviceSlice = slicePolyline(
                serviceCenterline,
                from / frontageTotal * serviceTotal,
                to / frontageTotal * serviceTotal,
                map.cellSize,
              );
              if (frontageSlice.length < 2 || serviceSlice.length < 2) return null;
              return {
                frontage: frontageSlice,
                rear: serviceSlice,
                polygon: buildStripPolygon(frontageSlice, serviceSlice),
              };
            })();
        if (!strip) continue;
        layout.addParcel(new ReservationParcel({
          kind: 'commercial-frontage-strip',
          polygon: strip.polygon,
          frontageSpanId: span.id,
          meta: {
            frontageLength: roundNumber(to - from),
            depth: roundNumber(depthMeters),
            cutMode: mode,
          },
        }));
      }
    }
  }

  return {
    anchorCellCount: anchorAnalysis.anchorCells.length,
    anchorCells: anchorAnalysis.anchorCells,
    anchorRuns: anchorAnalysis.anchorRuns,
    layout,
    gapMarkers,
  };
}

function buildAnchorAnalysis(sector, roadGrid, width, height, params) {
  const sectorSet = new Set(sector.cells.map(cell => cell.gz * width + cell.gx));
  const anchorCells = [];
  const anchorInfo = new Map();

  for (const cell of sector.cells) {
    const roadNeighbors = [];
    let boundary = false;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cell.gx + dx;
      const nz = cell.gz + dz;
      if (nx < 0 || nx >= width || nz < 0 || nz >= height) {
        boundary = true;
        continue;
      }
      if (sectorSet.has(nz * width + nx)) continue;
      boundary = true;
      if (roadGrid.get(nx, nz) > 0) {
        roadNeighbors.push({ gx: nx, gz: nz });
      }
    }
    if (boundary && roadNeighbors.length > 0) {
      anchorCells.push(cell);
      anchorInfo.set(cell.gz * width + cell.gx, { cell, roadNeighbors });
    }
  }

  const anchorRuns = buildAnchorRuns(anchorCells, anchorInfo, width, params);
  return {
    sectorSet,
    anchorCells,
    anchorRuns,
    cornerClearanceSet: buildCornerClearanceSet(anchorRuns, sectorSet, width, params.cornerClearanceCells),
  };
}

function createBuyerClaimState() {
  return {
    commercialSet: new Set(),
    serviceRoadSet: new Set(),
    serviceRoadLines: [],
    stubSet: new Set(),
    stubLines: [],
    gapSet: new Set(),
    gapCenters: [],
    parkSet: new Set(),
    parkRoadSet: new Set(),
    parkRoadLines: [],
    premiumResidentialSet: new Set(),
    premiumAccessRoadSet: new Set(),
    premiumAccessRoadLines: [],
    terraceResidentialSet: new Set(),
    residentialSet: new Set(),
  };
}

function applyCommercialFrontageVariant(anchorRuns, claimState, anchorAnalysis, width, params) {
  const sectorSet = anchorAnalysis.sectorSet;
  const cornerClearanceSet = anchorAnalysis.cornerClearanceSet || new Set();
  for (const run of anchorRuns) {
    const activeCells = run.sortedCells.filter(cell => !cornerClearanceSet.has(cell.gz * width + cell.gx));
    if (activeCells.length === 0) continue;
    const serviceLine = buildOffsetRoad(activeCells, run.inward, params.blockDepthCells, sectorSet, width);
    if (serviceLine.length >= 2) claimState.serviceRoadLines.push(serviceLine);
    for (const serviceCell of serviceLine) {
      if (cornerClearanceSet.has(serviceCell.gz * width + serviceCell.gx)) continue;
      claimState.serviceRoadSet.add(serviceCell.gz * width + serviceCell.gx);
    }
    for (const gapCenter of run.gapCenters) {
      if (cornerClearanceSet.has(gapCenter.gz * width + gapCenter.gx)) continue;
      claimState.gapCenters.push(gapCenter);
      const stubLine = buildStub(gapCenter, run.inward, params.blockDepthCells, sectorSet, width);
      if (stubLine.length >= 2) claimState.stubLines.push(stubLine);
      for (const stubCell of stubLine) {
        if (cornerClearanceSet.has(stubCell.gz * width + stubCell.gx)) continue;
        claimState.stubSet.add(stubCell.gz * width + stubCell.gx);
      }
    }
    for (const gapKey of run.gapCells) {
      if (!cornerClearanceSet.has(gapKey)) claimState.gapSet.add(gapKey);
    }

    for (const cell of activeCells) {
      const key = cell.gz * width + cell.gx;
      if (claimState.gapSet.has(key)) continue;
      for (let d = 1; d <= params.commercialDepthCells; d++) {
        const gx = Math.round(cell.gx + run.inward.x * d);
        const gz = Math.round(cell.gz + run.inward.z * d);
        const cellKey = gz * width + gx;
        if (!sectorSet.has(cellKey)) break;
        if (cornerClearanceSet.has(cellKey)) continue;
        if (claimState.serviceRoadSet.has(cellKey) || claimState.stubSet.has(cellKey)) continue;
        claimState.commercialSet.add(cellKey);
      }
    }
  }
}

function applyParkVariant({ sector, sectorSet, blockedSet, plannedRoadSet, width, params }) {
  return buildCentralParkReservation({
    sector,
    sectorSet,
    blockedSet,
    plannedRoadSet,
    width,
    params,
  });
}

function applyResidentialResidualVariant({ sectorSet, nonResidentialSet, plannedRoadSet, roadGrid, width, height }) {
  return floodReachableResidential({
    sectorSet,
    nonResidentialSet,
    plannedRoadSet,
    roadGrid,
    width,
    height,
  });
}

function applyViewVillaVariant({
  sector,
  sectorSet,
  blockedSet,
  plannedRoadSet,
  width,
  params,
  roadGrid,
  waterMask,
  elevation,
}) {
  const reservation = buildPremiumResidentialReservation({
    sector,
    sectorSet,
    blockedSet,
    plannedRoadSet,
    width,
    params,
    roadGrid,
    waterMask,
    elevation,
  });
  return {
    premiumResidentialSet: reservation.premiumResidentialSet,
    premiumAccessRoadSet: reservation.premiumAccessRoadSet,
  };
}

function applyParkEdgeTerraceVariant({ parkSet, parkRoadSet, sectorSet, blockedSet, width, params }) {
  if (!parkSet.size || !parkRoadSet.size) return new Set();
  const sideBuckets = new Map();
  for (const key of parkRoadSet) {
    const gx = key % width;
    const gz = Math.floor(key / width);
    for (const [dx, dz, side] of [
      [-1, 0, 'east'],
      [1, 0, 'west'],
      [0, -1, 'south'],
      [0, 1, 'north'],
    ]) {
      const neighborKey = (gz + dz) * width + (gx + dx);
      if (!parkSet.has(neighborKey)) continue;
      if (!sideBuckets.has(side)) sideBuckets.set(side, []);
      sideBuckets.get(side).push({ gx, gz, outward: { x: -dx, z: -dz } });
    }
  }

  const blockedRoadKeys = new Set();
  for (const [side, entries] of sideBuckets) {
    entries.sort((a, b) => side === 'north' || side === 'south' ? a.gx - b.gx : a.gz - b.gz);
    const halfGap = Math.max(0.5, params.parkTerraceGapWidthCells / 2);
    if (entries.length >= params.parkTerraceGapSpacingCells * 0.5) {
      for (let center = params.parkTerraceGapSpacingCells * 0.5; center < entries.length; center += params.parkTerraceGapSpacingCells) {
        for (let i = 0; i < entries.length; i++) {
          if (Math.abs(i - center) <= halfGap) {
            blockedRoadKeys.add(entries[i].gz * width + entries[i].gx);
          }
        }
      }
    }
  }

  const terraceSet = new Set();
  for (const key of parkRoadSet) {
    const gx = key % width;
    const gz = Math.floor(key / width);
    if (blockedRoadKeys.has(key)) continue;
    let outward = null;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const neighborKey = (gz + dz) * width + (gx + dx);
      if (parkSet.has(neighborKey)) {
        outward = { x: -dx, z: -dz };
        break;
      }
    }
    if (!outward) continue;
    const nx = gx + outward.x;
    const nz = gz + outward.z;
    const neighborKey = nz * width + nx;
    if (!sectorSet.has(neighborKey)) continue;
    if (parkSet.has(neighborKey) || parkRoadSet.has(neighborKey) || blockedSet.has(neighborKey)) continue;
    terraceSet.add(neighborKey);
  }
  return terraceSet;
}

function summarizeBuyerProgram(buyerProgram) {
  return {
    name: buyerProgram.name,
    families: (buyerProgram.families || []).map(family => ({
      key: family.key,
      label: family.label,
      macroSearch: family.macroSearch || null,
      variantKeys: (family.variants || []).map(variant => variant.key),
      variants: (family.variants || []).map(variant => ({
        key: variant.key,
        kind: variant.kind,
        microClaim: variant.microClaim || null,
      })),
    })),
  };
}

function buildCornerClearanceSet(anchorRuns, sectorSet, width, clearance) {
  const cornerCells = [];
  for (const run of anchorRuns) {
    if (!run.sortedCells?.length) continue;
    cornerCells.push(run.sortedCells[0]);
    if (run.sortedCells.length > 1) {
      cornerCells.push(run.sortedCells[run.sortedCells.length - 1]);
    }
  }
  if (cornerCells.length === 0) return new Set();

  const clearanceSet = new Set();
  for (const cell of cornerCells) {
    for (let dz = -clearance; dz <= clearance; dz++) {
      for (let dx = -clearance; dx <= clearance; dx++) {
        if (Math.abs(dx) + Math.abs(dz) > clearance) continue;
        const gx = cell.gx + dx;
        const gz = cell.gz + dz;
        const key = gz * width + gx;
        if (sectorSet.has(key)) clearanceSet.add(key);
      }
    }
  }
  return clearanceSet;
}

function buildPremiumResidentialReservation({
  sector,
  sectorSet,
  blockedSet,
  plannedRoadSet,
  width,
  params,
  roadGrid,
  waterMask,
  elevation,
}) {
  const bounds = boundsForCells(sector.cells);
  const targetWidth = clampInt(
    Math.round((bounds.maxGx - bounds.minGx + 1) * params.viewVillaTargetWidthRatio),
    params.viewVillaMinWidthCells,
    params.viewVillaMaxWidthCells,
  );
  const targetHeight = clampInt(
    Math.round((bounds.maxGz - bounds.minGz + 1) * params.viewVillaTargetHeightRatio),
    params.viewVillaMinHeightCells,
    params.viewVillaMaxHeightCells,
  );

  const elevationBounds = elevation ? elevation.bounds() : null;
  const waterCells = [];
  if (waterMask) {
    for (const cell of sector.cells) {
      if (waterMask.get(cell.gx, cell.gz) > 0) waterCells.push(cell);
    }
  }
  const candidateCenters = [...sector.cells]
    .map(cell => ({
      cell,
      score: premiumResidentialScore({
        cell,
        sector,
        elevation,
        elevationBounds,
        waterCells,
        width,
        blockedSet,
      }),
    }))
    .filter(entry => Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score)
    .map(entry => entry.cell);

  const rect = findParkRectangle({
    candidateCenters,
    sectorSet,
    blockedSet,
    width,
    targetWidth,
    targetHeight,
    minWidth: params.viewVillaMinWidthCells,
    minHeight: params.viewVillaMinHeightCells,
  });
  if (!rect) {
    return {
      premiumResidentialSet: new Set(),
      premiumAccessRoadSet: new Set(),
    };
  }

  const premiumResidentialSet = rectangleCellSet(rect, width);
  const premiumAccessRoadSet = buildPremiumAccessLane({
    premiumResidentialSet,
    plannedRoadSet,
    blockedSet,
    sectorSet,
    roadGrid,
    width,
  });
  return { premiumResidentialSet, premiumAccessRoadSet };
}

function premiumResidentialScore({ cell, sector, elevation, elevationBounds, waterCells, blockedSet, width }) {
  const key = cell.gz * width + cell.gx;
  if (blockedSet.has(key)) return -Infinity;

  let score = 0;
  if (elevation && elevationBounds) {
    const range = Math.max(1e-6, elevationBounds.max - elevationBounds.min);
    score += 0.55 * ((elevation.get(cell.gx, cell.gz) - elevationBounds.min) / range);
  }
  if (waterCells && waterCells.length > 0) {
    let bestDistSq = Infinity;
    for (const waterCell of waterCells) {
      const distSq = (cell.gx - waterCell.gx) ** 2 + (cell.gz - waterCell.gz) ** 2;
      if (distSq < bestDistSq) bestDistSq = distSq;
    }
    const waterBonus = Math.max(0, 1 - Math.sqrt(bestDistSq) / 40);
    score += 0.3 * waterBonus;
  }
  const edgeDist = Math.min(
    Math.abs(cell.gx - sector.centroidGx),
    Math.abs(cell.gz - sector.centroidGz),
  );
  score += 0.05 * Math.min(edgeDist / 20, 1);
  return score;
}

function buildPremiumAccessLane({ premiumResidentialSet, plannedRoadSet, blockedSet, sectorSet, width }) {
  if (!premiumResidentialSet.size || !plannedRoadSet.size) return new Set();
  const premiumCells = keysToCells(premiumResidentialSet, width);
  const plannedRoadCells = keysToCells(plannedRoadSet, width);
  let best = null;
  let bestDistance = Infinity;
  for (const from of premiumCells) {
    for (const to of plannedRoadCells) {
      const distance = (from.gx - to.gx) ** 2 + (from.gz - to.gz) ** 2;
      if (distance >= bestDistance) continue;
      const line = rasterLine(from.gx, from.gz, to.gx, to.gz);
      let valid = true;
      for (const point of line) {
        const key = point.gz * width + point.gx;
        if (!sectorSet.has(key)) {
          valid = false;
          break;
        }
        if (blockedSet.has(key) && !premiumResidentialSet.has(key) && !plannedRoadSet.has(key)) {
          valid = false;
          break;
        }
      }
      if (!valid) continue;
      best = line;
      bestDistance = distance;
    }
  }
  if (!best) return new Set();
  const laneSet = new Set();
  for (const point of best) {
    const key = point.gz * width + point.gx;
    if (!premiumResidentialSet.has(key)) laneSet.add(key);
  }
  return laneSet;
}

function buildCentralParkReservation({ sector, sectorSet, blockedSet, plannedRoadSet, width, params }) {
  const bounds = boundsForCells(sector.cells);
  const targetWidth = clampInt(
    Math.round((bounds.maxGx - bounds.minGx + 1) * params.parkTargetWidthRatio),
    params.parkMinWidthCells,
    params.parkMaxWidthCells,
  );
  const targetHeight = clampInt(
    Math.round((bounds.maxGz - bounds.minGz + 1) * params.parkTargetHeightRatio),
    params.parkMinHeightCells,
    params.parkMaxHeightCells,
  );

  const candidateCenters = [...sector.cells]
    .map(cell => ({
      cell,
      distanceSq: (cell.gx - sector.centroidGx) ** 2 + (cell.gz - sector.centroidGz) ** 2,
    }))
    .sort((a, b) => a.distanceSq - b.distanceSq)
    .map(entry => entry.cell);

  const rect = findParkRectangle({
    candidateCenters,
    sectorSet,
    blockedSet,
    width,
    targetWidth,
    targetHeight,
    minWidth: params.parkMinWidthCells,
    minHeight: params.parkMinHeightCells,
  });
  if (!rect) {
    return {
      parkSet: new Set(),
      parkRoadSet: new Set(),
      parkRoadLines: [],
    };
  }

  const parkSet = rectangleCellSet(rect, width);
  const roadRingSet = rectangleRingSet(expandRect(rect, 1), width);
  const parkRoadLines = rectangleRoadLines(expandRect(rect, 1));
  const parkRoadSet = new Set();
  for (const key of roadRingSet) {
    if (sectorSet.has(key) && !blockedSet.has(key) && !parkSet.has(key)) {
      parkRoadSet.add(key);
    }
  }

  const connectorLine = buildParkConnector({
    parkRoadSet,
    plannedRoadSet,
    blockedSet,
    parkSet,
    sectorSet,
    width,
  });
  if (connectorLine.length >= 2) parkRoadLines.push(connectorLine);
  for (const point of connectorLine) {
    const key = point.gz * width + point.gx;
    if (!parkSet.has(key)) parkRoadSet.add(key);
  }

  return { parkSet, parkRoadSet, parkRoadLines };
}

function findParkRectangle({
  candidateCenters,
  sectorSet,
  blockedSet,
  width,
  targetWidth,
  targetHeight,
  minWidth,
  minHeight,
}) {
  const widthOptions = descendingSizeOptions(targetWidth, minWidth);
  const heightOptions = descendingSizeOptions(targetHeight, minHeight);
  for (const cell of candidateCenters) {
    for (const rectWidth of widthOptions) {
      for (const rectHeight of heightOptions) {
        const rect = centeredRect(cell.gx, cell.gz, rectWidth, rectHeight);
        if (!rectFitsWithRing(rect, sectorSet, blockedSet, width)) continue;
        return rect;
      }
    }
  }
  return null;
}

function rectFitsWithRing(rect, sectorSet, blockedSet, width) {
  for (const key of rectangleCellSet(rect, width)) {
    if (!sectorSet.has(key) || blockedSet.has(key)) return false;
  }
  for (const key of rectangleRingSet(expandRect(rect, 1), width)) {
    if (!sectorSet.has(key) || blockedSet.has(key)) return false;
  }
  return true;
}

function buildParkConnector({ parkRoadSet, plannedRoadSet, blockedSet, parkSet, sectorSet, width }) {
  if (!parkRoadSet.size || !plannedRoadSet.size) return [];
  const parkRoadCells = keysToCells(parkRoadSet, width);
  const plannedRoadCells = keysToCells(plannedRoadSet, width);
  let best = null;
  let bestDistance = Infinity;
  for (const from of parkRoadCells) {
    for (const to of plannedRoadCells) {
      const distance = (from.gx - to.gx) ** 2 + (from.gz - to.gz) ** 2;
      if (distance >= bestDistance) continue;
      const line = rasterLine(from.gx, from.gz, to.gx, to.gz);
      let valid = true;
      for (const point of line) {
        const key = point.gz * width + point.gx;
        if (!sectorSet.has(key)) {
          valid = false;
          break;
        }
        if (parkSet.has(key)) {
          valid = false;
          break;
        }
        if (blockedSet.has(key) && !plannedRoadSet.has(key) && !parkRoadSet.has(key)) {
          valid = false;
          break;
        }
      }
      if (!valid) continue;
      best = line;
      bestDistance = distance;
    }
  }
  if (!best) return [];
  return best.filter(point => !parkSet.has(point.gz * width + point.gx));
}

function descendingSizeOptions(target, min) {
  const options = [];
  const seen = new Set();
  for (let size = target; size >= min; size -= 2) {
    if (!seen.has(size)) {
      seen.add(size);
      options.push(size);
    }
  }
  if (!seen.has(min)) options.push(min);
  return options;
}

function centeredRect(gx, gz, rectWidth, rectHeight) {
  const halfWidth = Math.floor(rectWidth / 2);
  const halfHeight = Math.floor(rectHeight / 2);
  return {
    minGx: gx - halfWidth,
    maxGx: gx - halfWidth + rectWidth - 1,
    minGz: gz - halfHeight,
    maxGz: gz - halfHeight + rectHeight - 1,
  };
}

function expandRect(rect, pad) {
  return {
    minGx: rect.minGx - pad,
    maxGx: rect.maxGx + pad,
    minGz: rect.minGz - pad,
    maxGz: rect.maxGz + pad,
  };
}

function rectangleCellSet(rect, width) {
  const result = new Set();
  for (let gz = rect.minGz; gz <= rect.maxGz; gz++) {
    for (let gx = rect.minGx; gx <= rect.maxGx; gx++) {
      result.add(gz * width + gx);
    }
  }
  return result;
}

function rectangleRingSet(rect, width) {
  const result = new Set();
  for (let gz = rect.minGz; gz <= rect.maxGz; gz++) {
    for (let gx = rect.minGx; gx <= rect.maxGx; gx++) {
      const onEdge = gx === rect.minGx || gx === rect.maxGx || gz === rect.minGz || gz === rect.maxGz;
      if (onEdge) result.add(gz * width + gx);
    }
  }
  return result;
}

function rectangleRoadLines(rect) {
  return [
    rasterLine(rect.minGx, rect.minGz, rect.maxGx, rect.minGz),
    rasterLine(rect.maxGx, rect.minGz, rect.maxGx, rect.maxGz),
    rasterLine(rect.maxGx, rect.maxGz, rect.minGx, rect.maxGz),
    rasterLine(rect.minGx, rect.maxGz, rect.minGx, rect.minGz),
  ].filter(line => line.length >= 2);
}

function boundsForCells(cells) {
  let minGx = Infinity;
  let minGz = Infinity;
  let maxGx = -Infinity;
  let maxGz = -Infinity;
  for (const cell of cells) {
    if (cell.gx < minGx) minGx = cell.gx;
    if (cell.gx > maxGx) maxGx = cell.gx;
    if (cell.gz < minGz) minGz = cell.gz;
    if (cell.gz > maxGz) maxGz = cell.gz;
  }
  return { minGx, maxGx, minGz, maxGz };
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function buildAnchorRuns(anchorCells, anchorInfo, width, params) {
  const cellMap = new Map(anchorCells.map(cell => [cell.gz * width + cell.gx, cell]));
  const seen = new Set();
  const runs = [];

  for (const cell of anchorCells) {
    const startKey = cell.gz * width + cell.gx;
    if (seen.has(startKey)) continue;
    const queue = [cell];
    seen.add(startKey);
    const cells = [];
    while (queue.length > 0) {
      const current = queue.pop();
      cells.push(current);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const nx = current.gx + dx;
        const nz = current.gz + dz;
        const neighborKey = nz * width + nx;
        if (seen.has(neighborKey) || !cellMap.has(neighborKey)) continue;
        seen.add(neighborKey);
        queue.push(cellMap.get(neighborKey));
      }
    }

    if (cells.length < params.minAnchorRunCells) continue;

    const tangent = principalDirection(cells);
    const inward = averageInwardNormal(cells, anchorInfo, width);
    if (!tangent || !inward) continue;

    const ordered = cells
      .map(entry => ({
        cell: entry,
        projection: entry.gx * tangent.x + entry.gz * tangent.z,
      }))
      .sort((a, b) => a.projection - b.projection);

    const sortedCells = ordered.map(entry => entry.cell);
    const minProj = ordered[0].projection;
    const maxProj = ordered[ordered.length - 1].projection;
    const gapCenters = [];
    if (maxProj - minProj >= params.accessGapSpacingCells * 0.8) {
      for (let center = minProj + params.accessGapSpacingCells * 0.5; center < maxProj; center += params.accessGapSpacingCells) {
        let best = null;
        let bestDist = Infinity;
        for (const entry of ordered) {
          const dist = Math.abs(entry.projection - center);
          if (dist < bestDist) {
            best = entry.cell;
            bestDist = dist;
          }
        }
        if (best) gapCenters.push(best);
      }
    }

    const gapCenterKeys = new Set(gapCenters.map(entry => entry.gz * width + entry.gx));
    const halfWidth = Math.max(0.5, params.accessGapWidthCells / 2);
    const gapCells = new Set();
    if (gapCenters.length > 0) {
      for (const entry of ordered) {
        const isGap = gapCenters.some(center => {
          const centerProj = center.gx * tangent.x + center.gz * tangent.z;
          return Math.abs(entry.projection - centerProj) <= halfWidth;
        });
        if (isGap) gapCells.add(entry.cell.gz * width + entry.cell.gx);
      }
    }

    runs.push({
      cells,
      sortedCells,
      tangent,
      inward,
      gapCenters,
      gapCenterKeys,
      gapCells,
    });
  }

  return runs;
}

function principalDirection(cells) {
  let meanX = 0;
  let meanZ = 0;
  for (const cell of cells) {
    meanX += cell.gx;
    meanZ += cell.gz;
  }
  meanX /= cells.length;
  meanZ /= cells.length;

  let xx = 0;
  let zz = 0;
  let xz = 0;
  for (const cell of cells) {
    const dx = cell.gx - meanX;
    const dz = cell.gz - meanZ;
    xx += dx * dx;
    zz += dz * dz;
    xz += dx * dz;
  }

  const theta = 0.5 * Math.atan2(2 * xz, xx - zz);
  return normalize2({ x: Math.cos(theta), z: Math.sin(theta) });
}

function averageInwardNormal(cells, anchorInfo, width) {
  let sumX = 0;
  let sumZ = 0;
  for (const cell of cells) {
    const record = anchorInfo.get(cell.gz * width + cell.gx);
    const roadNeighbors = record?.roadNeighbors || [];
    for (const neighbor of roadNeighbors) {
      sumX += cell.gx - neighbor.gx;
      sumZ += cell.gz - neighbor.gz;
    }
  }
  return normalize2({ x: sumX, z: sumZ });
}

function buildOffsetRoad(sortedCells, inward, depth, sectorSet, width) {
  const points = [];
  for (const cell of sortedCells) {
    const gx = Math.round(cell.gx + inward.x * depth);
    const gz = Math.round(cell.gz + inward.z * depth);
    const key = gz * width + gx;
    if (!sectorSet.has(key)) continue;
    points.push({ gx, gz });
  }
  return connectGridPoints(points);
}

function buildStub(gapCenter, inward, depth, sectorSet, width) {
  const end = {
    gx: Math.round(gapCenter.gx + inward.x * depth),
    gz: Math.round(gapCenter.gz + inward.z * depth),
  };
  const points = rasterLine(gapCenter.gx, gapCenter.gz, end.gx, end.gz)
    .filter(point => sectorSet.has(point.gz * width + point.gx));
  return points;
}

function connectGridPoints(points) {
  if (points.length === 0) return [];
  const connected = [];
  for (let i = 0; i < points.length; i++) {
    if (i === 0) {
      connected.push(points[i]);
      continue;
    }
    const segment = rasterLine(points[i - 1].gx, points[i - 1].gz, points[i].gx, points[i].gz);
    for (const point of segment) connected.push(point);
  }
  return dedupeCells(connected);
}

function rasterLine(x0, y0, x1, y1) {
  const result = [];
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0;
  let y = y0;
  while (true) {
    result.push({ gx: x, gz: y });
    if (x === x1 && y === y1) break;
    const e2 = err * 2;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
  return result;
}

function floodReachableResidential({ sectorSet, nonResidentialSet, plannedRoadSet, roadGrid, width, height }) {
  const visited = new Set();
  const queue = [];

  for (const key of sectorSet) {
    if (nonResidentialSet.has(key) || plannedRoadSet.has(key)) continue;
    const gx = key % width;
    const gz = Math.floor(key / width);
    let accessible = false;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = gx + dx;
      const nz = gz + dz;
      if (nx < 0 || nx >= width || nz < 0 || nz >= height) continue;
      const nKey = nz * width + nx;
      if (plannedRoadSet.has(nKey) || roadGrid.get(nx, nz) > 0) {
        accessible = true;
        break;
      }
    }
    if (accessible) {
      visited.add(key);
      queue.push({ gx, gz });
    }
  }

  while (queue.length > 0) {
    const cell = queue.shift();
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cell.gx + dx;
      const nz = cell.gz + dz;
      if (nx < 0 || nx >= width || nz < 0 || nz >= height) continue;
      const key = nz * width + nx;
      if (visited.has(key) || !sectorSet.has(key) || nonResidentialSet.has(key) || plannedRoadSet.has(key)) continue;
      visited.add(key);
      queue.push({ gx: nx, gz: nz });
    }
  }

  return visited;
}

function buildBasePixels({ crop, elev, eBounds, eRange, waterMask, roadGrid, zone, sector, cs, ox, oz, W }) {
  const pixels = new Uint8Array(crop.width * crop.height * 3);

  for (let z = 0; z < crop.height; z++) {
    for (let x = 0; x < crop.width; x++) {
      const gx = crop.minGx + x;
      const gz = crop.minGz + z;
      const idx = (z * crop.width + x) * 3;
      const v = (elev.get(gx, gz) - eBounds.min) / eRange;
      if (waterMask && waterMask.get(gx, gz) > 0) {
        pixels[idx] = 20;
        pixels[idx + 1] = 35;
        pixels[idx + 2] = 85;
      } else {
        const grey = Math.round(40 + v * 80);
        pixels[idx] = grey;
        pixels[idx + 1] = grey;
        pixels[idx + 2] = grey;
      }
      if (roadGrid.get(gx, gz) > 0) {
        pixels[idx] = 150;
        pixels[idx + 1] = 150;
        pixels[idx + 2] = 150;
      }
    }
  }

  drawBoundary(pixels, crop, zone.boundary || [], cs, ox, oz, [255, 255, 0], 2);

  const sectorBoundary = extractCellBoundary(sector.cells, W);
  for (const edge of sectorBoundary) {
    const idx = ((edge.gz - crop.minGz) * crop.width + (edge.gx - crop.minGx)) * 3;
    if (idx < 0 || idx >= pixels.length) continue;
    pixels[idx] = 220;
    pixels[idx + 1] = 220;
    pixels[idx + 2] = 220;
  }

  return pixels;
}

function extractCellBoundary(cells, width) {
  const set = new Set(cells.map(cell => cell.gz * width + cell.gx));
  const boundary = [];
  for (const cell of cells) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const key = (cell.gz + dz) * width + (cell.gx + dx);
      if (!set.has(key)) {
        boundary.push(cell);
        break;
      }
    }
  }
  return boundary;
}

function drawBoundary(pixels, crop, boundary, cs, ox, oz, color, thickness = 1) {
  for (let i = 0; i < boundary.length; i++) {
    const p1 = boundary[i];
    const p2 = boundary[(i + 1) % boundary.length];
    const x0 = Math.round((p1.x - ox) / cs) - crop.minGx;
    const y0 = Math.round((p1.z - oz) / cs) - crop.minGz;
    const x1 = Math.round((p2.x - ox) / cs) - crop.minGx;
    const y1 = Math.round((p2.z - oz) / cs) - crop.minGz;
    for (let offset = 0; offset < thickness; offset++) {
      bres(pixels, crop.width, crop.height, x0 + offset, y0, x1 + offset, y1, color[0], color[1], color[2]);
      bres(pixels, crop.width, crop.height, x0, y0 + offset, x1, y1 + offset, color[0], color[1], color[2]);
    }
  }
}

function drawWorldPolyline(pixels, crop, points, cs, ox, oz, color) {
  if (!Array.isArray(points) || points.length < 2) return;
  for (let i = 1; i < points.length; i++) {
    bres(
      pixels,
      crop.width,
      crop.height,
      Math.round((points[i - 1].x - ox) / cs) - crop.minGx,
      Math.round((points[i - 1].z - oz) / cs) - crop.minGz,
      Math.round((points[i].x - ox) / cs) - crop.minGx,
      Math.round((points[i].z - oz) / cs) - crop.minGz,
      color[0],
      color[1],
      color[2],
    );
  }
}

function drawCells(pixels, crop, cells, color) {
  for (const cell of cells) {
    const x = cell.gx - crop.minGx;
    const z = cell.gz - crop.minGz;
    if (x < 0 || x >= crop.width || z < 0 || z >= crop.height) continue;
    const idx = (z * crop.width + x) * 3;
    pixels[idx] = color[0];
    pixels[idx + 1] = color[1];
    pixels[idx + 2] = color[2];
  }
}

function drawGridMarker(pixels, crop, gx, gz, color, radius = 1) {
  const px = gx - crop.minGx;
  const pz = gz - crop.minGz;
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = px + dx;
      const z = pz + dz;
      if (x < 0 || x >= crop.width || z < 0 || z >= crop.height) continue;
      const idx = (z * crop.width + x) * 3;
      pixels[idx] = color[0];
      pixels[idx + 1] = color[1];
      pixels[idx + 2] = color[2];
    }
  }
}

function drawWorldMarker(pixels, crop, point, cs, ox, oz, color, radius = 1) {
  const gx = Math.round((point.x - ox) / cs);
  const gz = Math.round((point.z - oz) / cs);
  drawGridMarker(pixels, crop, gx, gz, color, radius);
}

function computeSectorCrop(sector, width, height, pad) {
  let minGx = width;
  let maxGx = 0;
  let minGz = height;
  let maxGz = 0;
  for (const cell of sector.cells) {
    if (cell.gx < minGx) minGx = cell.gx;
    if (cell.gx > maxGx) maxGx = cell.gx;
    if (cell.gz < minGz) minGz = cell.gz;
    if (cell.gz > maxGz) maxGz = cell.gz;
  }
  minGx = Math.max(0, minGx - pad);
  maxGx = Math.min(width - 1, maxGx + pad);
  minGz = Math.max(0, minGz - pad);
  maxGz = Math.min(height - 1, maxGz + pad);
  return {
    minGx,
    minGz,
    maxGx,
    maxGz,
    width: maxGx - minGx + 1,
    height: maxGz - minGz + 1,
  };
}

function unionCellArrays(...arrays) {
  const map = new Map();
  for (const array of arrays) {
    for (const cell of array || []) {
      map.set(`${cell.gx}:${cell.gz}`, cell);
    }
  }
  return [...map.values()];
}

function keysToCells(set, width) {
  return [...set].map(key => ({ gx: key % width, gz: Math.floor(key / width) }));
}

function dedupeCells(cells) {
  const seen = new Set();
  const result = [];
  for (const cell of cells) {
    const key = `${cell.gx}:${cell.gz}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cell);
  }
  return result;
}

function unionSets(...sets) {
  const out = new Set();
  for (const set of sets) {
    if (!set) continue;
    for (const value of set) out.add(value);
  }
  return out;
}

function dedupeNumbers(values, tolerance) {
  const kept = [];
  for (const value of values.filter(Number.isFinite).sort((a, b) => a - b)) {
    if (!kept.some(existing => Math.abs(existing - value) <= tolerance)) {
      kept.push(value);
    }
  }
  return kept;
}

function normalize2(vector) {
  const len = Math.hypot(vector.x, vector.z);
  if (len < 1e-9) return null;
  return { x: vector.x / len, z: vector.z / len };
}

function bres(pixels, w, h, x0, y0, x1, y1, r, g, b) {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0;
  let y = y0;
  while (true) {
    if (x >= 0 && x < w && y >= 0 && y < h) {
      const idx = (y * w + x) * 3;
      pixels[idx] = r;
      pixels[idx + 1] = g;
      pixels[idx + 2] = b;
    }
    if (x === x1 && y === y1) break;
    const e2 = err * 2;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}

function writeRaster(basePath, width, height, pixels) {
  const header = `P6\n${width} ${height}\n255\n`;
  writeFileSync(`${basePath}.ppm`, Buffer.concat([Buffer.from(header), Buffer.from(pixels)]));
  try {
    execSync(`convert "${basePath}.ppm" "${basePath}.png" 2>/dev/null`);
  } catch {}
}

function writeDebugJson(filePath, data) {
  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function roundVector(vector) {
  return vector ? { x: roundNumber(vector.x), z: roundNumber(vector.z) } : null;
}

function roundNumber(value) {
  return Math.round(value * 1000) / 1000;
}

function outputPath(name) {
  return `${outDir}/${outputPrefix}${name}`;
}

function writeAllocationSvg(filePath, {
  crop,
  zoneBoundary,
  sectorBoundary,
  anchorCells,
  commercialCells,
  parkCells,
  parkRoadCells,
  premiumResidentialCells,
  premiumAccessRoadCells,
  terraceResidentialCells,
  committedBuyerRoads = [],
  residualBlocks = [],
  gapCells,
  serviceRoadCells,
  stubCells,
  residentialCells,
  unreachableCells,
  gapCenters,
  residualCrossStreets,
  residualRibbons,
  cs,
  ox,
  oz,
  labelMinCells = 20,
}) {
  const parts = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${crop.width}" height="${crop.height}" viewBox="0 0 ${crop.width} ${crop.height}">`);
  parts.push(`<rect width="${crop.width}" height="${crop.height}" fill="#262626" />`);

  parts.push(`<g opacity="0.95">`);
  if (residualBlocks.length > 0) {
    const blockPalette = ['#5ad2ff', '#5affb4', '#ffd25a', '#ff8c8c', '#b48cff', '#8cf0c8', '#ffaa5a', '#78c8ff'];
    residualBlocks.forEach((block, index) => {
      const fill = index < blockPalette.length ? blockPalette[index] : '#507896';
      parts.push(...cellsToSvg(block, crop, fill, `residual block ${index} (${block.length} cells)`));
    });
  } else {
    parts.push(...cellsToSvg(residentialCells, crop, '#46d2ff', 'residential residual'));
  }
  if (residualBlocks.length === 0) {
    parts.push(...cellsToSvg(unreachableCells, crop, '#b43c3c', 'unreachable residual'));
  }
  parts.push(...cellsToSvg(commercialCells, crop, '#ffaa3c', 'commercial frontage'));
  parts.push(...cellsToSvg(parkCells, crop, '#3c9650', 'park'));
  parts.push(...cellsToSvg(parkRoadCells, crop, '#a0f0a8', 'park perimeter road'));
  parts.push(...cellsToSvg(premiumResidentialCells, crop, '#c496ff', 'premium residential'));
  parts.push(...cellsToSvg(premiumAccessRoadCells, crop, '#d8baff', 'premium residential access lane'));
  parts.push(...cellsToSvg(terraceResidentialCells, crop, '#ffbed2', 'park-edge terrace'));
  parts.push(...cellsToSvg(gapCells, crop, '#282828', 'frontage access gap'));
  parts.push(...cellsToSvg(serviceRoadCells, crop, '#fff578', 'service road'));
  parts.push(...cellsToSvg(stubCells, crop, '#ffeb50', 'access stub'));
  parts.push(...cellsToSvg(anchorCells, crop, '#ff00ff', 'anchor edge'));
  parts.push(...cellsToSvg(sectorBoundary, crop, '#dcdcdc', 'sector boundary'));
  parts.push(`</g>`);

  parts.push(`<g fill="none" stroke-linecap="round" stroke-linejoin="round">`);
  if (zoneBoundary.length) {
    parts.push(polylineSvg(zoneBoundary, {
      crop, cs, ox, oz,
      stroke: '#ffff00',
      strokeWidth: 1.8,
      closed: true,
      title: 'zone boundary',
    }));
  }
  for (const road of committedBuyerRoads) {
    parts.push(polylineSvg(road.points, {
      crop, cs, ox, oz,
      stroke: road.type === 'park-road' ? '#a0f0a8' : '#fff578',
      strokeWidth: 1.2,
      title: `${road.type} committed buyer road`,
    }));
  }
  for (const label of summarizeResidualBlocks(residualBlocks, crop, labelMinCells).slice(0, 12)) {
    parts.push(textSvg(label.x, label.y, `${label.index}:${label.size}`, {
      fill: '#ffffff',
      stroke: '#000000',
      strokeWidth: 0.75,
      title: `residual block ${label.index} (${label.size} cells)`,
    }));
  }
  for (const street of residualCrossStreets) {
    parts.push(polylineSvg(street.points, {
      crop, cs, ox, oz,
      stroke: '#ff00ff',
      strokeWidth: 1.2,
      title: `residual cross street ct=${roundNumber(street.ctOff ?? 0)}`,
    }));
  }
  for (const ribbon of residualRibbons) {
    parts.push(polylineSvg(ribbon.points, {
      crop, cs, ox, oz,
      stroke: '#00ffff',
      strokeWidth: 1.1,
      title: `residual ribbon row ${ribbon.rowId ?? 'n/a'}`,
    }));
    if (ribbon.points?.length) {
      parts.push(circleSvg(ribbon.points[0], {
        crop, cs, ox, oz,
        radius: 1.5,
        fill: '#ffa500',
        stroke: '#000000',
        strokeWidth: 0.6,
        title: 'ribbon start',
      }));
      parts.push(circleSvg(ribbon.points[ribbon.points.length - 1], {
        crop, cs, ox, oz,
        radius: 1.5,
        fill: '#ffa500',
        stroke: '#000000',
        strokeWidth: 0.6,
        title: 'ribbon end',
      }));
    }
  }
  for (const center of gapCenters) {
    parts.push(cellMarkerSvg(center, {
      crop,
      radius: 2,
      fill: '#ffffff',
      stroke: '#000000',
      strokeWidth: 0.6,
      title: 'gap centre',
    }));
  }
  parts.push(`</g>`);
  parts.push(`</svg>`);
  writeFileSync(filePath, parts.join('\n'));
}

function writeVectorReservationSvg(filePath, {
  crop,
  zoneBoundary,
  sectorCells,
  anchorCells,
  layout,
  committedBuyerRoads = [],
  gapMarkers = [],
  cs,
  ox,
  oz,
}) {
  const parts = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${crop.width}" height="${crop.height}" viewBox="0 0 ${crop.width} ${crop.height}">`);
  parts.push(`<rect width="${crop.width}" height="${crop.height}" fill="#262626" />`);
  parts.push(`<g opacity="0.5">`);
  parts.push(...cellsToSvg(sectorCells, crop, '#46d2ff', 'sector cells'));
  parts.push(...cellsToSvg(anchorCells, crop, '#ff00ff', 'anchor cells'));
  parts.push(`</g>`);

  parts.push(`<g opacity="0.55">`);
  for (const parcel of layout.parcels) {
    parts.push(polygonSvg(parcel.polygon, {
      crop, cs, ox, oz,
      fill: '#ffaa3c',
      stroke: '#ffcf85',
      strokeWidth: 0.35,
      title: `${parcel.kind} parcel`,
    }));
  }
  parts.push(`</g>`);

  parts.push(`<g fill="none" stroke-linecap="round" stroke-linejoin="round">`);
  if (zoneBoundary.length) {
    parts.push(polylineSvg(zoneBoundary, {
      crop, cs, ox, oz,
      stroke: '#ffff00',
      strokeWidth: 1.8,
      closed: true,
      title: 'zone boundary',
    }));
  }

  for (const span of layout.frontageSpans) {
    parts.push(polylineSvg(span.frontage, {
      crop, cs, ox, oz,
      stroke: '#ff00ff',
      strokeWidth: 1.1,
      title: `frontage span ${span.id}`,
    }));
  }

  for (const road of layout.roads) {
    parts.push(polylineSvg(road.centerline, {
      crop, cs, ox, oz,
      stroke: road.kind === 'stub-road' ? '#ffeb50' : '#fff578',
      strokeWidth: road.kind === 'stub-road' ? 0.9 : 1.2,
      title: `${road.kind} planned road`,
    }));
  }

  for (const road of committedBuyerRoads) {
    parts.push(polylineSvg(road.points, {
      crop, cs, ox, oz,
      stroke: road.type === 'stub-road' ? '#ffd84a' : '#fffde1',
      strokeWidth: road.type === 'stub-road' ? 1.0 : 1.5,
      title: `${road.type} committed road`,
    }));
  }

  for (const marker of gapMarkers) {
    parts.push(circleSvg(marker, {
      crop, cs, ox, oz,
      radius: 1.2,
      fill: '#ffffff',
      stroke: '#000000',
      strokeWidth: 0.5,
      title: 'frontage access gap',
    }));
  }
  parts.push(`</g>`);
  parts.push(`</svg>`);
  writeFileSync(filePath, parts.join('\n'));
}

function cellsToSvg(cells, crop, fill, title) {
  return cells.map(cell => {
    const x = cell.gx - crop.minGx;
    const y = cell.gz - crop.minGz;
    if (x < 0 || x >= crop.width || y < 0 || y >= crop.height) return '';
    return `<rect x="${x}" y="${y}" width="1" height="1" fill="${fill}" pointer-events="visiblePainted"><title>${escapeXml(title)}</title></rect>`;
  }).filter(Boolean);
}

function polygonSvg(points, { crop, cs, ox, oz, fill, stroke = 'none', strokeWidth = 0, title = '' }) {
  if (!points || points.length < 3) return '';
  const svgPoints = points
    .map(point => worldToSvg(point, crop, cs, ox, oz))
    .map(point => `${point.x},${point.y}`)
    .join(' ');
  return `<polygon points="${svgPoints}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" pointer-events="visiblePainted">${title ? `<title>${escapeXml(title)}</title>` : ''}</polygon>`;
}

function polylineSvg(points, { crop, cs, ox, oz, stroke, strokeWidth = 1, closed = false, title = '' }) {
  if (!points || points.length === 0) return '';
  const svgPoints = points
    .map(point => worldToSvg(point, crop, cs, ox, oz))
    .map(point => `${point.x},${point.y}`)
    .join(' ');
  return `<polyline points="${svgPoints}${closed ? ` ${svgPoints.split(' ')[0]}` : ''}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" pointer-events="stroke">${title ? `<title>${escapeXml(title)}</title>` : ''}</polyline>`;
}

function circleSvg(point, { crop, cs, ox, oz, radius = 2, fill = 'none', stroke = '#ffffff', strokeWidth = 1, title = '' }) {
  const p = worldToSvg(point, crop, cs, ox, oz);
  return `<circle cx="${p.x}" cy="${p.y}" r="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" pointer-events="visiblePainted">${title ? `<title>${escapeXml(title)}</title>` : ''}</circle>`;
}

function cellMarkerSvg(cell, { crop, radius = 2, fill = '#ffffff', stroke = '#000000', strokeWidth = 1, title = '' }) {
  const x = roundNumber(cell.gx - crop.minGx + 0.5);
  const y = roundNumber(cell.gz - crop.minGz + 0.5);
  return `<circle cx="${x}" cy="${y}" r="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" pointer-events="visiblePainted">${title ? `<title>${escapeXml(title)}</title>` : ''}</circle>`;
}

function textSvg(x, y, text, { fill = '#ffffff', stroke = '#000000', strokeWidth = 0.8, title = '' } = {}) {
  return `<text x="${roundNumber(x)}" y="${roundNumber(y)}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" paint-order="stroke" font-size="5" font-family="monospace" text-anchor="middle" dominant-baseline="middle" pointer-events="visiblePainted">${title ? `<title>${escapeXml(title)}</title>` : ''}${escapeXml(text)}</text>`;
}

function summarizeResidualBlocks(residualBlocks, crop, minCells = 0) {
  return residualBlocks.map((block, index) => {
    let sumX = 0;
    let sumY = 0;
    for (const cell of block) {
      sumX += cell.gx - crop.minGx + 0.5;
      sumY += cell.gz - crop.minGz + 0.5;
    }
    return {
      index,
      size: block.length,
      x: sumX / Math.max(1, block.length),
      y: sumY / Math.max(1, block.length),
    };
  }).filter(block => block.size >= minCells).sort((a, b) => b.size - a.size);
}

function worldToSvg(point, crop, cs, ox, oz) {
  return {
    x: roundNumber((point.x - ox) / cs - crop.minGx),
    y: roundNumber((point.z - oz) / cs - crop.minGz),
  };
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
