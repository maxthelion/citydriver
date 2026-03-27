/**
 * Shared test helpers for incremental street layout tests.
 */

/**
 * Create a simple grid-based layer mock.
 */
export function makeGrid(width, height, fillValue = 0) {
  const data = new Float32Array(width * height).fill(fillValue);
  return {
    get(gx, gz) { return data[gz * width + gx]; },
    set(gx, gz, v) { data[gz * width + gx] = v; },
    width,
    height,
  };
}

/**
 * Create a rectangular zone with cells from (x0,z0) to (x1,z1) inclusive.
 * Optionally apply a slope (elevation increases in +x direction).
 */
export function makeRectZone(x0, z0, x1, z1, cellSize = 5) {
  const cells = [];
  for (let gz = z0; gz <= z1; gz++) {
    for (let gx = x0; gx <= x1; gx++) {
      cells.push({ gx, gz });
    }
  }

  let sumGx = 0, sumGz = 0;
  for (const c of cells) { sumGx += c.gx; sumGz += c.gz; }

  return {
    cells,
    centroidGx: sumGx / cells.length,
    centroidGz: sumGz / cells.length,
    avgSlope: 0.05,
    slopeDir: { x: 1, z: 0 },
    boundary: [
      { x: x0 * cellSize, z: z0 * cellSize },
      { x: (x1 + 1) * cellSize, z: z0 * cellSize },
      { x: (x1 + 1) * cellSize, z: (z1 + 1) * cellSize },
      { x: x0 * cellSize, z: (z1 + 1) * cellSize },
    ],
  };
}

/**
 * Create a mock map with elevation, waterMask, and roadGrid layers.
 */
export function makeMap(width, height, cellSize = 5, options = {}) {
  const { originX = 0, originZ = 0, slopeX = 0.01 } = options;

  const elevation = makeGrid(width, height);
  const waterMask = makeGrid(width, height);
  const roadGrid = makeGrid(width, height);

  // Apply a simple slope in the +x direction
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      elevation.set(gx, gz, gx * cellSize * slopeX);
    }
  }

  const layers = { elevation, waterMask, roadGrid };

  return {
    width,
    height,
    cellSize,
    originX,
    originZ,
    getLayer(name) { return layers[name] || null; },
    hasLayer(name) { return name in layers; },
  };
}
