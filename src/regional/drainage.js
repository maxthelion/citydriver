/**
 * Drainage network generation.
 * Runs hydrological analysis on the regional heightmap to produce
 * rivers, confluences, narrow crossings, and a water cell set.
 * When geology is provided, stream density varies by rock permeability
 * and river segments gain a character tag.
 */
import {
  fillSinks,
  flowDirections,
  flowAccumulation,
  extractStreams,
  findConfluences,
  findNarrowCrossings,
} from '../core/flowAccumulation.js';
import { ROCK_TYPES, ROCK_PROPERTIES } from './geology.js';
import { lerp } from '../core/math.js';

/**
 * Collect all stream segments (flat list) from a drainage tree.
 * @param {object[]} nodes - Root DrainageNode array
 * @param {object[]} result - Accumulator array
 */
function collectSegments(nodes, result) {
  for (const node of nodes) {
    result.push(node);
    collectSegments(node.children, result);
  }
}

/**
 * Add sinusoidal meander displacement to river segments.
 * D8 flow produces grid-aligned paths; this post-processes segments
 * to introduce realistic sinuosity on gentle terrain.
 *
 * @param {object[]} allSegments - Flat list of all stream segments
 * @param {import('../core/heightmap.js').Heightmap} heightmap
 */
function addRiverMeander(allSegments, heightmap) {
  const W = heightmap.width;
  const H = heightmap.height;
  // Tiny tolerance: less than V4's eps (1e-4) so displaced cells pass the
  // downhill check, but enough to allow displacement on near-flat terrain.
  const MEANDER_EPS = 5e-5;

  for (const segment of allSegments) {
    const { cells } = segment;
    if (cells.length < 5) continue;

    // Overall flow direction: start → end
    const start = cells[0];
    const end = cells[cells.length - 1];
    const fdx = end.gx - start.gx;
    const fdz = end.gz - start.gz;
    const fLen = Math.sqrt(fdx * fdx + fdz * fdz);
    if (fLen < 1) continue;

    // Perpendicular axis (rotate 90°)
    const px = -fdz / fLen;
    const pz = fdx / fLen;

    // Average gradient along segment
    const elevDrop = Math.abs(start.elevation - end.elevation);
    const avgGradient = elevDrop / fLen;

    // Amplitude: 0 on steep, 2-3 on flat
    const amplitude = Math.min(3, Math.floor(1.5 / (avgGradient + 0.01)));
    if (amplitude < 1) continue;

    // Wavelength: segment length / 3 (2-3 meander periods)
    const wavelength = cells.length / 3;

    // Displace interior cells with sine wave, graduated fallback
    for (let i = 1; i < cells.length - 1; i++) {
      const origGx = cells[i].gx;
      const origGz = cells[i].gz;
      const t = i / cells.length;
      const fullOffset = amplitude * Math.sin(2 * Math.PI * t * (cells.length / wavelength));
      const prevElev = cells[i - 1].elevation;

      // Try full, 75%, 50%, 25% displacement
      let displaced = false;
      for (const scale of [1.0, 0.75, 0.5, 0.25]) {
        const offset = fullOffset * scale;
        const newGx = Math.round(cells[i].gx + px * offset);
        const newGz = Math.round(cells[i].gz + pz * offset);

        if (newGx < 0 || newGx >= W || newGz < 0 || newGz >= H) continue;
        if (newGx === cells[i].gx && newGz === cells[i].gz) break;

        const newElev = heightmap.get(newGx, newGz);
        // Allow tiny uphill (below V4's eps) so flat terrain can meander
        if (newElev > prevElev + MEANDER_EPS) continue;

        cells[i].gx = newGx;
        cells[i].gz = newGz;
        cells[i].elevation = newElev;
        displaced = true;
        break;
      }

      // If sine wave didn't displace, try local perpendicular jitter (±1 cell)
      if (!displaced) {
        const prev = cells[i - 1];
        const next = cells[Math.min(i + 1, cells.length - 1)];
        const ldx = next.gx - prev.gx;
        const ldz = next.gz - prev.gz;
        const lLen = Math.sqrt(ldx * ldx + ldz * ldz);
        if (lLen < 0.5) continue;
        const lpx = -ldz / lLen;
        const lpz = ldx / lLen;
        const sign = (i % 2 === 0) ? 1 : -1;

        const jGx = Math.round(origGx + lpx * sign);
        const jGz = Math.round(origGz + lpz * sign);

        if (jGx >= 0 && jGx < W && jGz >= 0 && jGz < H &&
            (jGx !== origGx || jGz !== origGz)) {
          const jElev = heightmap.get(jGx, jGz);
          if (jElev <= prevElev + MEANDER_EPS) {
            cells[i].gx = jGx;
            cells[i].gz = jGz;
            cells[i].elevation = jElev;
          }
        }
      }
    }
  }
}

/**
 * Generate the full drainage network from a regional heightmap.
 * @param {import('../core/heightmap.js').Heightmap} heightmap - Will be modified by fillSinks
 * @param {number} seaLevel - Elevation of sea surface
 * @param {object} [params]
 * @param {number} [params.streamThreshold=100]
 * @param {number} [params.riverThreshold=1000]
 * @param {number} [params.majorRiverThreshold=5000]
 * @param {number} [params.riverDensityMultiplier=1.0]
 * @param {object|null} geology - GeologyData or null
 * @returns {{
 *   directions: Int8Array,
 *   accumulation: Float32Array,
 *   streams: object[],
 *   confluences: Array<{gx: number, gz: number, flowVolume: number, tributaryCount: number}>,
 *   crossings: Array<{gx: number, gz: number, valleyWidth: number, riverRank: string}>,
 *   waterCells: Set<number>,
 * }}
 */
export function generateDrainage(heightmap, seaLevel, params = {}, geology = null) {
  const {
    streamThreshold = 100,
    riverThreshold = 1000,
    majorRiverThreshold = 5000,
    riverDensityMultiplier = 1.0,
  } = params;

  const W = heightmap.width;
  const H = heightmap.height;

  // 1. Fill sinks -- modifies heightmap in place
  fillSinks(heightmap);

  // 2. Compute flow directions and accumulation
  const directions = flowDirections(heightmap);
  const accumulation = flowAccumulation(heightmap, directions);

  // 3. Extract streams with thresholds
  const thresholds = {
    stream: streamThreshold,
    river: riverThreshold,
    majorRiver: majorRiverThreshold,
  };
  const streams = extractStreams(accumulation, directions, heightmap, thresholds, seaLevel);

  // 4. Find confluences for settlement scoring
  const confluences = findConfluences(accumulation, directions, heightmap, riverThreshold);

  // 4b. Apply meander displacement to improve sinuosity
  const allSegments = [];
  collectSegments(streams, allSegments);
  addRiverMeander(allSegments, heightmap);

  // 5. Find narrow crossings for river-rank and above streams
  const crossings = [];

  for (const segment of allSegments) {
    if (segment.rank === 'river' || segment.rank === 'majorRiver') {
      const narrowCrossings = findNarrowCrossings(segment.cells, heightmap);
      for (const nc of narrowCrossings) {
        crossings.push({
          gx: nc.gx,
          gz: nc.gz,
          valleyWidth: nc.valleyWidth,
          riverRank: segment.rank,
        });
      }
    }
  }

  // 5b. Geology: tag river character and filter by permeability
  if (geology) {
    const { rockTypes } = geology;

    for (const segment of allSegments) {
      // Determine dominant rock type along segment (sample middle cell)
      if (segment.cells.length > 0) {
        const mid = segment.cells[Math.floor(segment.cells.length / 2)];
        const idx = mid.gz * W + mid.gx;
        const rockType = rockTypes[idx];
        const props = ROCK_PROPERTIES[rockType];

        // Character based on rock properties
        if (props.permeability >= 0.7) {
          segment.character = 'underground';
        } else if (props.erosionResistance >= 0.7) {
          segment.character = 'gorge';
        } else if (props.erosionResistance <= 0.3) {
          segment.character = 'meander';
        } else {
          segment.character = 'normal';
        }

        // Permeability-based threshold filtering: high permeability needs
        // more accumulation for visible streams. Filter out segments below
        // their geology-adjusted threshold.
        const permFactor = lerp(0.5, 2.0, props.permeability) * riverDensityMultiplier;
        const adjustedThreshold = thresholds[segment.rank] * permFactor;

        if (segment.flowVolume < adjustedThreshold) {
          segment._filtered = true;
        }
      }
    }
  }

  // 6. Build waterCells set: river/majorRiver stream cells OR cells below seaLevel
  const waterCells = new Set();

  // Add all river and majorRiver stream cells (skip geology-filtered ones)
  for (const segment of allSegments) {
    if (segment.rank === 'river' || segment.rank === 'majorRiver') {
      if (segment._filtered) continue;
      for (const cell of segment.cells) {
        waterCells.add(cell.gz * W + cell.gx);
      }
    }
  }

  // Add cells below sea level (ocean/sea cells)
  for (let gz = 0; gz < H; gz++) {
    for (let gx = 0; gx < W; gx++) {
      if (heightmap.get(gx, gz) < seaLevel) {
        waterCells.add(gz * W + gx);
      }
    }
  }

  // 7. Geology: alluvial deposits along rivers in soft rock
  if (geology) {
    const { rockTypes } = geology;

    for (const segment of allSegments) {
      if (segment._filtered) continue;
      if (segment.rank !== 'river' && segment.rank !== 'majorRiver') continue;

      for (const cell of segment.cells) {
        const idx = cell.gz * W + cell.gx;
        const rockType = rockTypes[idx];
        const resistance = ROCK_PROPERTIES[rockType].erosionResistance;

        // Deposit alluvial in soft rock around rivers
        if (resistance <= 0.4) {
          const radius = segment.rank === 'majorRiver' ? 4 : 2;
          for (let dz = -radius; dz <= radius; dz++) {
            for (let dx = -radius; dx <= radius; dx++) {
              if (dx * dx + dz * dz > radius * radius) continue;
              const nx = cell.gx + dx;
              const nz = cell.gz + dz;
              if (nx < 0 || nx >= W || nz < 0 || nz >= H) continue;
              const nIdx = nz * W + nx;
              // Only convert non-igneous rock to alluvial
              if (rockTypes[nIdx] !== ROCK_TYPES.IGNEOUS) {
                rockTypes[nIdx] = ROCK_TYPES.ALLUVIAL;
              }
            }
          }
        }
      }
    }
  }

  return {
    directions,
    accumulation,
    streams,
    confluences,
    crossings,
    waterCells,
  };
}
