import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { segmentTerrainV2 } from '../incremental/ridgeSegmentationV2.js';

export async function loadOrCreateTerrainFaceCache({ fixturePath = null, map, opts = {} }) {
  if (!fixturePath) {
    const { faces } = segmentTerrainV2(map, opts);
    return buildRuntimeFaceData(map, faces);
  }

  const paths = resolveTerrainFaceCachePaths(fixturePath);
  if (existsSync(paths.jsonPath) && existsSync(paths.binPath)) {
    const cached = await loadTerrainFaceCache(paths, map, opts);
    if (cached) return cached;
  }

  const { faces } = segmentTerrainV2(map, opts);
  const runtime = buildRuntimeFaceData(map, faces);
  await saveTerrainFaceCache(paths, map, opts, runtime);
  return runtime;
}

function resolveTerrainFaceCachePaths(fixturePath) {
  const base = resolve(String(fixturePath)).replace(/\.(json|bin)$/i, '');
  return {
    jsonPath: `${base}.terrain-faces-v2.json`,
    binPath: `${base}.terrain-faces-v2.bin`,
  };
}

async function loadTerrainFaceCache(paths, map, opts) {
  try {
    const [jsonText, binBuffer] = await Promise.all([
      readFile(paths.jsonPath, 'utf8'),
      readFile(paths.binPath),
    ]);
    const payload = JSON.parse(jsonText);
    if (!isCompatibleCache(payload, map, opts, binBuffer)) return null;

    const faceIndex = new Int16Array(
      binBuffer.buffer,
      binBuffer.byteOffset,
      binBuffer.byteLength / Int16Array.BYTES_PER_ELEMENT,
    );
    return {
      faces: payload.faces.map(face => ({
        id: face.id,
        avgSlope: face.avgSlope,
        slopeDir: face.slopeDir,
      })),
      faceIndex,
    };
  } catch {
    return null;
  }
}

async function saveTerrainFaceCache(paths, map, opts, runtime) {
  const payload = {
    version: 1,
    width: map.width,
    height: map.height,
    cellSize: map.cellSize,
    options: normalizeOptions(opts),
    faces: runtime.faces.map(face => ({
      id: face.id,
      avgSlope: face.avgSlope,
      slopeDir: face.slopeDir,
    })),
  };
  await Promise.all([
    writeFile(paths.jsonPath, JSON.stringify(payload, null, 2)),
    writeFile(paths.binPath, Buffer.from(runtime.faceIndex.buffer.slice(0))),
  ]);
}

function buildRuntimeFaceData(map, faces) {
  const faceIndex = new Int16Array(map.width * map.height);
  faceIndex.fill(-1);
  faces.forEach((face, faceIdx) => {
    for (const cell of face.cells || []) {
      faceIndex[cell.gz * map.width + cell.gx] = faceIdx;
    }
  });
  return { faces, faceIndex };
}

function normalizeOptions(opts) {
  return {
    dirTolerance: opts.dirTolerance ?? null,
    elevTolerance: opts.elevTolerance ?? null,
    slopeBands: Array.isArray(opts.slopeBands) ? opts.slopeBands : null,
  };
}

function isCompatibleCache(payload, map, opts, binBuffer) {
  if (!payload || payload.version !== 1) return false;
  if (payload.width !== map.width || payload.height !== map.height) return false;
  if (payload.cellSize !== map.cellSize) return false;
  const expectedOptions = normalizeOptions(opts);
  const cachedOptions = payload.options || {};
  if (cachedOptions.dirTolerance !== expectedOptions.dirTolerance) return false;
  if (cachedOptions.elevTolerance !== expectedOptions.elevTolerance) return false;
  const cachedBands = Array.isArray(cachedOptions.slopeBands) ? cachedOptions.slopeBands : null;
  const expectedBands = expectedOptions.slopeBands;
  if (JSON.stringify(cachedBands) !== JSON.stringify(expectedBands)) return false;
  const expectedBytes = map.width * map.height * Int16Array.BYTES_PER_ELEMENT;
  if (binBuffer.byteLength !== expectedBytes) return false;
  if (!Array.isArray(payload.faces)) return false;
  return true;
}
