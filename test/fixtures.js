/**
 * Shared test fixtures.
 *
 * Caches expensive region generation across tests that use the same seed.
 * A single 128×128 region takes 2-5 seconds to generate — running it once
 * instead of 15+ times saves ~30-60 seconds off the test suite.
 */

import { generateRegion } from '../src/regional/pipeline.js';
import { setupCity } from '../src/city/setup.js';
import { SeededRandom } from '../src/core/rng.js';

const regionCache = new Map();
const cityCache = new Map();

/**
 * Get a cached region for a seed. Generates once, reuses thereafter.
 */
export function getRegion(seed = 42, params = {}) {
  const key = `${seed}-${JSON.stringify(params)}`;
  if (!regionCache.has(key)) {
    const rng = new SeededRandom(seed);
    const layers = generateRegion({
      width: 128,
      height: 128,
      cellSize: params.cellSize || 200,
      seaLevel: 0,
      ...params,
    }, rng);
    const settlements = layers.getData('settlements');
    const settlement = settlements && settlements.length > 0 ? settlements[0] : null;
    regionCache.set(key, { layers, settlement, settlements, rng });
  }
  return regionCache.get(key);
}

/**
 * Get a cached city map for a seed. Generates region + city once.
 */
export function getCity(seed = 42, params = {}) {
  const key = `${seed}-${JSON.stringify(params)}`;
  if (!cityCache.has(key)) {
    const region = getRegion(seed, params);
    if (!region.settlement) {
      cityCache.set(key, null);
    } else {
      const rng = new SeededRandom(seed);
      const map = setupCity(region.layers, region.settlement, rng.fork('city'));
      cityCache.set(key, map);
    }
  }
  return cityCache.get(key);
}
