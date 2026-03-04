import { RegionScreen } from './ui/RegionScreen.js';
import { CityScreen } from './ui/CityScreen.js';
import { SeededRandom } from './core/rng.js';

const container = document.getElementById('game-container');
let regionScreen = null;
let cityScreen = null;

function showRegion() {
  regionScreen = new RegionScreen(container, (layers, settlement, seed) => {
    // Enter city: switch to city generation + fly-around
    regionScreen.dispose();
    regionScreen = null;

    const rng = new SeededRandom(seed || 42);
    cityScreen = new CityScreen(container, layers, settlement, rng.fork('city'), () => {
      // Back to region
      cityScreen.dispose();
      cityScreen = null;
      container.innerHTML = '';
      showRegion();
    });
  });
}

showRegion();
