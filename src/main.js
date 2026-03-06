import { RegionScreen } from './ui/RegionScreen.js';
import { CityScreen } from './ui/CityScreen.js';
import { DebugScreen } from './ui/DebugScreen.js';
import { generateRegionFromSeed } from './ui/regionHelper.js';
import { SeededRandom } from './core/rng.js';

const container = document.getElementById('game-container');
let regionScreen = null;
let cityScreen = null;
let debugScreen = null;

function backToRegion() {
  if (cityScreen) { cityScreen.dispose(); cityScreen = null; }
  if (debugScreen) { debugScreen.dispose(); debugScreen = null; }
  history.replaceState(null, '', location.pathname);
  container.innerHTML = '';
  showRegion();
}

function showRegion(initialSeed) {
  regionScreen = new RegionScreen(container, {
    onEnter(layers, settlement, seed) {
      regionScreen.dispose();
      regionScreen = null;

      const rng = new SeededRandom(seed || 42);
      cityScreen = new CityScreen(container, layers, settlement, rng.fork('city'), backToRegion);
    },
    onDebug(layers, settlement, seed) {
      regionScreen.dispose();
      regionScreen = null;

      debugScreen = new DebugScreen(container, layers, settlement, seed, backToRegion);
    },
  }, initialSeed);
}

// Check URL for deep-link into debug screen
const params = new URLSearchParams(location.search);
if (params.get('mode') === 'debug' && params.has('seed')) {
  const seed = parseInt(params.get('seed'));
  const gx = parseInt(params.get('gx'));
  const gz = parseInt(params.get('gz'));

  const { layers, settlement } = generateRegionFromSeed(seed, gx, gz);
  if (settlement) {
    debugScreen = new DebugScreen(container, layers, settlement, seed, backToRegion);
  } else {
    showRegion(seed);
  }
} else {
  const seed = params.has('seed') ? parseInt(params.get('seed')) : undefined;
  showRegion(seed);
}
