import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { FeatureMap } from './FeatureMap.js';
import { Grid2D } from './Grid2D.js';
import { RoadNetwork } from './RoadNetwork.js';

const PROPERTY_GRID_NAMES = [
  'elevation',
  'slope',
  'waterMask',
  'waterType',
  'waterDepth',
  'waterDist',
  'railwayGrid',
  'landValue',
];

const DERIVED_GRID_LAYER_NAMES = new Set(['roadGrid', 'bridgeGrid']);

export async function saveMapFixture(map, path, options = {}) {
  const { jsonPath, binPath } = resolveFixturePaths(path);
  await mkdir(dirname(jsonPath), { recursive: true });

  const crop = normalizeCropBounds(options.crop, map);
  const sourceMap = crop ? buildCroppedFixtureMap(map, crop) : map;
  const grids = collectFixtureGrids(sourceMap);
  const { entries, buffer } = packGridEntries(grids);
  const defaultCropMeta = crop
    ? {
        minGx: crop.minGx,
        minGz: crop.minGz,
        maxGx: crop.maxGx,
        maxGz: crop.maxGz,
        width: sourceMap.width,
        height: sourceMap.height,
        originalWidth: map.width,
        originalHeight: map.height,
        originalOriginX: map.originX,
        originalOriginZ: map.originZ,
        source: crop.source ?? null,
        zoneId: crop.zoneId ?? null,
        zoneIndex: crop.zoneIndex ?? null,
        margin: crop.margin ?? null,
      }
    : undefined;

  const fixture = {
    meta: {
      version: 1,
      width: sourceMap.width,
      height: sourceMap.height,
      cellSize: sourceMap.cellSize,
      originX: sourceMap.originX,
      originZ: sourceMap.originZ,
      savedAt: new Date().toISOString(),
      crop: defaultCropMeta,
      ...options.meta,
    },
    grids: entries,
    bindings: {
      propertyGrids: buildPropertyGridBindings(sourceMap, grids),
      layerNames: [...sourceMap.layers.keys()],
    },
    data: {
      rivers: jsonClone(sourceMap.rivers),
      plots: jsonClone(sourceMap.plots),
      buildings: jsonClone(sourceMap.buildings),
      nuclei: jsonClone(sourceMap.nuclei),
      developmentZones: jsonClone(sourceMap.developmentZones ?? null),
      reservationZones: jsonClone(sourceMap.reservationZones ?? null),
      growthState: serializeGrowthState(sourceMap.growthState),
      settlement: jsonClone(sourceMap.settlement ?? null),
      regionalSettlements: jsonClone(sourceMap.regionalSettlements ?? null),
      regionalParams: sourceMap.regionalLayers?.getData?.('params') ?? null,
      seaLevel: sourceMap.seaLevel ?? null,
      prevailingWindAngle: sourceMap.prevailingWindAngle ?? null,
    },
    roadNetwork: sourceMap.roadNetwork.toJSON(),
  };

  await Promise.all([
    writeFile(jsonPath, JSON.stringify(fixture, null, 2)),
    writeFile(binPath, buffer),
  ]);

  return { jsonPath, binPath };
}

export async function loadMapFixture(path) {
  const { jsonPath, binPath } = resolveFixturePaths(path);
  const [jsonText, binBuffer] = await Promise.all([
    readFile(jsonPath, 'utf8'),
    readFile(binPath),
  ]);

  const fixture = JSON.parse(jsonText);
  const meta = fixture.meta || {};
  const map = new FeatureMap(meta.width, meta.height, meta.cellSize, {
    originX: meta.originX ?? 0,
    originZ: meta.originZ ?? 0,
  });

  const gridsByName = new Map();
  for (const entry of fixture.grids || []) {
    const ArrayType = gridArrayType(entry.type);
    const typed = new ArrayType(
      binBuffer.buffer,
      binBuffer.byteOffset + entry.offset,
      entry.bytes / ArrayType.BYTES_PER_ELEMENT,
    );
    const grid = new Grid2D(entry.width, entry.height, {
      type: entry.type,
      cellSize: entry.cellSize,
      originX: entry.originX,
      originZ: entry.originZ,
    });
    grid.data.set(typed);
    gridsByName.set(entry.name, grid);
  }

  map.roadNetwork = RoadNetwork.fromJSON(
    fixture.roadNetwork || {},
    meta.width,
    meta.height,
    meta.cellSize,
    meta.originX ?? 0,
    meta.originZ ?? 0,
  );

  const propertyBindings = fixture.bindings?.propertyGrids || {};
  for (const propertyName of PROPERTY_GRID_NAMES) {
    const gridName = propertyBindings[propertyName];
    if (!gridName) continue;
    map[propertyName] = gridsByName.get(gridName) ?? null;
  }

  map.rivers = jsonClone(fixture.data?.rivers ?? []);
  map.plots = jsonClone(fixture.data?.plots ?? []);
  map.buildings = jsonClone(fixture.data?.buildings ?? []);
  map.nuclei = jsonClone(fixture.data?.nuclei ?? []);
  map.developmentZones = jsonClone(fixture.data?.developmentZones ?? undefined);
  map.reservationZones = jsonClone(fixture.data?.reservationZones ?? undefined);
  map.growthState = deserializeGrowthState(fixture.data?.growthState);
  map.settlement = jsonClone(fixture.data?.settlement ?? null);
  map.regionalSettlements = jsonClone(fixture.data?.regionalSettlements ?? []);
  map.seaLevel = fixture.data?.seaLevel ?? null;
  map.prevailingWindAngle = fixture.data?.prevailingWindAngle ?? null;

  if (fixture.data?.regionalParams) {
    map.regionalLayers = {
      getData(name) {
        return name === 'params' ? fixture.data.regionalParams : undefined;
      },
      hasData(name) {
        return name === 'params';
      },
    };
  } else {
    map.regionalLayers = null;
  }

  map.layers.clear();
  for (const layerName of fixture.bindings?.layerNames || []) {
    if (layerName === 'roadGrid') {
      map.setLayer(layerName, map.roadNetwork.roadGrid);
      continue;
    }
    if (layerName === 'bridgeGrid') {
      map.setLayer(layerName, map.roadNetwork.bridgeGrid);
      continue;
    }
    const grid = gridsByName.get(layerName);
    if (grid) {
      map.setLayer(layerName, grid);
    }
  }

  map.fixtureMeta = meta;
  return map;
}

function resolveFixturePaths(path) {
  const absolute = resolve(path);
  const base = absolute.replace(/\.(json|bin)$/i, '');
  return {
    jsonPath: `${base}.json`,
    binPath: `${base}.bin`,
  };
}

function normalizeCropBounds(crop, map) {
  if (!crop) return null;
  const minGx = clampInt(crop.minGx, 0, map.width - 1);
  const minGz = clampInt(crop.minGz, 0, map.height - 1);
  const maxGx = clampInt(crop.maxGx, minGx, map.width - 1);
  const maxGz = clampInt(crop.maxGz, minGz, map.height - 1);
  return {
    ...crop,
    minGx,
    minGz,
    maxGx,
    maxGz,
  };
}

function buildCroppedFixtureMap(map, crop) {
  const cellSize = map.cellSize;
  const width = crop.maxGx - crop.minGx + 1;
  const height = crop.maxGz - crop.minGz + 1;
  const originX = map.originX + crop.minGx * cellSize;
  const originZ = map.originZ + crop.minGz * cellSize;
  const cropRect = buildCropRect(map, crop);
  const cropped = new FeatureMap(width, height, cellSize, { originX, originZ });
  const gridCache = new Map();
  const getSlicedGrid = grid => {
    if (!(grid instanceof Grid2D)) return null;
    if (!gridCache.has(grid)) {
      gridCache.set(grid, sliceGrid(grid, crop));
    }
    return gridCache.get(grid);
  };

  for (const propertyName of PROPERTY_GRID_NAMES) {
    const grid = map[propertyName];
    cropped[propertyName] = grid instanceof Grid2D ? getSlicedGrid(grid) : null;
  }

  cropped.layers.clear();
  for (const [name, grid] of map.layers) {
    if (!(grid instanceof Grid2D)) continue;
    if (DERIVED_GRID_LAYER_NAMES.has(name)) continue;
    const sliced = getSlicedGrid(grid);
    if (sliced) {
      cropped.setLayer(name, sliced);
    }
  }

  cropped.roadNetwork = RoadNetwork.fromJSON(
    cropRoadNetworkSnapshot(map.roadNetwork, cropRect),
    width,
    height,
    cellSize,
    originX,
    originZ,
  );

  if (map.layers.has('roadGrid')) {
    cropped.setLayer('roadGrid', cropped.roadNetwork.roadGrid);
  }
  if (map.layers.has('bridgeGrid')) {
    cropped.setLayer('bridgeGrid', cropped.roadNetwork.bridgeGrid);
  }

  cropped.rivers = cropPolylineFeatureArray(map.rivers, 'polyline', cropRect);
  cropped.plots = cropStructuredFeatureArray(map.plots, crop, cropRect);
  cropped.buildings = cropStructuredFeatureArray(map.buildings, crop, cropRect);
  cropped.nuclei = cropPointFeatureArray(map.nuclei, crop);
  cropped.developmentZones = cropZoneArray(map.developmentZones, crop);
  cropped.reservationZones = cropReservationZoneArray(map.reservationZones, crop);
  cropped.growthState = cropGrowthState(map.growthState, crop, cropped.developmentZones);
  cropped.seaLevel = map.seaLevel ?? null;
  cropped.prevailingWindAngle = map.prevailingWindAngle ?? null;
  cropped.settlement = jsonClone(map.settlement ?? null);
  cropped.regionalSettlements = jsonClone(map.regionalSettlements ?? null);

  if (map.regionalLayers?.getData?.('params')) {
    const regionalParams = map.regionalLayers.getData('params');
    cropped.regionalLayers = {
      getData(name) {
        return name === 'params' ? regionalParams : undefined;
      },
      hasData(name) {
        return name === 'params';
      },
    };
  } else {
    cropped.regionalLayers = null;
  }

  return cropped;
}

function buildCropRect(map, crop) {
  const cs = map.cellSize;
  return {
    minX: map.originX + crop.minGx * cs - cs * 0.5,
    minZ: map.originZ + crop.minGz * cs - cs * 0.5,
    maxX: map.originX + crop.maxGx * cs + cs * 0.5,
    maxZ: map.originZ + crop.maxGz * cs + cs * 0.5,
  };
}

function sliceGrid(grid, crop) {
  const width = crop.maxGx - crop.minGx + 1;
  const height = crop.maxGz - crop.minGz + 1;
  const sliced = new Grid2D(width, height, {
    type: grid._type,
    cellSize: grid.cellSize,
    originX: grid.originX + crop.minGx * grid.cellSize,
    originZ: grid.originZ + crop.minGz * grid.cellSize,
  });
  for (let gz = 0; gz < height; gz++) {
    const sourceStart = (crop.minGz + gz) * grid.width + crop.minGx;
    const sourceEnd = sourceStart + width;
    sliced.data.set(grid.data.subarray(sourceStart, sourceEnd), gz * width);
  }
  return sliced;
}

function cropRoadNetworkSnapshot(roadNetwork, cropRect) {
  const nodeIdByKey = new Map();
  const nodes = [];
  const ways = [];
  let nextNodeId = 0;
  let nextWayId = 0;

  for (const way of roadNetwork.ways) {
    const clippedLines = clipPolylineToRect(way.polyline, cropRect);
    for (const line of clippedLines) {
      const deduped = dedupePolylinePoints(line);
      if (deduped.length < 2) continue;
      const nodeIds = deduped.map(point => {
        const key = pointKey(point);
        if (!nodeIdByKey.has(key)) {
          const id = nextNodeId++;
          nodeIdByKey.set(key, id);
          nodes.push({
            id,
            x: point.x,
            z: point.z,
            attrs: {},
          });
        }
        return nodeIdByKey.get(key);
      });
      if (nodeIds.length < 2) continue;
      ways.push({
        id: nextWayId++,
        nodeIds,
        width: way.width,
        hierarchy: way.hierarchy,
        importance: way.importance,
        source: way.source,
        bridges: samePolyline(way.polyline, deduped) ? way.bridges : [],
      });
    }
  }

  return { nodes, ways };
}

function cropPolylineFeatureArray(features, polylineKey, cropRect) {
  const out = [];
  for (const feature of features || []) {
    const polyline = feature?.[polylineKey];
    if (!Array.isArray(polyline) || polyline.length < 2) continue;
    const clippedLines = clipPolylineToRect(polyline, cropRect);
    for (const line of clippedLines) {
      const deduped = dedupePolylinePoints(line);
      if (deduped.length < 2) continue;
      const copy = jsonClone(feature);
      copy[polylineKey] = deduped;
      out.push(copy);
    }
  }
  return out;
}

function cropStructuredFeatureArray(features, crop, cropRect) {
  const out = [];
  for (const feature of features || []) {
    const cropped = cropStructuredFeature(feature, crop, cropRect);
    if (cropped) out.push(cropped);
  }
  return out;
}

function cropStructuredFeature(feature, crop, cropRect) {
  if (!feature || typeof feature !== 'object') return null;
  const copy = jsonClone(feature);

  if (Array.isArray(feature.cells)) {
    copy.cells = cropCells(feature.cells, crop);
    if (copy.cells.length === 0) return null;
  }

  if (Number.isFinite(feature.gx) && Number.isFinite(feature.gz)) {
    if (!cellInCrop(feature.gx, feature.gz, crop)) return null;
    copy.gx = feature.gx - crop.minGx;
    copy.gz = feature.gz - crop.minGz;
  }

  if (Array.isArray(feature.polygon)) {
    const clipped = clipPolylineToRect(feature.polygon, cropRect);
    if (clipped.length > 0) {
      copy.polygon = clipped[0];
    }
  }
  if (Array.isArray(feature.footprint)) {
    const clipped = clipPolylineToRect(feature.footprint, cropRect);
    if (clipped.length > 0) {
      copy.footprint = clipped[0];
    }
  }
  if (Number.isFinite(feature.x) && Number.isFinite(feature.z) && !pointInRect(feature, cropRect)) {
    return null;
  }

  return copy;
}

function cropPointFeatureArray(features, crop) {
  const out = [];
  for (const feature of features || []) {
    if (!Number.isFinite(feature?.gx) || !Number.isFinite(feature?.gz)) continue;
    if (!cellInCrop(feature.gx, feature.gz, crop)) continue;
    out.push({
      ...jsonClone(feature),
      gx: feature.gx - crop.minGx,
      gz: feature.gz - crop.minGz,
    });
  }
  return out;
}

function cropZoneArray(zones, crop) {
  const out = [];
  for (const zone of zones || []) {
    const cells = cropCells(zone.cells || [], crop);
    if (cells.length === 0) continue;
    const copy = jsonClone(zone);
    copy.cells = cells;
    if ('centroidGx' in copy || 'centroidGz' in copy) {
      const centroid = averageCells(cells);
      copy.centroidGx = centroid.gx;
      copy.centroidGz = centroid.gz;
    }
    delete copy.boundingNodeIds;
    delete copy.boundingEdgeIds;
    out.push(copy);
  }
  return out;
}

function cropReservationZoneArray(zones, crop) {
  const out = [];
  for (const zone of zones || []) {
    const cells = cropCells(zone.cells || [], crop);
    if (cells.length === 0) continue;
    const copy = jsonClone(zone);
    copy.cells = cells;
    out.push(copy);
  }
  return out;
}

function cropGrowthState(state, crop, developmentZones) {
  if (!state) return undefined;
  return {
    tick: state.tick,
    totalZoneCells: (developmentZones || []).reduce((sum, zone) => sum + (zone.cells?.length || 0), 0),
    nucleusRadii: new Map(state.nucleusRadii || []),
    claimedCounts: new Map(state.claimedCounts || []),
    activeSeeds: new Map(
      [...(state.activeSeeds || new Map()).entries()].map(([key, seeds]) => [
        key,
        (seeds || [])
          .filter(seed => cellInCrop(seed.gx, seed.gz, crop))
          .map(seed => ({
            ...jsonClone(seed),
            gx: seed.gx - crop.minGx,
            gz: seed.gz - crop.minGz,
          })),
      ]),
    ),
  };
}

function cropCells(cells, crop) {
  const out = [];
  for (const cell of cells || []) {
    if (!cellInCrop(cell.gx, cell.gz, crop)) continue;
    out.push({
      ...cell,
      gx: cell.gx - crop.minGx,
      gz: cell.gz - crop.minGz,
    });
  }
  return out;
}

function averageCells(cells) {
  if (!cells.length) return { gx: 0, gz: 0 };
  let sumGx = 0;
  let sumGz = 0;
  for (const cell of cells) {
    sumGx += cell.gx;
    sumGz += cell.gz;
  }
  return {
    gx: sumGx / cells.length,
    gz: sumGz / cells.length,
  };
}

function cellInCrop(gx, gz, crop) {
  return gx >= crop.minGx && gx <= crop.maxGx && gz >= crop.minGz && gz <= crop.maxGz;
}

function pointInRect(point, rect) {
  return point.x >= rect.minX && point.x <= rect.maxX && point.z >= rect.minZ && point.z <= rect.maxZ;
}

function clipPolylineToRect(polyline, rect) {
  if (!Array.isArray(polyline) || polyline.length < 2) return [];
  const lines = [];
  let current = [];

  for (let i = 1; i < polyline.length; i++) {
    const clipped = clipSegmentToRect(polyline[i - 1], polyline[i], rect);
    if (!clipped) {
      pushClippedLine(lines, current);
      current = [];
      continue;
    }

    const start = clipped.start;
    const end = clipped.end;
    if (current.length === 0) {
      current.push(start);
      if (!pointsApproxEqual(start, end)) current.push(end);
      continue;
    }

    if (!pointsApproxEqual(current[current.length - 1], start)) {
      pushClippedLine(lines, current);
      current = [start];
      if (!pointsApproxEqual(start, end)) current.push(end);
      continue;
    }

    if (!pointsApproxEqual(current[current.length - 1], end)) {
      current.push(end);
    }
  }

  pushClippedLine(lines, current);
  return lines;
}

function pushClippedLine(lines, current) {
  const deduped = dedupePolylinePoints(current);
  if (deduped.length >= 2) {
    lines.push(deduped);
  }
}

function clipSegmentToRect(a, b, rect) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  let t0 = 0;
  let t1 = 1;
  const tests = [
    [-dx, a.x - rect.minX],
    [dx, rect.maxX - a.x],
    [-dz, a.z - rect.minZ],
    [dz, rect.maxZ - a.z],
  ];

  for (const [p, q] of tests) {
    if (Math.abs(p) < 1e-9) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }

  return {
    start: interpolatePoint(a, b, t0),
    end: interpolatePoint(a, b, t1),
  };
}

function interpolatePoint(a, b, t) {
  if (t <= 0) return jsonClone(a);
  if (t >= 1) return jsonClone(b);

  const point = {};
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const key of keys) {
    const av = a?.[key];
    const bv = b?.[key];
    if (typeof av === 'number' && typeof bv === 'number') {
      point[key] = av + (bv - av) * t;
      continue;
    }
    point[key] = t < 0.5 ? jsonClone(av) : jsonClone(bv);
  }
  return point;
}

function dedupePolylinePoints(polyline) {
  const out = [];
  for (const point of polyline || []) {
    if (!out.length || !pointsApproxEqual(out[out.length - 1], point)) {
      out.push(point);
    }
  }
  return out;
}

function pointsApproxEqual(a, b, eps = 1e-6) {
  return Math.abs((a?.x ?? 0) - (b?.x ?? 0)) <= eps && Math.abs((a?.z ?? 0) - (b?.z ?? 0)) <= eps;
}

function samePolyline(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((point, idx) => pointsApproxEqual(point, b[idx]));
}

function pointKey(point) {
  return `${point.x.toFixed(6)},${point.z.toFixed(6)}`;
}

function clampInt(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function collectFixtureGrids(map) {
  const grids = new Map();
  for (const propertyName of PROPERTY_GRID_NAMES) {
    const grid = map[propertyName];
    if (grid instanceof Grid2D) {
      grids.set(propertyName, grid);
    }
  }
  for (const [name, grid] of map.layers) {
    if (!(grid instanceof Grid2D)) continue;
    if (DERIVED_GRID_LAYER_NAMES.has(name)) continue;
    if (!grids.has(name)) {
      grids.set(name, grid);
    }
  }
  return grids;
}

function buildPropertyGridBindings(map, grids) {
  const bindings = {};
  for (const propertyName of PROPERTY_GRID_NAMES) {
    const grid = map[propertyName];
    if (!(grid instanceof Grid2D)) continue;
    const match = [...grids.entries()].find(([, candidate]) => candidate === grid);
    if (match) bindings[propertyName] = match[0];
  }
  return bindings;
}

function packGridEntries(grids) {
  const entries = [];
  let offset = 0;
  for (const [name, grid] of grids) {
    const alignment = grid.data.BYTES_PER_ELEMENT || 1;
    offset = alignOffset(offset, alignment);
    entries.push({
      name,
      type: grid._type,
      width: grid.width,
      height: grid.height,
      cellSize: grid.cellSize,
      originX: grid.originX,
      originZ: grid.originZ,
      offset,
      bytes: grid.data.byteLength,
    });
    offset += grid.data.byteLength;
  }

  const buffer = new Uint8Array(offset);
  for (const entry of entries) {
    const grid = grids.get(entry.name);
    const bytes = new Uint8Array(grid.data.buffer, grid.data.byteOffset, grid.data.byteLength);
    buffer.set(bytes, entry.offset);
  }
  return { entries, buffer };
}

function alignOffset(offset, alignment) {
  const remainder = offset % alignment;
  return remainder === 0 ? offset : offset + (alignment - remainder);
}

function gridArrayType(type) {
  switch (type) {
    case 'float32': return Float32Array;
    case 'uint8': return Uint8Array;
    case 'int32': return Int32Array;
    case 'int8': return Int8Array;
    case 'uint16': return Uint16Array;
    case 'float64': return Float64Array;
    default: throw new Error(`Unsupported grid array type: ${type}`);
  }
}

function serializeGrowthState(state) {
  if (!state) return null;
  return {
    tick: state.tick,
    totalZoneCells: state.totalZoneCells,
    nucleusRadii: [...(state.nucleusRadii || new Map()).entries()],
    claimedCounts: [...(state.claimedCounts || new Map()).entries()],
    activeSeeds: [...(state.activeSeeds || new Map()).entries()].map(([key, seeds]) => [key, jsonClone(seeds)]),
  };
}

function deserializeGrowthState(state) {
  if (!state) return undefined;
  return {
    tick: state.tick,
    totalZoneCells: state.totalZoneCells,
    nucleusRadii: new Map(state.nucleusRadii || []),
    claimedCounts: new Map(state.claimedCounts || []),
    activeSeeds: new Map((state.activeSeeds || []).map(([key, seeds]) => [key, jsonClone(seeds)])),
  };
}

function jsonClone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}
