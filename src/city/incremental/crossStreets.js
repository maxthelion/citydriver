/**
 * Cross Streets — Contour-axis sweep with gradient-direction scan.
 *
 * Seeds at ~90m intervals along the contour axis. For each seed,
 * scans along the gradient to find in-zone runs. Each run becomes
 * a cross street. Roads split zones into separate runs.
 *
 * Lines are straight rays in the gradient direction. Skeleton road
 * perpendicular pull is not yet implemented (per-line direction
 * approach preserved spacing but added complexity for little visual gain).
 */

export function layCrossStreets(zone, map, params = {}) {
  const p = {
    spacing: 90,
    stepSize: 2.5,
    minLength: 20,
    minSeparation: 5,
    ...params,
  };

  const cs = map.cellSize;
  const W = map.width, H = map.height;
  const ox = map.originX, oz = map.originZ;

  const zoneSet = new Set();
  for (const c of zone.cells) zoneSet.add(c.gz * W + c.gx);

  const gradDir = computeZoneGradient(zone, map, zoneSet);
  const contourDir = { x: -gradDir.z, z: gradDir.x };

  const waterMask = map.getLayer('waterMask');
  const roadGrid = map.getLayer('roadGrid');

  // Contour-axis sweep
  const zoneCx = ox + zone.centroidGx * cs;
  const zoneCz = oz + zone.centroidGz * cs;

  let minCt = Infinity, maxCt = -Infinity;
  for (const c of zone.cells) {
    const wx = ox + c.gx * cs;
    const wz = oz + c.gz * cs;
    const projCt = (wx - zoneCx) * contourDir.x + (wz - zoneCz) * contourDir.z;
    if (projCt < minCt) minCt = projCt;
    if (projCt > maxCt) maxCt = projCt;
  }

  const offsets = [];
  const firstCt = Math.ceil(minCt / p.spacing) * p.spacing;
  for (let ct = firstCt; ct <= maxCt + 1e-6; ct += p.spacing) {
    offsets.push(ct);
  }
  if (offsets.length === 0 || offsets[0] - minCt > p.spacing * 0.3) {
    offsets.unshift(minCt);
  }
  if (offsets.length === 0 || maxCt - offsets[offsets.length - 1] > p.spacing * 0.3) {
    offsets.push(maxCt);
  }
  offsets.sort((a, b) => a - b);

  const filtered = [offsets[0]];
  for (let i = 1; i < offsets.length; i++) {
    if (offsets[i] - filtered[filtered.length - 1] >= p.spacing * 0.3) {
      filtered.push(offsets[i]);
    }
  }

  // Scan each offset for zone runs, keep as cross streets
  const allLines = [];

  for (const ctOff of filtered) {
    const seedX = zoneCx + contourDir.x * ctOff;
    const seedZ = zoneCz + contourDir.z * ctOff;

    const runs = findZoneRuns(
      seedX, seedZ, gradDir, zoneSet, waterMask, roadGrid,
      cs, W, H, ox, oz,
    );

    for (const run of runs) {
      if (run.length < 2) continue;
      const points = run.map(pt => ({ x: pt.x, z: pt.z }));
      const length = arcLength(points);
      if (length < p.minLength) continue;
      allLines.push({ points, length, ctOff });
    }
  }

  const crossStreets = pruneConverging(allLines, p.minSeparation);
  return { crossStreets, gradDir, contourDir };
}

function computeZoneGradient(zone, map, zoneSet) {
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
      return { x: zone.slopeDir.x, z: zone.slopeDir.z };
    }
    return { x: 1, z: 0 };
  }
  return { x: gx / mag, z: gz / mag };
}

function findZoneRuns(targetX, targetZ, gradDir, zoneSet, waterMask, roadGrid, cs, W, H, ox, oz) {
  const step = cs * 0.5;
  const maxScan = 500;

  const allPoints = [];
  for (let si = -maxScan; si <= maxScan; si++) {
    const wx = targetX + gradDir.x * si * step;
    const wz = targetZ + gradDir.z * si * step;
    const cgx = Math.round((wx - ox) / cs);
    const cgz = Math.round((wz - oz) / cs);
    if (cgx < 0 || cgx >= W || cgz < 0 || cgz >= H) continue;

    const inZone = zoneSet.has(cgz * W + cgx);
    const isWater = waterMask && waterMask.get(cgx, cgz) > 0;
    const isRoad = roadGrid && roadGrid.get(cgx, cgz) > 0;

    allPoints.push({ x: wx, z: wz, inZone, isWater, isRoad });
  }

  const runs = [];
  let curRun = [];

  for (const pt of allPoints) {
    if (pt.inZone && !pt.isWater) {
      curRun.push(pt);
    } else if (pt.isRoad && curRun.length > 0) {
      curRun.push(pt);
      runs.push(curRun);
      curRun = [];
    } else {
      if (curRun.length > 0) runs.push(curRun);
      curRun = [];
    }
  }
  if (curRun.length > 0) runs.push(curRun);

  runs.sort((a, b) => b.length - a.length);
  return runs;
}

function arcLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.sqrt(
      (points[i].x - points[i - 1].x) ** 2 +
      (points[i].z - points[i - 1].z) ** 2,
    );
  }
  return len;
}

function pruneConverging(lines, minSeparation) {
  if (lines.length < 2) return lines;
  const keep = new Array(lines.length).fill(true);
  const minDistSq = minSeparation * minSeparation;

  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) continue;
    for (let j = i + 1; j < lines.length; j++) {
      if (!keep[j]) continue;
      if (polylinesConverge(lines[i].points, lines[j].points, minDistSq)) {
        if (lines[i].length < lines[j].length) {
          keep[i] = false;
          break;
        } else {
          keep[j] = false;
        }
      }
    }
  }

  return lines.filter((_, i) => keep[i]);
}

function polylinesConverge(ptsA, ptsB, minDistSq) {
  const stepA = Math.max(1, Math.floor(ptsA.length / 20));
  const stepB = Math.max(1, Math.floor(ptsB.length / 20));

  for (let ia = 0; ia < ptsA.length; ia += stepA) {
    for (let ib = 0; ib < ptsB.length; ib += stepB) {
      const dx = ptsA[ia].x - ptsB[ib].x;
      const dz = ptsA[ia].z - ptsB[ib].z;
      if (dx * dx + dz * dz < minDistSq) return true;
    }
  }
  return false;
}
