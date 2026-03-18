/**
 * Wrap a zone's boundary polygon as a road.
 * Simple: take the boundary, simplify it, clip against existing roads/water,
 * add surviving segments as roads.
 */

const CLIP_SAMPLE_STEP = 2;
const ROAD_HALF_WIDTH = 8;
const MIN_ROAD_LENGTH_M = 60;

/**
 * @param {object} map - FeatureMap
 * @param {object} zone - a development zone with boundary polygon
 */
export function wrapZoneWithRoad(map, zone) {
  if (!zone.boundary || zone.boundary.length < 3) return 0;

  const roadGrid = map.hasLayer('roadGrid') ? map.getLayer('roadGrid') : null;
  const waterMask = map.hasLayer('waterMask') ? map.getLayer('waterMask') : null;
  if (!roadGrid) return 0;

  const cs = map.cellSize;
  let pts = [...zone.boundary];

  // Simplify
  pts = simplify(pts, cs * 4);

  // Clip against existing roads and water
  const segments = clip(pts, map);

  let added = 0;
  for (const seg of segments) {
    if (seg.length < 2) continue;

    const roadData = {
      type: 'road',
      polyline: seg,
      width: 6,
      hierarchy: 'collector',
      importance: 0.5,
      source: 'zone-wrap',
      id: map.roads ? map.roads.length : 0,
    };

    if (map.addFeature) {
      map.addFeature('road', roadData);
    } else {
      map.roads.push(roadData);
    }

    if (map.graph && seg.length >= 2) {
      const snapDist = cs * 3;
      const startPt = seg[0];
      const endPt = seg[seg.length - 1];
      const startNode = findOrCreate(map.graph, startPt.x, startPt.z, snapDist);
      const endNode = findOrCreate(map.graph, endPt.x, endPt.z, snapDist);
      if (startNode !== endNode) {
        map.graph.addEdge(startNode, endNode, {
          points: seg.slice(1, -1),
          width: 6,
          hierarchy: 'collector',
        });
      }
    }

    added++;
  }

  return added;
}

function clip(street, map) {
  if (street.length < 2) return [];
  const roadGrid = map.hasLayer('roadGrid') ? map.getLayer('roadGrid') : null;
  const waterMask = map.hasLayer('waterMask') ? map.getLayer('waterMask') : null;
  const cs = map.cellSize;
  const ox = map.originX, oz = map.originZ;
  const r = Math.ceil(ROAD_HALF_WIDTH / cs);

  const samples = [];
  for (let i = 0; i < street.length - 1; i++) {
    const ax = street[i].x, az = street[i].z;
    const bx = street[i + 1].x, bz = street[i + 1].z;
    const dx = bx - ax, dz = bz - az;
    const len = Math.sqrt(dx * dx + dz * dz);
    const steps = Math.max(1, Math.ceil(len / CLIP_SAMPLE_STEP));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      samples.push({ x: ax + dx * t, z: az + dz * t });
    }
  }
  samples.push(street[street.length - 1]);

  const clear = samples.map(p => {
    const gx = Math.round((p.x - ox) / cs);
    const gz = Math.round((p.z - oz) / cs);
    if (gx < 3 || gz < 3 || gx >= map.width - 3 || gz >= map.height - 3) return false;
    if (waterMask) {
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = gx + dx, nz = gz + dz;
          if (nx >= 0 && nz >= 0 && nx < map.width && nz < map.height && waterMask.get(nx, nz) > 0) return false;
        }
    }
    if (roadGrid) {
      for (let dz = -r; dz <= r; dz++)
        for (let dx = -r; dx <= r; dx++) {
          const nx = gx + dx, nz = gz + dz;
          if (nx >= 0 && nz >= 0 && nx < map.width && nz < map.height && roadGrid.get(nx, nz) > 0) return false;
        }
    }
    return true;
  });

  const segments = [];
  let current = null;
  for (let i = 0; i < samples.length; i++) {
    if (clear[i]) {
      if (!current) current = [];
      current.push(samples[i]);
    } else {
      if (current && current.length >= 2) segments.push(current);
      current = null;
    }
  }
  if (current && current.length >= 2) segments.push(current);

  return segments.filter(seg => {
    let len = 0;
    for (let i = 1; i < seg.length; i++) {
      const dx = seg[i].x - seg[i - 1].x, dz = seg[i].z - seg[i - 1].z;
      len += Math.sqrt(dx * dx + dz * dz);
    }
    return len >= MIN_ROAD_LENGTH_M;
  });
}

function simplify(pts, tolerance) {
  if (pts.length < 3) return pts;
  const tolSq = tolerance * tolerance;
  let maxDist = 0, maxIdx = 0;
  const first = pts[0], last = pts[pts.length - 1];
  const dx = last.x - first.x, dz = last.z - first.z;
  const lenSq = dx * dx + dz * dz;
  for (let i = 1; i < pts.length - 1; i++) {
    let dist;
    if (lenSq < 0.001) {
      const ex = pts[i].x - first.x, ez = pts[i].z - first.z;
      dist = ex * ex + ez * ez;
    } else {
      const t = Math.max(0, Math.min(1, ((pts[i].x - first.x) * dx + (pts[i].z - first.z) * dz) / lenSq));
      const px = first.x + t * dx, pz = first.z + t * dz;
      const ex = pts[i].x - px, ez = pts[i].z - pz;
      dist = ex * ex + ez * ez;
    }
    if (dist > maxDist) { maxDist = dist; maxIdx = i; }
  }
  if (maxDist > tolSq) {
    const left = simplify(pts.slice(0, maxIdx + 1), tolerance);
    const right = simplify(pts.slice(maxIdx), tolerance);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

function findOrCreate(graph, x, z, snapDist) {
  const nearest = graph.nearestNode(x, z);
  if (nearest && nearest.dist < snapDist) return nearest.id;
  return graph.addNode(x, z);
}
