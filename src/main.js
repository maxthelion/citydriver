import { RegionScreen } from './ui/RegionScreen.js';
import { CityScreen } from './ui/CityScreen.js';
import { DebugScreen } from './ui/DebugScreen.js';
import { CompareScreen } from './ui/CompareScreen.js';
import { CompareArchetypesScreen } from './ui/CompareArchetypesScreen.js';
import { BuildingStyleScreen } from './ui/BuildingStyleScreen.js';
import { TerracedRowScreen } from './ui/TerracedRowScreen.js';
import { RailwayScreen } from './ui/RailwayScreen.js';
import { generateRegionFromSeed } from './ui/regionHelper.js';
import { buildCityMap } from './city/buildCityMap.js';

const container = document.getElementById('game-container');
let regionScreen = null;
let cityScreen = null;
let debugScreen = null;
let compareScreen = null;
let compareArchetypesScreen = null;
let buildingScreen = null;
let terracedScreen = null;
let railwayScreen = null;

function disposeAll() {
  if (regionScreen) { regionScreen.dispose(); regionScreen = null; }
  if (cityScreen) { cityScreen.dispose(); cityScreen = null; }
  if (debugScreen) { debugScreen.dispose(); debugScreen = null; }
  if (compareScreen) { compareScreen.dispose(); compareScreen = null; }
  if (compareArchetypesScreen) { compareArchetypesScreen.dispose(); compareArchetypesScreen = null; }
  if (buildingScreen) { buildingScreen.dispose(); buildingScreen = null; }
  if (terracedScreen) { terracedScreen.dispose(); terracedScreen = null; }
  if (railwayScreen) { railwayScreen.dispose(); railwayScreen = null; }
  container.innerHTML = '';
}

function goBack() {
  history.back();
}

function enterSubScreen(mode, layers, settlement, seed, opts = {}) {
  disposeAll();
  const { archetype, step, growth, lens } = opts;
  let url = `?seed=${seed}&mode=${mode}&gx=${settlement.gx}&gz=${settlement.gz}`;
  if (archetype && archetype !== 'auto') url += `&archetype=${archetype}`;
  if (step) url += `&step=${step}`;
  if (step === 'growth' && growth) url += `&growth=${growth}`;
  if (lens && (mode === 'debug' || mode === 'compare-archetypes')) url += `&lens=${lens}`;
  history.pushState(null, '', url);

  if (mode === 'city') {
    buildCityMap({ seed, layers, settlement, archetype, step, growth }).then(({ map }) => {
      cityScreen = new CityScreen(container, map, seed, goBack);
    });
  } else if (mode === 'compare') {
    compareScreen = new CompareScreen(container, layers, settlement, seed, goBack);
  } else if (mode === 'compare-archetypes') {
    compareArchetypesScreen = new CompareArchetypesScreen(container, layers, settlement, seed, goBack);
  } else if (mode === 'buildings') {
    buildingScreen = new BuildingStyleScreen(container, goBack);
  } else if (mode === 'terraced') {
    terracedScreen = new TerracedRowScreen(container, goBack);
  } else {
    debugScreen = new DebugScreen(container, layers, settlement, seed, goBack);
  }
}

function showRegion(initialSeed) {
  regionScreen = new RegionScreen(container, {
    onGo(mode, layers, settlement, seed, opts) {
      enterSubScreen(mode, layers, settlement, seed, opts);
    },
    onBuildings() {
      disposeAll();
      history.pushState(null, '', '?mode=buildings');
      buildingScreen = new BuildingStyleScreen(container, goBack);
    },
    onTerraced() {
      disposeAll();
      history.pushState(null, '', '?mode=terraced');
      terracedScreen = new TerracedRowScreen(container, goBack);
    },
    onRailways(layers, seed) {
      disposeAll();
      history.pushState(null, '', `?seed=${seed}&mode=railway`);
      railwayScreen = new RailwayScreen(container, layers, seed, goBack);
    },
  }, initialSeed);
}

// Browser back/forward button handler
window.addEventListener('popstate', () => {
  disposeAll();
  const params = new URLSearchParams(location.search);
  const mode = params.get('mode');
  const seed = params.has('seed') ? parseInt(params.get('seed')) : undefined;

  if (mode === 'buildings') {
    buildingScreen = new BuildingStyleScreen(container, goBack);
    return;
  }

  if (mode === 'terraced') {
    terracedScreen = new TerracedRowScreen(container, goBack);
    return;
  }

  if (mode === 'railway' && seed != null) {
    const { layers } = generateRegionFromSeed(seed);
    railwayScreen = new RailwayScreen(container, layers, seed, goBack);
    return;
  }

  if (mode && seed != null) {
    const gx = parseInt(params.get('gx'));
    const gz = parseInt(params.get('gz'));
    const { layers, settlement } = generateRegionFromSeed(seed, gx, gz);
    if (settlement) {
      if (mode === 'city') {
        buildCityMap({ seed, layers, settlement }).then(({ map }) => {
          cityScreen = new CityScreen(container, map, seed, goBack);
        });
      } else if (mode === 'compare') {
        compareScreen = new CompareScreen(container, layers, settlement, seed, goBack);
      } else if (mode === 'compare-archetypes') {
        compareArchetypesScreen = new CompareArchetypesScreen(container, layers, settlement, seed, goBack);
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

if (urlMode === 'buildings') {
  buildingScreen = new BuildingStyleScreen(container, goBack);
} else if (urlMode === 'terraced') {
  terracedScreen = new TerracedRowScreen(container, goBack);
} else if (urlMode === 'railway' && urlSeed != null) {
  const { layers } = generateRegionFromSeed(urlSeed);
  history.replaceState(null, '', `?seed=${urlSeed}`);
  history.pushState(null, '', `?seed=${urlSeed}&mode=railway`);
  railwayScreen = new RailwayScreen(container, layers, urlSeed, goBack);
} else if ((urlMode === 'debug' || urlMode === 'city' || urlMode === 'compare' || urlMode === 'compare-archetypes') && urlSeed != null) {
  const gx = parseInt(urlParams.get('gx'));
  const gz = parseInt(urlParams.get('gz'));

  const { layers, settlement } = generateRegionFromSeed(urlSeed, gx, gz);
  if (settlement) {
    // Push region state first so browser back goes to region view
    const fullSearch = location.search;
    history.replaceState(null, '', `?seed=${urlSeed}`);
    history.pushState(null, '', fullSearch);

    if (urlMode === 'city') {
      buildCityMap({ seed: urlSeed, layers, settlement }).then(({ map }) => {
        cityScreen = new CityScreen(container, map, urlSeed, goBack);
      });
    } else if (urlMode === 'compare') {
      compareScreen = new CompareScreen(container, layers, settlement, urlSeed, goBack);
    } else if (urlMode === 'compare-archetypes') {
      compareArchetypesScreen = new CompareArchetypesScreen(container, layers, settlement, urlSeed, goBack);
    } else {
      debugScreen = new DebugScreen(container, layers, settlement, urlSeed, goBack);
    }
  } else {
    showRegion(urlSeed);
  }
} else {
  showRegion(urlSeed);
}
