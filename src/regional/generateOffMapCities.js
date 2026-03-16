/**
 * Generate off-map cities at region edges.
 * These represent cities beyond the region that railway lines connect to.
 *
 * @param {object} params - { width, height, cellSize }
 * @param {import('../core/rng.js').SeededRandom} rng
 * @returns {Array<{ gx: number, gz: number, edge: string, importance: number, role: string, name: string }>}
 */
export function generateOffMapCities(params, rng) {
  const { width, height } = params;
  const count = 3 + Math.floor(rng.next() * 3); // 3-5 cities

  const edges = ['north', 'south', 'east', 'west'];
  const roles = ['capital', 'industrial', 'port', 'market', 'university'];

  const cities = [];

  for (let i = 0; i < count; i++) {
    const edge = edges[i % edges.length];
    const pos = 0.2 + rng.next() * 0.6; // 20-80% along the edge

    let gx, gz;
    if (edge === 'north') { gx = Math.round(pos * width); gz = 0; }
    else if (edge === 'south') { gx = Math.round(pos * width); gz = height - 1; }
    else if (edge === 'west') { gx = 0; gz = Math.round(pos * height); }
    else { gx = width - 1; gz = Math.round(pos * height); }

    const importance = i === 0 ? 1 : (i < 2 ? 2 : 3);
    const role = i === 0 ? 'capital' : roles[1 + Math.floor(rng.next() * (roles.length - 1))];

    cities.push({ gx, gz, edge, importance, role, name: `City_${i}` });
  }

  return cities;
}
