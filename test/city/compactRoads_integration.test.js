import { describe, it, expect } from 'vitest';
import { setupCity } from '../../src/city/setup.js';
import { buildSkeleton, compactRoads } from '../../src/city/skeleton.js';
import { generateRegion } from '../../src/regional/pipeline.js';
import { SeededRandom } from '../../src/core/rng.js';

function makeCity(seed = 42) {
  const rng = new SeededRandom(seed);
  const coastEdge = ['north', 'south', 'east', 'west', null][rng.int(0, 4)];
  const layers = generateRegion({
    width: 128, height: 128, cellSize: 50, seaLevel: 0, coastEdge,
  }, rng);
  const settlements = layers.getData('settlements');
  if (!settlements || settlements.length === 0) return null;

  const cityRng = rng.fork('city');
  return setupCity(layers, settlements[0], cityRng);
}

function countParallel(roads, snapDist) {
  let count = 0;
  const snapDistSq = snapDist * snapDist;
  for (let i = 0; i < roads.length; i++) {
    const si = roads[i].polyline[0], ei = roads[i].polyline[roads[i].polyline.length - 1];
    for (let j = i + 1; j < roads.length; j++) {
      const sj = roads[j].polyline[0], ej = roads[j].polyline[roads[j].polyline.length - 1];
      // Share start, other ends close
      if (si.x === sj.x && si.z === sj.z) {
        const dx = ei.x - ej.x, dz = ei.z - ej.z;
        if (dx * dx + dz * dz <= snapDistSq) { count++; continue; }
      }
      // Share end, other ends close
      if (ei.x === ej.x && ei.z === ej.z) {
        const dx = si.x - sj.x, dz = si.z - sj.z;
        if (dx * dx + dz * dz <= snapDistSq) { count++; continue; }
      }
      // Share start/end cross
      if (si.x === ej.x && si.z === ej.z) {
        const dx = ei.x - sj.x, dz = ei.z - sj.z;
        if (dx * dx + dz * dz <= snapDistSq) { count++; continue; }
      }
      if (ei.x === sj.x && ei.z === sj.z) {
        const dx = si.x - ej.x, dz = si.z - ej.z;
        if (dx * dx + dz * dz <= snapDistSq) { count++; continue; }
      }
    }
  }
  return count;
}

// Detect geometrically parallel roads: every point on the shorter road
// is within `corridorDist` of the longer road's polyline.
function findGeometricParallels(roads, corridorDist) {
  const pairs = [];

  function ptToPolylineDist(px, pz, polyline) {
    let minD = Infinity;
    for (let k = 0; k < polyline.length - 1; k++) {
      const ax = polyline[k].x, az = polyline[k].z;
      const bx = polyline[k + 1].x, bz = polyline[k + 1].z;
      const dx = bx - ax, dz = bz - az;
      const lenSq = dx * dx + dz * dz;
      let t = lenSq > 0 ? ((px - ax) * dx + (pz - az) * dz) / lenSq : 0;
      t = Math.max(0, Math.min(1, t));
      const cx = ax + t * dx, cz = az + t * dz;
      const d = Math.sqrt((px - cx) ** 2 + (pz - cz) ** 2);
      if (d < minD) minD = d;
    }
    return minD;
  }

  function polylineLength(poly) {
    let len = 0;
    for (let i = 1; i < poly.length; i++) {
      len += Math.sqrt((poly[i].x - poly[i - 1].x) ** 2 + (poly[i].z - poly[i - 1].z) ** 2);
    }
    return len;
  }

  for (let i = 0; i < roads.length; i++) {
    for (let j = i + 1; j < roads.length; j++) {
      const pi = roads[i].polyline, pj = roads[j].polyline;
      // Check shorter road against longer
      const [shorter, longer] = polylineLength(pi) <= polylineLength(pj) ? [pi, pj] : [pj, pi];

      // Sample the shorter road at each vertex
      let allClose = true;
      for (const pt of shorter) {
        if (ptToPolylineDist(pt.x, pt.z, longer) > corridorDist) {
          allClose = false;
          break;
        }
      }
      if (allClose && shorter.length >= 2) {
        pairs.push({ i, j, roadI: roads[i], roadJ: roads[j] });
      }
    }
  }
  return pairs;
}

describe('compactRoads integration', () => {
  it('reduces parallel roads on a real map', () => {
    const map = makeCity(652341);
    if (!map) return;

    buildSkeleton(map);

    const skeletonRoads = map.roads.filter(r => r.source === 'skeleton');
    const snapDist = map.cellSize * 1.5;
    const parallelAfter = countParallel(skeletonRoads, snapDist);

    console.log('After skeleton: roads:', skeletonRoads.length, 'parallel (fan):', parallelAfter);

    // Geometric parallel check — roads running alongside each other
    const geoParallels = findGeometricParallels(skeletonRoads, snapDist);
    // Filter: only pairs that don't share ANY endpoint
    const trueParallels = geoParallels.filter(p => {
      const si = p.roadI.polyline[0], ei = p.roadI.polyline[p.roadI.polyline.length - 1];
      const sj = p.roadJ.polyline[0], ej = p.roadJ.polyline[p.roadJ.polyline.length - 1];
      const sharesEndpoint = (si.x === sj.x && si.z === sj.z) ||
                             (si.x === ej.x && si.z === ej.z) ||
                             (ei.x === sj.x && ei.z === sj.z) ||
                             (ei.x === ej.x && ei.z === ej.z);
      return !sharesEndpoint;
    });
    console.log('Geometric parallels (total):', geoParallels.length, 'no shared endpoint:', trueParallels.length);
    for (const p of trueParallels.slice(0, 15)) {
      const ri = p.roadI, rj = p.roadJ;
      const si = ri.polyline[0], ei = ri.polyline[ri.polyline.length - 1];
      const sj = rj.polyline[0], ej = rj.polyline[rj.polyline.length - 1];
      console.log(`  ${ri.hierarchy}(${si.x},${si.z})→(${ei.x},${ei.z}) pts=${ri.polyline.length}`
        + ` || ${rj.hierarchy}(${sj.x},${sj.z})→(${ej.x},${ej.z}) pts=${rj.polyline.length}`);
    }

    expect(parallelAfter).toBe(0);
  });
});
