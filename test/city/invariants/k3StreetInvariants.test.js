/**
 * k3 street geometry invariant tests.
 *
 * Runs the k3 algorithm on real seeds and checks world-state invariants
 * against the generated street geometry. These tests are EXPECTED TO FAIL
 * on some seeds — they document violations that need fixing.
 *
 * Invariants tested:
 * 1. Minimum parallel separation (5m) — no two parallel streets within 5m
 * 2. No unresolved crossings — streets don't cross existing roads without junctions
 * 3. No short dead ends (<15m) — stubs too short to serve plots
 * 4. Junction elevation consistency — connected junctions should be at similar elevation
 * 5. Streets within zone boundary — no street extends beyond the zone polygon
 *
 * See wiki/pages/world-state-invariants.md and wiki/pages/road-network-invariants.md
 */

import { describe, it, expect } from 'vitest';
import { generateRegionFromSeed } from '../../../src/ui/regionHelper.js';
import { setupCity } from '../../../src/city/setup.js';
import { LandFirstDevelopment } from '../../../src/city/strategies/landFirstDevelopment.js';
import { ARCHETYPES } from '../../../src/city/archetypes.js';
import { SeededRandom } from '../../../src/core/rng.js';
import { runToStep } from '../../../scripts/pipeline-utils.js';
import {
  countParallelViolations,
  countUnresolvedCrossings,
  countShortDeadEnds,
} from '../../../src/city/invariants/streetGeometryChecks.js';

// ── k3 algorithm (extracted from render-k3-survey.js) ─────────────────────

function runK3OnZone(zone, map) {
  const W = map.width, H = map.height;
  const cs = map.cellSize;
  const ox = map.originX, oz = map.originZ;
  const elev = map.getLayer('elevation');
  const roadGrid = map.getLayer('roadGrid');

  const zoneSet = new Set();
  for (const c of zone.cells) zoneSet.add(c.gz * W + c.gx);

  // Elevation quartile face segmentation (as per 007k3)
  const elevations = zone.cells.map(c => elev.get(c.gx, c.gz)).sort((a, b) => a - b);
  const q25 = elevations[Math.floor(elevations.length * 0.25)];
  const q50 = elevations[Math.floor(elevations.length * 0.50)];
  const q75 = elevations[Math.floor(elevations.length * 0.75)];
  const thresholds = [q25, q50, q75];

  const bandGrid = new Int8Array(W * H).fill(-1);
  for (const c of zone.cells) {
    const e = elev.get(c.gx, c.gz);
    let band = 0;
    for (const t of thresholds) { if (e >= t) band++; }
    bandGrid[c.gz * W + c.gx] = band;
  }

  const visited = new Uint8Array(W * H);
  const faces = [];
  for (const c of zone.cells) {
    const idx = c.gz * W + c.gx;
    if (visited[idx]) continue;
    const band = bandGrid[idx];
    if (band < 0) continue;
    const cells = [];
    const queue = [{ gx: c.gx, gz: c.gz }];
    visited[idx] = 1;
    while (queue.length > 0) {
      const p = queue.shift();
      cells.push(p);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = p.gx + dx, nz = p.gz + dz;
        if (nx < 0 || nx >= W || nz < 0 || nz >= H) continue;
        const ni = nz * W + nx;
        if (visited[ni] || bandGrid[ni] !== band) continue;
        visited[ni] = 1;
        queue.push({ gx: nx, gz: nz });
      }
    }
    if (cells.length >= 500) faces.push({ cells, band });
  }

  const CROSS_SPACING = 90;
  const PARALLEL_SPACING = 35;
  const MIN_STREET_LEN = 20;
  const allCross = [];
  const allParallel = [];
  const allJunctions = [];

  for (const face of faces) {
    const faceSet = new Set(face.cells.map(c => c.gz * W + c.gx));
    let sumDx = 0, sumDz = 0, gradCount = 0;
    for (const c of face.cells) {
      const eC = elev.get(c.gx, c.gz);
      const eE = faceSet.has(c.gz * W + (c.gx + 1)) ? elev.get(c.gx + 1, c.gz) : eC;
      const eW2 = faceSet.has(c.gz * W + (c.gx - 1)) ? elev.get(c.gx - 1, c.gz) : eC;
      const eS = faceSet.has((c.gz + 1) * W + c.gx) ? elev.get(c.gx, c.gz + 1) : eC;
      const eN = faceSet.has((c.gz - 1) * W + c.gx) ? elev.get(c.gx, c.gz - 1) : eC;
      sumDx += (eE - eW2) / (2 * cs);
      sumDz += (eS - eN) / (2 * cs);
      gradCount++;
    }
    if (gradCount === 0) continue;
    let gradX = sumDx / gradCount, gradZ = sumDz / gradCount;
    const gradMag = Math.sqrt(gradX * gradX + gradZ * gradZ);
    if (gradMag < 1e-6) {
      if (zone.slopeDir) { gradX = zone.slopeDir.x; gradZ = zone.slopeDir.z; }
      else continue;
    } else { gradX /= gradMag; gradZ /= gradMag; }

    const ctX = -gradZ, ctZ = gradX;
    let cxSum = 0, czSum = 0;
    for (const c of face.cells) { cxSum += c.gx; czSum += c.gz; }
    const faceCx = ox + (cxSum / face.cells.length) * cs;
    const faceCz = oz + (czSum / face.cells.length) * cs;

    let minCt = Infinity, maxCt = -Infinity, minGr = Infinity, maxGr = -Infinity;
    for (const c of face.cells) {
      const wx = ox + c.gx * cs, wz = oz + c.gz * cs;
      const projCt = (wx - faceCx) * ctX + (wz - faceCz) * ctZ;
      const projGr = (wx - faceCx) * gradX + (wz - faceCz) * gradZ;
      if (projCt < minCt) minCt = projCt;
      if (projCt > maxCt) maxCt = projCt;
      if (projGr < minGr) minGr = projGr;
      if (projGr > maxGr) maxGr = projGr;
    }

    const crossStreets = [];
    const firstCt = Math.ceil(minCt / CROSS_SPACING) * CROSS_SPACING;
    for (let ctOff = firstCt; ctOff <= maxCt + 1e-6; ctOff += CROSS_SPACING) {
      const lineOx = faceCx + ctX * ctOff, lineOz = faceCz + ctZ * ctOff;
      const step = cs * 0.5;
      const reach = (maxGr - minGr) + cs * 2;
      const nSteps = Math.ceil(reach / step);
      const inFacePoints = [];
      for (let si = -nSteps; si <= nSteps; si++) {
        const grOff = si * step;
        const wx = lineOx + gradX * grOff, wz = lineOz + gradZ * grOff;
        const cgx = Math.round((wx - ox) / cs), cgz = Math.round((wz - oz) / cs);
        if (cgx < 0 || cgx >= W || cgz < 0 || cgz >= H) continue;
        inFacePoints.push({ wx, wz, grOff, inFace: faceSet.has(cgz * W + cgx), cgx, cgz });
      }
      let bestRun = [], curRun = [];
      for (const pt of inFacePoints) {
        if (pt.inFace) { curRun.push(pt); }
        else { if (curRun.length > bestRun.length) bestRun = curRun; curRun = []; }
      }
      if (curRun.length > bestRun.length) bestRun = curRun;
      if (bestRun.length < 2) continue;
      const segStart = bestRun[0], segEnd = bestRun[bestRun.length - 1];
      const segLen = Math.hypot(segEnd.wx - segStart.wx, segEnd.wz - segStart.wz);
      if (segLen < MIN_STREET_LEN) continue;
      allCross.push([{ x: segStart.wx, z: segStart.wz }, { x: segEnd.wx, z: segEnd.wz }]);

      const junctions = [];
      let distAccum = 0;
      for (let si = 0; si < bestRun.length; si++) {
        if (si > 0) distAccum += Math.hypot(bestRun[si].wx - bestRun[si-1].wx, bestRun[si].wz - bestRun[si-1].wz);
        if (distAccum < PARALLEL_SPACING) continue;
        distAccum = 0;
        const e = elev.get(bestRun[si].cgx, bestRun[si].cgz);
        junctions.push({ x: bestRun[si].wx, z: bestRun[si].wz, elev: e });
      }
      crossStreets.push({ ctOff, junctions });
    }

    crossStreets.sort((a, b) => a.ctOff - b.ctOff);
    for (const cs_ of crossStreets) {
      for (const pt of cs_.junctions) allJunctions.push(pt);
    }
    // Connect junctions by closest elevation (not sequential index)
    for (let k = 0; k < crossStreets.length - 1; k++) {
      const jA = crossStreets[k].junctions, jB = crossStreets[k + 1].junctions;
      const usedB = new Set();
      for (const pA of jA) {
        let bestIdx = -1, bestElevDiff = Infinity;
        for (let bi = 0; bi < jB.length; bi++) {
          if (usedB.has(bi)) continue;
          const diff = Math.abs(pA.elev - jB[bi].elev);
          if (diff < bestElevDiff) { bestElevDiff = diff; bestIdx = bi; }
        }
        if (bestIdx < 0) continue;
        const pB = jB[bestIdx];
        usedB.add(bestIdx);
        const segLen = Math.hypot(pB.x - pA.x, pB.z - pA.z);
        if (segLen < MIN_STREET_LEN) continue;
        if (bestElevDiff / segLen > 0.15) continue; // Skip steep connections
        allParallel.push([{ x: pA.x, z: pA.z }, { x: pB.x, z: pB.z }]);
      }
    }
  }

  // Post-process: remove parallel streets within 5m of each other
  for (let i = allParallel.length - 1; i >= 0; i--) {
    const midI = {
      x: (allParallel[i][0].x + allParallel[i][1].x) / 2,
      z: (allParallel[i][0].z + allParallel[i][1].z) / 2,
    };
    const angleI = Math.atan2(allParallel[i][1].z - allParallel[i][0].z, allParallel[i][1].x - allParallel[i][0].x);
    for (let j = 0; j < i; j++) {
      const angleJ = Math.atan2(allParallel[j][1].z - allParallel[j][0].z, allParallel[j][1].x - allParallel[j][0].x);
      let angleDiff = Math.abs(angleI - angleJ);
      if (angleDiff > Math.PI) angleDiff = 2 * Math.PI - angleDiff;
      if (angleDiff > Math.PI / 12) continue;
      const a = allParallel[j][0], b = allParallel[j][1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const lenSq = dx * dx + dz * dz;
      if (lenSq === 0) continue;
      let t = ((midI.x - a.x) * dx + (midI.z - a.z) * dz) / lenSq;
      t = Math.max(0, Math.min(1, t));
      const dist = Math.hypot(midI.x - (a.x + t * dx), midI.z - (a.z + t * dz));
      if (dist < 5) { allParallel.splice(i, 1); break; }
    }
  }

  // Remove self-crossings — for each crossing pair, remove the shorter segment
  function segIntersect(a0, a1, b0, b1) {
    const dax = a1.x - a0.x, daz = a1.z - a0.z;
    const dbx = b1.x - b0.x, dbz = b1.z - b0.z;
    const det = dax * dbz - daz * dbx;
    if (Math.abs(det) < 1e-10) return false;
    const dx = b0.x - a0.x, dz = b0.z - a0.z;
    const t = (dx * dbz - dz * dbx) / det;
    const u = (dx * daz - dz * dax) / det;
    return t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98;
  }

  const allK3 = [...allCross, ...allParallel];
  const rmCross = new Set(), rmParallel = new Set();
  for (let i = 0; i < allK3.length; i++) {
    for (let j = i + 1; j < allK3.length; j++) {
      if (segIntersect(allK3[i][0], allK3[i][1], allK3[j][0], allK3[j][1])) {
        const lenI = Math.hypot(allK3[i][1].x - allK3[i][0].x, allK3[i][1].z - allK3[i][0].z);
        const lenJ = Math.hypot(allK3[j][1].x - allK3[j][0].x, allK3[j][1].z - allK3[j][0].z);
        const rm = lenI < lenJ ? i : j;
        if (rm < allCross.length) rmCross.add(rm); else rmParallel.add(rm - allCross.length);
      }
    }
  }
  for (let i = allCross.length - 1; i >= 0; i--) { if (rmCross.has(i)) allCross.splice(i, 1); }
  for (let i = allParallel.length - 1; i >= 0; i--) { if (rmParallel.has(i)) allParallel.splice(i, 1); }

  // Clip at existing roads
  const existingRoads = [];
  if (roadGrid) {
    for (const road of (map.roads || [])) {
      const pts = road.polyline || road.points || [];
      for (let i = 0; i < pts.length - 1; i++) {
        existingRoads.push([{ x: pts[i].x, z: pts[i].z }, { x: pts[i+1].x, z: pts[i+1].z }]);
      }
    }
  }

  // Clip k3 segments at road cells
  const clipAtRoads = (segments) => {
    if (!roadGrid) return segments;
    const result = [];
    for (const seg of segments) {
      const dx = seg[1].x - seg[0].x, dz = seg[1].z - seg[0].z;
      const len = Math.hypot(dx, dz);
      if (len < 1) { result.push(seg); continue; }
      const stepLen = cs * 0.5;
      const nSteps = Math.ceil(len / stepLen);
      let lastClean = seg[0], hitRoad = false;
      for (let s = 1; s <= nSteps; s++) {
        const t = Math.min(s / nSteps, 1);
        const px = seg[0].x + dx * t, pz = seg[0].z + dz * t;
        const gx2 = Math.round((px - ox) / cs), gz2 = Math.round((pz - oz) / cs);
        if (gx2 >= 0 && gx2 < W && gz2 >= 0 && gz2 < H && roadGrid.get(gx2, gz2) > 0) {
          const clipLen = Math.hypot(px - lastClean.x, pz - lastClean.z);
          if (clipLen >= MIN_STREET_LEN) result.push([{ ...lastClean }, { x: px, z: pz }]);
          hitRoad = true;
          while (s < nSteps) {
            s++;
            const t2 = Math.min(s / nSteps, 1);
            const px2 = seg[0].x + dx * t2, pz2 = seg[0].z + dz * t2;
            const gx3 = Math.round((px2 - ox) / cs), gz3 = Math.round((pz2 - oz) / cs);
            if (gx3 < 0 || gx3 >= W || gz3 < 0 || gz3 >= H || roadGrid.get(gx3, gz3) === 0) {
              lastClean = { x: px2, z: pz2 }; break;
            }
          }
        }
      }
      const fl = Math.hypot(seg[1].x - lastClean.x, seg[1].z - lastClean.z);
      if (fl >= MIN_STREET_LEN) result.push([{ ...lastClean }, { ...seg[1] }]);
      else if (!hitRoad) result.push(seg);
    }
    return result;
  };
  const clippedCross = clipAtRoads(allCross);
  const clippedPar = clipAtRoads(allParallel);
  allCross.length = 0; allCross.push(...clippedCross);
  allParallel.length = 0; allParallel.push(...clippedPar);

  return { allCross, allParallel, allJunctions, existingRoads, faces };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function setupAndRun(seed, gx, gz) {
  const { layers, settlement } = generateRegionFromSeed(seed, gx, gz);
  if (!settlement) return null;
  const rng = new SeededRandom(seed);
  const map = setupCity(layers, settlement, rng.fork('city'));
  const strategy = new LandFirstDevelopment(map, { archetype: ARCHETYPES.marketTown });
  runToStep(strategy, 'spatial');

  const zones = map.developmentZones || [];
  const candidates = zones.filter(z =>
    z.cells.length > 2000 && z.cells.length < 50000 &&
    z.boundary && z.boundary.length >= 4 && z.avgSlope !== undefined
  );
  candidates.sort((a, b) => {
    const W = map.width, H = map.height;
    const ad = Math.abs(a.centroidGx - W / 2) + Math.abs(a.centroidGz - H / 2);
    const bd = Math.abs(b.centroidGx - W / 2) + Math.abs(b.centroidGz - H / 2);
    return ad - bd;
  });

  if (candidates.length === 0) return null;

  // Test up to 3 zones (not just the first) to catch cross-face issues
  const allCross = [], allParallel = [], allJunctions = [], existingRoads = [];
  let faces = [];
  for (let zi = 0; zi < Math.min(candidates.length, 3); zi++) {
    const k3 = runK3OnZone(candidates[zi], map);
    allCross.push(...k3.allCross);
    allParallel.push(...k3.allParallel);
    allJunctions.push(...k3.allJunctions);
    if (zi === 0) existingRoads.push(...k3.existingRoads);
    faces.push(...k3.faces);
  }
  return { map, zone: candidates[0], allCross, allParallel, allJunctions, existingRoads, faces };
}

// ── Tests ─────────────────────────────────────────────────────────────────

const TEST_CASES = [
  { seed: 884469, gx: 27, gz: 95 },
  { seed: 42, gx: 15, gz: 50 },
  { seed: 12345, gx: 20, gz: 60 },
];

for (const { seed, gx, gz } of TEST_CASES) {
  describe(`k3 street invariants (seed ${seed})`, { timeout: 60000 }, () => {
    let result;

    it('produces k3 output', () => {
      result = setupAndRun(seed, gx, gz);
      expect(result).not.toBeNull();
      expect(result.allCross.length).toBeGreaterThan(0);
      expect(result.allParallel.length).toBeGreaterThan(0);
    });

    // ── Invariant 1: Minimum parallel separation ──

    it('no parallel streets within 5m of each other', () => {
      if (!result) return;
      const violations = countParallelViolations(result.allParallel, 5, 15);
      expect(violations, `${violations} parallel street pairs within 5m`).toBe(0);
    });

    // ── Invariant 2a: No unresolved crossings with existing roads ──

    it('k3 streets do not cross existing roads without junctions', () => {
      if (!result) return;
      const k3Segments = [...result.allCross, ...result.allParallel];
      const crossings = countUnresolvedCrossings([...k3Segments, ...result.existingRoads], 3);
      const k3SelfCrossings = countUnresolvedCrossings(k3Segments, 3);
      const roadCrossings = crossings - k3SelfCrossings;
      expect(roadCrossings, `${roadCrossings} k3 streets cross existing roads`).toBe(0);
    });

    // ── Invariant 2b: No self-crossings between k3 streets ──

    it('k3 streets do not cross each other without junctions', () => {
      if (!result) return;
      const k3Segments = [...result.allCross, ...result.allParallel];
      const selfCrossings = countUnresolvedCrossings(k3Segments, 3);
      expect(selfCrossings, `${selfCrossings} k3 street self-crossings`).toBe(0);
    });

    // ── Invariant 3: No short dead ends ──

    it('no k3 street segments shorter than 15m', () => {
      if (!result) return;
      const allSegments = [...result.allCross, ...result.allParallel];
      const violations = countShortDeadEnds(allSegments, 15, 3);
      expect(violations, `${violations} street segments shorter than 15m`).toBe(0);
    });

    // ── Invariant 4: Junction elevation consistency ──

    it('connected parallel junctions are at similar elevation', () => {
      if (!result) return;
      // For each parallel street (connecting two junctions), check that
      // the elevation difference is reasonable (< 10m for a 35m street)
      let violations = 0;
      const elev = result.map.getLayer('elevation');
      const cs = result.map.cellSize;
      const ox = result.map.originX, oz = result.map.originZ;
      for (const seg of result.allParallel) {
        const gxA = Math.round((seg[0].x - ox) / cs);
        const gzA = Math.round((seg[0].z - oz) / cs);
        const gxB = Math.round((seg[1].x - ox) / cs);
        const gzB = Math.round((seg[1].z - oz) / cs);
        if (gxA < 0 || gxA >= result.map.width || gzA < 0 || gzA >= result.map.height) continue;
        if (gxB < 0 || gxB >= result.map.width || gzB < 0 || gzB >= result.map.height) continue;
        const elevA = elev.get(gxA, gzA);
        const elevB = elev.get(gxB, gzB);
        const elevDiff = Math.abs(elevA - elevB);
        const streetLen = Math.hypot(seg[1].x - seg[0].x, seg[1].z - seg[0].z);
        // Max reasonable gradient: 15% (steep residential street)
        const maxElevDiff = streetLen * 0.15;
        if (elevDiff > maxElevDiff) violations++;
      }
      expect(violations, `${violations} parallel streets with excessive elevation change`).toBe(0);
    });

    // ── Invariant 5: k3 streets within zone ──

    // NOTE: zone boundary check removed from multi-zone test — each zone's
    // streets are generated within that zone, but this test aggregates streets
    // from multiple zones. Per-zone boundary checking needs per-zone street tracking.
  });
}
