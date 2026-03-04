import { pointToSegmentDist, distance2D, polygonArea } from '../core/math.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function polylineLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += distance2D(points[i - 1].x, points[i - 1].z, points[i].x, points[i].z);
  }
  return len;
}

function minDistToPolyline(px, pz, points) {
  let min = Infinity;
  for (let i = 1; i < points.length; i++) {
    const d = pointToSegmentDist(px, pz, points[i - 1].x, points[i - 1].z, points[i].x, points[i].z);
    if (d < min) min = d;
  }
  return min;
}

function minDistBetweenPolylines(ptsA, ptsB) {
  let min = Infinity;
  for (let i = 1; i < ptsA.length; i++) {
    for (let j = 1; j < ptsB.length; j++) {
      const d = segmentToSegmentDist(
        ptsA[i - 1].x, ptsA[i - 1].z, ptsA[i].x, ptsA[i].z,
        ptsB[j - 1].x, ptsB[j - 1].z, ptsB[j].x, ptsB[j].z,
      );
      if (d < min) min = d;
    }
  }
  return min;
}

function segmentToSegmentDist(ax1, az1, ax2, az2, bx1, bz1, bx2, bz2) {
  // Min of all point-to-segment distances (exact for non-intersecting segments)
  return Math.min(
    pointToSegmentDist(ax1, az1, bx1, bz1, bx2, bz2),
    pointToSegmentDist(ax2, az2, bx1, bz1, bx2, bz2),
    pointToSegmentDist(bx1, bz1, ax1, az1, ax2, az2),
    pointToSegmentDist(bx2, bz2, ax1, az1, ax2, az2),
  );
}

/** Compute axis-aligned OBB corners for a building rotated by `rotation`. */
function buildingCorners(b) {
  const hw = b.w / 2;
  const hd = b.d / 2;
  const cos = Math.cos(b.rotation);
  const sin = Math.sin(b.rotation);
  const offsets = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
  return offsets.map(([lx, lz]) => ({
    x: b.x + lx * cos - lz * sin,
    z: b.z + lx * sin + lz * cos,
  }));
}

/** Separating-axis test for two convex quads. */
function obbOverlap(cornersA, cornersB) {
  const polys = [cornersA, cornersB];
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const j = (i + 1) % poly.length;
      const nx = poly[j].z - poly[i].z;
      const nz = -(poly[j].x - poly[i].x);
      let minA = Infinity, maxA = -Infinity;
      let minB = Infinity, maxB = -Infinity;
      for (const p of cornersA) {
        const d = p.x * nx + p.z * nz;
        if (d < minA) minA = d;
        if (d > maxA) maxA = d;
      }
      for (const p of cornersB) {
        const d = p.x * nx + p.z * nz;
        if (d < minB) minB = d;
        if (d > maxB) maxB = d;
      }
      if (maxA <= minB + 0.01 || maxB <= minA + 0.01) return false;
    }
  }
  return true;
}

function boundingRect(polygon) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of polygon) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  return { minX, maxX, minZ, maxZ, area: (maxX - minX) * (maxZ - minZ) };
}

// ── Tier 1: Validity ─────────────────────────────────────────────────────────

function checkV1(cityData) {
  const { buildings, heightmap, seaLevel, terrainData } = cityData;
  const waterCells = terrainData.waterCells;
  const gridWidth = heightmap.width;
  let violations = 0;
  const details = [];

  for (const b of buildings) {
    const elev = heightmap.sample(b.x, b.z);
    if (elev < seaLevel) {
      violations++;
      continue;
    }
    const { gx, gz } = heightmap.worldToGrid(b.x, b.z);
    const gi = Math.round(gz) * gridWidth + Math.round(gx);
    if (waterCells.has(gi)) {
      violations++;
    }
  }

  const pass = violations === 0;
  if (!pass) details.push(`${violations} building(s) on water`);
  return { pass, details: details.join('; ') || 'OK' };
}

function checkV2(cityData) {
  const { nodes, edges } = cityData.network;
  if (edges.length === 0) return { pass: true, details: 'No edges' };

  const adj = new Map();
  for (const [id] of nodes) adj.set(id, []);
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to)) adj.set(e.to, []);
    adj.get(e.from).push(e.to);
    adj.get(e.to).push(e.from);
  }

  // Find nodes with at least one edge
  const connectedNodes = new Set();
  for (const e of edges) {
    connectedNodes.add(e.from);
    connectedNodes.add(e.to);
  }

  const visited = new Set();
  const start = connectedNodes.values().next().value;
  const queue = [start];
  visited.add(start);
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const nb of (adj.get(cur) || [])) {
      if (!visited.has(nb)) {
        visited.add(nb);
        queue.push(nb);
      }
    }
  }

  const unreached = connectedNodes.size - visited.size;
  const pass = unreached === 0;
  return {
    pass,
    details: pass ? 'OK' : `${unreached} node(s) unreachable`,
  };
}

function checkV3(cityData) {
  const { buildings, network } = cityData;
  if (buildings.length === 0) return { pass: true, details: 'No buildings' };

  // Check building-building overlap (sample up to 5000 pairs for performance)
  const cornerCache = buildings.map(b => buildingCorners(b));
  let overlaps = 0;
  const limit = Math.min(buildings.length, 200);
  for (let i = 0; i < limit; i++) {
    for (let j = i + 1; j < limit; j++) {
      if (obbOverlap(cornerCache[i], cornerCache[j])) {
        overlaps++;
        if (overlaps >= 10) break;
      }
    }
    if (overlaps >= 10) break;
  }

  // Check building centers on road segments (sample)
  let onRoad = 0;
  const edgeSample = network.edges.slice(0, 100);
  for (let i = 0; i < Math.min(buildings.length, 200); i++) {
    const b = buildings[i];
    for (const e of edgeSample) {
      if (e.points.length < 2) continue;
      const d = minDistToPolyline(b.x, b.z, e.points);
      if (d < e.width / 2) {
        onRoad++;
        break;
      }
    }
  }

  const pass = overlaps === 0 && onRoad === 0;
  const details = [];
  if (overlaps > 0) details.push(`${overlaps} overlapping pair(s)`);
  if (onRoad > 0) details.push(`${onRoad} building(s) on road`);
  return { pass, details: details.join('; ') || 'OK' };
}

function checkV4(cityData) {
  const edges = cityData.network.edges;
  if (edges.length < 2) return { pass: true, details: 'OK' };

  let violations = 0;
  // Sample pairs for performance
  const limit = Math.min(edges.length, 100);
  for (let i = 0; i < limit; i++) {
    for (let j = i + 1; j < limit; j++) {
      const a = edges[i];
      const b = edges[j];
      // Skip edges that share a node
      if (a.from === b.from || a.from === b.to || a.to === b.from || a.to === b.to) continue;
      if (a.points.length < 2 || b.points.length < 2) continue;
      const d = minDistBetweenPolylines(a.points, b.points);
      if (d < 5) {
        violations++;
        if (violations >= 10) break;
      }
    }
    if (violations >= 10) break;
  }

  return {
    pass: violations === 0,
    details: violations === 0 ? 'OK' : `${violations} edge pair(s) too close`,
  };
}

function checkV5(cityData) {
  const edges = cityData.network.edges;
  const seen = new Set();
  let dupes = 0;
  for (const e of edges) {
    const key = e.from < e.to ? `${e.from}-${e.to}` : `${e.to}-${e.from}`;
    if (seen.has(key)) {
      dupes++;
    } else {
      seen.add(key);
    }
  }
  return {
    pass: dupes === 0,
    details: dupes === 0 ? 'OK' : `${dupes} duplicate edge(s)`,
  };
}

function checkV6(cityData) {
  const { edges, bridges } = cityData.network;
  const { waterCells } = cityData.terrainData;
  const gridWidth = cityData.heightmap.width;

  const bridgeEdgeIds = new Set(bridges.map(br => br.edgeId));
  let missing = 0;

  for (const e of edges) {
    if (!e.gridPath || e.gridPath.length === 0) continue;
    let crossesWater = false;
    for (const cell of e.gridPath) {
      const idx = typeof cell === 'number' ? cell : cell.gz * gridWidth + cell.gx;
      if (waterCells.has(idx)) {
        crossesWater = true;
        break;
      }
    }
    if (crossesWater && !bridgeEdgeIds.has(e.id)) {
      missing++;
    }
  }

  return {
    pass: missing === 0,
    details: missing === 0 ? 'OK' : `${missing} water-crossing edge(s) without bridge`,
  };
}

// ── Tier 2: Structural ──────────────────────────────────────────────────────

function checkS1(cityData) {
  const { buildings, network } = cityData;
  if (buildings.length === 0) return { score: 1, threshold: 0.95, count: 0, total: 0, details: 'No buildings' };

  const edgePoints = network.edges.map(e => e.points).filter(p => p.length >= 2);
  let passing = 0;
  for (const b of buildings) {
    if (!b.doorPosition) { passing++; continue; }
    let minDist = Infinity;
    for (const pts of edgePoints) {
      const d = minDistToPolyline(b.doorPosition.x, b.doorPosition.z, pts);
      if (d < minDist) minDist = d;
      if (minDist <= 2) break;
    }
    if (minDist <= 2) passing++;
  }
  const score = passing / buildings.length;
  return { score, threshold: 0.95, count: passing, total: buildings.length, details: `${passing}/${buildings.length} within 2m` };
}

function checkS2(cityData) {
  const { plots, network } = cityData;
  const plotsWithFront = plots.filter(p => p.frontEdge && p.frontEdge.length === 2);
  if (plotsWithFront.length === 0) return { score: 1, threshold: 0.95, count: 0, total: 0, details: 'No plots with frontEdge' };

  const edgePoints = network.edges.map(e => e.points).filter(p => p.length >= 2);
  let passing = 0;
  for (const p of plotsWithFront) {
    const mx = (p.frontEdge[0].x + p.frontEdge[1].x) / 2;
    const mz = (p.frontEdge[0].z + p.frontEdge[1].z) / 2;
    let minDist = Infinity;
    for (const pts of edgePoints) {
      const d = minDistToPolyline(mx, mz, pts);
      if (d < minDist) minDist = d;
      if (minDist <= 30) break;
    }
    if (minDist <= 30) passing++;
  }
  const score = passing / plotsWithFront.length;
  return { score, threshold: 0.95, count: passing, total: plotsWithFront.length, details: `${passing}/${plotsWithFront.length} within 30m` };
}

function checkS3(cityData) {
  const { nodes, edges } = cityData.network;
  const degree = new Map();
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) || 0) + 1);
    degree.set(e.to, (degree.get(e.to) || 0) + 1);
  }

  let deadEnds = 0;
  let totalNonEntry = 0;
  for (const [id, deg] of degree) {
    const node = nodes.get(id);
    if (node && node.type === 'entry') continue;
    totalNonEntry++;
    if (deg === 1) deadEnds++;
  }

  if (totalNonEntry === 0) return { score: 1, threshold: 0.95, count: 0, total: 0, details: 'No non-entry nodes' };
  const score = 1 - deadEnds / totalNonEntry;
  return { score, threshold: 0.95, count: totalNonEntry - deadEnds, total: totalNonEntry, details: `${deadEnds} dead-end(s) of ${totalNonEntry}` };
}

function checkS4(cityData) {
  const { edges } = cityData.network;
  const { heightmap } = cityData;
  const gradientLimits = {
    primary: 0.08, secondary: 0.08,
    collector: 0.12,
    local: 0.15, alley: 0.15,
  };

  let passing = 0;
  let total = 0;
  for (const e of edges) {
    if (e.points.length < 2) continue;
    total++;
    const limit = gradientLimits[e.hierarchy] || 0.15;
    let ok = true;
    for (let i = 1; i < e.points.length; i++) {
      const p0 = e.points[i - 1];
      const p1 = e.points[i];
      const hDist = distance2D(p0.x, p0.z, p1.x, p1.z);
      if (hDist < 0.5) continue;
      const e0 = heightmap.sample(p0.x, p0.z);
      const e1 = heightmap.sample(p1.x, p1.z);
      const gradient = Math.abs(e1 - e0) / hDist;
      if (gradient > limit) { ok = false; break; }
    }
    if (ok) passing++;
  }

  if (total === 0) return { score: 1, threshold: 0.90, count: 0, total: 0, details: 'No edges' };
  const score = passing / total;
  return { score, threshold: 0.90, count: passing, total, details: `${passing}/${total} within gradient limits` };
}

function checkS5(cityData) {
  const { buildings, heightmap } = cityData;
  if (buildings.length === 0) return { score: 1, threshold: 0.90, count: 0, total: 0, details: 'No buildings' };

  let passing = 0;
  for (const b of buildings) {
    const corners = buildingCorners(b);
    let minE = Infinity, maxE = -Infinity;
    for (const c of corners) {
      const e = heightmap.sample(c.x, c.z);
      if (e < minE) minE = e;
      if (e > maxE) maxE = e;
    }
    const range = maxE - minE;
    const maxRange = Math.max(b.w, b.d) < 10 ? 2 : 4;
    if (range <= maxRange) passing++;
  }

  const score = passing / buildings.length;
  return { score, threshold: 0.90, count: passing, total: buildings.length, details: `${passing}/${buildings.length} within terrain range` };
}

function checkS6(cityData) {
  const { buildings } = cityData;
  if (buildings.length === 0) return { score: 1, threshold: 0.85, count: 0, total: 0, details: 'No buildings' };

  let sumCoherence = 0;
  let counted = 0;
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    if (!b.districtCharacter) continue;
    let same = 0, total = 0;
    for (let j = 0; j < buildings.length; j++) {
      if (i === j) continue;
      const nb = buildings[j];
      const d = distance2D(b.x, b.z, nb.x, nb.z);
      if (d <= 50) {
        total++;
        if (nb.districtCharacter === b.districtCharacter) same++;
      }
    }
    if (total > 0) {
      sumCoherence += same / total;
      counted++;
    }
  }

  if (counted === 0) return { score: 1, threshold: 0.85, count: 0, total: 0, details: 'No neighbors found' };
  const score = sumCoherence / counted;
  return { score, threshold: 0.85, count: counted, total: buildings.length, details: `Mean coherence ${score.toFixed(3)}` };
}

function checkS7(cityData) {
  const { buildings, amenities } = cityData;
  const residential = buildings.filter(b =>
    b.style === 'terrace' || b.style === 'suburban' || b.style === 'apartment'
  );
  if (residential.length === 0) return { score: 1, threshold: 0.80, count: 0, total: 0, details: 'No residential buildings' };

  const schools = (amenities || []).filter(a => a.type === 'school');
  const parks = (amenities || []).filter(a => a.type === 'park');
  const commercial = buildings.filter(b => b.style === 'commercial' || b.style === 'mixed');

  let passing = 0;
  for (const b of residential) {
    const hasSchool = schools.some(s => distance2D(b.x, b.z, s.x, s.z) <= 800);
    const hasCommercial = commercial.some(c => distance2D(b.x, b.z, c.x, c.z) <= 400);
    const hasPark = parks.some(p => distance2D(b.x, b.z, p.x, p.z) <= 400);
    if (hasSchool && hasCommercial && hasPark) passing++;
  }

  const score = passing / residential.length;
  return { score, threshold: 0.80, count: passing, total: residential.length, details: `${passing}/${residential.length} with all 3 amenities` };
}

function checkS8(cityData) {
  const { edges } = cityData.network;
  const localEdges = edges.filter(e => e.hierarchy === 'local' || e.hierarchy === 'alley');
  if (localEdges.length === 0) return { score: 1, threshold: 0.85, count: 0, total: 0, details: 'No local/alley edges' };

  // Build node→edge adjacency
  const nodeEdges = new Map();
  for (const e of edges) {
    if (!nodeEdges.has(e.from)) nodeEdges.set(e.from, []);
    if (!nodeEdges.has(e.to)) nodeEdges.set(e.to, []);
    nodeEdges.get(e.from).push(e);
    nodeEdges.get(e.to).push(e);
  }

  const higherHierarchy = new Set(['primary', 'secondary', 'collector']);

  let passing = 0;
  for (const le of localEdges) {
    // BFS along edges, up to 5 hops
    const visited = new Set([le.id]);
    let frontier = [le];
    let found = false;
    for (let hop = 0; hop < 5 && !found; hop++) {
      const next = [];
      for (const e of frontier) {
        for (const nodeId of [e.from, e.to]) {
          for (const ne of (nodeEdges.get(nodeId) || [])) {
            if (visited.has(ne.id)) continue;
            visited.add(ne.id);
            if (higherHierarchy.has(ne.hierarchy)) { found = true; break; }
            next.push(ne);
          }
          if (found) break;
        }
        if (found) break;
      }
      frontier = next;
    }
    if (found) passing++;
  }

  const score = passing / localEdges.length;
  return { score, threshold: 0.85, count: passing, total: localEdges.length, details: `${passing}/${localEdges.length} reach collector+` };
}

// ── Tier 3: Quality ─────────────────────────────────────────────────────────

function checkQ1(cityData) {
  const { districts, buildings, network } = cityData;
  if (!districts || districts.length === 0) return { score: 0.5, details: 'No districts' };

  const densityTargets = {
    commercial_core: 0.7,
    industrial_docks: 0.5,
    mixed_use: 0.6,
    dense_residential: 0.55,
    suburban_residential: 0.3,
    parkland: 0.1,
  };

  let sumRatio = 0;
  let counted = 0;
  for (const dist of districts) {
    if (!dist.polygon || dist.area <= 0) continue;
    const target = densityTargets[dist.character] || 0.4;

    // Sum building footprints in this district
    let buildingArea = 0;
    for (const b of buildings) {
      if (dist.polygon && pointInDistrict(b.x, b.z, dist)) {
        buildingArea += b.w * b.d;
      }
    }

    // Estimate road area in district
    let roadArea = 0;
    for (const e of network.edges) {
      if (e.points.length < 2) continue;
      const mid = e.points[Math.floor(e.points.length / 2)];
      if (pointInDistrict(mid.x, mid.z, dist)) {
        roadArea += polylineLength(e.points) * (e.width || 6);
      }
    }

    const actual = (buildingArea + roadArea) / dist.area;
    sumRatio += Math.min(actual / target, 1.0);
    counted++;
  }

  if (counted === 0) return { score: 0.5, details: 'No valid districts' };
  const score = sumRatio / counted;
  return { score, details: `Mean land use ratio ${score.toFixed(3)} across ${counted} districts` };
}

function pointInDistrict(x, z, district) {
  // Simple bounding check then polygon
  const p = district.polygon;
  if (!p || p.length < 3) return false;
  // Quick centroid distance check
  const dx = x - district.centroid.x;
  const dz = z - district.centroid.z;
  if (dx * dx + dz * dz > district.area * 4) return false;
  return pointInPolygonSimple(x, z, p);
}

function pointInPolygonSimple(px, pz, polygon) {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i].x, zi = polygon[i].z;
    const xj = polygon[j].x, zj = polygon[j].z;
    if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function checkQ3(cityData) {
  const { network, buildings } = cityData;
  const denseCharacters = new Set(['commercial_core', 'mixed_use']);

  // Collect door positions for fast lookup
  const doors = buildings
    .filter(b => b.doorPosition)
    .map(b => b.doorPosition);

  if (doors.length === 0) return { score: 0.5, details: 'No doors' };

  let totalSamples = 0;
  let covered = 0;

  for (const e of network.edges) {
    // Only edges in dense districts - check via midpoint building neighbors
    if (e.points.length < 2) continue;
    // Approximate: check if any nearby building is in dense district
    const mid = e.points[Math.floor(e.points.length / 2)];
    const nearDense = buildings.some(b =>
      denseCharacters.has(b.districtCharacter) &&
      distance2D(mid.x, mid.z, b.x, b.z) < 100
    );
    if (!nearDense) continue;

    const len = polylineLength(e.points);
    const steps = Math.max(1, Math.floor(len / 5));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const pt = interpolatePolyline(e.points, t);
      totalSamples++;
      const hasDoor = doors.some(d => distance2D(pt.x, pt.z, d.x, d.z) <= 15);
      if (hasDoor) covered++;
    }
  }

  if (totalSamples === 0) return { score: 0.5, details: 'No dense-district edges' };
  const score = covered / totalSamples;
  return { score, details: `${covered}/${totalSamples} samples covered` };
}

function interpolatePolyline(points, t) {
  if (points.length === 1 || t <= 0) return { x: points[0].x, z: points[0].z };
  if (t >= 1) return { x: points[points.length - 1].x, z: points[points.length - 1].z };

  const totalLen = polylineLength(points);
  let target = t * totalLen;
  for (let i = 1; i < points.length; i++) {
    const segLen = distance2D(points[i - 1].x, points[i - 1].z, points[i].x, points[i].z);
    if (target <= segLen) {
      const st = segLen > 0 ? target / segLen : 0;
      return {
        x: points[i - 1].x + st * (points[i].x - points[i - 1].x),
        z: points[i - 1].z + st * (points[i].z - points[i - 1].z),
      };
    }
    target -= segLen;
  }
  return { x: points[points.length - 1].x, z: points[points.length - 1].z };
}

function checkQ8(cityData) {
  const { network, heightmap } = cityData;
  let totalRoadArea = 0;
  for (const e of network.edges) {
    if (e.points.length < 2) continue;
    totalRoadArea += polylineLength(e.points) * (e.width || 6);
  }

  const cityArea = heightmap.worldWidth * heightmap.worldHeight;
  if (cityArea === 0) return { score: 0.5, details: 'Zero city area' };

  const ratio = totalRoadArea / cityArea;
  const target = 0.30;
  const sigma = 0.15;
  const diff = (ratio - target) / sigma;
  const score = Math.exp(-(diff * diff));
  return { score, details: `Road ratio ${ratio.toFixed(3)}, target ${target}` };
}

function checkQ9(cityData) {
  const blocks = cityData.network.blocks;
  if (!blocks || blocks.length === 0) return { score: 0.5, details: 'No blocks' };

  const nonTriangular = blocks.filter(b => !b.isTriangular && b.polygon && b.polygon.length >= 4);
  if (nonTriangular.length === 0) return { score: 0.5, details: 'No non-triangular blocks' };

  let sumCompactness = 0;
  for (const block of nonTriangular) {
    const area = Math.abs(block.area || polygonArea(block.polygon));
    const br = boundingRect(block.polygon);
    if (br.area > 0) {
      sumCompactness += area / br.area;
    }
  }

  const score = sumCompactness / nonTriangular.length;
  return { score, details: `Mean compactness ${score.toFixed(3)} across ${nonTriangular.length} blocks` };
}

// ── Composite ───────────────────────────────────────────────────────────────

const S_WEIGHTS = { S1: 0.20, S2: 0.15, S3: 0.10, S4: 0.15, S5: 0.10, S6: 0.10, S7: 0.10, S8: 0.10 };
const Q_WEIGHTS = { Q1: 0.30, Q3: 0.30, Q8: 0.20, Q9: 0.20 };

function weightedMean(checks, weights) {
  let sum = 0, wsum = 0;
  for (const [key, w] of Object.entries(weights)) {
    if (checks[key]) {
      sum += checks[key].score * w;
      wsum += w;
    }
  }
  return wsum > 0 ? sum / wsum : 0;
}

// ── Main ────────────────────────────────────────────────────────────────────

export function scoreCity(cityData) {
  const validity = {
    V1: checkV1(cityData),
    V2: checkV2(cityData),
    V3: checkV3(cityData),
    V4: checkV4(cityData),
    V5: checkV5(cityData),
    V6: checkV6(cityData),
  };

  const valid = Object.values(validity).every(v => v.pass);

  const structural = {
    S1: checkS1(cityData),
    S2: checkS2(cityData),
    S3: checkS3(cityData),
    S4: checkS4(cityData),
    S5: checkS5(cityData),
    S6: checkS6(cityData),
    S7: checkS7(cityData),
    S8: checkS8(cityData),
  };

  const quality = {
    Q1: checkQ1(cityData),
    Q3: checkQ3(cityData),
    Q8: checkQ8(cityData),
    Q9: checkQ9(cityData),
  };

  const structuralScore = weightedMean(structural, S_WEIGHTS);
  const qualityScore = weightedMean(quality, Q_WEIGHTS);
  const overallScore = structuralScore * 0.6 + qualityScore * 0.4;

  return {
    valid,
    validity,
    structural,
    quality,
    structuralScore,
    qualityScore,
    overallScore,
  };
}
