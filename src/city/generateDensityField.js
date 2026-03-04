/**
 * B3. Density field — population density heatmap.
 * Driven by distance from city seed, proximity to arterials,
 * terrain suitability, and waterfront desirability.
 */

import { Grid2D } from '../core/Grid2D.js';
import { smoothstep } from '../core/math.js';

/**
 * Generate a population density heatmap.
 *
 * @param {import('../core/LayerStack.js').LayerStack} cityLayers
 * @param {import('../core/PlanarGraph.js').PlanarGraph} roadGraph
 * @param {import('../core/rng.js').SeededRandom} rng
 * @returns {Grid2D} - density values 0-1
 */
export function generateDensityField(cityLayers, roadGraph, rng) {
  const params = cityLayers.getData('params');
  const elevation = cityLayers.getGrid('elevation');
  const slope = cityLayers.getGrid('slope');
  const waterMask = cityLayers.getGrid('waterMask');

  const w = params.width;
  const h = params.height;
  const cs = params.cellSize;
  const seaLevel = params.seaLevel;

  const density = new Grid2D(w, h, { cellSize: cs });

  const centerX = w * cs / 2;
  const centerZ = h * cs / 2;
  const maxRadius = Math.min(w, h) * cs * 0.45;

  // Pre-compute distance to nearest road node
  const roadNodes = [];
  for (const [, node] of roadGraph.nodes) {
    roadNodes.push({ x: node.x, z: node.z });
  }

  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      const wx = gx * cs;
      const wz = gz * cs;

      // Skip water cells
      if (waterMask && waterMask.get(gx, gz) > 0) continue;
      if (elevation.get(gx, gz) < seaLevel) continue;

      // Distance from center (primary density driver)
      const dx = wx - centerX;
      const dz = wz - centerZ;
      const distFromCenter = Math.sqrt(dx * dx + dz * dz);
      const centerFactor = smoothstep(maxRadius, 0, distFromCenter);

      // Slope penalty (steep ground = lower density)
      const s = slope ? slope.get(gx, gz) : 0;
      const slopeFactor = Math.max(0, 1 - s * 5);

      // Road proximity bonus
      let minRoadDist = Infinity;
      for (const rn of roadNodes) {
        const rdx = wx - rn.x;
        const rdz = wz - rn.z;
        const rdist = Math.sqrt(rdx * rdx + rdz * rdz);
        if (rdist < minRoadDist) minRoadDist = rdist;
      }
      const roadFactor = smoothstep(maxRadius * 0.5, 0, minRoadDist);

      // Combine factors
      let d = centerFactor * 0.5 + roadFactor * 0.3 + slopeFactor * 0.2;
      d = Math.max(0, Math.min(1, d));

      density.set(gx, gz, d);
    }
  }

  return density;
}
