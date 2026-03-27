/**
 * Incremental Street Layout
 *
 * Implements the algorithm from wiki/pages/incremental-street-layout.md.
 * Lays one street, checks it, creates the parcel, then lays the next.
 * Adapts streets at obstacles (truncate, don't reject).
 *
 * Entry point: layoutIncrementalStreets(zone, map, params)
 */

import { buildConstructionLines, buildGradientField } from './constructionLines.js';
import { buildParallelStreets } from './streets.js';
import { subdividePlots } from './plots.js';
import {
  countParallelViolations,
  countUnresolvedCrossings,
  countShortDeadEnds,
} from '../invariants/streetGeometryChecks.js';

const DEFAULT_PARAMS = {
  constructionSpacing: 90,   // metres between construction lines
  parcelDepth: 35,           // metres between parallel streets
  minStreetLength: 20,       // minimum street segment length
  minParcelDepth: 15,        // minimum parcel short side
  angleTolerance: Math.PI / 4, // ±45° from perpendicular to construction lines (wider for curved lines)
  minFrontage: 5,            // minimum plot frontage
  plotDepth: 10,             // minimum plot depth
  plotWidth: 10,             // target plot width along frontage
};

/**
 * @param {object} zone - Development zone with cells, centroidGx/Gz, boundary, slopeDir
 * @param {object} map  - FeatureMap with getLayer, width, height, cellSize, originX/Z
 * @param {object} [params] - Override any DEFAULT_PARAMS
 * @returns {{ constructionLines, streets, parcels, plots, wasteRatio, gradDir, contourDir }}
 */
export function layoutIncrementalStreets(zone, map, params = {}) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const cs = map.cellSize;
  const W = map.width;

  const zoneSet = new Set();
  for (const c of zone.cells) zoneSet.add(c.gz * W + c.gx);

  const { gradDir, contourDir } = computeGradient(zone, map, zoneSet);

  // Build per-cell gradient field for organic line tracing
  const gradField = buildGradientField(zone, map, zoneSet);

  // Phase 1: Construction lines (cross streets traced through gradient field)
  const constructionLines = buildConstructionLines(zone, map, gradDir, contourDir, zoneSet, p, gradField);

  // Phase 2: Parallel streets + parcels (incremental)
  const { streets, parcels } = buildParallelStreets(
    constructionLines, zone, map, gradDir, contourDir, zoneSet, p,
  );

  // Phase 3: Plot subdivision
  const plots = subdividePlots(parcels, p);

  // Waste ratio: fraction of buildable area not covered by parcels
  const buildableArea = zone.cells.length * cs * cs;
  let parcelArea = 0;
  for (const parcel of parcels) parcelArea += parcel.area;
  const wasteRatio = buildableArea > 0 ? 1 - Math.min(1, parcelArea / buildableArea) : 1;

  // Post-hoc diagnostics (tier 2 checks)
  const diagnostics = diagnose(constructionLines, streets, parcels, wasteRatio);

  return { constructionLines, streets, parcels, plots, wasteRatio, gradDir, contourDir, diagnostics };
}

/**
 * Post-hoc quality checks on the layout output.
 * These are the tier 2 metrics from the incremental street layout spec.
 */
export function diagnose(constructionLines, streets, parcels, wasteRatio) {
  // Convert construction lines to segments for streetGeometryChecks.
  // For curved polylines, sample segments between consecutive points
  // but at a coarser resolution (every ~10 points) to keep it tractable.
  const cLineSegments = [];
  for (const cl of constructionLines) {
    const pts = cl.points;
    if (!pts || pts.length < 2) continue;
    const step = Math.max(1, Math.floor(pts.length / 20));
    for (let i = step; i < pts.length; i += step) {
      cLineSegments.push([pts[i - step], pts[i]]);
    }
    // Always include last segment
    const last = pts.length - 1;
    const prevSample = Math.floor(last / step) * step;
    if (prevSample < last) {
      cLineSegments.push([pts[prevSample], pts[last]]);
    }
  }

  // Convert streets to segment format
  const streetSegments = streets.map(s => [s.start, s.end]);

  // All segments combined
  const allSegments = [...cLineSegments, ...streetSegments];

  // 1. Construction line convergence: check pairs of adjacent lines for minimum distance.
  // (Can't use countParallelViolations on mixed segments — intra-line segments are naturally close)
  let cLineConvergence = 0;
  for (let i = 0; i < constructionLines.length; i++) {
    for (let j = i + 1; j < constructionLines.length; j++) {
      const ptsA = constructionLines[i].points;
      const ptsB = constructionLines[j].points;
      if (!ptsA || !ptsB) continue;
      const stepA = Math.max(1, Math.floor(ptsA.length / 20));
      const stepB = Math.max(1, Math.floor(ptsB.length / 20));
      let tooClose = false;
      for (let ia = 0; ia < ptsA.length && !tooClose; ia += stepA) {
        for (let ib = 0; ib < ptsB.length && !tooClose; ib += stepB) {
          const dx = ptsA[ia].x - ptsB[ib].x;
          const dz = ptsA[ia].z - ptsB[ib].z;
          if (dx * dx + dz * dz < 25) tooClose = true; // < 5m
        }
      }
      if (tooClose) cLineConvergence++;
    }
  }

  // 2. Street separation violations: parallel violations among street segments only
  // (cLine segments inflate the count with intra-polyline matches)
  const parallelViolations = countParallelViolations(streetSegments, 5, 15);

  // 3. Unresolved crossings among streets (not construction lines — those form junctions by design)
  const unresolvedCrossings = countUnresolvedCrossings(streetSegments, 3);

  // 4. Short dead-ends among streets
  const shortDeadEnds = countShortDeadEnds(streetSegments, 15, 5);

  // 5. Junction duplication: count junction pairs < 5m apart
  const junctions = [];
  for (const s of streets) {
    junctions.push(s.start);
    junctions.push(s.end);
  }
  // 5. Junction duplication: pairs that are near (< 5m) but NOT shared (> 0.5m).
  // Shared junctions (same coordinates, distance ~0) are correctly reused, not violations.
  let duplicateJunctions = 0;
  for (let i = 0; i < junctions.length; i++) {
    for (let j = i + 1; j < junctions.length; j++) {
      const dx = junctions[i].x - junctions[j].x;
      const dz = junctions[i].z - junctions[j].z;
      const distSq = dx * dx + dz * dz;
      if (distSq > 0.25 && distSq < 25) { // between 0.5m and 5m
        duplicateJunctions++;
      }
    }
  }

  // 6. Parcel aspect ratio violations
  let sliverParcels = 0;
  for (const p of parcels) {
    if (p.ratio < 0.1 || p.ratio > 10) sliverParcels++;
  }

  // Aggregate pass/fail
  const passed = cLineConvergence === 0
    && parallelViolations === 0
    && unresolvedCrossings === 0
    && duplicateJunctions === 0
    && sliverParcels === 0
    && wasteRatio < 0.4;

  return {
    passed,
    cLineConvergence,
    parallelViolations,
    unresolvedCrossings,
    shortDeadEnds,
    duplicateJunctions,
    sliverParcels,
    wasteRatio,
  };
}

/**
 * Compute average gradient direction from elevation within the zone.
 * Returns the gradient (uphill) direction and the contour (perpendicular) direction.
 */
export function computeGradient(zone, map, zoneSet) {
  const cs = map.cellSize;
  const W = map.width;
  const elev = map.getLayer('elevation');

  let sumDx = 0, sumDz = 0, count = 0;

  if (elev) {
    for (const c of zone.cells) {
      const eC = elev.get(c.gx, c.gz);
      const eE = zoneSet.has(c.gz * W + (c.gx + 1)) ? elev.get(c.gx + 1, c.gz) : eC;
      const eW = zoneSet.has(c.gz * W + (c.gx - 1)) ? elev.get(c.gx - 1, c.gz) : eC;
      const eS = zoneSet.has((c.gz + 1) * W + c.gx) ? elev.get(c.gx, c.gz + 1) : eC;
      const eN = zoneSet.has((c.gz - 1) * W + c.gx) ? elev.get(c.gx, c.gz - 1) : eC;
      sumDx += (eE - eW) / (2 * cs);
      sumDz += (eS - eN) / (2 * cs);
      count++;
    }
  }

  let gx = count > 0 ? sumDx / count : 0;
  let gz = count > 0 ? sumDz / count : 0;
  const mag = Math.sqrt(gx * gx + gz * gz);

  if (mag < 1e-6) {
    if (zone.slopeDir && (zone.slopeDir.x !== 0 || zone.slopeDir.z !== 0)) {
      gx = zone.slopeDir.x;
      gz = zone.slopeDir.z;
    } else {
      gx = 1; gz = 0;
    }
  } else {
    gx /= mag;
    gz /= mag;
  }

  return {
    gradDir: { x: gx, z: gz },
    contourDir: { x: -gz, z: gx },
  };
}
