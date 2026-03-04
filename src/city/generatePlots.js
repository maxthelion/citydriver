/**
 * B9. Plot subdivision — divide blocks into building plots.
 * Uses facesWithEdges() to identify road frontage, then subdivides
 * blocks perpendicular to their frontage edges.
 */

import { distance2D, polygonArea, polygonCentroid, pointInPolygon, normalize2D } from '../core/math.js';

/**
 * @param {import('../core/LayerStack.js').LayerStack} cityLayers
 * @param {import('../core/PlanarGraph.js').PlanarGraph} graph
 * @param {import('../core/rng.js').SeededRandom} rng
 * @returns {Array<{vertices, area, centroid, frontageEdgeId, frontageDirection, depth, density, district}>}
 */
export function generatePlots(cityLayers, graph, rng) {
  const params = cityLayers.getData('params');
  const density = cityLayers.getGrid('density');
  const districts = cityLayers.getGrid('districts');

  if (!params) return [];

  const cs = params.cellSize;
  const plots = [];

  // Get blocks with edge info
  const faces = graph.facesWithEdges();

  for (const face of faces) {
    const { nodeIds, edgeIds } = face;

    // Build polygon from node IDs
    const vertices = nodeIds.map(nodeId => {
      const node = graph.getNode(nodeId);
      return node ? { x: node.x, z: node.z } : null;
    }).filter(v => v !== null);

    if (vertices.length < 3) continue;

    const area = Math.abs(polygonArea(vertices));

    // Skip very small or very large faces (outer face)
    if (area < cs * cs * 2) continue;
    if (area > cs * cs * 500) continue;

    const centroid = polygonCentroid(vertices);
    if (!isFinite(centroid.x) || !isFinite(centroid.z)) continue;

    const gx = Math.round(centroid.x / cs);
    const gz = Math.round(centroid.z / cs);
    const d = density ? density.get(gx, gz) : 0;

    if (d < 0.05) continue; // Skip very low density areas

    const districtType = districts ? districts.get(gx, gz) : 0;

    // Identify frontage edges — all edges in edgeIds are road edges (they're in the graph)
    // Build frontage segments: for each consecutive pair of nodes sharing an edge, that's a frontage
    const frontageSegments = [];
    for (let i = 0; i < nodeIds.length; i++) {
      const j = (i + 1) % nodeIds.length;
      const edgeId = edgeIds[i]; // The edge between nodeIds[i] and nodeIds[j]

      const fromNode = graph.getNode(nodeIds[i]);
      const toNode = graph.getNode(nodeIds[j]);
      if (!fromNode || !toNode) continue;

      frontageSegments.push({
        edgeId,
        from: { x: fromNode.x, z: fromNode.z },
        to: { x: toNode.x, z: toNode.z },
        index: i,
      });
    }

    if (frontageSegments.length === 0) continue;

    // Subdivide the block into plots along each frontage edge
    const blockPlots = subdivideAlongFrontage(vertices, frontageSegments, d, districtType, cs, rng);

    for (const plot of blockPlots) {
      // Verify plot centroid is inside block
      const pc = polygonCentroid(plot.vertices);
      if (!isFinite(pc.x) || !isFinite(pc.z)) continue;

      const plotGx = Math.round(pc.x / cs);
      const plotGz = Math.round(pc.z / cs);
      const plotDensity = density ? density.get(plotGx, plotGz) : d;

      plots.push({
        vertices: plot.vertices,
        area: Math.abs(polygonArea(plot.vertices)),
        centroid: pc,
        frontageEdgeId: plot.frontageEdgeId,
        frontageDirection: plot.frontageDirection,
        depth: plot.depth,
        density: plotDensity,
        district: districtType,
      });
    }
  }

  return plots;
}

/**
 * Subdivide a block along its frontage edges into rectangular plots.
 *
 * For each frontage segment, walks along the edge creating rectangles
 * that extend inward (perpendicular to the road) with proper sizing
 * based on district type and density.
 *
 * @param {Array<{x, z}>} blockVertices - polygon vertices of the block
 * @param {Array<{edgeId, from, to, index}>} frontageSegments
 * @param {number} density - density value at the block centroid
 * @param {number} districtType - district enum value
 * @param {number} cs - cell size
 * @param {import('../core/rng.js').SeededRandom} rng
 * @returns {Array<{vertices, frontageEdgeId, frontageDirection, depth}>}
 */
function subdivideAlongFrontage(blockVertices, frontageSegments, density, districtType, cs, rng) {
  const plots = [];

  // Determine plot dimensions from district type
  let baseWidth, baseDepth;
  switch (districtType) {
    case 0: // COMMERCIAL
      baseWidth = cs * 1.0;
      baseDepth = cs * 1.5;
      break;
    case 1: // DENSE_RESIDENTIAL (terraces)
      baseWidth = cs * 0.6;
      baseDepth = cs * 1.2;
      break;
    case 2: // SUBURBAN
      baseWidth = cs * 1.5;
      baseDepth = cs * 2.5;
      break;
    case 3: // INDUSTRIAL
      baseWidth = cs * 2.5;
      baseDepth = cs * 3.0;
      break;
    case 4: // PARKLAND
      return []; // No plots in parkland
    default:
      baseWidth = cs * 1.2;
      baseDepth = cs * 2.0;
  }

  // Adjust depth by density (denser = shallower)
  const depth = baseDepth * (0.6 + (1 - density) * 0.4);

  for (const seg of frontageSegments) {
    const dx = seg.to.x - seg.from.x;
    const dz = seg.to.z - seg.from.z;
    const segLen = Math.sqrt(dx * dx + dz * dz);
    if (segLen < baseWidth * 0.5) continue;

    // Frontage direction (unit vector along the edge)
    const frontDir = { x: dx / segLen, z: dz / segLen };

    // Inward normal: perpendicular to frontage, pointing into block
    // Try both perpendicular directions, pick the one pointing toward block centroid
    const blockCentroid = polygonCentroid(blockVertices);
    const edgeMid = { x: (seg.from.x + seg.to.x) / 2, z: (seg.from.z + seg.to.z) / 2 };
    const toCentroid = { x: blockCentroid.x - edgeMid.x, z: blockCentroid.z - edgeMid.z };

    const normalA = { x: -frontDir.z, z: frontDir.x };
    const dotA = normalA.x * toCentroid.x + normalA.z * toCentroid.z;
    const inwardNormal = dotA > 0 ? normalA : { x: frontDir.z, z: -frontDir.x };

    // Cap depth to half perpendicular extent of block from this frontage
    const maxPerp = computeMaxPerpDist(blockVertices, edgeMid, inwardNormal);
    const cappedDepth = Math.min(depth, maxPerp * 0.5);

    // Walk along frontage edge, creating plots
    const numPlots = Math.floor(segLen / baseWidth);
    if (numPlots < 1) continue;

    const actualWidth = segLen / numPlots; // Distribute evenly

    for (let i = 0; i < numPlots; i++) {
      const plotD = cappedDepth * (1.0 + rng.range(-0.1, 0.1));

      const t0 = (i * actualWidth) / segLen;
      const t1 = Math.min(1, ((i + 1) * actualWidth) / segLen);

      // Front corners (on the frontage edge)
      const f0 = {
        x: seg.from.x + dx * t0,
        z: seg.from.z + dz * t0,
      };
      const f1 = {
        x: seg.from.x + dx * t1,
        z: seg.from.z + dz * t1,
      };

      // Rear corners (inward by depth)
      const r0 = {
        x: f0.x + inwardNormal.x * plotD,
        z: f0.z + inwardNormal.z * plotD,
      };
      const r1 = {
        x: f1.x + inwardNormal.x * plotD,
        z: f1.z + inwardNormal.z * plotD,
      };

      const plotVertices = [f0, f1, r1, r0];

      // Check all corners inside block
      let allInside = true;
      for (const v of plotVertices) {
        if (!pointInPolygon(v.x, v.z, blockVertices)) {
          allInside = false;
          break;
        }
      }

      // At least check rear corners — front are on the edge so may be borderline
      // Accept if at least rear corners are inside
      if (!allInside) {
        const rearInside = pointInPolygon(r0.x, r0.z, blockVertices) &&
                          pointInPolygon(r1.x, r1.z, blockVertices);
        if (!rearInside) continue;
      }

      plots.push({
        vertices: plotVertices,
        frontageEdgeId: seg.edgeId,
        frontageDirection: frontDir,
        depth: plotD,
      });
    }
  }

  return plots;
}

/**
 * Compute max perpendicular distance from the frontage mid-point into the block.
 * Projects all block vertices onto the inward normal direction.
 */
function computeMaxPerpDist(blockVertices, edgeMid, inwardNormal) {
  let maxProj = 0;
  for (const v of blockVertices) {
    const dx = v.x - edgeMid.x;
    const dz = v.z - edgeMid.z;
    const proj = dx * inwardNormal.x + dz * inwardNormal.z;
    if (proj > maxProj) maxProj = proj;
  }
  return maxProj > 0 ? maxProj : 1; // Avoid zero
}
