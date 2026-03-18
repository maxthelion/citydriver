/**
 * Railway-specific A* cost function.
 * Railways need very gentle gradients (real max ~2-3%).
 * Much higher slope penalty than roads.
 *
 * @param {import('./Grid2D.js').Grid2D} elevation
 * @param {object} options
 * @returns {Function} (fromGx, fromGz, toGx, toGz) => cost
 */
export function railwayCostFunction(elevation, options = {}) {
  const {
    slopePenalty = 150,
    waterGrid = null,
    waterPenalty = 200,
    edgeMargin = 2,
    edgePenalty = 0,
    seaLevel = null,
    maxGradient = 0.03,
    valleyGrid = null,
    valleyBonus = 0.3,
  } = options;

  return function cost(fromGx, fromGz, toGx, toGz) {
    const dx = toGx - fromGx;
    const dz = toGz - fromGz;
    const baseDist = Math.sqrt(dx * dx + dz * dz);

    const fromH = elevation.get(fromGx, fromGz);
    const toH = elevation.get(toGx, toGz);
    const gradient = Math.abs(toH - fromH) / (baseDist * elevation.cellSize);

    let c = baseDist;

    if (gradient > maxGradient) {
      const excess = gradient - maxGradient;
      c += baseDist * slopePenalty * (1 + excess * 20);
    } else {
      c += baseDist * (gradient / maxGradient) * slopePenalty * 0.1;
    }

    if (seaLevel !== null && toH < seaLevel) return Infinity;

    if (waterGrid && waterGrid.get(toGx, toGz) > 0) {
      c += waterPenalty;
    }

    if (
      edgePenalty > 0 && (
        toGx < edgeMargin || toGx >= elevation.width - edgeMargin ||
        toGz < edgeMargin || toGz >= elevation.height - edgeMargin
      )
    ) {
      c += edgePenalty;
    }

    if (valleyGrid) {
      const vScore = valleyGrid.get(toGx, toGz);
      if (vScore > 0) c *= (1 - valleyBonus * vScore);
    }

    return c;
  };
}
