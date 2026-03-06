/**
 * Block subdivision: extract polygonal faces from the road graph,
 * inset them for road clearance, and subdivide into building plots.
 */

import { distance2D } from '../core/math.js';
import { polygonArea, polygonCentroid } from '../core/math.js';

// ============================================================
// extractBlocks
// ============================================================

const MIN_BLOCK_AREA = 100;   // m² — skip tiny slivers
const MAX_BLOCK_AREA = 50000; // m² — skip unbounded peripheral faces

/**
 * Extract closed block polygons from the road graph.
 * Uses half-edge face extraction, discards the outer face and degenerate faces.
 *
 * @param {import('../core/PlanarGraph.js').PlanarGraph} graph
 * @returns {Array<{nodeIds: number[], edgeIds: number[], polygon: Array<{x:number,z:number}>, area: number, centroid: {x:number,z:number}}>}
 */
export function extractBlocks(graph) {
  const rawFaces = graph.facesWithEdges();
  if (rawFaces.length === 0) return [];

  const blocks = [];
  let maxAbsArea = 0;
  let outerIdx = -1;

  for (let i = 0; i < rawFaces.length; i++) {
    const face = rawFaces[i];
    const polygon = face.nodeIds.map(id => {
      const n = graph.getNode(id);
      return { x: n.x, z: n.z };
    });

    const area = polygonArea(polygon);
    const absArea = Math.abs(area);

    if (absArea > maxAbsArea) {
      maxAbsArea = absArea;
      outerIdx = i;
    }

    blocks.push({
      nodeIds: face.nodeIds,
      edgeIds: face.edgeIds,
      polygon,
      area,
      absArea,
      centroid: polygonCentroid(polygon),
    });
  }

  // Filter: remove outer face, tiny faces, and oversized faces
  return blocks.filter((b, i) => {
    if (i === outerIdx) return false;
    if (b.absArea < MIN_BLOCK_AREA) return false;
    if (b.absArea > MAX_BLOCK_AREA) return false;
    return true;
  });
}

// ============================================================
// insetBlockPolygon
// ============================================================

/**
 * Inset a block polygon to account for road width and setback.
 * Uses simplified vertex-averaging approach.
 *
 * @param {Array<{x:number,z:number}>} polygon - block boundary
 * @param {number[]} edgeIds - graph edge IDs forming this block
 * @param {import('../core/PlanarGraph.js').PlanarGraph} graph
 * @param {number} setback - additional setback beyond road half-width
 * @returns {Array<{x:number,z:number}>|null} - inset polygon or null if degenerate
 */
export function insetBlockPolygon(polygon, edgeIds, graph, setback) {
  const n = polygon.length;
  if (n < 3) return null;

  // Determine winding direction (positive area = CCW)
  const totalArea = polygonArea(polygon);
  const sign = totalArea > 0 ? 1 : -1;

  const insetVerts = [];

  for (let i = 0; i < n; i++) {
    const prev = polygon[(i - 1 + n) % n];
    const curr = polygon[i];
    const next = polygon[(i + 1) % n];

    // Get road widths for adjacent edges
    const prevEdgeId = edgeIds[(i - 1 + n) % n];
    const currEdgeId = edgeIds[i % edgeIds.length];
    const prevWidth = getEdgeWidth(graph, prevEdgeId);
    const currWidth = getEdgeWidth(graph, currEdgeId);
    const avgOffset = (prevWidth + currWidth) / 4 + setback; // half-width avg + setback

    // Compute inward normal as average of two edge normals
    const dx1 = curr.x - prev.x;
    const dz1 = curr.z - prev.z;
    const len1 = Math.sqrt(dx1 * dx1 + dz1 * dz1) || 1;

    const dx2 = next.x - curr.x;
    const dz2 = next.z - curr.z;
    const len2 = Math.sqrt(dx2 * dx2 + dz2 * dz2) || 1;

    // Edge normals (inward depends on winding)
    const nx1 = -dz1 / len1 * sign;
    const nz1 = dx1 / len1 * sign;
    const nx2 = -dz2 / len2 * sign;
    const nz2 = dx2 / len2 * sign;

    const nx = (nx1 + nx2) / 2;
    const nz = (nz1 + nz2) / 2;
    const nLen = Math.sqrt(nx * nx + nz * nz) || 1;

    insetVerts.push({
      x: curr.x + (nx / nLen) * avgOffset,
      z: curr.z + (nz / nLen) * avgOffset,
    });
  }

  // Validate: inset polygon must have same winding and reasonable area
  const insetArea = polygonArea(insetVerts);
  if (Math.sign(insetArea) !== Math.sign(totalArea)) return null;
  if (Math.abs(insetArea) < MIN_BLOCK_AREA * 0.3) return null;

  return insetVerts;
}

function getEdgeWidth(graph, edgeId) {
  const edge = graph.getEdge(edgeId);
  return (edge && edge.width) || 9;
}

// ============================================================
// subdivideBlock
// ============================================================

/**
 * Subdivide a block into plots along each frontage edge.
 *
 * @param {{polygon: Array, edgeIds: number[], centroid: {x,z}, nodeIds: number[]}} block
 * @param {Array<{x:number,z:number}>} insetPolygon
 * @param {import('../core/PlanarGraph.js').PlanarGraph} graph
 * @param {object} config - { frontageWidth, plotDepth, setback }
 * @param {number} nucleusId
 * @param {import('../core/rng.js').SeededRandom} rng
 * @returns {Array} plots
 */
export function subdivideBlock(block, insetPolygon, graph, config, nucleusId, rng) {
  const plots = [];
  const n = insetPolygon.length;

  for (let i = 0; i < n; i++) {
    const a = insetPolygon[i];
    const b = insetPolygon[(i + 1) % n];

    const edgeId = block.edgeIds[i % block.edgeIds.length];

    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const edgeLen = Math.sqrt(dx * dx + dz * dz);
    if (edgeLen < config.frontageWidth * 0.8) continue;

    // Direction along frontage
    const dirX = dx / edgeLen;
    const dirZ = dz / edgeLen;

    // Determine winding to know which way is "inward"
    const blockArea = polygonArea(insetPolygon);
    const sign = blockArea > 0 ? 1 : -1;

    // Inward perpendicular
    const perpX = -dirZ * sign;
    const perpZ = dirX * sign;

    const numPlots = Math.floor(edgeLen / config.frontageWidth);
    if (numPlots === 0) continue;

    // Center the plots along the edge
    const usedLen = numPlots * config.frontageWidth;
    const startOffset = (edgeLen - usedLen) / 2;

    for (let p = 0; p < numPlots; p++) {
      const along = startOffset + p * config.frontageWidth;

      // Front edge corners
      const f0x = a.x + dirX * along;
      const f0z = a.z + dirZ * along;
      const f1x = a.x + dirX * (along + config.frontageWidth);
      const f1z = a.z + dirZ * (along + config.frontageWidth);

      // Clamp depth: raycast from front corners inward, limit to block boundary
      const maxDepth = config.plotDepth;
      const depth0 = clampDepthToPolygon(f0x, f0z, perpX, perpZ, maxDepth, insetPolygon);
      const depth1 = clampDepthToPolygon(f1x, f1z, perpX, perpZ, maxDepth, insetPolygon);
      const depth = Math.min(depth0, depth1);

      if (depth < config.frontageWidth * 0.5) continue;

      const v0 = { x: f0x, z: f0z };
      const v1 = { x: f1x, z: f1z };
      const v2 = { x: f1x + perpX * depth, z: f1z + perpZ * depth };
      const v3 = { x: f0x + perpX * depth, z: f0z + perpZ * depth };

      const vertices = [v0, v1, v2, v3];
      const centroid = {
        x: (v0.x + v1.x + v2.x + v3.x) / 4,
        z: (v0.z + v1.z + v2.z + v3.z) / 4,
      };

      plots.push({
        vertices,
        centroid,
        area: config.frontageWidth * depth,
        density: 0.5,
        district: 2,
        nucleusId,
        edgeId,
        frontageEdgeId: edgeId,
        frontageDirection: { x: dirX, z: dirZ },
        frontageWidth: config.frontageWidth,
        depth,
        setback: config.setback,
      });
    }
  }

  return plots;
}

/**
 * Raycast from (ox, oz) in direction (dx, dz) and find the distance to the
 * polygon boundary. Returns min(maxDepth, distance to boundary).
 */
function clampDepthToPolygon(ox, oz, dx, dz, maxDepth, polygon) {
  let minDist = maxDepth;
  const n = polygon.length;

  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];

    const t = raySegmentIntersect(ox, oz, dx, dz, a.x, a.z, b.x, b.z);
    if (t !== null && t > 0.1 && t < minDist) {
      minDist = t;
    }
  }

  return minDist;
}

/**
 * Ray-segment intersection. Returns distance along ray or null.
 * Ray: P = (ox,oz) + t*(dx,dz)
 * Segment: Q = A + u*(B-A), u in [0,1]
 */
function raySegmentIntersect(ox, oz, dx, dz, ax, az, bx, bz) {
  const ex = bx - ax;
  const ez = bz - az;
  const denom = dx * ez - dz * ex;
  if (Math.abs(denom) < 1e-10) return null;

  const t = ((ax - ox) * ez - (az - oz) * ex) / denom;
  const u = ((ax - ox) * dz - (az - oz) * dx) / denom;

  if (u >= 0 && u <= 1 && t > 0) return t;
  return null;
}

// ============================================================
// fillBlockPlots — top-level replacement for fillFrontage
// ============================================================

/**
 * Extract blocks from the road graph and subdivide into plots.
 * Dead-end edges that don't form blocks get fallback frontage projection.
 *
 * @param {import('../core/PlanarGraph.js').PlanarGraph} graph
 * @param {Array} nuclei
 * @param {Map<number,number>} edgeOwnership - edgeId → nucleusId
 * @param {object} terrain - { elevation, waterMask, occupancy, w, h, cs, seaLevel }
 * @param {import('../core/rng.js').SeededRandom} rng
 * @param {Set<string>} processedBlocks - set of block keys already processed
 * @returns {Array} new plots
 */
export function fillBlockPlots(graph, nuclei, edgeOwnership, terrain, rng, processedBlocks) {
  const blocks = extractBlocks(graph);
  const newPlots = [];

  // Track which edges appear in at least one block
  const edgesInBlocks = new Set();

  for (const block of blocks) {
    // Block key: sorted edge IDs
    const blockKey = [...block.edgeIds].sort((a, b) => a - b).join(',');
    if (processedBlocks.has(blockKey)) continue;

    // Find owning nucleus (nearest to centroid)
    let bestNucleus = nuclei[0];
    let bestDist = Infinity;
    for (const n of nuclei) {
      const d = distance2D(block.centroid.x, block.centroid.z, n.x, n.z);
      if (d < bestDist) { bestDist = d; bestNucleus = n; }
    }

    if (!bestNucleus) continue;

    const config = bestNucleus.plotConfig;
    const inset = insetBlockPolygon(block.polygon, block.edgeIds, graph, config.setback);
    if (!inset) {
      processedBlocks.add(blockKey);
      for (const eid of block.edgeIds) edgesInBlocks.add(eid);
      continue;
    }

    const plots = subdivideBlock(block, inset, graph, config, bestNucleus.id, rng);

    // Validate and collect
    for (const plot of plots) {
      if (!isPlotBuildableSimple(plot.centroid, plot.vertices, terrain)) continue;
      newPlots.push(plot);
    }

    processedBlocks.add(blockKey);
    for (const eid of block.edgeIds) edgesInBlocks.add(eid);
  }

  // Dead-end fallback: edges not in any block get frontage projection
  const deadEndPlots = fillDeadEndFrontage(graph, nuclei, edgeOwnership, edgesInBlocks, terrain, rng);
  newPlots.push(...deadEndPlots);

  return newPlots;
}

// ============================================================
// splitDeepBlocks — add interior roads through oversized blocks
// ============================================================

const DEEP_BLOCK_THRESHOLD = 2.5; // block must be > 2.5x plotDepth across to split

/**
 * Find blocks that are too deep for frontage plots to fill, and add
 * an interior road to split them. Invalidates the block in processedBlocks
 * so it gets re-subdivided next tick.
 *
 * @param {import('../core/PlanarGraph.js').PlanarGraph} graph
 * @param {Array} nuclei
 * @param {Map<number,number>} edgeOwnership
 * @param {Set<string>} processedBlocks
 * @param {object} terrain
 * @param {Function} costFn
 * @returns {Array<{edgeId: number, nucleusId: number}>}
 */
export function splitDeepBlocks(graph, nuclei, edgeOwnership, processedBlocks, terrain, costFn) {
  const blocks = extractBlocks(graph);
  const results = [];
  const { w, h, cs, seaLevel, elevation, waterMask, occupancy } = terrain;

  // Limit splits per tick to avoid explosive growth
  let splitCount = 0;
  const maxSplitsPerTick = 3;

  for (const block of blocks) {
    if (splitCount >= maxSplitsPerTick) break;

    // Find owning nucleus
    let bestNucleus = nuclei[0];
    let bestDist = Infinity;
    for (const n of nuclei) {
      const d = distance2D(block.centroid.x, block.centroid.z, n.x, n.z);
      if (d < bestDist) { bestDist = d; bestNucleus = n; }
    }
    if (!bestNucleus) continue;

    const config = bestNucleus.plotConfig;
    const minDepthForSplit = config.plotDepth * DEEP_BLOCK_THRESHOLD;

    // Measure block "width" across its shortest dimension
    // Use the minimum distance between opposing edge midpoints
    const poly = block.polygon;
    const n = poly.length;
    if (n < 4) continue; // triangles can't be meaningfully split

    // Find the longest edge and measure perpendicular depth
    let longestIdx = 0;
    let longestLen = 0;
    for (let i = 0; i < n; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % n];
      const len = distance2D(a.x, a.z, b.x, b.z);
      if (len > longestLen) { longestLen = len; longestIdx = i; }
    }

    // Measure depth perpendicular to the longest edge
    const a = poly[longestIdx];
    const b = poly[(longestIdx + 1) % n];
    const edgeDx = b.x - a.x;
    const edgeDz = b.z - a.z;
    const edgeLen = Math.sqrt(edgeDx * edgeDx + edgeDz * edgeDz) || 1;
    const normX = -edgeDz / edgeLen;
    const normZ = edgeDx / edgeLen;

    let maxPerp = 0;
    for (let i = 0; i < n; i++) {
      const p = poly[i];
      const proj = (p.x - a.x) * normX + (p.z - a.z) * normZ;
      maxPerp = Math.max(maxPerp, Math.abs(proj));
    }

    if (maxPerp < minDepthForSplit) continue;

    // Place a road through the block's interior, parallel to the longest edge,
    // at plotDepth offset from the longest edge
    const offset = config.plotDepth + config.setback + 3;
    const mid0x = a.x + normX * offset;
    const mid0z = a.z + normZ * offset;
    const mid1x = b.x + normX * offset;
    const mid1z = b.z + normZ * offset;

    // Validate the road endpoints are on land
    const g0x = Math.round(mid0x / cs);
    const g0z = Math.round(mid0z / cs);
    const g1x = Math.round(mid1x / cs);
    const g1z = Math.round(mid1z / cs);

    if (g0x < 1 || g0x >= w - 1 || g0z < 1 || g0z >= h - 1) continue;
    if (g1x < 1 || g1x >= w - 1 || g1z < 1 || g1z >= h - 1) continue;
    if (elevation.get(g0x, g0z) < seaLevel) continue;
    if (elevation.get(g1x, g1z) < seaLevel) continue;
    if (waterMask && waterMask.get(g0x, g0z) > 0) continue;
    if (waterMask && waterMask.get(g1x, g1z) > 0) continue;

    // Snap to existing nodes or create new ones
    const snapThreshold = cs * 2;
    const n0 = snapOrCreate(graph, mid0x, mid0z, snapThreshold);
    const n1 = snapOrCreate(graph, mid1x, mid1z, snapThreshold);
    if (n0 === n1) continue;
    if (graph.neighbors(n0).includes(n1)) continue;

    const edgeId = graph.addEdge(n0, n1, {
      width: 6, hierarchy: 'local',
    });

    results.push({ edgeId, nucleusId: bestNucleus.id });
    splitCount++;

    // Invalidate old block key so new sub-blocks get processed
    const blockKey = [...block.edgeIds].sort((a, b) => a - b).join(',');
    processedBlocks.delete(blockKey);
  }

  return results;
}

function snapOrCreate(graph, x, z, threshold) {
  const nearest = graph.nearestNode(x, z);
  if (nearest && nearest.dist < threshold) return nearest.id;
  return graph.addNode(x, z);
}

// ============================================================
// Dead-end fallback frontage
// ============================================================

function fillDeadEndFrontage(graph, nuclei, edgeOwnership, edgesInBlocks, terrain, rng) {
  const plots = [];
  const nucleiById = new Map(nuclei.map(n => [n.id, n]));

  for (const [edgeId, edge] of graph.edges) {
    if (edgesInBlocks.has(edgeId)) continue;

    const nucleusId = edgeOwnership.get(edgeId);
    const nucleus = nucleiById.get(nucleusId);
    if (!nucleus) continue;

    const config = nucleus.plotConfig;
    const polyline = graph.edgePolyline(edgeId);
    if (polyline.length < 2) continue;

    const totalLen = polylineLength(polyline);
    if (totalLen < config.frontageWidth * 1.5) continue;

    const roadHalfWidth = ((edge.width) || 9) / 2 + config.setback;
    const halfFront = config.frontageWidth / 2;
    const depth = config.plotDepth;

    for (const side of ['left', 'right']) {
      let offset = 0;
      while (offset < totalLen - config.frontageWidth) {
        const t = (offset + halfFront) / totalLen;
        const pos = samplePolylineAt(polyline, totalLen, t);
        const dir = samplePolylineDir(polyline, totalLen, t);

        const perpX = side === 'left' ? -dir.z : dir.z;
        const perpZ = side === 'left' ? dir.x : -dir.x;

        const baseX = pos.x + perpX * roadHalfWidth;
        const baseZ = pos.z + perpZ * roadHalfWidth;

        const v0 = { x: baseX - dir.x * halfFront, z: baseZ - dir.z * halfFront };
        const v1 = { x: baseX + dir.x * halfFront, z: baseZ + dir.z * halfFront };
        const v2 = { x: v1.x + perpX * depth, z: v1.z + perpZ * depth };
        const v3 = { x: v0.x + perpX * depth, z: v0.z + perpZ * depth };

        const vertices = [v0, v1, v2, v3];
        const centroid = {
          x: (v0.x + v1.x + v2.x + v3.x) / 4,
          z: (v0.z + v1.z + v2.z + v3.z) / 4,
        };

        offset += config.frontageWidth;

        if (!isPlotBuildableSimple(centroid, vertices, terrain)) continue;

        plots.push({
          vertices,
          centroid,
          area: config.frontageWidth * depth,
          density: 0.5,
          district: 2,
          nucleusId: nucleus.id,
          edgeId,
          frontageEdgeId: edgeId,
          frontageDirection: { x: dir.x, z: dir.z },
          frontageWidth: config.frontageWidth,
          depth,
          setback: config.setback,
        });
      }
    }
  }

  return plots;
}

// ============================================================
// Helpers
// ============================================================

function isPlotBuildableSimple(centroid, vertices, terrain) {
  const { elevation, waterMask, occupancy, w, h, cs, seaLevel } = terrain;

  const cgx = Math.round(centroid.x / cs);
  const cgz = Math.round(centroid.z / cs);
  if (cgx < 0 || cgx >= w || cgz < 0 || cgz >= h) return false;
  if (elevation.get(cgx, cgz) < seaLevel) return false;
  if (waterMask && waterMask.get(cgx, cgz) > 0) return false;

  if (occupancy) {
    const val = occGet(occupancy, centroid.x, centroid.z);
    // OCCUPANCY values: 0=empty, 1=road, 2=plot, 3=junction
    if (val === 1 || val === 2 || val === 3) return false;

    for (let i = 0; i < vertices.length; i++) {
      const v = vertices[i];
      const vNext = vertices[(i + 1) % vertices.length];

      if (v.x < 0 || v.x > (w - 1) * cs || v.z < 0 || v.z > (h - 1) * cs) return false;
      const vval = occGet(occupancy, v.x, v.z);
      if (vval === 1 || vval === 3) return false;

      const mx = (v.x + vNext.x) / 2;
      const mz = (v.z + vNext.z) / 2;
      const mval = occGet(occupancy, mx, mz);
      if (mval === 1 || mval === 3) return false;
    }

    for (const v of vertices) {
      const vgx = Math.round(v.x / cs);
      const vgz = Math.round(v.z / cs);
      if (vgx >= 0 && vgx < w && vgz >= 0 && vgz < h) {
        if (waterMask && waterMask.get(vgx, vgz) > 0) return false;
      }
    }
  }

  return true;
}

function occGet(occupancy, wx, wz) {
  const ogx = Math.round(wx / occupancy.res);
  const ogz = Math.round(wz / occupancy.res);
  if (ogx < 0 || ogx >= occupancy.width || ogz < 0 || ogz >= occupancy.height) return -1;
  return occupancy.data[ogz * occupancy.width + ogx];
}

function polylineLength(polyline) {
  let len = 0;
  for (let i = 0; i < polyline.length - 1; i++) {
    len += distance2D(polyline[i].x, polyline[i].z, polyline[i + 1].x, polyline[i + 1].z);
  }
  return len;
}

function samplePolylineAt(polyline, totalLen, t) {
  const target = t * totalLen;
  let accum = 0;
  for (let i = 0; i < polyline.length - 1; i++) {
    const segLen = distance2D(polyline[i].x, polyline[i].z, polyline[i + 1].x, polyline[i + 1].z);
    if (accum + segLen >= target) {
      const frac = segLen > 0 ? (target - accum) / segLen : 0;
      return {
        x: polyline[i].x + frac * (polyline[i + 1].x - polyline[i].x),
        z: polyline[i].z + frac * (polyline[i + 1].z - polyline[i].z),
      };
    }
    accum += segLen;
  }
  return polyline[polyline.length - 1];
}

function samplePolylineDir(polyline, totalLen, t) {
  const target = t * totalLen;
  let accum = 0;
  for (let i = 0; i < polyline.length - 1; i++) {
    const dx = polyline[i + 1].x - polyline[i].x;
    const dz = polyline[i + 1].z - polyline[i].z;
    const segLen = Math.sqrt(dx * dx + dz * dz);
    if (accum + segLen >= target || i === polyline.length - 2) {
      const len = segLen || 1;
      return { x: dx / len, z: dz / len };
    }
    accum += segLen;
  }
  return { x: 1, z: 0 };
}
