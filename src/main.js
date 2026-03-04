import { Game } from './game/game.js';
import { SeededRandom } from './core/rng.js';
import { extractCityContext } from './regional/region.js';
import { generateCity } from './generation/pipeline.js';
import { buildRoadMeshes } from './rendering/roadMesh.js';
import { buildBuildingMeshes } from './rendering/buildingMesh.js';
import { buildBridgeMeshes } from './rendering/bridgeMesh.js';
import { buildParkMeshes } from './rendering/parkMesh.js';
import { createMinimap } from './game/minimap.js';
import { createRegionModal } from './game/ui.js';
import { renderRegionalMap } from './rendering/regionalMap.js';

const game = new Game(document.getElementById('game-container'));
game.init();

// Set up minimap
game.minimap = createMinimap();

// Set up region selection modal
const regionModal = createRegionModal();

// Generate city from a region + settlement selection
async function enterCity(region, settlement) {
  regionModal.hide();
  regionModal.dispose3D();
  game.ui.showLoading();

  // Snapshot regional map for the in-game region minimap
  const regionSnap = document.createElement('canvas');
  regionSnap.width = 600;
  regionSnap.height = 600;
  renderRegionalMap(regionSnap, region, { selectedSettlement: settlement });
  game.minimap.setRegionMap(regionSnap);

  try {
    const seed = region.params.seed;

    // Extract city context from regional data
    const cityContext = extractCityContext(region, settlement, 25);

    // Phase display names and timing
    const phaseNames = {
      terrain: 'Phase 1/8: Terrain',
      arterials: 'Phase 2/8: Arterials',
      density: 'Phase 3/8: Density Field',
      districts: 'Phase 4/8: Districts',
      streets: 'Phase 5/8: Streets',
      plots: 'Phase 6/8: Plots',
      buildings: 'Phase 7/8: Buildings',
      amenities: 'Phase 8/8: Amenities',
    };
    const phaseTimes = {};
    let phaseStart = performance.now();
    let lastPhase = null;

    // Generate city
    const cityData = await generateCity(cityContext, {
      seed: seed + 1,
      gridSize: 256,
      organicness: 0.6,
    }, (phase, progress) => {
      const now = performance.now();

      // Record elapsed time for the previous phase when a new one starts
      if (lastPhase && lastPhase !== phase) {
        phaseTimes[lastPhase] = (now - phaseStart).toFixed(0);
        phaseStart = now;
      }
      if (!lastPhase) phaseStart = now;
      lastPhase = phase;

      // Build detail string showing completed phase timings
      const lines = Object.entries(phaseTimes).map(
        ([p, ms]) => `${phaseNames[p] || p}: ${ms}ms`
      );

      const label = phaseNames[phase] || phase;
      game.ui.setLoadingText(`Generating: ${label}...`, lines.join('\n'));
    });

    // Record the last phase
    if (lastPhase) {
      phaseTimes[lastPhase] = (performance.now() - phaseStart).toFixed(0);
    }

    // Log total timing
    const totalMs = Object.values(phaseTimes).reduce((s, v) => s + Number(v), 0);
    console.log(`City generated in ${totalMs}ms:`,
      Object.entries(phaseTimes).map(([p, ms]) => `${p}=${ms}ms`).join(', '));

    game.ui.setLoadingText('Building meshes...', Object.entries(phaseTimes).map(
      ([p, ms]) => `${phaseNames[p] || p}: ${ms}ms`
    ).join('\n'));

    // Build meshes
    const rng = new SeededRandom(seed + 2);
    const meshes = [];

    if (cityData.network.edges.length > 0) {
      meshes.push(buildRoadMeshes(cityData.network.edges, cityData.heightmap, game.materials, cityData.seaLevel));
    }

    // if (cityData.buildings && cityData.buildings.length > 0) {
    //   meshes.push(buildBuildingMeshes(cityData.buildings, cityData.heightmap, game.materials));
    // }

    if (cityData.network.bridges && cityData.network.bridges.length > 0) {
      meshes.push(buildBridgeMeshes(cityData.network.bridges, cityData.heightmap, game.materials));
    }

    const parkBlocks = (cityData.network.blocks || []).filter(b => b.landUse === 'park' || b.districtCharacter === 'parkland');
    if (parkBlocks.length > 0) {
      meshes.push(buildParkMeshes(parkBlocks, cityData.heightmap, game.materials, rng));
    }

    // Load into game
    game.cityData = cityData;
    game.loadTerrain(cityData.heightmap, cityData.seaLevel, cityData.buildings, meshes);

  } catch (err) {
    console.error('Generation failed:', err);
  }

  game.ui.hideLoading();
}

// Wire up modal → city entry
regionModal.onEnterCity(enterCity);

// "New City" button re-opens the modal
game.ui.onRegenerate(() => {
  regionModal.show();
});

// Show modal on startup (auto-generates first region)
regionModal.show();

// Start game loop (renders empty scene until terrain loads)
game.start();
