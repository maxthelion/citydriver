import { pointInPolygon } from '../../core/math.js';
import { layCrossStreets } from '../incremental/crossStreets.js';
import { layRibbons } from '../incremental/ribbons.js';
import { tryAddRoad } from '../incremental/roadTransaction.js';

export function fillResidualAreasWithRibbons({
  residualAreas = [],
  parentSector,
  map,
  crossParams = {},
  ribbonParams = {},
  minCells = 120,
  eventSink = null,
  eventContext = {},
  crossEventStepId = 'cross-streets',
  ribbonEventStepId = 'ribbons',
}) {
  const fillSectors = [];
  const residualCrossStreets = [];
  const residualRibbons = [];
  const failedRibbons = [];
  let rejectedCrossStreets = 0;
  let rejectedRibbons = 0;
  let nextFillSectorIdx = 0;

  for (const area of residualAreas) {
    if (!area?.polygon?.length) continue;
    const cells = rasterizeResidualPolygon(area.polygon, parentSector, map);
    const sectors = buildResidualFillSectors(cells, parentSector, map, minCells);
    fillSectors.push(...sectors);

    for (const sector of sectors) {
      const sectorIdx = nextFillSectorIdx++;
      const sectorEventContext = compactObject({
        ...eventContext,
        sectorIdx,
        residualAreaId: area.id,
      });
      const crossResult = layCrossStreets(sector, map, {
        ...crossParams,
        eventSink,
        eventStepId: crossEventStepId,
        eventContext: sectorEventContext,
      });
      const committedCross = [];
      for (const street of crossResult.crossStreets || []) {
        const result = tryAddRoad(map, street.points, {
          hierarchy: 'residential',
          source: 'residual-cross-street',
        });
        if (!result.accepted || !result.way) {
          rejectedCrossStreets += 1;
          continue;
        }
        const committedPoints = result.way.polyline.map(point => ({ x: point.x, z: point.z }));
        const committedStreet = {
          ...street,
          roadId: result.way.id,
          points: committedPoints,
          residualAreaId: area.id,
          sectorIdx,
          streetKey: streetEventKey({
            ...street,
            points: committedPoints,
          }),
        };
        committedCross.push(committedStreet);
        residualCrossStreets.push(committedStreet);
        emitResidualEvent(eventSink, crossEventStepId, sectorEventContext, 'cross-street-committed', {
          streetKey: committedStreet.streetKey,
          roadId: committedStreet.roadId,
          ctOff: roundEventNumber(committedStreet.ctOff),
          length: roundEventNumber(committedStreet.length ?? polylineLength(committedStreet.points)),
          startPoint: roundEventPoint(committedStreet.points[0]),
          endPoint: roundEventPoint(committedStreet.points[committedStreet.points.length - 1]),
          snapped: !!committedStreet.snapped,
          snapPoint: roundEventPoint(committedStreet.snapPoint),
        });
      }

      if (committedCross.length < 2) continue;

      const ribbonResult = layRibbons(committedCross, sector, map, {
        ...ribbonParams,
        eventSink,
        eventStepId: ribbonEventStepId,
        eventContext: sectorEventContext,
      });
      failedRibbons.push(...(ribbonResult.failedRibbons || []).map(failure => ({
        ...failure,
        residualAreaId: area.id,
        sectorIdx,
      })));
      for (const ribbon of ribbonResult.ribbons || []) {
        const result = tryAddRoad(map, ribbon.points, {
          hierarchy: 'residential',
          source: 'residual-ribbon',
        });
        if (!result.accepted || !result.way) {
          rejectedRibbons += 1;
          continue;
        }
        residualRibbons.push({
          ...ribbon,
          roadId: result.way.id,
          points: result.way.polyline.map(point => ({ x: point.x, z: point.z })),
          residualAreaId: area.id,
          sectorIdx,
        });
      }
    }
  }

  return {
    fillSectors,
    residualCrossStreets,
    residualRibbons,
    failedRibbons,
    rejectedCrossStreets,
    rejectedRibbons,
  };
}

function rasterizeResidualPolygon(polygon, parentSector, map) {
  const sectorCellMap = new Map(parentSector.cells.map(cell => [cell.gz * map.width + cell.gx, cell]));
  const bounds = polygonBounds(polygon);
  const minGx = Math.max(0, Math.floor((bounds.minX - map.originX) / map.cellSize));
  const maxGx = Math.min(map.width - 1, Math.ceil((bounds.maxX - map.originX) / map.cellSize));
  const minGz = Math.max(0, Math.floor((bounds.minZ - map.originZ) / map.cellSize));
  const maxGz = Math.min(map.height - 1, Math.ceil((bounds.maxZ - map.originZ) / map.cellSize));
  const cells = [];

  for (let gz = minGz; gz <= maxGz; gz++) {
    for (let gx = minGx; gx <= maxGx; gx++) {
      const key = gz * map.width + gx;
      const cell = sectorCellMap.get(key);
      if (!cell) continue;
      const wx = map.originX + gx * map.cellSize;
      const wz = map.originZ + gz * map.cellSize;
      if (!pointInPolygon(wx, wz, polygon)) continue;
      cells.push(cell);
    }
  }

  return cells;
}

function buildResidualFillSectors(cells, parentSector, map, minCells) {
  const roadGrid = map.getLayer('roadGrid');
  const waterMask = map.hasLayer('waterMask') ? map.getLayer('waterMask') : null;
  const cellMap = new Map(cells.map(cell => [cell.gz * map.width + cell.gx, cell]));
  const seen = new Set();
  const sectors = [];

  for (const cell of cells) {
    const startKey = cell.gz * map.width + cell.gx;
    if (seen.has(startKey)) continue;
    if (roadGrid.get(cell.gx, cell.gz) > 0) continue;
    if (waterMask && waterMask.get(cell.gx, cell.gz) > 0) continue;

    const queue = [cell];
    seen.add(startKey);
    const component = [];

    while (queue.length > 0) {
      const current = queue.pop();
      component.push(current);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = current.gx + dx;
        const nz = current.gz + dz;
        const key = nz * map.width + nx;
        if (seen.has(key) || !cellMap.has(key)) continue;
        if (roadGrid.get(nx, nz) > 0) continue;
        if (waterMask && waterMask.get(nx, nz) > 0) continue;
        seen.add(key);
        queue.push(cellMap.get(key));
      }
    }

    if (component.length < minCells) continue;
    sectors.push(buildResidualSector(component, parentSector));
  }

  return sectors;
}

function buildResidualSector(cells, parentSector) {
  let centroidGx = 0;
  let centroidGz = 0;
  for (const cell of cells) {
    centroidGx += cell.gx;
    centroidGz += cell.gz;
  }
  centroidGx /= cells.length;
  centroidGz /= cells.length;
  return {
    cells,
    centroidGx,
    centroidGz,
    faceIdx: parentSector.faceIdx,
    avgSlope: parentSector.avgSlope,
    slopeDir: parentSector.slopeDir,
    boundary: parentSector.boundary,
  };
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

function emitResidualEvent(sink, stepId, context, type, payload = {}) {
  if (!sink || typeof sink.emit !== 'function' || typeof sink.next !== 'function') return;
  sink.emit({
    seq: sink.next(),
    stepId,
    type,
    ...compactObject(context),
    payload: compactObject(payload),
  });
}

function compactObject(obj = {}) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined),
  );
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

function polylineLength(points = []) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  }
  return total;
}

function roundEventNumber(value) {
  return Number.isFinite(value) ? roundNumber(value) : null;
}

function roundEventPoint(point) {
  return point ? { x: roundNumber(point.x), z: roundNumber(point.z) } : null;
}

function roundNumber(value) {
  return Math.round(value * 100) / 100;
}
