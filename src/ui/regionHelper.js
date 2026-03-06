import { generateRegion } from '../regional/pipeline.js';
import { SeededRandom } from '../core/rng.js';

/**
 * Generate a region from a seed and optionally find a settlement at (gx, gz).
 * Uses the same parameters as RegionScreen._generate() so results are identical.
 */
export function generateRegionFromSeed(seed, gx, gz) {
  const rng = new SeededRandom(seed);
  const edges = ['north', 'south', 'east', 'west'];
  const coastEdges = [edges[rng.int(0, 3)]];

  const layers = generateRegion({
    width: 128,
    height: 128,
    cellSize: 50,
    seaLevel: 0,
    coastEdges,
  }, rng);

  let settlement = null;
  const settlements = layers.getData('settlements');

  if (gx != null && gz != null && !isNaN(gx) && !isNaN(gz) && settlements) {
    // Find the settlement closest to (gx, gz)
    let bestDist = Infinity;
    for (const s of settlements) {
      const dx = s.gx - gx;
      const dz = s.gz - gz;
      const dist = dx * dx + dz * dz;
      if (dist < bestDist) {
        bestDist = dist;
        settlement = s;
      }
    }
  } else if (settlements && settlements.length > 0) {
    settlement = settlements[0];
  }

  return { layers, settlement };
}
