#!/usr/bin/env bun

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { loadMapForStep } from './fixture-bootstrap.js';
import { extractZoneBoundary } from '../src/city/zoneExtraction.js';
import { fillResidualAreasWithRibbons } from '../src/city/land/residualRibbonFill.js';
import { loadOrCreateTerrainFaceCache } from '../src/city/land/terrainFaceCache.js';
import { FanoutEventSink, FilteredEventSink, NdjsonEventSink } from '../src/core/EventSink.js';
import {
  analyzeVectorBoundaryParkCommercialTerraceSector,
  analyzeVectorBoundaryParkCommercialTerraceGuidedSector,
  analyzeVectorBoundaryParkResidualCommercialSector,
  analyzeVectorBoundaryParkResidualSector,
  analyzeVectorBoundaryParkSector,
  analyzeVectorFrontageSector,
  analyzeVectorFrontageSectorWithPark,
  commitVectorFrontageRoads,
  createVectorFrontageParams,
} from '../src/city/land/vectorFrontageLayout.js';

const cliArgs = process.argv.slice(2);
const getArg = (name, def = null) => {
  const idx = cliArgs.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < cliArgs.length ? cliArgs[idx + 1] : def;
};
const profileMode = cliArgs.includes('--profile');
const profileTotals = new Map();

function timeBlock(label, fn) {
  const t0 = performance.now();
  const result = fn();
  const dt = performance.now() - t0;
  profileTotals.set(label, (profileTotals.get(label) || 0) + dt);
  return { result, ms: dt };
}

async function timeBlockAsync(label, fn) {
  const t0 = performance.now();
  const result = await fn();
  const dt = performance.now() - t0;
  profileTotals.set(label, (profileTotals.get(label) || 0) + dt);
  return { result, ms: dt };
}

const fixturePath = getArg('fixture', null);
const seed = fixturePath ? NaN : (parseInt(process.argv[2], 10) || 42);
const gx = fixturePath ? NaN : (parseInt(process.argv[3], 10) || 27);
const gz = fixturePath ? NaN : (parseInt(process.argv[4], 10) || 95);
const outDir = fixturePath ? (getArg('out', 'experiments/053-output')) : (process.argv[5] || 'experiments/053-output');
const experimentNum = fixturePath ? getArg('experiment', null) : (process.argv[6] || null);
const outputPrefix = getArg('output-prefix', '');

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const BASE_PARAMS = {
  minSectorCells: 80,
  cropPad: 14,
};
const RESIDUAL_FILL_CROSS_PARAMS = {
  spacing: 70,
  stepSize: 2.5,
  minLength: 18,
  minSeparation: 5,
};
const RESIDUAL_FILL_RIBBON_PARAMS = {
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
const includePark = experimentNum === '054' || experimentNum === '055' || experimentNum === '056' || experimentNum === '057' || experimentNum === '058' || experimentNum === '059' || experimentNum === '060' || experimentNum === '061';
const boundaryParkMode = experimentNum === '055';
const regularizedBoundaryParkMode = experimentNum === '056';
const residualBoundaryParkMode = experimentNum === '057';
const residualCommercialBoundaryParkMode = experimentNum === '058';
const terraceCommercialBoundaryParkMode = experimentNum === '059' || experimentNum === '060';
const residualRibbonFillMode = experimentNum === '060' || experimentNum === '061';
const guidedTerraceCommercialBoundaryParkMode = experimentNum === '061';

const { map, runSeed, runGx, runGz } = await loadMapForStep({
  fixturePath,
  seed,
  gx,
  gz,
  step: 'spatial',
});

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
const layoutParams = createVectorFrontageParams(cs);

console.log('Loading terrain faces...');
const terrainFaceTimer = await timeBlockAsync('terrain-faces', async () => loadOrCreateTerrainFaceCache({
  fixturePath,
  map,
  opts: {
  dirTolerance: Math.PI / 6,
  elevTolerance: 100,
  slopeBands: [0.3, 0.8],
  },
}));
const { faces, faceIndex } = terrainFaceTimer.result;
console.log(`Terrain faces: ${faces.length}`);

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

for (let zi = 0; zi < selectedZones.length; zi++) {
  const zone = selectedZones[zi];
  console.log(`\n=== Zone ${zi} ===`);

  const sectorBuildTimer = timeBlock(`zone-${zi}:build-sectors`, () =>
    buildSectors(zone, faceIndex, faces, W, BASE_PARAMS.minSectorCells, cs, ox, oz),
  );
  const sectors = sectorBuildTimer.result;
  console.log(`  Sectors: ${sectors.length}`);

  const scoredSectorsTimer = timeBlock(`zone-${zi}:analyze-sectors`, () => sectors
    .map((sector, sectorIdx) => {
      const analysis = analyzeVectorFrontageSector({
        sector,
        roadGrid,
        width: W,
        height: H,
        map,
        params: layoutParams,
      });
      let enhanced = analysis;
      if (boundaryParkMode) {
        enhanced = analyzeVectorBoundaryParkSector({
          sector,
          roadGrid,
          width: W,
          height: H,
          map,
          waterMask,
          params: layoutParams,
          mode: 'strip',
        });
      } else if (residualBoundaryParkMode) {
        enhanced = analyzeVectorBoundaryParkResidualSector({
          sector,
          roadGrid,
          width: W,
          height: H,
          map,
          waterMask,
          params: layoutParams,
          mode: 'regularized-quad',
        });
      } else if (residualCommercialBoundaryParkMode) {
        enhanced = analyzeVectorBoundaryParkResidualCommercialSector({
          sector,
          roadGrid,
          width: W,
          height: H,
          map,
          waterMask,
          params: layoutParams,
          mode: 'regularized-quad',
        });
      } else if (terraceCommercialBoundaryParkMode) {
        enhanced = analyzeVectorBoundaryParkCommercialTerraceSector({
          sector,
          roadGrid,
          width: W,
          height: H,
          map,
          waterMask,
          params: layoutParams,
          mode: 'regularized-quad',
        });
      }
      if (guidedTerraceCommercialBoundaryParkMode) {
        enhanced = analyzeVectorBoundaryParkCommercialTerraceGuidedSector({
          sector,
          roadGrid,
          width: W,
          height: H,
          map,
          waterMask,
          params: layoutParams,
        });
      } else if (regularizedBoundaryParkMode) {
        enhanced = analyzeVectorBoundaryParkSector({
          sector,
          roadGrid,
          width: W,
          height: H,
          map,
          waterMask,
          params: layoutParams,
          mode: 'regularized-quad',
        });
      } else if (includePark) {
        enhanced = analyzeVectorFrontageSectorWithPark({
          sector,
          roadGrid,
          width: W,
          height: H,
          map,
          waterMask,
          params: layoutParams,
        });
      }
      const summary = enhanced.layout.summary();
      const score = summary.totalFrontageLength + summary.counts.frontageSpans * 150 + summary.counts.parcels * 8;
      return { sector, sectorIdx, analysis: enhanced, score, summary };
    })
    .filter(entry => entry.summary.counts.frontageSpans > 0)
    .sort((a, b) => b.score - a.score));
  const scoredSectors = scoredSectorsTimer.result;

  if (scoredSectors.length === 0) {
    console.log('  No suitable vector frontage sector found');
    continue;
  }

  const selected = scoredSectors[0];
  const { sector, sectorIdx, analysis, summary } = selected;
  const cropTimer = timeBlock(`zone-${zi}:compute-crop`, () => computeSectorCrop(sector, W, H, BASE_PARAMS.cropPad));
  const crop = cropTimer.result;
  const basePixelsTimer = timeBlock(`zone-${zi}:build-base-pixels`, () => buildBasePixels({
    crop,
    elev,
    eBounds,
    eRange,
    waterMask,
    roadGrid,
    zone,
    sector,
    cs,
    ox,
    oz,
    W,
  }));
  const pixels = basePixelsTimer.result;

  drawCells(pixels, crop, sector.cells, [70, 210, 255]);
  drawCells(pixels, crop, analysis.anchorCells, [255, 0, 255]);

  const cloneTimer = timeBlock(`zone-${zi}:clone-map`, () => map.clone());
  const workingMap = cloneTimer.result;
  const zoneEventSink = residualRibbonFillMode
    ? createZoneEventSink(outputPath, zi, runSeed)
    : null;
  const commitRoadsTimer = timeBlock(`zone-${zi}:commit-buyer-roads`, () =>
    commitVectorFrontageRoads(workingMap, analysis.layout.roads),
  );
  const committedRoads = commitRoadsTimer.result;
  const residualCrossParams = {
    ...RESIDUAL_FILL_CROSS_PARAMS,
    ...(analysis.guideLattice ? {
      phaseOrigin: analysis.guideLattice.origin,
      phaseOffset: analysis.guideLattice.phaseOffset,
      phaseOriginSource: 'vector-guide-lattice',
    } : {}),
  };
  const residualFillTimer = timeBlock(`zone-${zi}:residual-fill`, () => residualRibbonFillMode
    ? fillResidualAreasWithRibbons({
        residualAreas: analysis.residualAreas || [],
        parentSector: sector,
        map: workingMap,
        crossParams: residualCrossParams,
        ribbonParams: RESIDUAL_FILL_RIBBON_PARAMS,
        minCells: 120,
        eventSink: zoneEventSink,
        eventContext: {
          experiment: experimentNum,
          seed: runSeed,
          zoneIdx: zi,
          faceIdx: sector.faceIdx,
        },
      })
    : {
        fillSectors: [],
        residualCrossStreets: [],
        residualRibbons: [],
        failedRibbons: [],
        rejectedCrossStreets: 0,
        rejectedRibbons: 0,
      });
  const residualFill = residualFillTimer.result;
  zoneEventSink?.close();
  for (const road of committedRoads) {
    drawWorldPolyline(
      pixels,
      crop,
      road.points,
      cs,
      ox,
      oz,
      road.type === 'stub-road' ? [255, 215, 64] : [255, 245, 120],
    );
  }
  for (const street of residualFill.residualCrossStreets) {
    drawWorldPolyline(pixels, crop, street.points, cs, ox, oz, [255, 0, 255]);
  }
  for (const ribbon of residualFill.residualRibbons) {
    drawWorldPolyline(pixels, crop, ribbon.points, cs, ox, oz, [0, 255, 255]);
    if (ribbon.points?.length) {
      drawWorldMarker(pixels, crop, ribbon.points[0], cs, ox, oz, [255, 165, 0], 1);
      drawWorldMarker(pixels, crop, ribbon.points[ribbon.points.length - 1], cs, ox, oz, [255, 165, 0], 1);
    }
  }
  for (const marker of analysis.gapMarkers) {
    drawWorldMarker(pixels, crop, marker, cs, ox, oz, [255, 255, 255], 1);
  }

  let baseLabel = 'clean-frontage';
  if (boundaryParkMode) baseLabel = 'boundary-park';
  if (regularizedBoundaryParkMode) baseLabel = 'boundary-park-regularized';
  if (residualBoundaryParkMode) baseLabel = 'boundary-park-residual';
  if (residualCommercialBoundaryParkMode) baseLabel = 'boundary-park-commercial-residual';
  if (terraceCommercialBoundaryParkMode) baseLabel = 'boundary-park-commercial-terraces';
  if (residualRibbonFillMode) baseLabel = 'boundary-park-commercial-terraces-ribbons';
  if (guidedTerraceCommercialBoundaryParkMode) baseLabel = 'boundary-park-commercial-terraces-guided-ribbons';
  if (!boundaryParkMode && !regularizedBoundaryParkMode && !residualBoundaryParkMode && !residualCommercialBoundaryParkMode && !terraceCommercialBoundaryParkMode && !guidedTerraceCommercialBoundaryParkMode && includePark) {
    baseLabel = 'clean-frontage-park';
  }
  const basePath = outputPath(`${baseLabel}-zone${zi}-seed${runSeed}`);
  const rasterTimer = timeBlock(`zone-${zi}:write-raster`, () => writeRaster(basePath, crop.width, crop.height, pixels));
    const svgTimer = timeBlock(`zone-${zi}:write-svg`, () => writeCleanFrontageSvg(`${basePath}.svg`, {
      crop,
      zoneBoundary: zone.boundary || [],
      sectorCells: sector.cells,
      layout: analysis.layout,
      committedRoads,
      gapMarkers: analysis.gapMarkers,
      park: analysis.park || null,
      residualAreas: analysis.residualAreas || [],
      residualCrossStreets: residualFill.residualCrossStreets,
      residualRibbons: residualFill.residualRibbons,
      guideLattice: analysis.guideLattice || null,
      cs,
      ox,
      oz,
    }));
  const jsonTimer = timeBlock(`zone-${zi}:write-json`, () => writeFileSync(`${basePath}.json`, JSON.stringify({
    experiment: experimentNum,
    seed: runSeed,
    gx: runGx,
    gz: runGz,
    zoneIdx: zi,
    sectorIdx,
    crop,
    sectorCells: sector.cells.length,
    anchorCellCount: analysis.anchorCellCount,
    anchorRuns: analysis.anchorRuns.map(run => ({
      cellCount: run.cells.length,
      tangent: roundVector(run.tangent),
      inward: roundVector(run.inward),
    })),
    params: {
      ...BASE_PARAMS,
      ...layoutParams,
    },
      counts: {
        frontageSpans: analysis.layout.frontageSpans.length,
        parcels: analysis.layout.parcels.length,
        commercialParcels: analysis.layout.parcels.filter(parcel => parcel.kind === 'commercial-frontage-strip').length,
        terraceParcels: analysis.layout.parcels.filter(parcel => parcel.kind === 'residential-park-terrace').length,
        parkParcels: analysis.layout.parcels.filter(parcel => parcel.kind === 'civic-park').length,
        residualAreas: (analysis.residualAreas || []).length,
        plannedRoads: analysis.layout.roads.length,
        committedRoads: committedRoads.length,
        residualFillSectors: residualFill.fillSectors.length,
        residualCrossStreets: residualFill.residualCrossStreets.length,
        residualRibbons: residualFill.residualRibbons.length,
        residualRejectedCrossStreets: residualFill.rejectedCrossStreets,
        residualRejectedRibbons: residualFill.rejectedRibbons,
        gapMarkers: analysis.gapMarkers.length,
      },
      park: analysis.park || null,
      guideLattice: analysis.guideLattice || null,
      layout: analysis.layout.toJSON(),
      residualAreas: (analysis.residualAreas || []).map(area => area.toJSON()),
      residualFill: {
        sectors: residualFill.fillSectors.map(fillSector => ({
          cells: fillSector.cells.length,
          centroidGx: roundNumber(fillSector.centroidGx),
          centroidGz: roundNumber(fillSector.centroidGz),
        })),
        crossStreets: residualFill.residualCrossStreets.map(street => ({
          roadId: street.roadId,
          ctOff: roundNumber(street.ctOff ?? 0),
          length: roundNumber(street.length ?? 0),
        })),
        ribbons: residualFill.residualRibbons.map(ribbon => ({
          roadId: ribbon.roadId,
          rowId: ribbon.rowId ?? null,
          familyRootRowId: ribbon.familyRootRowId ?? null,
        })),
        failedRibbons: residualFill.failedRibbons,
      },
    }, null, 2)));

  console.log(`  Sector ${sectorIdx}: ${sector.cells.length} cells`);
    console.log(`    frontage spans: ${summary.counts.frontageSpans}`);
    console.log(`    parcels: ${summary.counts.parcels}`);
    if (includePark) {
      console.log(`    park parcels: ${analysis.layout.parcels.filter(parcel => parcel.kind === 'civic-park').length}`);
    }
    const terraceCount = analysis.layout.parcels.filter(parcel => parcel.kind === 'residential-park-terrace').length;
    if (terraceCount > 0) {
      console.log(`    terrace parcels: ${terraceCount}`);
    }
    if ((analysis.residualAreas || []).length > 0) {
      console.log(`    residual areas: ${analysis.residualAreas.length}`);
    }
    if (residualRibbonFillMode) {
      console.log(`    residual fill sectors: ${residualFill.fillSectors.length}`);
      console.log(`    residual cross streets: ${residualFill.residualCrossStreets.length}`);
      console.log(`    residual ribbons: ${residualFill.residualRibbons.length}`);
      console.log(`    residual rejected cross streets: ${residualFill.rejectedCrossStreets}`);
      console.log(`    residual rejected ribbons: ${residualFill.rejectedRibbons}`);
    }
  console.log(`    planned roads: ${summary.counts.roads}`);
  console.log(`    committed roads: ${committedRoads.length}`);
  if (profileMode) {
    console.log(`    profile(ms): sectors ${sectorBuildTimer.ms.toFixed(1)}, analyze ${scoredSectorsTimer.ms.toFixed(1)}, pixels ${basePixelsTimer.ms.toFixed(1)}, clone ${cloneTimer.ms.toFixed(1)}, commit ${commitRoadsTimer.ms.toFixed(1)}, residual ${residualFillTimer.ms.toFixed(1)}, raster ${rasterTimer.ms.toFixed(1)}, svg ${svgTimer.ms.toFixed(1)}, json ${jsonTimer.ms.toFixed(1)}`);
  }
  console.log(`  Written to ${basePath}.png`);
  console.log(`  Written to ${basePath}.svg`);
  if (zoneEventSink) {
    console.log(`  Written to ${outputPath(`events-zone${zi}-seed${runSeed}.ndjson`)}`);
    console.log(`  Written to ${outputPath(`cross-events-zone${zi}-seed${runSeed}.ndjson`)}`);
    console.log(`  Written to ${outputPath(`ribbon-events-zone${zi}-seed${runSeed}.ndjson`)}`);
  }
}

if (profileMode) {
  console.log('\nProfile totals (ms):');
  [...profileTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([label, ms]) => {
      console.log(`  ${label}: ${ms.toFixed(1)}`);
    });
}

function buildSectors(zone, faceIndex, faces, width, minSectorCells, cellSize, originX, originZ) {
  const sectorMap = new Map();
  for (const cell of zone.cells) {
    const faceIdx = faceIndex[cell.gz * width + cell.gx];
    if (faceIdx === undefined) continue;
    if (faceIdx < 0) continue;
    if (!sectorMap.has(faceIdx)) sectorMap.set(faceIdx, []);
    sectorMap.get(faceIdx).push(cell);
  }

  const sectors = [];
  for (const [faceIdx, cells] of sectorMap) {
    if (cells.length < minSectorCells) continue;
    let centroidGx = 0;
    let centroidGz = 0;
    for (const cell of cells) {
      centroidGx += cell.gx;
      centroidGz += cell.gz;
    }
    centroidGx /= cells.length;
    centroidGz /= cells.length;
    sectors.push({
      cells,
      centroidGx,
      centroidGz,
      faceIdx,
      avgSlope: faces[faceIdx]?.avgSlope ?? zone.avgSlope,
      slopeDir: faces[faceIdx]?.slopeDir ?? zone.slopeDir,
      boundary: extractZoneBoundary(cells, cellSize, originX, originZ),
    });
  }
  return sectors;
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

function drawWorldMarker(pixels, crop, point, cs, ox, oz, color, radius = 1) {
  const gx = Math.round((point.x - ox) / cs);
  const gz = Math.round((point.z - oz) / cs);
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = gx - crop.minGx + dx;
      const z = gz - crop.minGz + dz;
      if (x < 0 || x >= crop.width || z < 0 || z >= crop.height) continue;
      const idx = (z * crop.width + x) * 3;
      pixels[idx] = color[0];
      pixels[idx + 1] = color[1];
      pixels[idx + 2] = color[2];
    }
  }
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

function outputPath(name) {
  return `${outDir}/${outputPrefix}${name}`;
}

function createZoneEventSink(outputPathFn, zoneIdx, runSeed) {
  const combinedEventSink = new NdjsonEventSink(outputPathFn(`events-zone${zoneIdx}-seed${runSeed}.ndjson`));
  const crossEventSink = new FilteredEventSink(
    new NdjsonEventSink(outputPathFn(`cross-events-zone${zoneIdx}-seed${runSeed}.ndjson`)),
    event => event.stepId === 'cross-streets',
  );
  const ribbonEventSink = new FilteredEventSink(
    new NdjsonEventSink(outputPathFn(`ribbon-events-zone${zoneIdx}-seed${runSeed}.ndjson`)),
    event => event.stepId === 'ribbons',
  );
  return new FanoutEventSink([combinedEventSink, crossEventSink, ribbonEventSink]);
}

function writeCleanFrontageSvg(filePath, {
  crop,
  zoneBoundary,
  sectorCells,
  layout,
  committedRoads = [],
  gapMarkers = [],
  park = null,
  residualAreas = [],
  residualCrossStreets = [],
  residualRibbons = [],
  guideLattice = null,
  cs,
  ox,
  oz,
}) {
  const parts = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${crop.width}" height="${crop.height}" viewBox="0 0 ${crop.width} ${crop.height}">`);
  parts.push(`<rect width="${crop.width}" height="${crop.height}" fill="#262626" />`);

  parts.push(`<g opacity="0.42">`);
  parts.push(...cellsToSvg(sectorCells, crop, '#46d2ff', 'sector cells'));
  parts.push(`</g>`);

  if (residualAreas.length) {
    parts.push(`<g opacity="0.24">`);
    for (const area of residualAreas) {
      parts.push(polygonSvg(area.polygon, {
        crop, cs, ox, oz,
        fill: '#d9dde3',
        stroke: '#cfd5dc',
        strokeWidth: 0.55,
        title: 'unallocated residual area',
      }));
    }
    parts.push(`</g>`);
  }

  if (guideLattice?.lines?.length) {
    parts.push(`<g opacity="0.22" fill="none" stroke="#9ea7b4" stroke-width="0.55" stroke-dasharray="2 1.4">`);
    for (const line of guideLattice.lines) {
      parts.push(polylineSvg(line, {
        crop, cs, ox, oz,
        stroke: '#aab4c1',
        strokeWidth: 0.55,
        strokeDasharray: '2 1.4',
        title: 'construction guide line',
      }));
    }
    parts.push(`</g>`);
  }

  parts.push(`<g opacity="0.72">`);
  for (const parcel of layout.parcels) {
    const parcelFill = parcel.kind === 'civic-park'
      ? '#3c9650'
      : (parcel.kind === 'residential-park-terrace' ? '#f3d7d9' : '#ffb347');
    const parcelStroke = parcel.kind === 'civic-park'
      ? '#a8f0b0'
      : (parcel.kind === 'residential-park-terrace' ? '#fff3f4' : '#fff0c2');
    parts.push(polygonSvg(parcel.polygon, {
      crop, cs, ox, oz,
      fill: parcelFill,
      stroke: parcelStroke,
      strokeWidth: 0.45,
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
    const boundaryParkFrontage = span.meta?.use === 'boundary-park-frontage';
    parts.push(polylineSvg(span.frontage, {
      crop, cs, ox, oz,
      stroke: boundaryParkFrontage ? '#7bcf7b' : '#ff00ff',
      strokeWidth: boundaryParkFrontage ? 0.85 : 1.2,
      strokeDasharray: boundaryParkFrontage ? '2 1.4' : null,
      title: boundaryParkFrontage ? `park frontage edge ${span.id}` : `frontage span ${span.id}`,
    }));
  }
  for (const road of layout.roads) {
    parts.push(polylineSvg(road.centerline, {
      crop, cs, ox, oz,
      stroke: roadStroke(road.kind, false),
      strokeWidth: road.kind === 'stub-road' ? 1.0 : 1.3,
      title: `${road.kind} planned road\nPlan ${road.id}`,
    }));
  }
  for (const road of committedRoads) {
    parts.push(polylineSvg(road.points, {
      crop, cs, ox, oz,
      stroke: roadStroke(road.type, true),
      strokeWidth: road.type === 'stub-road' ? 1.1 : 1.55,
      title: `${road.type} committed road\nPlan ${road.id}\nRoad ${road.wayId}`,
    }));
    for (const point of road.junctionPoints || []) {
      parts.push(circleSvg(point, {
        crop, cs, ox, oz,
        radius: 1.2,
        fill: '#d8ffd8',
        stroke: '#153015',
        strokeWidth: 0.35,
        title: 'road connection to host road',
      }));
    }
  }
  for (const street of residualCrossStreets) {
    parts.push(polylineSvg(street.points, {
      crop, cs, ox, oz,
      stroke: '#ff00ff',
      strokeWidth: 1.05,
      title: [
        'Residual cross street',
        `Road ${street.roadId}`,
        `Fill sector ${street.sectorIdx ?? '?'}`,
        street.ctOff !== undefined ? `ct ${roundNumber(street.ctOff)}` : null,
      ].filter(Boolean).join('\n'),
      attrs: {
        class: 'debug-cross-street',
        'data-sector-idx': String(street.sectorIdx ?? ''),
        'data-street-key': street.streetKey || residualStreetKey(street),
      },
    }));
  }
  for (const ribbon of residualRibbons) {
    parts.push(polylineSvg(ribbon.points, {
      crop, cs, ox, oz,
      stroke: '#00ffff',
      strokeWidth: 1.0,
      title: [
        'Residual ribbon',
        `Road ${ribbon.roadId}`,
        `Fill sector ${ribbon.sectorIdx ?? '?'}`,
        ribbon.rowId !== undefined ? `Row ${ribbon.rowId}` : null,
      ].filter(Boolean).join('\n'),
      attrs: {
        class: 'debug-ribbon',
        'data-sector-idx': String(ribbon.sectorIdx ?? ''),
        'data-row-id': String(ribbon.rowId ?? ''),
      },
    }));
    if (ribbon.points?.length) {
      parts.push(circleSvg(ribbon.points[0], {
        crop, cs, ox, oz,
        radius: 0.8,
        fill: '#ffa500',
        stroke: '#3b2200',
        strokeWidth: 0.3,
        title: 'ribbon endpoint',
      }));
      parts.push(circleSvg(ribbon.points[ribbon.points.length - 1], {
        crop, cs, ox, oz,
        radius: 0.8,
        fill: '#ffa500',
        stroke: '#3b2200',
        strokeWidth: 0.3,
        title: 'ribbon endpoint',
      }));
    }
  }
  for (const marker of gapMarkers) {
    parts.push(circleSvg(marker, {
      crop, cs, ox, oz,
      radius: 1.3,
      fill: '#ffffff',
      stroke: '#000000',
      strokeWidth: 0.45,
      title: 'frontage access gap',
    }));
  }
  if (park?.polygon) {
    const center = centroidForPolygon(park.polygon, crop, cs, ox, oz);
    parts.push(`<text x="${roundNumber(center.x)}" y="${roundNumber(center.y)}" fill="#ffffff" stroke="#000000" stroke-width="0.8" paint-order="stroke" font-size="6" font-family="monospace" text-anchor="middle" dominant-baseline="middle">park</text>`);
  }
  residualAreas.forEach((area, index) => {
    const center = centroidForPolygon(area.polygon, crop, cs, ox, oz);
    parts.push(`<text x="${roundNumber(center.x)}" y="${roundNumber(center.y)}" fill="#ffffff" stroke="#000000" stroke-width="0.7" paint-order="stroke" font-size="4.8" font-family="monospace" text-anchor="middle" dominant-baseline="middle">residual</text>`);
  });
  parts.push(`</g>`);
  parts.push(`</svg>`);
  writeFileSync(filePath, parts.join('\n'));
}

function cellsToSvg(cells, crop, fill, title) {
  return cells.map(cell => {
    const x = cell.gx - crop.minGx;
    const y = cell.gz - crop.minGz;
    if (x < 0 || x >= crop.width || y < 0 || y >= crop.height) return '';
    const attrs = attrsToSvg(title ? { 'data-tooltip': title } : {});
    return `<rect x="${x}" y="${y}" width="1" height="1" fill="${fill}" pointer-events="visiblePainted"${attrs}>${title ? `<title>${escapeXml(title)}</title>` : ''}</rect>`;
  }).filter(Boolean);
}

function polygonSvg(points, { crop, cs, ox, oz, fill, stroke = 'none', strokeWidth = 0, title = '', attrs = {} }) {
  if (!points || points.length < 3) return '';
  const svgPoints = points.map(point => worldToSvg(point, crop, cs, ox, oz)).map(point => `${point.x},${point.y}`).join(' ');
  const extraAttrs = attrsToSvg(withTooltipAttr(attrs, title));
  return `<polygon points="${svgPoints}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" pointer-events="visiblePainted"${extraAttrs}>${title ? `<title>${escapeXml(title)}</title>` : ''}</polygon>`;
}

function polylineSvg(points, { crop, cs, ox, oz, stroke, strokeWidth = 1, strokeDasharray = null, closed = false, title = '', attrs = {} }) {
  if (!points || points.length === 0) return '';
  const svgPoints = points.map(point => worldToSvg(point, crop, cs, ox, oz)).map(point => `${point.x},${point.y}`).join(' ');
  const extraAttrs = attrsToSvg(withTooltipAttr(attrs, title));
  return `<polyline points="${svgPoints}${closed ? ` ${svgPoints.split(' ')[0]}` : ''}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}"${strokeDasharray ? ` stroke-dasharray="${strokeDasharray}"` : ''} pointer-events="stroke"${extraAttrs}>${title ? `<title>${escapeXml(title)}</title>` : ''}</polyline>`;
}

function circleSvg(point, { crop, cs, ox, oz, radius = 2, fill = 'none', stroke = '#ffffff', strokeWidth = 1, title = '', attrs = {} }) {
  const p = worldToSvg(point, crop, cs, ox, oz);
  const extraAttrs = attrsToSvg(withTooltipAttr(attrs, title));
  return `<circle cx="${p.x}" cy="${p.y}" r="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" pointer-events="visiblePainted"${extraAttrs}>${title ? `<title>${escapeXml(title)}</title>` : ''}</circle>`;
}

function withTooltipAttr(attrs = {}, title = '') {
  if (!title) return attrs;
  if (attrs['data-tooltip']) return attrs;
  return {
    ...attrs,
    'data-tooltip': title,
  };
}

function attrsToSvg(attrs = {}) {
  const parts = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === '') continue;
    parts.push(` ${key}="${escapeXml(value)}"`);
  }
  return parts.join('');
}

function worldToSvg(point, crop, cs, ox, oz) {
  return {
    x: roundNumber((point.x - ox) / cs - crop.minGx),
    y: roundNumber((point.z - oz) / cs - crop.minGz),
  };
}

function roundVector(vector) {
  return vector ? { x: roundNumber(vector.x), z: roundNumber(vector.z) } : null;
}

function roadStroke(kind, committed) {
  if (kind === 'park-road') return committed ? '#d8ffd8' : '#9ee69e';
  if (kind === 'park-connector-road') return committed ? '#c6ffe8' : '#5ad2b0';
  if (kind === 'stub-road') return committed ? '#ffe28a' : '#ffd84a';
  return committed ? '#fffef2' : '#fff578';
}

function centroidForPolygon(polygon, crop, cs, ox, oz) {
  let sumX = 0;
  let sumY = 0;
  for (const point of polygon) {
    const p = worldToSvg(point, crop, cs, ox, oz);
    sumX += p.x;
    sumY += p.y;
  }
  return { x: sumX / polygon.length, y: sumY / polygon.length };
}

function roundNumber(value) {
  return Math.round(value * 1000) / 1000;
}

function residualStreetKey(street) {
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

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
