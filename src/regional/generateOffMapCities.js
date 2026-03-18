/**
 * Generate off-map cities at region edges.
 * These represent cities beyond the region that railway lines connect to.
 * Only places cities on inland edges — railways don't go off coastal edges.
 *
 * @param {object} params - { width, height, cellSize }
 * @param {import('../core/rng.js').SeededRandom} rng
 * @param {object} [options]
 * @param {string[]} [options.coastEdges] - Edges that are coastline (excluded from placement)
 * @returns {Array<{ gx: number, gz: number, edge: string, importance: number, role: string, name: string }>}
 */
export function generateOffMapCities(params, rng, options = {}) {
  const { width, height } = params;
  const coastEdges = options.coastEdges || [];

  // Only place cities on inland edges
  const allEdges = ['north', 'south', 'east', 'west'];
  const inlandEdges = allEdges.filter(e => !coastEdges.includes(e));

  if (inlandEdges.length === 0) return [];

  const count = Math.min(inlandEdges.length * 2, 3 + Math.floor(rng.next() * 3)); // 3-5, capped by available edges
  const roles = ['capital', 'industrial', 'port', 'market', 'university'];

  const cities = [];

  for (let i = 0; i < count; i++) {
    const edge = inlandEdges[i % inlandEdges.length];
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
