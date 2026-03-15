/**
 * Development pressure model.
 * Maps land value + distance into a 0–1 pressure score that drives
 * building typology, plot width, and street spacing.
 */

/**
 * Compute development pressure for a zone.
 * @param {number} avgLandValue - Mean land value across zone cells (0–1)
 * @param {number} distFromNucleus - Distance from zone centroid to nearest nucleus (meters)
 * @param {object} [opts]
 * @param {number} [opts.avgSlope=0] - Mean slope across zone (0–1)
 * @param {number} [opts.nucleusTier=1] - Tier of the owning nucleus (1 = city center)
 * @returns {number} Pressure in [0, 1]
 */
export function computePressure(avgLandValue, distFromNucleus, { avgSlope = 0, nucleusTier = 1 } = {}) {
  // Land value component (60% weight)
  const lvComponent = Math.min(1, Math.max(0, avgLandValue * 1.5)) * 0.6;

  // Proximity component — satellite nuclei (higher tier) get a weaker pull
  const tierFactor = nucleusTier <= 1 ? 1.0 : nucleusTier <= 2 ? 0.5 : 0.3;
  const proxWeight = 0.4 * tierFactor;
  const proxComponent = Math.min(1, Math.max(0, 1 - distFromNucleus / 400)) * proxWeight;

  // Slope penalty — steep terrain strongly suppresses pressure
  const slopePenalty = Math.min(1, avgSlope / 0.25) * 0.5;

  return Math.min(1, Math.max(0, lvComponent + proxComponent - slopePenalty));
}

const TYPOLOGIES = [
  { name: 'dense-urban',  minPressure: 0.75, plotWidth: [4.5, 6],  floors: [3, 6], spacing: 25 },
  { name: 'mid-density',  minPressure: 0.5,  plotWidth: [5, 8],    floors: [2, 3], spacing: 35 },
  { name: 'suburban',     minPressure: 0.25, plotWidth: [8, 12],   floors: [2, 2], spacing: 45 },
  { name: 'rural-edge',   minPressure: 0,    plotWidth: [12, 15],  floors: [1, 2], spacing: 55 },
];

export function typologyForPressure(pressure) {
  for (const t of TYPOLOGIES) {
    if (pressure >= t.minPressure) return t;
  }
  return TYPOLOGIES[TYPOLOGIES.length - 1];
}

export function plotWidthForPressure(pressure, rng01) {
  const typo = typologyForPressure(pressure);
  const base = typo.plotWidth[0] + (typo.plotWidth[1] - typo.plotWidth[0]) * 0.5;
  const variation = base * 0.15;
  return base + (rng01 - 0.5) * 2 * variation;
}

export function ribbonSpacingForPressure(pressure) {
  const typo = typologyForPressure(pressure);
  return typo.spacing;
}

export function shouldBeApartment(pressure, plotIndex, rng01) {
  if (pressure <= 0.75) return false;
  const interval = 3 + Math.floor(rng01 * 3); // 3, 4, or 5
  if (plotIndex % interval !== 0 || plotIndex === 0) return false;
  const prob = Math.min(0.5, (pressure - 0.75) * 4);
  return rng01 < prob;
}

export function apartmentDimensions() {
  return { plotWidth: [15, 20], plotDepth: [12, 15], floors: [4, 6] };
}
