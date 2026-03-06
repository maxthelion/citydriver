import { RegionScreen } from './ui/RegionScreen.js';
import { CityScreen } from './ui/CityScreen.js';
import { DebugScreen } from './ui/DebugScreen.js';
import { generateRegionFromSeed } from './ui/regionHelper.js';
import { SeededRandom } from './core/rng.js';

const container = document.getElementById('game-container');
let regionScreen = null;
let cityScreen = null;
let debugScreen = null;

function backToRegion(seed) {
  if (cityScreen) { cityScreen.dispose(); cityScreen = null; }
  if (debugScreen) { debugScreen.dispose(); debugScreen = null; }
  const url = seed != null ? `?seed=${seed}` : location.pathname;
  history.replaceState(null, '', url);
  container.innerHTML = '';
  showRegion(seed);
}

function showRegion(initialSeed) {
  regionScreen = new RegionScreen(container, {
    onEnter(layers, settlement, seed) {
      regionScreen.dispose();
      regionScreen = null;

      const rng = new SeededRandom(seed || 42);
      cityScreen = new CityScreen(container, layers, settlement, rng.fork('city'), seed, () => backToRegion(seed));
    },
    onDebug(layers, settlement, seed) {
      regionScreen.dispose();
      regionScreen = null;

      debugScreen = new DebugScreen(container, layers, settlement, seed, () => backToRegion(seed));
    },
  }, initialSeed);
}

// Check URL for deep-link into debug or city screen
const urlParams = new URLSearchParams(location.search);
const urlMode = urlParams.get('mode');
const urlSeed = urlParams.has('seed') ? parseInt(urlParams.get('seed')) : undefined;

if ((urlMode === 'debug' || urlMode === 'city') && urlSeed != null) {
  const gx = parseInt(urlParams.get('gx'));
  const gz = parseInt(urlParams.get('gz'));

  const { layers, settlement } = generateRegionFromSeed(urlSeed, gx, gz);
  if (settlement) {
    if (urlMode === 'city') {
      const rng = new SeededRandom(urlSeed);
      cityScreen = new CityScreen(container, layers, settlement, rng.fork('city'), urlSeed, () => backToRegion(urlSeed));
    } else {
      debugScreen = new DebugScreen(container, layers, settlement, urlSeed, () => backToRegion(urlSeed));
    }
  } else {
    showRegion(urlSeed);
  }
} else {
  showRegion(urlSeed);
}
