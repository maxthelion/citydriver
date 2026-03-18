/**
 * Create secondary roads from zone boundary geometry.
 *
 * Algorithm:
 * 1. Collect all zone polygon vertices
 * 2. Cluster nearby vertices into junction candidates
 * 3. Find which candidates are near arterial road cells → confirmed junctions
 * 4. Walk zone boundary segments between confirmed junctions → mark as roads
 */

const CLUSTER_RADIUS = 3;       // cells — merge vertices within this distance
const ARTERIAL_SNAP_DIST = 5;   // cells — max distance to snap to a road cell
const MIN_SEGMENT_LENGTH = 5;   // cells — skip very short boundary segments

/**
 * Create secondary roads from zone boundaries.
 *
 * @param {object} map - FeatureMap with developmentZones, roadGrid, waterMask, originX, originZ, cellSize
 * @returns {{ junctions: Array<{gx,gz}>, segments: Array<Array<{gx,gz}>> }} placed junctions and road segments
 */
export function createZoneBoundaryRoads(map) {
  const zones = map.developmentZones;
  if (!zones || zones.length === 0) return { junctions: [], segments: [] };

  const roadGrid = map.hasLayer('roadGrid') ? map.getLayer('roadGrid') : null;
  const waterMask = map.hasLayer('waterMask') ? map.getLayer('waterMask') : null;
  if (!roadGrid) return { junctions: [], segments: [] };

  const w = map.width, h = map.height;
  const cs = map.cellSize;
  const ox = map.originX, oz = map.originZ;

  // Step 1: Collect all zone polygon vertices as grid coordinates
  const allVertices = [];
  for (const zone of zones) {
    if (!zone.boundary || zone.boundary.length < 3) continue;
    for (const pt of zone.boundary) {
      const gx = Math.round((pt.x - ox) / cs);
      const gz = Math.round((pt.z - oz) / cs);
      if (gx >= 0 && gx < w && gz >= 0 && gz < h) {
        allVertices.push({ gx, gz });
      }
    }
  }

  if (allVertices.length === 0) return { junctions: [], segments: [] };

  // Step 2: Cluster nearby vertices
  const clusters = clusterVertices(allVertices, CLUSTER_RADIUS);

  // Step 3: Find which clusters are near arterial road cells
  const confirmedJunctions = [];
  const otherJunctions = [];

  for (const cluster of clusters) {
    let nearRoad = false;
    for (let dz = -ARTERIAL_SNAP_DIST; dz <= ARTERIAL_SNAP_DIST && !nearRoad; dz++) {
      for (let dx = -ARTERIAL_SNAP_DIST; dx <= ARTERIAL_SNAP_DIST && !nearRoad; dx++) {
        const nx = cluster.gx + dx, nz = cluster.gz + dz;
        if (nx >= 0 && nx < w && nz >= 0 && nz < h && roadGrid.get(nx, nz) > 0) {
          nearRoad = true;
        }
      }
    }
    if (nearRoad) {
      confirmedJunctions.push(cluster);
    } else {
      otherJunctions.push(cluster);
    }
  }

  // Step 4: For each zone boundary, collect the full polygon as grid points.
  // Then for each boundary segment (vertex to next vertex), if EITHER end is
  // near a confirmed junction, mark the whole boundary polygon as a candidate road.
  // This is simpler: any zone that touches an arterial gets its boundary marked as road.
  const placedSegments = [];
  const confirmedSet = new Set(confirmedJunctions.map(j => key(j.gx, j.gz)));

  for (const zone of zones) {
    if (!zone.boundary || zone.boundary.length < 3) continue;

    const boundary = zone.boundary.map(pt => ({
      gx: Math.round((pt.x - ox) / cs),
      gz: Math.round((pt.z - oz) / cs),
    }));

    // Check if any vertex of this zone's boundary is near a confirmed junction
    let touchesArterial = false;
    for (const pt of boundary) {
      if (isNearJunction(pt, confirmedJunctions, ARTERIAL_SNAP_DIST)) {
        touchesArterial = true;
        break;
      }
    }

    if (touchesArterial) {
      placedSegments.push(boundary);
    }
  }

  // Step 5: Stamp road segments onto roadGrid
  const stampedCells = [];
  for (const segment of placedSegments) {
    for (let i = 0; i < segment.length - 1; i++) {
      const cells = bresenham(segment[i].gx, segment[i].gz, segment[i + 1].gx, segment[i + 1].gz);
      for (const c of cells) {
        if (c.gx >= 0 && c.gx < w && c.gz >= 0 && c.gz < h) {
          if (waterMask && waterMask.get(c.gx, c.gz) > 0) continue;
          if (roadGrid.get(c.gx, c.gz) === 0) {
            roadGrid.set(c.gx, c.gz, 1);
            stampedCells.push(c);
          }
        }
      }
    }
  }

  console.log(`[zoneBoundaryRoads] ${allVertices.length} vertices → ${clusters.length} clusters (${confirmedJunctions.length} near roads) → ${placedSegments.length} segments → ${stampedCells.length} new road cells`);

  return {
    junctions: confirmedJunctions,
    segments: placedSegments,
  };
}

/**
 * Cluster nearby vertices into single junction points.
 */
function clusterVertices(vertices, radius) {
  const clusters = [];
  const used = new Set();
  const radiusSq = radius * radius;

  for (let i = 0; i < vertices.length; i++) {
    if (used.has(i)) continue;
    let sumX = vertices[i].gx, sumZ = vertices[i].gz, count = 1;
    used.add(i);

    for (let j = i + 1; j < vertices.length; j++) {
      if (used.has(j)) continue;
      const dx = vertices[j].gx - vertices[i].gx;
      const dz = vertices[j].gz - vertices[i].gz;
      if (dx * dx + dz * dz <= radiusSq) {
        sumX += vertices[j].gx;
        sumZ += vertices[j].gz;
        count++;
        used.add(j);
      }
    }

    clusters.push({
      gx: Math.round(sumX / count),
      gz: Math.round(sumZ / count),
      count,
    });
  }

  return clusters;
}

function isNearJunction(pt, junctions, radius) {
  const radiusSq = radius * radius;
  for (const j of junctions) {
    const dx = pt.gx - j.gx, dz = pt.gz - j.gz;
    if (dx * dx + dz * dz <= radiusSq) return true;
  }
  return false;
}

function key(gx, gz) { return gx | (gz << 16); }

function bresenham(x0, y0, x1, y1) {
  const cells = [];
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy, x = x0, y = y0;
  for (let i = 0; i < dx + dy + 2; i++) {
    cells.push({ gx: x, gz: y });
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
  }
  return cells;
}
