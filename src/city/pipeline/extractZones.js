/**
 * Pipeline step: extract development zones from the road network graph.
 *
 * Phase 5 of the pipeline refactor: zones are now graph faces (blocks)
 * rather than bitmap flood-fills. Each face from PlanarGraph.facesWithEdges()
 * becomes a zone with explicit references to its bounding road edges.
 *
 * Falls back to the bitmap flood-fill approach if the graph has no edges
 * (e.g. no skeleton roads placed yet — shouldn't happen in normal flow).
 *
 * Reads:  graph, waterMask, landValue, terrainSuitability, slope, elevation, nuclei
 * Writes: developmentZones (array of blocks), zoneGrid (layer)
 */

import { Grid2D } from '../../core/Grid2D.js';
import { extractDevelopmentZones } from '../zoneExtraction.js';

const MIN_BLOCK_AREA_M2 = 500;    // skip faces smaller than 500m²
const ZONE_LV_THRESHOLD = 0.15;   // minimum land value to be a zone

// ── Polygon geometry helpers ───────────────────────────────────────────────

/** Shoelace formula — signed area (positive = CCW). */
function polygonSignedArea(polygon) {
  let area = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    area += (polygon[j].x + polygon[i].x) * (polygon[j].z - polygon[i].z);
  }
  return area / 2;
}

function polygonArea(polygon) {
  return Math.abs(polygonSignedArea(polygon));
}

function polygonCentroid(polygon) {
  let cx = 0, cz = 0;
  for (const p of polygon) { cx += p.x; cz += p.z; }
  return { x: cx / polygon.length, z: cz / polygon.length };
}

/** Rasterize a world-coord polygon into grid cells. */
function rasterizePolygon(polygon, map) {
  const { width, height, cellSize: cs, originX: ox, originZ: oz } = map;
  const cells = [];

  // Bounding box
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of polygon) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
  }

  const gxMin = Math.max(0, Math.floor((minX - ox) / cs));
  const gxMax = Math.min(width - 1, Math.ceil((maxX - ox) / cs));
  const gzMin = Math.max(0, Math.floor((minZ - oz) / cs));
  const gzMax = Math.min(height - 1, Math.ceil((maxZ - oz) / cs));

  for (let gz = gzMin; gz <= gzMax; gz++) {
    for (let gx = gxMin; gx <= gxMax; gx++) {
      const wx = ox + gx * cs, wz = oz + gz * cs;
      if (pointInPolygon(wx, wz, polygon)) cells.push({ gx, gz });
    }
  }
  return cells;
}

function pointInPolygon(x, z, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, zi = polygon[i].z;
    const xj = polygon[j].x, zj = polygon[j].z;
    if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
  }
  return inside;
}

// ── Block extraction from graph faces ─────────────────────────────────────

function extractBlocksFromGraph(map) {
  const graph = map.graph;
  const facesWithEdges = graph.facesWithEdges();
  if (facesWithEdges.length === 0) return null; // fall back

  const waterMask = map.getLayer('waterMask') || map.waterMask;
  const landValue = map.getLayer('landValue') || map.landValue;
  const slope = map.getLayer('slope') || map.slope;
  const elevation = map.getLayer('elevation') || map.elevation;
  const { width, height, cellSize: cs, originX: ox, originZ: oz, nuclei } = map;
  const mapAreaM2 = width * height * cs * cs;

  const blocks = [];
  let blockId = 1;

  for (const { nodeIds, edgeIds } of facesWithEdges) {
    // Build polygon from node world coords
    const polygon = nodeIds.map(id => {
      const node = graph.getNode(id);
      return node ? { x: node.x, z: node.z } : null;
    }).filter(Boolean);

    if (polygon.length < 3) continue;

    const area = polygonArea(polygon);
    if (area < MIN_BLOCK_AREA_M2) continue;       // too small
    if (area > mapAreaM2 * 0.4) continue;          // outer face / unbounded

    const centroid = polygonCentroid(polygon);
    const cgx = Math.round((centroid.x - ox) / cs);
    const cgz = Math.round((centroid.z - oz) / cs);

    if (cgx < 0 || cgx >= width || cgz < 0 || cgz >= height) continue;
    if (waterMask && waterMask.get(cgx, cgz) > 0) continue;

    // Rasterize to get cells
    const allCells = rasterizePolygon(polygon, map);
    const cells = allCells.filter(c => {
      if (c.gx < 0 || c.gx >= width || c.gz < 0 || c.gz >= height) return false;
      if (waterMask && waterMask.get(c.gx, c.gz) > 0) return false;
      return true;
    });

    if (cells.length === 0) continue;

    // Land value threshold
    let lvSum = 0;
    for (const c of cells) lvSum += landValue ? landValue.get(c.gx, c.gz) : 0.5;
    const avgLv = lvSum / cells.length;
    if (avgLv < ZONE_LV_THRESHOLD) continue;

    // Find nearest nucleus
    let nucleusIdx = 0, bestDist = Infinity;
    for (let i = 0; i < nuclei.length; i++) {
      const n = nuclei[i];
      const d = (cgx - n.gx) ** 2 + (cgz - n.gz) ** 2;
      if (d < bestDist) { bestDist = d; nucleusIdx = i; }
    }

    // Metadata (same shape as old zones)
    let slopeSum = 0, gradX = 0, gradZ = 0;
    for (const c of cells) {
      if (slope) slopeSum += slope.get(c.gx, c.gz);
      if (elevation) {
        const e = elevation.get(c.gx, c.gz);
        if (c.gx > 0) gradX += e - elevation.get(c.gx - 1, c.gz);
        if (c.gz > 0) gradZ += e - elevation.get(c.gx, c.gz - 1);
      }
    }
    const avgSlope = slope ? slopeSum / cells.length : 0;
    const gradLen = Math.sqrt(gradX ** 2 + gradZ ** 2);
    const slopeDir = gradLen > 0.01 ? { x: gradX / gradLen, z: gradZ / gradLen } : { x: 0, z: 0 };

    const n = nuclei[nucleusIdx];
    const nwx = ox + n.gx * cs, nwz = oz + n.gz * cs;
    const distFromNucleus = Math.sqrt((centroid.x - nwx) ** 2 + (centroid.z - nwz) ** 2);
    const gradingCost = avgSlope > 0.15 ? (avgSlope - 0.15) * 2 : 0;
    const priority = (lvSum / Math.max(1, distFromNucleus)) * (1 - gradingCost);

    blocks.push({
      id: blockId++,
      // Topological data (Phase 5 additions)
      polygon,
      boundingEdgeIds: edgeIds,
      boundingNodeIds: nodeIds,
      area,
      centroid,
      // Compatibility with existing consumers
      cells,
      centroidGx: cgx,
      centroidGz: cgz,
      nucleusIdx,
      avgSlope,
      avgLandValue: avgLv,
      totalLandValue: lvSum,
      slopeDir,
      distFromNucleus,
      priority,
      boundary: polygon,
    });
  }

  blocks.sort((a, b) => b.priority - a.priority);
  return blocks.length > 0 ? blocks : null;
}

// ── Pipeline step ──────────────────────────────────────────────────────────

/**
 * @param {object} map - FeatureMap with getLayer/setLayer, nuclei, graph
 * @returns {object} map (for chaining)
 */
export function extractZones(map) {
  // Prefer graph-based extraction (Phase 5); fall back to bitmap if no graph
  let zones = null;
  if (map.graph && map.graph.edges.size > 0 && map.nuclei && map.nuclei.length > 0) {
    zones = extractBlocksFromGraph(map);
  }
  if (!zones) {
    zones = extractDevelopmentZones(map);
  }

  map.developmentZones = zones;

  // Build zoneGrid (last-write-wins — higher-priority zones overwrite earlier ones).
  // Zones are sorted by priority descending, so we write in reverse order so that
  // the highest-priority zone wins each contested cell.
  const zoneGrid = new Grid2D(map.width, map.height, {
    type: 'uint8', cellSize: map.cellSize,
    originX: map.originX, originZ: map.originZ,
  });
  for (let i = zones.length - 1; i >= 0; i--) {
    const zone = zones[i];
    for (const cell of zone.cells) {
      zoneGrid.set(cell.gx, cell.gz, zone.id || 1);
    }
  }

  // Reconcile zone.cells with zoneGrid: each cell belongs to exactly one zone.
  // Cells that were claimed by a higher-priority zone are removed from lower ones.
  for (const zone of zones) {
    zone.cells = zone.cells.filter(c => zoneGrid.get(c.gx, c.gz) === zone.id);
  }

  map.setLayer('zoneGrid', zoneGrid);

  return map;
}
