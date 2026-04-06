import { tryAddRoad } from '../incremental/roadTransaction.js';
import { pointInPolygon } from '../../core/math.js';
import {
  FrontageSpan,
  PlannedRoad,
  ResidualArea,
  ReservationLayout,
  ReservationParcel,
} from './microReservationModel.js';
import {
  arcLengths,
  buildBoundaryClaimsResidualPolygon,
  buildBoundaryAttachedResidualPolygon,
  buildAttachedBoundaryStrip,
  buildPerpendicularCutLine,
  buildPerpendicularStrip,
  buildRegularizedAttachedBoundaryQuad,
  dedupePolyline,
  ensureClosedPolyline,
  offsetPolylineWithHint,
  orientedRectanglePolygon,
  polygonArea,
  polygonCentroid,
  polygonEdgeMidpoints,
  polylineLength,
  projectPointOntoPolyline,
  sampleAtDistance,
  sliceClosedPolylineBetween,
  smoothPolylineChaikin,
  splitDistanceRange,
  subdivideDistanceRange,
  trimPolylineEnds,
} from './geometryPrimitives.js';

export function createVectorFrontageParams(cellSize, overrides = {}) {
  return {
    minAnchorRunCells: 8,
    maxFrontageSpans: 1,
    frontageSmoothingIterations: 2,
    frontageEndTrimMeters: 4 * cellSize,
    minFrontageLengthMeters: 18 * cellSize,
    serviceRoadOffsetMeters: 4 * cellSize,
    accessSpacingMeters: 28 * cellSize,
    accessGapWidthMeters: 4 * cellSize,
    targetParcelFrontageMeters: 7 * cellSize,
    minParcelFrontageMeters: 3.5 * cellSize,
    samplingSpacingMeters: cellSize,
    parkMinLengthMeters: 10 * cellSize,
    parkMaxLengthMeters: 18 * cellSize,
    parkMinDepthMeters: 8 * cellSize,
    parkMaxDepthMeters: 14 * cellSize,
    parkSetbackMeters: 8 * cellSize,
    parkRoadOffsetMeters: 2 * cellSize,
    parkSearchSamples: 10,
    parkRoadWidthMeters: 8,
    parkTerraceDepthMeters: 2.5 * cellSize,
    guideSpacingMeters: 70,
    ...overrides,
  };
}

export function analyzeVectorFrontageSector({ sector, roadGrid, width, height, map, params }) {
  const anchorAnalysis = buildAnchorAnalysis(sector, roadGrid, width, height, params);
  const layout = new ReservationLayout({
    kind: 'clean-vector-frontage',
    meta: {
      strategy: 'vector-frontage-baseline',
      depthMeters: roundNumber(params.serviceRoadOffsetMeters),
      accessSpacingMeters: roundNumber(params.accessSpacingMeters),
      parcelFrontageMeters: roundNumber(params.targetParcelFrontageMeters),
    },
  });
  const gapMarkers = [];

  const preparedRuns = anchorAnalysis.anchorRuns
    .map(run => {
      const rawFrontage = dedupePolyline(run.sortedCells.map(cell => ({
        x: map.originX + cell.gx * map.cellSize,
        z: map.originZ + cell.gz * map.cellSize,
      })));
      if (rawFrontage.length < 2) return null;

      const smoothedFrontage = smoothPolylineChaikin(rawFrontage, params.frontageSmoothingIterations);
      const frontage = trimPolylineEnds(
        smoothedFrontage,
        params.frontageEndTrimMeters,
        params.frontageEndTrimMeters,
        params.samplingSpacingMeters,
      );
      if (frontage.length < 2) return null;

      const frontageLength = polylineLength(frontage);
      if (frontageLength < params.minFrontageLengthMeters) return null;
      return {
        run,
        frontage,
        frontageLength,
        inwardHint: { x: run.inward.x, z: run.inward.z },
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.frontageLength - a.frontageLength)
    .slice(0, Math.max(1, params.maxFrontageSpans));

  for (const prepared of preparedRuns) {
    const { run, frontage, frontageLength, inwardHint } = prepared;
    const serviceCenterline = offsetPolylineWithHint(frontage, params.serviceRoadOffsetMeters, inwardHint);
    if (serviceCenterline.length < 2) continue;

    const serviceRoad = layout.addRoad(new PlannedRoad({
      kind: 'service-road',
      centerline: serviceCenterline,
      width: 8,
      meta: {
        source: 'clean-vector-frontage',
        anchorRunCells: run.sortedCells.length,
      },
    }));

    const gapDistances = buildGapDistances(frontageLength, params.accessSpacingMeters);
    const span = layout.addFrontageSpan(new FrontageSpan({
      frontage,
      inward: inwardHint,
      depth: params.serviceRoadOffsetMeters,
      serviceRoadId: serviceRoad.id,
      gapDistances,
      meta: {
        anchorRunCells: run.sortedCells.length,
        frontageLength: roundNumber(frontageLength),
      },
    }));

    const cutRanges = [];
    const gapHalfWidth = params.accessGapWidthMeters * 0.5;
    for (const gapDistance of gapDistances) {
      const from = Math.max(0, gapDistance - gapHalfWidth);
      const to = Math.min(frontageLength, gapDistance + gapHalfWidth);
      if (to - from > params.samplingSpacingMeters * 0.5) {
        cutRanges.push({ from, to });
      }

      const stub = buildPerpendicularCutLine(frontage, gapDistance, params.serviceRoadOffsetMeters, inwardHint);
      if (stub.length >= 2) {
        gapMarkers.push(stub[0]);
        layout.addRoad(new PlannedRoad({
          kind: 'stub-road',
          centerline: stub,
          width: 6,
          meta: {
            source: 'clean-vector-frontage-gap',
            parentSpanId: span.id,
          },
        }));
      }
    }

    const frontageSegments = splitDistanceRange(
      0,
      frontageLength,
      cutRanges,
      params.minParcelFrontageMeters,
    );
    for (const frontageSegment of frontageSegments) {
      const parcelSegments = subdivideDistanceRange(
        frontageSegment.from,
        frontageSegment.to,
        params.targetParcelFrontageMeters,
        params.minParcelFrontageMeters,
      );
      for (const parcelSegment of parcelSegments) {
        const strip = buildPerpendicularStrip(
          frontage,
          parcelSegment.from,
          parcelSegment.to,
          params.serviceRoadOffsetMeters,
          inwardHint,
          params.samplingSpacingMeters,
        );
        if (!strip) continue;
        const segmentLength = polylineLength(strip.frontage);
        if (segmentLength < params.minParcelFrontageMeters) continue;
        layout.addParcel(new ReservationParcel({
          kind: 'commercial-frontage-strip',
          polygon: strip.polygon,
          frontageSpanId: span.id,
          meta: {
            frontageLength: roundNumber(segmentLength),
            depth: roundNumber(params.serviceRoadOffsetMeters),
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

export function analyzeVectorFrontageSectorWithPark({ sector, roadGrid, width, height, map, waterMask, params }) {
  const base = analyzeVectorFrontageSector({ sector, roadGrid, width, height, map, params });
  base.layout.kind = 'clean-vector-frontage-civic';
  base.layout.meta.strategy = 'vector-frontage-with-central-park';
  const parkInsertion = planCentralParkInsertion({
    sector,
    roadGrid,
    width,
    map,
    waterMask,
    layout: base.layout,
    params,
  });
  return {
    ...base,
    park: parkInsertion,
  };
}

export function analyzeVectorBoundaryParkResidualCommercialSector({ sector, roadGrid, width, height, map, waterMask, params, mode = 'regularized-quad' }) {
  const base = analyzeVectorBoundaryParkSector({
    sector,
    roadGrid,
    width,
    height,
    map,
    waterMask,
    params,
    mode,
  });
  base.layout.kind = 'clean-boundary-park-commercial';
  base.layout.meta.strategy = 'boundary-attached-park-with-commercial-edge';

  const park = base.park;
  if (!park?.frontageGuide?.length || !park.frontageRange || !Array.isArray(sector.boundary) || sector.boundary.length < 3) {
    return {
      ...base,
      residualAreas: [],
    };
  }

  const total = polylineLength(park.frontageGuide);
  const remaining = splitDistanceRange(
    0,
    total,
    [{ from: park.frontageRange.from, to: park.frontageRange.to }],
    params.minFrontageLengthMeters,
  );

  const claims = [{
    replacementPath: [park.frontEdge[0], park.rearEdge[0], park.rearEdge[1], park.frontEdge[1]],
    kind: 'park',
  }];

  for (const segment of remaining) {
    const frontageSegment = trimSlice(
      park.frontageGuide,
      segment.from,
      segment.to,
      params.samplingSpacingMeters,
    );
    if (frontageSegment.length < 2 || polylineLength(frontageSegment) < params.minFrontageLengthMeters) continue;
    const commercial = addCommercialFrontageStrip({
      layout: base.layout,
      frontage: frontageSegment,
      inwardHint: park.inwardHint,
      params,
      anchorRunCells: park.anchorRunCells,
    });
    if (!commercial) continue;
    claims.push({
      replacementPath: [
        frontageSegment[0],
        ...commercial.serviceRoad.centerline,
        frontageSegment[frontageSegment.length - 1],
      ],
      kind: 'commercial',
    });
  }

  const residualPolygon = buildBoundaryClaimsResidualPolygon(
    sector.boundary,
    claims,
    params.samplingSpacingMeters,
  );
  if (!residualPolygon || polygonArea(residualPolygon) < map.cellSize * map.cellSize * 80) {
    return {
      ...base,
      residualAreas: [],
    };
  }

  const residualArea = base.layout.addResidualArea(new ResidualArea({
    polygon: residualPolygon,
    meta: {
      source: 'boundary-attached-park-commercial',
      strategy: 'claims-replaced-boundary-residual',
    },
  }));

  return {
    ...base,
    residualAreas: [residualArea],
  };
}

export function analyzeVectorBoundaryParkCommercialTerraceSector({ sector, roadGrid, width, height, map, waterMask, params, mode = 'regularized-quad' }) {
  const base = analyzeVectorBoundaryParkSector({
    sector,
    roadGrid,
    width,
    height,
    map,
    waterMask,
    params,
    mode,
  });
  base.layout.kind = 'clean-boundary-park-commercial-terrace';
  base.layout.meta.strategy = 'boundary-attached-park-one-commercial-plus-terraces';

  const park = base.park;
  if (!park?.frontageGuide?.length || !park.frontageRange || !Array.isArray(sector.boundary) || sector.boundary.length < 3) {
    return {
      ...base,
      residualAreas: [],
    };
  }

  const total = polylineLength(park.frontageGuide);
  const remainingSegments = splitDistanceRange(
    0,
    total,
    [{ from: park.frontageRange.from, to: park.frontageRange.to }],
    params.minFrontageLengthMeters,
  ).sort((a, b) => (b.to - b.from) - (a.to - a.from));

  const claims = [];
  let parkReplacementPath = [park.frontEdge[0], park.rearEdge[0], park.rearEdge[1], park.frontEdge[1]];

  const terraces = addParkTerraceBands({
    layout: base.layout,
    park,
    sector,
    roadGrid,
    width,
    map,
    waterMask,
    params,
  });
  if (terraces?.notchPath?.length >= 4) {
    parkReplacementPath = terraces.notchPath;
  }

  claims.push({
    replacementPath: parkReplacementPath,
    kind: 'park',
  });

  const primaryCommercial = remainingSegments[0] || null;
  if (primaryCommercial) {
    const frontageSegment = trimSlice(
      park.frontageGuide,
      primaryCommercial.from,
      primaryCommercial.to,
      params.samplingSpacingMeters,
    );
    if (frontageSegment.length >= 2 && polylineLength(frontageSegment) >= params.minFrontageLengthMeters) {
      const commercial = addCommercialFrontageStrip({
        layout: base.layout,
        frontage: frontageSegment,
        inwardHint: park.inwardHint,
        params,
        anchorRunCells: park.anchorRunCells,
      });
      if (commercial) {
        claims.push({
          replacementPath: [
            frontageSegment[0],
            ...commercial.serviceRoad.centerline,
            frontageSegment[frontageSegment.length - 1],
          ],
          kind: 'commercial',
        });
      }
    }
  }

  const residualPolygon = buildBoundaryClaimsResidualPolygon(
    sector.boundary,
    claims,
    params.samplingSpacingMeters,
  );
  if (!residualPolygon || polygonArea(residualPolygon) < map.cellSize * map.cellSize * 80) {
    return {
      ...base,
      residualAreas: [],
    };
  }

  const residualArea = base.layout.addResidualArea(new ResidualArea({
    polygon: residualPolygon,
    meta: {
      source: 'boundary-attached-park-commercial-terrace',
      strategy: 'single-commercial-span-plus-park-terraces',
    },
  }));

  return {
    ...base,
    residualAreas: [residualArea],
  };
}

export function analyzeVectorBoundaryParkCommercialTerraceGuidedSector({ sector, roadGrid, width, height, map, waterMask, params }) {
  const base = analyzeVectorBoundaryParkSector({
    sector,
    roadGrid,
    width,
    height,
    map,
    waterMask,
    params,
    mode: 'guided-quad',
  });
  base.layout.kind = 'clean-boundary-park-commercial-terrace-guided';
  base.layout.meta.strategy = 'boundary-attached-park-guide-aligned-commercial-terraces';

  const park = base.park;
  if (!park?.frontageGuide?.length || !park.frontageRange || !Array.isArray(sector.boundary) || sector.boundary.length < 3) {
    return {
      ...base,
      guideLattice: park?.guideLattice || null,
      residualAreas: [],
    };
  }

  const total = polylineLength(park.frontageGuide);
  const remainingSegments = splitDistanceRange(
    0,
    total,
    [{ from: park.frontageRange.from, to: park.frontageRange.to }],
    params.minFrontageLengthMeters,
  ).sort((a, b) => (b.to - b.from) - (a.to - a.from));

  const claims = [];
  let parkReplacementPath = [park.frontEdge[0], park.rearEdge[0], park.rearEdge[1], park.frontEdge[1]];

  const terraces = addParkTerraceBands({
    layout: base.layout,
    park,
    sector,
    roadGrid,
    width,
    map,
    waterMask,
    params,
  });
  if (terraces?.notchPath?.length >= 4) {
    parkReplacementPath = terraces.notchPath;
  }

  claims.push({
    replacementPath: parkReplacementPath,
    kind: 'park',
  });

  const guideIntersections = projectGuideOffsetsToPolyline(park.frontageGuide, park.guideLattice);
  let alignedCommercialRange = null;
  for (const segment of remainingSegments) {
    alignedCommercialRange = alignSegmentToGuideIntersections(
      guideIntersections,
      segment.from,
      segment.to,
      params.minFrontageLengthMeters,
    );
    if (alignedCommercialRange) break;
  }

  const primaryCommercial = alignedCommercialRange
    ? alignedCommercialRange
    : (remainingSegments[0] || null);
  if (primaryCommercial) {
    const frontageSegment = trimSlice(
      park.frontageGuide,
      primaryCommercial.from,
      primaryCommercial.to,
      params.samplingSpacingMeters,
    );
    if (frontageSegment.length >= 2 && polylineLength(frontageSegment) >= params.minFrontageLengthMeters) {
      const commercial = addCommercialFrontageStrip({
        layout: base.layout,
        frontage: frontageSegment,
        inwardHint: park.inwardHint,
        params,
        anchorRunCells: park.anchorRunCells,
      });
      if (commercial) {
        claims.push({
          replacementPath: [
            frontageSegment[0],
            ...commercial.serviceRoad.centerline,
            frontageSegment[frontageSegment.length - 1],
          ],
          kind: 'commercial',
        });
      }
    }
  }

  const residualPolygon = buildBoundaryClaimsResidualPolygon(
    sector.boundary,
    claims,
    params.samplingSpacingMeters,
  );
  if (!residualPolygon || polygonArea(residualPolygon) < map.cellSize * map.cellSize * 80) {
    return {
      ...base,
      guideLattice: park.guideLattice || null,
      residualAreas: [],
    };
  }

  const residualArea = base.layout.addResidualArea(new ResidualArea({
    polygon: residualPolygon,
    meta: {
      source: 'boundary-attached-park-commercial-terrace-guided',
      strategy: 'guide-aligned-park-and-commercial-plus-park-terraces',
    },
  }));

  return {
    ...base,
    guideLattice: park.guideLattice || null,
    residualAreas: [residualArea],
  };
}

export function analyzeVectorBoundaryParkSector({ sector, roadGrid, width, height, map, waterMask, params, mode = 'strip' }) {
  const anchorAnalysis = buildAnchorAnalysis(sector, roadGrid, width, height, params);
  const layout = new ReservationLayout({
    kind: 'clean-boundary-park',
    meta: {
      strategy: 'boundary-attached-park',
    },
  });

  const preparedRuns = anchorAnalysis.anchorRuns
    .map(run => {
      const rawFrontage = dedupePolyline(run.sortedCells.map(cell => ({
        x: map.originX + cell.gx * map.cellSize,
        z: map.originZ + cell.gz * map.cellSize,
      })));
      if (rawFrontage.length < 2) return null;
      const smoothedFrontage = smoothPolylineChaikin(rawFrontage, params.frontageSmoothingIterations);
      const frontage = trimPolylineEnds(
        smoothedFrontage,
        params.frontageEndTrimMeters,
        params.frontageEndTrimMeters,
        params.samplingSpacingMeters,
      );
      if (frontage.length < 2) return null;
      const frontageLength = polylineLength(frontage);
      if (frontageLength < params.minFrontageLengthMeters) return null;
      return {
        run,
        frontage,
        frontageLength,
        inwardHint: { x: run.inward.x, z: run.inward.z },
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.frontageLength - a.frontageLength);

  const dominant = preparedRuns[0] || null;
  if (!dominant) {
    return {
      anchorCellCount: anchorAnalysis.anchorCells.length,
      anchorCells: anchorAnalysis.anchorCells,
      anchorRuns: anchorAnalysis.anchorRuns,
      layout,
      gapMarkers: [],
      park: null,
    };
  }

  const parkPlacement = planBoundaryAttachedPark({
    dominant,
    sector,
    roadGrid,
    width,
    map,
    waterMask,
    layout,
    params,
    mode,
  });

  return {
    anchorCellCount: anchorAnalysis.anchorCells.length,
    anchorCells: anchorAnalysis.anchorCells,
    anchorRuns: anchorAnalysis.anchorRuns,
    layout,
    gapMarkers: [],
    park: parkPlacement,
  };
}

export function analyzeVectorBoundaryParkResidualSector({ sector, roadGrid, width, height, map, waterMask, params, mode = 'regularized-quad' }) {
  const base = analyzeVectorBoundaryParkSector({
    sector,
    roadGrid,
    width,
    height,
    map,
    waterMask,
    params,
    mode,
  });
  base.layout.kind = 'clean-boundary-park-residual';
  base.layout.meta.strategy = 'boundary-attached-park-with-residual';

  const parkParcel = base.layout.parcels.find(parcel => parcel.kind === 'civic-park') || null;
  const rearRoad = base.layout.roads.find(road => road.kind === 'park-road' && road.meta?.role === 'rear-edge') || null;
  if (!parkParcel?.polygon || !rearRoad?.centerline || !Array.isArray(sector.boundary) || sector.boundary.length < 3) {
    return {
      ...base,
      residualAreas: [],
    };
  }

  const residualPolygon = buildBoundaryAttachedResidualPolygon(
    sector.boundary,
    [parkParcel.polygon[0], parkParcel.polygon[1]],
    rearRoad.centerline,
    params.samplingSpacingMeters,
  );
  if (!residualPolygon || polygonArea(residualPolygon) < map.cellSize * map.cellSize * 80) {
    return {
      ...base,
      residualAreas: [],
    };
  }

  const residualArea = base.layout.addResidualArea(new ResidualArea({
    polygon: residualPolygon,
    meta: {
      source: 'boundary-attached-park',
      strategy: 'main-complementary-boundary-area',
    },
  }));

  return {
    ...base,
    residualAreas: [residualArea],
  };
}

export function commitVectorFrontageRoads(workingMap, plannedRoads = [], sourcePrefix = 'clean-vector-frontage') {
  const committed = [];
  for (const road of plannedRoads) {
    if (!road?.centerline || road.centerline.length < 2) continue;
    const connectionPoints = Array.isArray(road.meta?.connectPoints)
      ? road.meta.connectPoints
      : (road.meta?.attachPoint ? [road.meta.attachPoint] : []);
    const result = tryAddRoad(workingMap, road.centerline, {
      hierarchy: classifyRoadHierarchy(road.kind),
      source: `${sourcePrefix}-${road.kind}`,
      snapEndpoints: connectionPoints.length === 0,
    });
    if (result.accepted && result.way) {
      for (const connectionPoint of connectionPoints) {
        const targetWay = findNearestWayAtPoint(
          workingMap,
          connectionPoint,
          result.way.id,
          workingMap.cellSize * 4,
        );
        if (targetWay) {
          workingMap.roadNetwork.connectWaysAtPoint(
            result.way.id,
            targetWay.id,
            connectionPoint.x,
            connectionPoint.z,
          );
        }
      }
      committed.push({
        id: road.id,
        type: road.kind,
        wayId: result.way.id,
        junctionPoints: connectionPoints,
      });
    }
  }
  return committed.map(road => {
    const way = workingMap.roadNetwork.getWay(road.wayId);
    return {
      ...road,
      points: (way?.polyline || []).map(point => ({ x: point.x, z: point.z })),
    };
  });
}

function planCentralParkInsertion({ sector, roadGrid, width, map, waterMask, layout, params }) {
  const dominantSpan = layout.frontageSpans[0] || null;
  if (!dominantSpan) return null;
  const serviceRoad = layout.roads.find(road => road.id === dominantSpan.serviceRoadId);
  if (!serviceRoad?.centerline?.length) return null;

  const tangent = normalize2({
    x: serviceRoad.centerline[serviceRoad.centerline.length - 1].x - serviceRoad.centerline[0].x,
    z: serviceRoad.centerline[serviceRoad.centerline.length - 1].z - serviceRoad.centerline[0].z,
  }) || { x: 1, z: 0 };
  const normal = normalize2(dominantSpan.inward) || { x: 0, z: 1 };
  const targetParkLength = clamp(
    polylineLength(dominantSpan.frontage) * 0.28,
    params.parkMinLengthMeters,
    params.parkMaxLengthMeters,
  );

  const sectorSet = new Set(sector.cells.map(cell => cell.gz * width + cell.gx));
  const serviceLengths = arcLengths(serviceRoad.centerline);
  const serviceTotal = serviceLengths[serviceLengths.length - 1] || 0;
  const sectorCentroid = {
    x: map.originX + sector.centroidGx * map.cellSize,
    z: map.originZ + sector.centroidGz * map.cellSize,
  };
  let best = null;

  const sizeScales = [1, 0.85, 0.72];
  for (let i = 0; i < params.parkSearchSamples; i++) {
    const t = params.parkSearchSamples === 1 ? 0.5 : (0.2 + (0.6 * i) / (params.parkSearchSamples - 1));
    const distanceAlong = serviceTotal * t;
    const roadPoint = sampleAtDistance(serviceRoad.centerline, serviceLengths, distanceAlong);
    if (!roadPoint) continue;
    for (const sizeScale of sizeScales) {
      const parkLength = clamp(
        targetParkLength * sizeScale,
        params.parkMinLengthMeters,
        params.parkMaxLengthMeters,
      );
      const parkDepth = clamp(
        parkLength * 0.7,
        params.parkMinDepthMeters,
        params.parkMaxDepthMeters,
      );
      for (const extraSetback of [0, 2 * map.cellSize, 4 * map.cellSize, 6 * map.cellSize, 8 * map.cellSize]) {
        const center = {
          x: roadPoint.x + normal.x * (params.parkSetbackMeters + parkDepth * 0.5 + extraSetback),
          z: roadPoint.z + normal.z * (params.parkSetbackMeters + parkDepth * 0.5 + extraSetback),
        };
        const parkPolygon = orientedRectanglePolygon(center, tangent, normal, parkLength, parkDepth);
        const ringPolygon = orientedRectanglePolygon(
          center,
          tangent,
          normal,
          parkLength + params.parkRoadOffsetMeters * 2,
          parkDepth + params.parkRoadOffsetMeters * 2,
        );
        if (!polygonRegionFits(ringPolygon, {
          sectorSet,
          roadGrid,
          waterMask,
          width,
          cellSize: map.cellSize,
          originX: map.originX,
          originZ: map.originZ,
          blockedPolygons: layout.parcels.map(parcel => parcel.polygon),
          blockedRoads: layout.roads.map(road => road.centerline),
          roadClearanceMeters: map.cellSize * 0.45,
        })) {
          continue;
        }

        const centroidDist = Math.hypot(center.x - sectorCentroid.x, center.z - sectorCentroid.z);
        const score = centroidDist - parkLength * 0.2;
        if (!best || score < best.score) {
          best = { center, parkPolygon, ringPolygon, score, serviceRoad, parkLength, parkDepth };
        }
      }
    }
  }

  if (!best) return null;

  const parkParcel = layout.addParcel(new ReservationParcel({
      kind: 'civic-park',
      polygon: best.parkPolygon,
      meta: {
        length: roundNumber(best.parkLength),
        depth: roundNumber(best.parkDepth),
      },
    }));

  const ringRoads = [];
  for (let i = 0; i < best.ringPolygon.length; i++) {
    const a = best.ringPolygon[i];
    const b = best.ringPolygon[(i + 1) % best.ringPolygon.length];
    ringRoads.push(layout.addRoad(new PlannedRoad({
      kind: 'park-road',
      centerline: [a, b],
      width: params.parkRoadWidthMeters,
      meta: {
        source: 'clean-vector-park-ring',
        parkParcelId: parkParcel.id,
      },
    })));
  }

  const connector = buildParkConnector(best.ringPolygon, best.serviceRoad.centerline, normal);
  let connectorRoad = null;
  if (connector) {
    connectorRoad = layout.addRoad(new PlannedRoad({
      kind: 'park-connector-road',
      centerline: connector,
      width: params.parkRoadWidthMeters,
      meta: {
        source: 'clean-vector-park-connector',
        parkParcelId: parkParcel.id,
      },
    }));
  }

  return {
    parcelId: parkParcel.id,
    polygon: best.parkPolygon,
    ringPolygon: best.ringPolygon,
    ringRoadIds: ringRoads.map(road => road.id),
    connectorRoadId: connectorRoad?.id ?? null,
  };
}

function planBoundaryAttachedPark({ dominant, sector, roadGrid, width, map, waterMask, layout, params, mode = 'strip' }) {
  const { frontage, frontageLength, inwardHint, run } = dominant;
  const boundaryGuide = buildBoundaryFrontageGuide(sector.boundary || [], frontage, params.samplingSpacingMeters);
  const baseFrontage = boundaryGuide?.length >= 2 ? boundaryGuide : frontage;
  const baseLengths = arcLengths(baseFrontage);
  const baseTotalLength = baseLengths[baseLengths.length - 1] || frontageLength;
  const targetLength = clamp(
    baseTotalLength * 0.34,
    params.parkMinLengthMeters,
    params.parkMaxLengthMeters * 1.25,
  );
  const sizeScales = [1, 0.85, 0.72];
  const offsetFactors = [0.5, 0.38, 0.62];
  const sectorSet = new Set(sector.cells.map(cell => cell.gz * width + cell.gx));
  const guideLattice = mode === 'guided-quad'
    ? buildSectorGuideLattice(sector, map, params.guideSpacingMeters)
    : null;
  const guideIntersections = guideLattice
    ? projectGuideOffsetsToPolyline(baseFrontage, guideLattice)
    : [];
  let best = null;

  if (mode === 'guided-quad' && guideIntersections.length >= 2) {
    for (let i = 0; i < guideIntersections.length - 1; i++) {
      for (let j = i + 1; j < guideIntersections.length; j++) {
        const from = guideIntersections[i].distanceAlong;
        const to = guideIntersections[j].distanceAlong;
        const parkLength = to - from;
        if (parkLength < params.parkMinLengthMeters || parkLength > params.parkMaxLengthMeters * 1.25) continue;
        const parkDepth = clamp(
          parkLength * 0.75,
          params.parkMinDepthMeters,
          params.parkMaxDepthMeters * 1.15,
        );
        const frontageSlice = trimSlice(baseFrontage, from, to, params.samplingSpacingMeters);
        const shape = buildRegularizedAttachedBoundaryQuad(frontageSlice, parkDepth, inwardHint);
        if (!shape) continue;
        const sliceLength = polylineLength(frontageSlice);
        const chordLength = frontageSlice.length >= 2
          ? Math.hypot(
            frontageSlice[frontageSlice.length - 1].x - frontageSlice[0].x,
            frontageSlice[frontageSlice.length - 1].z - frontageSlice[0].z,
          )
          : 0;
        const straightness = sliceLength <= 1e-6 ? 0 : chordLength / sliceLength;
        if (straightness < 0.8) continue;
        if (!polygonRegionFits(shape.polygon, {
          sectorSet,
          roadGrid,
          waterMask,
          width,
          cellSize: map.cellSize,
          originX: map.originX,
          originZ: map.originZ,
          blockedPolygons: [],
          blockedRoads: [],
          roadClearanceMeters: 0,
        })) {
          continue;
        }
        const centerPoint = sampleAtDistance(baseFrontage, baseLengths, (from + to) * 0.5);
        const sectorCentroid = {
          x: map.originX + sector.centroidGx * map.cellSize,
          z: map.originZ + sector.centroidGz * map.cellSize,
        };
        const score =
          Math.hypot(centerPoint.x - sectorCentroid.x, centerPoint.z - sectorCentroid.z)
          - parkLength * 0.18
          + (1 - straightness) * 220
          + Math.abs(parkLength - targetLength) * 0.12;
        if (!best || score < best.score) {
          best = {
            score,
            parkLength,
            parkDepth,
            shape,
            straightness,
            from,
            to,
          };
        }
      }
    }
  }

  if (!best) {
    for (const sizeScale of sizeScales) {
      const parkLength = Math.min(baseTotalLength, targetLength * sizeScale);
      const parkDepth = clamp(
        parkLength * 0.75,
        params.parkMinDepthMeters,
        params.parkMaxDepthMeters * 1.15,
      );
      for (const centerFactor of offsetFactors) {
        const centerDistance = baseTotalLength * centerFactor;
        const from = clamp(centerDistance - parkLength * 0.5, 0, baseTotalLength - parkLength);
        const to = from + parkLength;
        const frontageSlice = trimSlice(baseFrontage, from, to, params.samplingSpacingMeters);
        const sliceLength = polylineLength(frontageSlice);
        const chordLength = frontageSlice.length >= 2
          ? Math.hypot(
            frontageSlice[frontageSlice.length - 1].x - frontageSlice[0].x,
            frontageSlice[frontageSlice.length - 1].z - frontageSlice[0].z,
          )
          : 0;
        const straightness = sliceLength <= 1e-6 ? 0 : chordLength / sliceLength;
        if (straightness < 0.8) continue;
        const shape = mode === 'regularized-quad' || mode === 'guided-quad'
          ? buildRegularizedAttachedBoundaryQuad(frontageSlice, parkDepth, inwardHint)
          : buildAttachedBoundaryStrip(frontageSlice, parkDepth, inwardHint, params.samplingSpacingMeters);
        if (!shape) continue;

        if (!polygonRegionFits(shape.polygon, {
          sectorSet,
          roadGrid,
          waterMask,
          width,
          cellSize: map.cellSize,
          originX: map.originX,
          originZ: map.originZ,
          blockedPolygons: [],
          blockedRoads: [],
          roadClearanceMeters: 0,
        })) {
          continue;
        }

        const centerPoint = sampleAtDistance(baseFrontage, baseLengths, (from + to) * 0.5);
        const sectorCentroid = {
          x: map.originX + sector.centroidGx * map.cellSize,
          z: map.originZ + sector.centroidGz * map.cellSize,
        };
        const score =
          Math.hypot(centerPoint.x - sectorCentroid.x, centerPoint.z - sectorCentroid.z)
          - parkLength * 0.15
          + (1 - straightness) * 220;
        if (!best || score < best.score) {
          best = {
            score,
            parkLength,
            parkDepth,
            shape,
            straightness,
            from,
            to,
          };
        }
      }
    }
  }

  if (!best) return null;

  const span = layout.addFrontageSpan(new FrontageSpan({
    frontage: best.shape.frontEdge,
    inward: inwardHint,
    depth: best.parkDepth,
    serviceRoadId: null,
    gapDistances: [],
    meta: {
      use: 'boundary-park-frontage',
      anchorRunCells: run.sortedCells.length,
      straightness: roundNumber(best.straightness),
      mode,
    },
  }));

  const parkParcel = layout.addParcel(new ReservationParcel({
    kind: 'civic-park',
    polygon: best.shape.polygon,
    frontageSpanId: span.id,
    meta: {
      attachedToBoundary: true,
      length: roundNumber(best.parkLength),
      depth: roundNumber(best.parkDepth),
      straightness: roundNumber(best.straightness),
      mode,
    },
  }));

  const plannedRoads = [];
  plannedRoads.push(layout.addRoad(new PlannedRoad({
    kind: 'park-road',
    centerline: best.shape.rearEdge,
    width: params.parkRoadWidthMeters,
    meta: {
      source: 'boundary-attached-park',
      parkParcelId: parkParcel.id,
      role: 'rear-edge',
    },
  })));
  plannedRoads.push(layout.addRoad(new PlannedRoad({
    kind: 'park-road',
    centerline: best.shape.sideEdges[0],
    width: params.parkRoadWidthMeters,
    meta: {
      source: 'boundary-attached-park',
      parkParcelId: parkParcel.id,
      role: 'side-edge',
      connectPoints: [best.shape.frontEdge[0], best.shape.rearEdge[0]],
    },
  })));
  plannedRoads.push(layout.addRoad(new PlannedRoad({
    kind: 'park-road',
    centerline: best.shape.sideEdges[1],
    width: params.parkRoadWidthMeters,
    meta: {
      source: 'boundary-attached-park',
      parkParcelId: parkParcel.id,
      role: 'side-edge',
      connectPoints: [best.shape.frontEdge[1], best.shape.rearEdge[1]],
    },
  })));

  return {
    parcelId: parkParcel.id,
    polygon: best.shape.polygon,
    frontEdge: best.shape.frontEdge,
    rearEdge: best.shape.rearEdge,
    sideEdges: best.shape.sideEdges,
    ringPolygon: null,
    ringRoadIds: plannedRoads.map(road => road.id),
    connectorRoadId: null,
    attached: true,
    mode,
    straightness: roundNumber(best.straightness),
    anchorRunCells: run.sortedCells.length,
    inwardHint,
    frontageGuide: baseFrontage,
    guideLattice,
    guideIntersections,
    frontageRange: {
      from: roundNumber(best.from),
      to: roundNumber(best.to),
    },
  };
}

function buildBoundaryFrontageGuide(boundary, guideFrontage, spacing) {
  if (!Array.isArray(boundary) || boundary.length < 2 || !Array.isArray(guideFrontage) || guideFrontage.length < 2) {
    return null;
  }
  const closedBoundary = ensureClosedPolyline(boundary);
  const startProjection = projectPointOntoPolyline(guideFrontage[0], closedBoundary);
  const endProjection = projectPointOntoPolyline(guideFrontage[guideFrontage.length - 1], closedBoundary);
  if (!startProjection || !endProjection) return null;
  return sliceClosedPolylineBetween(
    closedBoundary,
    startProjection.distanceAlong,
    endProjection.distanceAlong,
    spacing,
  );
}

function findNearestWayAtPoint(map, point, excludedWayId = null, maxDist = 20) {
  if (!map?.roadNetwork || !point) return null;
  let best = null;
  let bestDist = maxDist;
  for (const way of map.roadNetwork.ways) {
    if (way.id === excludedWayId) continue;
    const projection = projectPointOntoPolyline(point, way.polyline);
    if (!projection) continue;
    const dist = Math.hypot(projection.x - point.x, projection.z - point.z);
    if (dist <= bestDist) {
      bestDist = dist;
      best = way;
    }
  }
  return best;
}

function trimSlice(polyline, from, to, spacing) {
  if (!Array.isArray(polyline) || polyline.length < 2) return [];
  const lengths = arcLengths(polyline);
  const total = lengths[lengths.length - 1];
  if (total <= 1e-6) return [];
  const start = clamp(from, 0, total);
  const end = clamp(to, 0, total);
  if (end - start <= 1e-6) return [];
  const points = [];
  for (let d = start; d <= end + 1e-6; d += Math.max(1e-6, spacing)) {
    points.push(sampleAtDistance(polyline, lengths, Math.min(d, end)));
    if (Math.min(d, end) === end) break;
  }
  return dedupePolyline(points);
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
      anchorInfo.set(cell.gz * width + cell.gx, { roadNeighbors });
    }
  }

  return {
    sectorSet,
    anchorCells,
    anchorRuns: buildAnchorRuns(anchorCells, anchorInfo, width, params),
  };
}

function buildAnchorRuns(anchorCells, anchorInfo, width, params) {
  const cellMap = new Map(anchorCells.map(cell => [cell.gz * width + cell.gx, cell]));
  const seen = new Set();
  const runs = [];

  for (const cell of anchorCells) {
    const startKey = cell.gz * width + cell.gx;
    if (seen.has(startKey)) continue;
    const stack = [cell];
    seen.add(startKey);
    const cells = [];
    while (stack.length > 0) {
      const current = stack.pop();
      cells.push(current);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const nx = current.gx + dx;
        const nz = current.gz + dz;
        const key = nz * width + nx;
        if (seen.has(key) || !cellMap.has(key)) continue;
        seen.add(key);
        stack.push(cellMap.get(key));
      }
    }

    if (cells.length < params.minAnchorRunCells) continue;
    const tangent = principalDirection(cells);
    const inward = averageInwardNormal(cells, anchorInfo, width);
    if (!tangent || !inward) continue;

    const sortedCells = cells
      .map(entry => ({
        cell: entry,
        projection: entry.gx * tangent.x + entry.gz * tangent.z,
      }))
      .sort((a, b) => a.projection - b.projection)
      .map(entry => entry.cell);

    runs.push({
      cells,
      sortedCells,
      tangent,
      inward,
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
    for (const neighbor of record?.roadNeighbors || []) {
      sumX += cell.gx - neighbor.gx;
      sumZ += cell.gz - neighbor.gz;
    }
  }
  return normalize2({ x: sumX, z: sumZ });
}

function buildGapDistances(totalLength, spacing) {
  const gapDistances = [];
  if (totalLength < spacing * 0.8) return gapDistances;
  for (let center = spacing * 0.5; center < totalLength; center += spacing) {
    gapDistances.push(center);
  }
  return gapDistances;
}

function buildSectorGuideLattice(sector, map, spacing) {
  const gradDir = normalize2(sector?.slopeDir || { x: 1, z: 0 }) || { x: 1, z: 0 };
  const contourDir = { x: -gradDir.z, z: gradDir.x };
  const origin = {
    x: map.originX + sector.centroidGx * map.cellSize,
    z: map.originZ + sector.centroidGz * map.cellSize,
  };
  const boundary = Array.isArray(sector.boundary) && sector.boundary.length >= 2
    ? sector.boundary
    : [];
  let minCt = Infinity;
  let maxCt = -Infinity;
  let minGd = Infinity;
  let maxGd = -Infinity;
  for (const point of boundary) {
    const dx = point.x - origin.x;
    const dz = point.z - origin.z;
    const ct = dx * contourDir.x + dz * contourDir.z;
    const gd = dx * gradDir.x + dz * gradDir.z;
    if (ct < minCt) minCt = ct;
    if (ct > maxCt) maxCt = ct;
    if (gd < minGd) minGd = gd;
    if (gd > maxGd) maxGd = gd;
  }
  if (!Number.isFinite(minCt) || !Number.isFinite(maxCt)) return null;
  const offsets = [];
  const firstCt = Math.ceil(minCt / spacing) * spacing;
  for (let ct = firstCt; ct <= maxCt + 1e-6; ct += spacing) {
    offsets.push(roundNumber(ct));
  }
  if (offsets.length < 2) {
    offsets.push(roundNumber(minCt), roundNumber(maxCt));
  }
  const lineExtent = Math.max(Math.abs(minGd), Math.abs(maxGd)) + spacing * 2;
  const lines = offsets.map(ct => {
    const center = {
      x: origin.x + contourDir.x * ct,
      z: origin.z + contourDir.z * ct,
    };
    return [
      {
        x: center.x - gradDir.x * lineExtent,
        z: center.z - gradDir.z * lineExtent,
      },
      {
        x: center.x + gradDir.x * lineExtent,
        z: center.z + gradDir.z * lineExtent,
      },
    ];
  });
  return {
    origin,
    gradDir,
    contourDir,
    spacing,
    phaseOffset: 0,
    offsets,
    lines,
  };
}

function projectGuideOffsetsToPolyline(polyline, lattice) {
  if (!lattice || !Array.isArray(polyline) || polyline.length < 2) return [];
  const origin = lattice.origin;
  const contourDir = lattice.contourDir;
  const intersections = [];
  let travelled = 0;
  for (let i = 1; i < polyline.length; i++) {
    const a = polyline[i - 1];
    const b = polyline[i];
    const segLength = Math.hypot(b.x - a.x, b.z - a.z);
    const act = (a.x - origin.x) * contourDir.x + (a.z - origin.z) * contourDir.z;
    const bct = (b.x - origin.x) * contourDir.x + (b.z - origin.z) * contourDir.z;
    const minCt = Math.min(act, bct);
    const maxCt = Math.max(act, bct);
    const deltaCt = bct - act;
    if (Math.abs(deltaCt) <= 1e-6) {
      travelled += segLength;
      continue;
    }
    for (const offset of lattice.offsets || []) {
      if (offset < minCt - 1e-6 || offset > maxCt + 1e-6) continue;
      const t = (offset - act) / deltaCt;
      if (t < -1e-6 || t > 1 + 1e-6) continue;
      const clampedT = clamp(t, 0, 1);
      intersections.push({
        ctOffset: offset,
        distanceAlong: travelled + segLength * clampedT,
        point: {
          x: a.x + (b.x - a.x) * clampedT,
          z: a.z + (b.z - a.z) * clampedT,
        },
      });
    }
    travelled += segLength;
  }
  intersections.sort((a, b) => a.distanceAlong - b.distanceAlong);
  const deduped = [];
  for (const entry of intersections) {
    const last = deduped[deduped.length - 1];
    if (last && Math.abs(last.distanceAlong - entry.distanceAlong) < 1) continue;
    deduped.push(entry);
  }
  return deduped;
}

function alignSegmentToGuideIntersections(intersections, from, to, minLength) {
  const inside = intersections.filter(entry => entry.distanceAlong >= from - 1e-6 && entry.distanceAlong <= to + 1e-6);
  if (inside.length < 2) return null;
  let best = null;
  for (let i = 0; i < inside.length - 1; i++) {
    for (let j = i + 1; j < inside.length; j++) {
      const length = inside[j].distanceAlong - inside[i].distanceAlong;
      if (length < minLength) continue;
      if (!best || length > best.length) {
        best = {
          from: inside[i].distanceAlong,
          to: inside[j].distanceAlong,
          length,
        };
      }
    }
  }
  return best;
}

function addCommercialFrontageStrip({ layout, frontage, inwardHint, params, anchorRunCells = null }) {
  const frontageLength = polylineLength(frontage);
  if (!frontage?.length || frontageLength < params.minFrontageLengthMeters) return null;

  const serviceCenterline = offsetPolylineWithHint(frontage, params.serviceRoadOffsetMeters, inwardHint);
  if (serviceCenterline.length < 2) return null;

  const serviceRoad = layout.addRoad(new PlannedRoad({
    kind: 'service-road',
    centerline: serviceCenterline,
    width: 8,
    meta: {
      source: 'boundary-commercial-residual',
      anchorRunCells,
    },
  }));

  const gapDistances = buildGapDistances(frontageLength, params.accessSpacingMeters);
  const span = layout.addFrontageSpan(new FrontageSpan({
    frontage,
    inward: inwardHint,
    depth: params.serviceRoadOffsetMeters,
    serviceRoadId: serviceRoad.id,
    gapDistances,
    meta: {
      anchorRunCells,
      frontageLength: roundNumber(frontageLength),
      use: 'commercial-frontage',
    },
  }));

  const cutRanges = [];
  const gapHalfWidth = params.accessGapWidthMeters * 0.5;
  for (const gapDistance of gapDistances) {
    const from = Math.max(0, gapDistance - gapHalfWidth);
    const to = Math.min(frontageLength, gapDistance + gapHalfWidth);
    if (to - from > params.samplingSpacingMeters * 0.5) {
      cutRanges.push({ from, to });
    }

    const stub = buildPerpendicularCutLine(frontage, gapDistance, params.serviceRoadOffsetMeters, inwardHint);
    if (stub.length >= 2) {
      layout.addRoad(new PlannedRoad({
        kind: 'stub-road',
        centerline: stub,
        width: 6,
        meta: {
          source: 'boundary-commercial-gap',
          parentSpanId: span.id,
        },
      }));
    }
  }

  const frontageSegments = splitDistanceRange(
    0,
    frontageLength,
    cutRanges,
    params.minParcelFrontageMeters,
  );
  for (const frontageSegment of frontageSegments) {
    const parcelSegments = subdivideDistanceRange(
      frontageSegment.from,
      frontageSegment.to,
      params.targetParcelFrontageMeters,
      params.minParcelFrontageMeters,
    );
    for (const parcelSegment of parcelSegments) {
      const strip = buildPerpendicularStrip(
        frontage,
        parcelSegment.from,
        parcelSegment.to,
        params.serviceRoadOffsetMeters,
        inwardHint,
        params.samplingSpacingMeters,
      );
      if (!strip) continue;
      const segmentLength = polylineLength(strip.frontage);
      if (segmentLength < params.minParcelFrontageMeters) continue;
      layout.addParcel(new ReservationParcel({
        kind: 'commercial-frontage-strip',
        polygon: strip.polygon,
        frontageSpanId: span.id,
        meta: {
          frontageLength: roundNumber(segmentLength),
          depth: roundNumber(params.serviceRoadOffsetMeters),
        },
      }));
    }
  }

  return {
    span,
    serviceRoad,
  };
}

function addParkTerraceBands({ layout, park, sector, roadGrid, width, map, waterMask, params }) {
  if (!park?.polygon || !park.sideEdges || !park.rearEdge) return null;
  const centroid = polygonCentroid(park.polygon);
  const terraceDepth = params.parkTerraceDepthMeters;
  const sectorSet = new Set(sector.cells.map(cell => cell.gz * width + cell.gx));

  const orderedEdges = [
    { role: 'side-edge', edge: park.sideEdges[0] },
    { role: 'rear-edge', edge: park.rearEdge },
    { role: 'side-edge', edge: park.sideEdges[1] },
  ];

  const bands = [];
  for (const { role, edge } of orderedEdges) {
    const midpoint = {
      x: (edge[0].x + edge[edge.length - 1].x) * 0.5,
      z: (edge[0].z + edge[edge.length - 1].z) * 0.5,
    };
    const outwardHint = normalize2({
      x: midpoint.x - centroid.x,
      z: midpoint.z - centroid.z,
    });
    const shape = buildRegularizedAttachedBoundaryQuad(edge, terraceDepth, outwardHint);
    if (!shape) continue;
    if (!polygonRegionFits(shape.polygon, {
      sectorSet,
      roadGrid,
      waterMask,
      width,
      cellSize: map.cellSize,
      originX: map.originX,
      originZ: map.originZ,
      blockedPolygons: layout.parcels.map(parcel => parcel.polygon),
      blockedRoads: [],
      roadClearanceMeters: 0,
    })) {
      continue;
    }
    const parcel = layout.addParcel(new ReservationParcel({
      kind: 'residential-park-terrace',
      polygon: shape.polygon,
      meta: {
        attachedToPark: true,
        role,
        depth: roundNumber(terraceDepth),
      },
    }));
    bands.push({ role, shape, parcel });
  }

  if (bands.length !== 3) {
    return { bands, notchPath: null };
  }

  const [leftBand, rearBand, rightBand] = bands;
  const notchPath = dedupePolyline([
    park.frontEdge[0],
    ...leftBand.shape.rearEdge,
    ...rearBand.shape.rearEdge,
    ...[...rightBand.shape.rearEdge].reverse(),
    park.frontEdge[1],
  ]);

  return { bands, notchPath };
}

function buildParkConnector(ringPolygon, serviceRoadCenterline, inwardNormal) {
  let best = null;
  for (const midpoint of polygonEdgeMidpoints(ringPolygon)) {
    const projected = projectPointOntoPolyline(midpoint, serviceRoadCenterline);
    if (!projected) continue;
    const dx = projected.x - midpoint.x;
    const dz = projected.z - midpoint.z;
    const outward = dx * inwardNormal.x + dz * inwardNormal.z;
    if (outward >= 0) continue;
    const dist = Math.hypot(dx, dz);
    if (!best || dist < best.distance) {
      best = {
        distance: dist,
        line: [
          { x: midpoint.x, z: midpoint.z },
          { x: projected.x, z: projected.z },
        ],
      };
    }
  }
  return best?.line ?? null;
}

function polygonRegionFits(polygon, {
  sectorSet,
  roadGrid,
  waterMask,
  width,
  cellSize,
  originX,
  originZ,
  blockedPolygons = [],
  blockedRoads = [],
  roadClearanceMeters = 0,
}) {
  const bounds = polygonBounds(polygon);
  const minGx = Math.floor((bounds.minX - originX) / cellSize);
  const maxGx = Math.ceil((bounds.maxX - originX) / cellSize);
  const minGz = Math.floor((bounds.minZ - originZ) / cellSize);
  const maxGz = Math.ceil((bounds.maxZ - originZ) / cellSize);

  let insideCount = 0;
  for (let gz = minGz; gz <= maxGz; gz++) {
    for (let gx = minGx; gx <= maxGx; gx++) {
      const wx = originX + gx * cellSize;
      const wz = originZ + gz * cellSize;
      if (!pointInPolygon(wx, wz, polygon)) continue;
      insideCount += 1;
      const key = gz * width + gx;
      if (!sectorSet.has(key)) return false;
      if (roadGrid.get(gx, gz) > 0) return false;
      if (waterMask && waterMask.get(gx, gz) > 0) return false;
      for (const blockedPolygon of blockedPolygons) {
        if (pointInPolygon(wx, wz, blockedPolygon)) return false;
      }
      for (const blockedRoad of blockedRoads) {
        if (distanceToPolyline({ x: wx, z: wz }, blockedRoad) < roadClearanceMeters) return false;
      }
    }
  }
  return insideCount > 0;
}

function distanceToPolyline(point, polyline) {
  let best = Infinity;
  for (let i = 1; i < polyline.length; i++) {
    const segmentDist = distanceToSegment(point, polyline[i - 1], polyline[i]);
    if (segmentDist < best) best = segmentDist;
  }
  return best;
}

function distanceToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lenSq = dx * dx + dz * dz;
  if (lenSq <= 1e-9) return Math.hypot(point.x - a.x, point.z - a.z);
  const t = clamp(
    ((point.x - a.x) * dx + (point.z - a.z) * dz) / lenSq,
    0,
    1,
  );
  const px = a.x + dx * t;
  const pz = a.z + dz * t;
  return Math.hypot(point.x - px, point.z - pz);
}

function classifyRoadHierarchy(kind) {
  if (kind === 'stub-road') return 'residential';
  if (kind === 'park-road' || kind === 'park-connector-road') return 'civic';
  return 'commercial';
}

function polygonBounds(polygon) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of polygon) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.z < minZ) minZ = point.z;
    if (point.z > maxZ) maxZ = point.z;
  }
  return { minX, maxX, minZ, maxZ };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalize2(vector) {
  const length = Math.hypot(vector.x, vector.z);
  if (length < 1e-9) return null;
  return { x: vector.x / length, z: vector.z / length };
}

function roundNumber(value) {
  return Math.round(value * 1000) / 1000;
}
