import { CELL_SIZE, GRID_COUNT, ROAD_WIDTH, sampleHeightmap } from '../heightmap.js';

/**
 * Pick a random point on the road network that is:
 *  - at least `minDist` units from `carPos`
 *  - not inside any building footprint
 *
 * @param {object}   cityData          - { roads, buildings, ... }
 * @param {{ x: number, z: number }} carPos - current car world position
 * @param {function} rng               - () => number in [0,1)
 * @param {number}   [minDist=100]     - minimum distance from car
 * @returns {{ x: number, y: number, z: number }}
 */
export function pickTargetLocation(cityData, carPos, rng, minDist = 100) {
  const MAX_ATTEMPTS = 50;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Pick a random road
    const road = cityData.roads[Math.floor(rng() * cityData.roads.length)];

    // Pick a random parametric position along the road (0.1 to 0.9 to avoid edges)
    const t = 0.1 + rng() * 0.8;

    let x, z;
    if (road.horizontal) {
      x = road.x + (road.endX - road.x) * t;
      // Small cross-road offset within road width
      z = road.z + (rng() - 0.5) * (ROAD_WIDTH * 0.8);
    } else {
      // Vertical road
      z = road.z + (road.endZ - road.z) * t;
      x = road.x + (rng() - 0.5) * (ROAD_WIDTH * 0.8);
    }

    // Check minimum distance from car
    const dx = x - carPos.x;
    const dz = z - carPos.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < minDist) continue;

    // Check not inside any building footprint
    let insideBuilding = false;
    for (const b of cityData.buildings) {
      if (
        Math.abs(x - b.x) < b.w / 2 &&
        Math.abs(z - b.z) < b.d / 2
      ) {
        insideBuilding = true;
        break;
      }
    }
    if (insideBuilding) continue;

    const y = sampleHeightmap(x, z);
    return { x, y, z };
  }

  // Fallback: pick a random intersection
  const halfCity = (GRID_COUNT * CELL_SIZE) / 2;
  const gx = Math.floor(rng() * (GRID_COUNT + 1));
  const gz = Math.floor(rng() * (GRID_COUNT + 1));
  const x = gx * CELL_SIZE - halfCity;
  const z = gz * CELL_SIZE - halfCity;
  const y = sampleHeightmap(x, z);
  return { x, y, z };
}
