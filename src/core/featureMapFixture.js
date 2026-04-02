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

  const grids = collectFixtureGrids(map);
  const { entries, buffer } = packGridEntries(grids);

  const fixture = {
    meta: {
      version: 1,
      width: map.width,
      height: map.height,
      cellSize: map.cellSize,
      originX: map.originX,
      originZ: map.originZ,
      savedAt: new Date().toISOString(),
      ...options.meta,
    },
    grids: entries,
    bindings: {
      propertyGrids: buildPropertyGridBindings(map, grids),
      layerNames: [...map.layers.keys()],
    },
    data: {
      rivers: jsonClone(map.rivers),
      plots: jsonClone(map.plots),
      buildings: jsonClone(map.buildings),
      nuclei: jsonClone(map.nuclei),
      developmentZones: jsonClone(map.developmentZones ?? null),
      reservationZones: jsonClone(map.reservationZones ?? null),
      growthState: serializeGrowthState(map.growthState),
      settlement: jsonClone(map.settlement ?? null),
      regionalSettlements: jsonClone(map.regionalSettlements ?? null),
      regionalParams: map.regionalLayers?.getData?.('params') ?? null,
      seaLevel: map.seaLevel ?? null,
      prevailingWindAngle: map.prevailingWindAngle ?? null,
    },
    roadNetwork: map.roadNetwork.toJSON(),
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
