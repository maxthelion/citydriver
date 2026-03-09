import { RegionScreen } from './ui/RegionScreen.js';
import { CityScreen } from './ui/CityScreen.js';
import { DebugScreen } from './ui/DebugScreen.js';
import { CompareScreen } from './ui/CompareScreen.js';
import { generateRegionFromSeed } from './ui/regionHelper.js';
import { SeededRandom } from './core/rng.js';

const container = document.getElementById('game-container');
let regionScreen = null;
let cityScreen = null;
let debugScreen = null;
let compareScreen = null;

function disposeAll() {
  if (regionScreen) { regionScreen.dispose(); regionScreen = null; }
  if (cityScreen) { cityScreen.dispose(); cityScreen = null; }
  if (debugScreen) { debugScreen.dispose(); debugScreen = null; }
  if (compareScreen) { compareScreen.dispose(); compareScreen = null; }
  container.innerHTML = '';
}

function goBack() {
  history.back();
}

function enterSubScreen(mode, layers, settlement, seed) {
  disposeAll();
  const url = `?seed=${seed}&mode=${mode}&gx=${settlement.gx}&gz=${settlement.gz}`;
  history.pushState(null, '', url);

  if (mode === 'city') {
    const rng = new SeededRandom(seed || 42);
    cityScreen = new CityScreen(container, layers, settlement, rng.fork('city'), seed, goBack);
  } else if (mode === 'compare') {
    compareScreen = new CompareScreen(container, layers, settlement, seed, goBack);
  } else {
    debugScreen = new DebugScreen(container, layers, settlement, seed, goBack);
  }
}

function showRegion(initialSeed) {
  regionScreen = new RegionScreen(container, {
    onEnter(layers, settlement, seed) { enterSubScreen('city', layers, settlement, seed); },
    onDebug(layers, settlement, seed) { enterSubScreen('debug', layers, settlement, seed); },
    onCompare(layers, settlement, seed) { enterSubScreen('compare', layers, settlement, seed); },
  }, initialSeed);
}

// Browser back/forward button handler
window.addEventListener('popstate', () => {
  disposeAll();
  const params = new URLSearchParams(location.search);
  const mode = params.get('mode');
  const seed = params.has('seed') ? parseInt(params.get('seed')) : undefined;

  if (mode && seed != null) {
    const gx = parseInt(params.get('gx'));
    const gz = parseInt(params.get('gz'));
    const { layers, settlement } = generateRegionFromSeed(seed, gx, gz);
    if (settlement) {
      if (mode === 'city') {
        const rng = new SeededRandom(seed);
        cityScreen = new CityScreen(container, layers, settlement, rng.fork('city'), seed, goBack);
      } else if (mode === 'compare') {
        compareScreen = new CompareScreen(container, layers, settlement, seed, goBack);
      } else {
        debugScreen = new DebugScreen(container, layers, settlement, seed, goBack);
      }
      return;
    }
  }
  showRegion(seed);
});

// Check URL for deep-link into debug or city screen
const urlParams = new URLSearchParams(location.search);
const urlMode = urlParams.get('mode');
const urlSeed = urlParams.has('seed') ? parseInt(urlParams.get('seed')) : undefined;

if ((urlMode === 'debug' || urlMode === 'city' || urlMode === 'compare') && urlSeed != null) {
  const gx = parseInt(urlParams.get('gx'));
  const gz = parseInt(urlParams.get('gz'));

  const { layers, settlement } = generateRegionFromSeed(urlSeed, gx, gz);
  if (settlement) {
    // Push region state first so browser back goes to region view
    history.replaceState(null, '', `?seed=${urlSeed}`);
    history.pushState(null, '', `?seed=${urlSeed}&mode=${urlMode}&gx=${gx}&gz=${gz}`);

    if (urlMode === 'city') {
      const rng = new SeededRandom(urlSeed);
      cityScreen = new CityScreen(container, layers, settlement, rng.fork('city'), urlSeed, goBack);
    } else if (urlMode === 'compare') {
      compareScreen = new CompareScreen(container, layers, settlement, urlSeed, goBack);
    } else {
      debugScreen = new DebugScreen(container, layers, settlement, urlSeed, goBack);
    }
  } else {
    showRegion(urlSeed);
  }
} else {
  showRegion(urlSeed);
}
