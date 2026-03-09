import { SeededRandom } from '../core/rng.js';

/**
 * Available climate presets for building generation.
 */
export const CLIMATES = [
  'cold',
  'temperate',
  'continental',
  'mediterranean',
  'tropical',
  'arid',
];

/**
 * Climate-specific style presets. Each defines architectural parameters
 * typical of that climate zone.
 */
const CLIMATE_STYLES = {
  cold: {
    floorHeight: 2.8,
    floorCountRange: [1, 3],
    roofType: 'gable',
    roofPitch: 50,
    roofOverhang: 0.4,
    windowWidth: 0.8,
    windowHeight: 1.2,
    windowSpacing: 2.4,
    windowHeightDecay: 0.05,
    hasPorch: false,
    porchDepth: 0,
    hasBalcony: false,
    balconyFloors: [],
    hasDormers: true,
    wingProbability: 0.2,
    wallColor: 0xc8b896,
    roofColor: 0x4a3728,
    trimColor: 0xf5f0e8,
    windowColor: 0x88aabb,
  },
  temperate: {
    floorHeight: 3.0,
    floorCountRange: [2, 4],
    roofType: 'gable',
    roofPitch: 38,
    roofOverhang: 0.35,
    windowWidth: 1.0,
    windowHeight: 1.6,
    windowSpacing: 2.8,
    windowHeightDecay: 0.04,
    hasPorch: true,
    porchDepth: 1.8,
    hasBalcony: false,
    balconyFloors: [],
    hasDormers: false,
    wingProbability: 0.35,
    wallColor: 0xd4c4a8,
    roofColor: 0x6b4e37,
    trimColor: 0xffffff,
    windowColor: 0x7799bb,
  },
  continental: {
    floorHeight: 3.2,
    floorCountRange: [3, 6],
    roofType: 'hip',
    roofPitch: 28,
    roofOverhang: 0.25,
    windowWidth: 1.2,
    windowHeight: 2.0,
    windowSpacing: 3.0,
    windowHeightDecay: 0.03,
    hasPorch: false,
    porchDepth: 0,
    hasBalcony: true,
    balconyFloors: [2, 3],
    hasDormers: false,
    wingProbability: 0.4,
    wallColor: 0xe8dcc8,
    roofColor: 0x555555,
    trimColor: 0xf0e8d8,
    windowColor: 0x6688aa,
  },
  mediterranean: {
    floorHeight: 3.4,
    floorCountRange: [3, 6],
    roofType: 'mansard',
    roofPitch: 25,
    roofOverhang: 0.3,
    windowWidth: 1.1,
    windowHeight: 2.2,
    windowSpacing: 2.6,
    windowHeightDecay: 0.06,
    hasPorch: false,
    porchDepth: 0,
    hasBalcony: true,
    balconyFloors: [2, 3, 4],
    hasDormers: true,
    wingProbability: 0.45,
    wallColor: 0xf0e0c0,
    roofColor: 0xb85c38,
    trimColor: 0xfaf0e6,
    windowColor: 0x5577aa,
  },
  tropical: {
    floorHeight: 3.6,
    floorCountRange: [1, 2],
    roofType: 'hip',
    roofPitch: 35,
    roofOverhang: 0.5,
    windowWidth: 1.4,
    windowHeight: 2.0,
    windowSpacing: 2.4,
    windowHeightDecay: 0.02,
    hasPorch: true,
    porchDepth: 2.5,
    hasBalcony: false,
    balconyFloors: [],
    hasDormers: false,
    wingProbability: 0.15,
    wallColor: 0xf5eedc,
    roofColor: 0x7a5c44,
    trimColor: 0xffffff,
    windowColor: 0x6699aa,
  },
  arid: {
    floorHeight: 3.0,
    floorCountRange: [1, 3],
    roofType: 'flat',
    roofPitch: 2,
    roofOverhang: 0.05,
    windowWidth: 0.7,
    windowHeight: 1.0,
    windowSpacing: 3.2,
    windowHeightDecay: 0.08,
    hasPorch: false,
    porchDepth: 0,
    hasBalcony: false,
    balconyFloors: [],
    hasDormers: false,
    wingProbability: 0.1,
    wallColor: 0xe8d8b8,
    roofColor: 0xd0c0a0,
    trimColor: 0xf0e8d0,
    windowColor: 0x556688,
  },
};

/**
 * Returns the architectural style preset for the given climate.
 * @param {string} climate - One of the CLIMATES values
 * @returns {object} Style object with all architectural parameters
 */
export function getClimateStyle(climate) {
  const style = CLIMATE_STYLES[climate];
  if (!style) {
    throw new Error(`Unknown climate: ${climate}`);
  }
  // Return a shallow copy so callers can't mutate the presets
  return { ...style, balconyFloors: [...style.balconyFloors] };
}

/**
 * Shift each RGB component of a hex color by a random amount.
 * @param {number} hex - Color as a hex integer (e.g. 0xrrggbb)
 * @param {number} amount - Shift magnitude in [0, 1] (fraction of 255)
 * @param {SeededRandom} rng - Random number generator
 * @returns {number} Nudged hex color
 */
function nudgeColor(hex, amount, rng) {
  const shift = Math.round(amount * 255);
  const r = Math.min(255, Math.max(0, ((hex >> 16) & 0xff) + rng.int(-shift, shift)));
  const g = Math.min(255, Math.max(0, ((hex >> 8) & 0xff) + rng.int(-shift, shift)));
  const b = Math.min(255, Math.max(0, (hex & 0xff) + rng.int(-shift, shift)));
  return (r << 16) | (g << 8) | b;
}

/**
 * Plot size dimension ranges and wing limits.
 */
const PLOT_SPECS = {
  small:  { width: [4, 5],  depth: [4, 5],  maxWings: 0, floorBias: 0 },
  medium: { width: [5, 7],  depth: [4, 6],  maxWings: 1, floorBias: 0.5 },
  large:  { width: [8, 10], depth: [5, 7],  maxWings: 1, floorBias: 1 },
};

/**
 * Builds a concrete building recipe from a style, plot size, richness, and seed.
 *
 * @param {object} style - Style object from getClimateStyle()
 * @param {'small'|'medium'|'large'} plotSize - Plot size category
 * @param {number} richness - Richness level: 0, 0.5, or 1
 * @param {number} seed - Integer seed for deterministic generation
 * @returns {object} Recipe object with all building parameters
 */
export function buildRecipe(style, plotSize, richness, seed) {
  const rng = new SeededRandom(seed);
  const spec = PLOT_SPECS[plotSize];
  if (!spec) {
    throw new Error(`Unknown plot size: ${plotSize}`);
  }

  // Main dimensions
  const mainWidth = rng.range(spec.width[0], spec.width[1]);
  const mainDepth = rng.range(spec.depth[0], spec.depth[1]);

  // Floor count — bias toward min (small), middle (medium), or max (large)
  const [minFloors, maxFloors] = style.floorCountRange;
  const floorRange = maxFloors - minFloors;
  const biasedFloor = minFloors + spec.floorBias * floorRange;
  // Add a small random offset around the biased value
  const floors = Math.min(
    maxFloors,
    Math.max(minFloors, Math.round(biasedFloor + rng.range(-0.8, 0.8)))
  );

  // Wings
  const wings = [];
  if (spec.maxWings > 0) {
    const wingCount = rng.next() < style.wingProbability
      ? rng.int(1, spec.maxWings)
      : 0;
    const sides = ['left', 'right', 'back'];
    for (let i = 0; i < wingCount; i++) {
      const side = sides[i % sides.length];
      const wingWidth = mainWidth * rng.range(0.4, 0.65);
      const wingDepth = mainDepth * rng.range(0.35, 0.6);
      const wingFloors = Math.max(1, floors - rng.int(0, 1));
      wings.push({
        side,
        width: Math.round(wingWidth * 10) / 10,
        depth: Math.round(wingDepth * 10) / 10,
        floors: wingFloors,
      });
    }
  }

  // Richness-driven features
  const hasArched = richness >= 1;
  const hasQuoins = richness >= 1;
  const hasSills = richness >= 0.5;
  const hasCornice = richness >= 0.5;

  // Porch — from style, only if richness allows
  const hasPorch = style.hasPorch && richness >= 0;
  const porchDepth = hasPorch ? style.porchDepth : 0;

  // Balcony — from style, modulated by richness
  let hasBalcony = false;
  let balconyFloors = [];
  if (style.hasBalcony) {
    if (richness >= 1) {
      hasBalcony = true;
      balconyFloors = style.balconyFloors.filter((f) => f <= floors);
    } else if (richness >= 0.5) {
      hasBalcony = rng.next() > 0.4;
      if (hasBalcony) {
        // Pick a subset of balcony floors
        balconyFloors = style.balconyFloors.filter(
          (f) => f <= floors && rng.next() > 0.4
        );
        if (balconyFloors.length === 0) hasBalcony = false;
      }
    }
  }

  // Dormers — from style, modulated by richness
  let hasDormers = false;
  let dormerCount = 0;
  if (style.hasDormers) {
    if (richness >= 1) {
      hasDormers = true;
      // Full dormer row: roughly one per 3m of width
      dormerCount = Math.max(2, Math.floor(mainWidth / 3));
    } else if (richness >= 0.5) {
      hasDormers = rng.next() > 0.4;
      dormerCount = hasDormers ? rng.int(1, Math.max(1, Math.floor(mainWidth / 4))) : 0;
    }
  }

  // Chimneys
  let chimneyCount;
  if (richness >= 1) {
    chimneyCount = rng.int(1, 2);
  } else if (richness >= 0.5) {
    chimneyCount = 1;
  } else {
    chimneyCount = rng.int(0, 1);
  }

  // Colors — nudge from style for variety
  const colorRng = rng.fork('colors');
  const wallColor = nudgeColor(style.wallColor, 0.06, colorRng);
  const roofColor = style.roofColor;
  const trimColor = style.trimColor;
  const windowColor = style.windowColor;

  return {
    mainWidth: Math.round(mainWidth * 10) / 10,
    mainDepth: Math.round(mainDepth * 10) / 10,
    floors,
    wings,
    richness,
    hasArched,
    hasQuoins,
    hasSills,
    hasCornice,
    hasPorch,
    porchDepth,
    hasBalcony,
    balconyFloors,
    hasDormers,
    dormerCount,
    chimneyCount,
    wallColor,
    roofColor,
    trimColor,
    windowColor,
  };
}
