/**
 * A0b. Plan major river corridors before terrain generation.
 *
 * Major rivers predate the current terrain (antecedent drainage).
 * This step plans 0-3 corridor polylines from inland edges to coast,
 * producing grids that terrain generation reads to suppress ridges.
 *
 * Outputs:
 *   corridors       — array of corridor objects with polylines
 *   corridorDist    — Grid2D: distance from nearest corridor (cells)
 *   corridorInfluence — Grid2D: gaussian falloff 0-1 for ridge suppression
 */

import { Grid2D } from '../core/Grid2D.js';
import { chaikinSmooth } from '../core/riverGeometry.js';

// Corridor count: base + intensity bias
const MAX_CORRIDORS = 3;
const INTENSITY_BIAS = 0.3; // higher intensity → more corridors

// Corridor width in cells (for ridge suppression gaussian)
const CORRIDOR_WIDTH_SMALL = 8;    // ~400m at 50m cells
const CORRIDOR_WIDTH_MEDIUM = 15;  // ~750m
const CORRIDOR_WIDTH_LARGE = 25;   // ~1250m

// Margin from corners (fraction of edge length)
const CORNER_MARGIN = 0.15;

/**
 * @param {object} params - { width, height, cellSize }
 * @param {object} tectonics - { coastEdges, plateAngle, intensity }
 * @param {import('../core/rng.js').SeededRandom} rng
 * @returns {{ corridors: Array, corridorDist: Grid2D, corridorInfluence: Grid2D }}
 */
export function planRiverCorridors(params, tectonics, rng) {
  const { width, height } = params;
  const coastEdges = tectonics.coastEdges || [];
  const intensity = tectonics.intensity ?? 0.5;

  // Determine non-coastal edges (where rivers can enter)
  const allEdges = ['north', 'south', 'east', 'west'];
  const inlandEdges = allEdges.filter(e => !coastEdges.includes(e));

  // Count corridors
  const roll = rng.next();
  const threshold = 0.3 - intensity * INTENSITY_BIAS;
  let count = 0;
  if (roll > threshold) count = 1;
  if (roll > threshold + 0.3) count = 2;
  if (roll > threshold + 0.55) count = 3;
  count = Math.min(count, MAX_CORRIDORS, inlandEdges.length);

  if (count === 0 || inlandEdges.length === 0 || coastEdges.length === 0) {
    return {
      corridors: [],
      corridorDist: new Grid2D(width, height, { fill: width + height }),
      corridorInfluence: new Grid2D(width, height),
    };
  }

  // Pick entry and exit points
  const corridors = [];
  const usedEntryEdges = new Set();

  for (let i = 0; i < count; i++) {
    // Pick an inland edge (prefer unused)
    let entryEdge = null;
    for (const e of inlandEdges) {
      if (!usedEntryEdges.has(e)) { entryEdge = e; break; }
    }
    if (!entryEdge) entryEdge = inlandEdges[Math.floor(rng.next() * inlandEdges.length)];
    usedEntryEdges.add(entryEdge);

    // Entry position along edge
    const entryT = CORNER_MARGIN + rng.next() * (1 - 2 * CORNER_MARGIN);
    const entry = edgePoint(entryEdge, entryT, width, height);

    // Exit on nearest coastal edge
    const exitEdge = coastEdges[Math.floor(rng.next() * coastEdges.length)];
    const exitT = CORNER_MARGIN + rng.next() * (1 - 2 * CORNER_MARGIN);
    const exit = edgePoint(exitEdge, exitT, width, height);

    // Generate corridor polyline with intermediate control points
    const polyline = generateCorridorPolyline(entry, exit, width, height, rng);

    // Assign importance based on index (first corridor is largest)
    const importance = i === 0 ? 1.0 : i === 1 ? 0.6 : 0.3;
    const widthLevels = [CORRIDOR_WIDTH_LARGE, CORRIDOR_WIDTH_MEDIUM, CORRIDOR_WIDTH_SMALL];

    corridors.push({
      polyline,
      entryAccumulation: 0, // computed by carveRiverProfiles (A2b) from terrain elevation
      importance,
      corridorWidth: widthLevels[i] || CORRIDOR_WIDTH_SMALL,
      entryEdge,
      exitEdge,
    });
  }

  // Compute distance field and influence grid
  const corridorDist = computeCorridorDist(corridors, width, height);
  const corridorInfluence = computeCorridorInfluence(corridors, corridorDist, width, height);

  return { corridors, corridorDist, corridorInfluence };
}

/**
 * Get a grid point on a map edge at parameter t (0-1 along the edge).
 */
function edgePoint(edge, t, width, height) {
  switch (edge) {
    case 'north': return { gx: Math.round(t * (width - 1)), gz: 0 };
    case 'south': return { gx: Math.round(t * (width - 1)), gz: height - 1 };
    case 'west':  return { gx: 0, gz: Math.round(t * (height - 1)) };
    case 'east':  return { gx: width - 1, gz: Math.round(t * (height - 1)) };
    default:      return { gx: Math.round(width / 2), gz: Math.round(height / 2) };
  }
}

/**
 * Generate a smooth corridor polyline between entry and exit.
 */
function generateCorridorPolyline(entry, exit, width, height, rng) {
  const dx = exit.gx - entry.gx;
  const dz = exit.gz - entry.gz;
  const len = Math.sqrt(dx * dx + dz * dz);

  // 3-5 control points with lateral noise
  const numMid = 2 + Math.floor(rng.next() * 2);
  const points = [{ x: entry.gx, z: entry.gz }];

  for (let i = 1; i <= numMid; i++) {
    const t = i / (numMid + 1);
    const baseX = entry.gx + dx * t;
    const baseZ = entry.gz + dz * t;
    // Perpendicular displacement
    const perpX = -dz / len;
    const perpZ = dx / len;
    const displacement = (rng.next() - 0.5) * len * 0.3;
    points.push({
      x: Math.max(1, Math.min(width - 2, baseX + perpX * displacement)),
      z: Math.max(1, Math.min(height - 2, baseZ + perpZ * displacement)),
    });
  }

  points.push({ x: exit.gx, z: exit.gz });

  // Smooth with Chaikin (need {x, z} format)
  let smoothed = points;
  for (let i = 0; i < 3; i++) {
    smoothed = chaikinSmooth(smoothed, 1);
  }

  // Convert back to grid coordinates
  return smoothed.map(p => ({
    gx: Math.round(p.x),
    gz: Math.round(p.z),
  }));
}

/**
 * BFS distance from corridor polyline cells.
 */
function computeCorridorDist(corridors, width, height) {
  const dist = new Grid2D(width, height, { fill: width + height });
  const queue = [];

  // Seed with all corridor polyline cells
  for (const corridor of corridors) {
    for (let i = 0; i < corridor.polyline.length - 1; i++) {
      const a = corridor.polyline[i];
      const b = corridor.polyline[i + 1];
      const dx = b.gx - a.gx, dz = b.gz - a.gz;
      const steps = Math.max(Math.abs(dx), Math.abs(dz)) || 1;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const gx = Math.round(a.gx + dx * t);
        const gz = Math.round(a.gz + dz * t);
        if (gx >= 0 && gx < width && gz >= 0 && gz < height) {
          if (dist.get(gx, gz) > 0) {
            dist.set(gx, gz, 0);
            queue.push(gx | (gz << 16));
          }
        }
      }
    }
  }

  // BFS
  const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
  let head = 0;
  const maxDist = Math.max(...corridors.map(c => c.corridorWidth)) * 2;
  while (head < queue.length) {
    const packed = queue[head++];
    const cx = packed & 0xFFFF;
    const cz = packed >> 16;
    const cd = dist.get(cx, cz);
    if (cd >= maxDist) continue;

    for (const [ddx, ddz] of dirs) {
      const nx = cx + ddx, nz = cz + ddz;
      if (nx < 0 || nx >= width || nz < 0 || nz >= height) continue;
      if (dist.get(nx, nz) > cd + 1) {
        dist.set(nx, nz, cd + 1);
        queue.push(nx | (nz << 16));
      }
    }
  }

  return dist;
}

/**
 * Gaussian influence field — 1.0 at corridor centre, falls to 0 at edges.
 * Each corridor has its own width; take the max influence at each cell.
 */
function computeCorridorInfluence(corridors, corridorDist, width, height) {
  const influence = new Grid2D(width, height);

  // For each corridor, compute its own gaussian and max into the influence grid.
  // Since corridorDist is the distance to the NEAREST corridor, we need per-corridor
  // distance for per-corridor width. Approximate: use corridorDist with the largest
  // corridor width (conservative — slightly wider suppression for smaller corridors).
  // This is acceptable because corridor count is small (1-3).
  const maxWidth = Math.max(...corridors.map(c => c.corridorWidth));
  const sigma = maxWidth / 3; // 3-sigma = full width

  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      const d = corridorDist.get(gx, gz);
      if (d >= maxWidth) continue;
      const g = Math.exp(-(d * d) / (2 * sigma * sigma));
      influence.set(gx, gz, Math.max(influence.get(gx, gz), g));
    }
  }

  return influence;
}
