import * as THREE from 'three';
import { App } from './App.js';
import { generateCity } from '../city/pipeline.js';
import { buildBuildingMeshes } from '../rendering/buildingMesh.js';
import { buildRoadMeshes } from '../rendering/roadMesh.js';
import { buildCityTerrainMesh } from '../rendering/terrainMesh.js';
import { buildCityWaterMesh, buildRiverMeshes } from '../rendering/waterMesh.js';
import { renderMap, drawRivers, drawRoads, drawSettlements } from '../rendering/mapRenderer.js';
import { LoadingOverlay } from './LoadingOverlay.js';

/**
 * City fly-around screen with full 3D rendering + HUD.
 */
export class CityScreen {
  /**
   * @param {HTMLElement} container
   * @param {import('../core/LayerStack.js').LayerStack} regionalLayers
   * @param {object} settlement
   * @param {import('../core/rng.js').SeededRandom} rng
   * @param {number} seed
   * @param {function} onBack - callback when user clicks "Back to Region"
   */
  constructor(container, regionalLayers, settlement, rng, seed, onBack) {
    this.container = container;
    this.onBack = onBack;
    this._regionalLayers = regionalLayers;
    this._seed = seed;
    this._hud = [];

    // Push seed into URL
    if (seed != null) {
      const params = new URLSearchParams();
      params.set('mode', 'city');
      params.set('seed', seed);
      params.set('gx', settlement.gx);
      params.set('gz', settlement.gz);
      history.replaceState(null, '', '?' + params.toString());
    }

    // Show loading overlay, generate city, then build scene
    const loading = new LoadingOverlay(container);
    loading.setProgress(0.1, 'Generating city layout...');

    // Use setTimeout to let the overlay render before blocking generation
    setTimeout(() => {
      try {
        loading.setProgress(0.3, 'Building roads and districts...');
        const radiusByTier = { 1: 40, 2: 30, 3: 20 };
        const cityRadius = radiusByTier[settlement.tier] ?? 20;
        const cityLayers = generateCity(regionalLayers, settlement, rng, {
          cityRadius,
          cityCellSize: 10,
        });

        loading.setProgress(0.7, 'Building 3D scene...');
        this._buildScene(container, cityLayers, settlement);

        loading.setProgress(1.0, 'Done');
        loading.dispose();
      } catch (err) {
        loading.setProgress(0, `Error: ${err.message}`);
        console.error('City generation failed:', err);
      }
    }, 50);
  }

  _buildScene(container, cityLayers, settlement) {
    this._app = new App(container);
    this._layers = {};

    // Terrain
    const terrain = buildCityTerrainMesh(cityLayers);
    this._app.add(terrain);
    this._layers.terrain = terrain;

    // Water
    const water = buildCityWaterMesh(cityLayers);
    this._app.add(water);
    this._layers.water = water;

    // Rivers
    const rivers = buildRiverMeshes(cityLayers);
    this._app.add(rivers);
    this._layers.rivers = rivers;

    // Roads
    const roadGraph = cityLayers.getData('roadGraph');
    const elevation = cityLayers.getGrid('elevation');
    if (roadGraph) {
      const roads = buildRoadMeshes(roadGraph, elevation);
      this._app.add(roads);
      this._layers.roads = roads;
    }

    // Buildings
    const buildings = cityLayers.getData('buildings');
    if (buildings && buildings.length > 0) {
      const buildingGroup = buildBuildingMeshes(buildings);
      this._app.add(buildingGroup);
      this._layers.buildings = buildingGroup;
    }

    // Parks — disabled, green disks don't look right
    // TODO: replace with proper park geometry (trees, fenced areas, etc.)
    // const amenities = cityLayers.getData('amenities');
    // if (amenities && amenities.length > 0) {
    //   const parks = buildParkMeshes(amenities, elevation);
    //   this._app.add(parks);
    //   this._layers.parks = parks;
    // }

    // Position camera at city center, elevated
    const params = cityLayers.getData('params');
    const cx = params.width * params.cellSize / 2;
    const cz = params.height * params.cellSize / 2;
    const centerGx = Math.floor(params.width / 2);
    const centerGz = Math.floor(params.height / 2);
    const cy = (elevation ? elevation.get(centerGx, centerGz) : 0) + 80;
    this._app.flyCamera.setPosition(cx, cy, cz);

    this._app.start();

    // Setup minimap
    const cityWidth = params.width * params.cellSize;
    const cityHeight = params.height * params.cellSize;
    this._app.setupMinimap(cityWidth, cityHeight);

    // Region minimap: static 2D overlay showing city extent within the region
    if (this._regionalLayers) {
      this._buildRegionMinimap(settlement);
    }

    // HUD: Back button
    const backBtn = document.createElement('button');
    backBtn.textContent = 'Back to Region';
    backBtn.style.cssText =
      'position:fixed;top:10px;left:10px;padding:8px 16px;background:#444;color:#eee;border:1px solid #666;cursor:pointer;font-family:monospace;font-size:13px;border-radius:4px;z-index:100';
    backBtn.addEventListener('click', () => {
      if (this.onBack) this.onBack();
    });
    document.body.appendChild(backBtn);
    this._hud.push(backBtn);

    // HUD: Layers palette
    const palette = document.createElement('div');
    palette.style.cssText =
      'position:fixed;left:10px;top:50px;background:rgba(0,0,0,0.7);color:#eee;font-family:monospace;font-size:12px;padding:8px 10px;border-radius:4px;z-index:100';
    for (const [name, mesh] of Object.entries(this._layers)) {
      const label = document.createElement('label');
      label.style.cssText = 'display:block;cursor:pointer;margin:2px 0';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.style.marginRight = '6px';
      cb.addEventListener('change', () => { mesh.visible = cb.checked; });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(name));
      palette.appendChild(label);
    }
    document.body.appendChild(palette);
    this._hud.push(palette);

    // HUD: Instructions
    const info = document.createElement('div');
    info.style.cssText =
      'position:fixed;bottom:10px;left:10px;color:white;font-family:monospace;font-size:13px;pointer-events:none;text-shadow:1px 1px 2px black;z-index:100';
    info.textContent = 'Click to capture mouse. WASD move, Mouse look, Space/Shift up/down, Scroll to change speed.';
    document.body.appendChild(info);
    this._hud.push(info);

    // HUD: City info
    const cityInfo = document.createElement('div');
    cityInfo.style.cssText =
      'position:fixed;top:200px;right:10px;background:rgba(0,0,0,0.7);color:#eee;font-family:monospace;font-size:12px;padding:10px;border-radius:4px;z-index:100;max-height:60vh;overflow-y:auto';
    const bCount = buildings ? buildings.length : 0;
    const rCount = roadGraph ? roadGraph.edges.size : 0;
    const amenities = cityLayers.getData('amenities');
    const aCount = amenities ? amenities.length : 0;
    const population = cityLayers.getData('population') ?? 0;
    const targetPop = cityLayers.getData('targetPopulation') ?? 0;
    const validation = cityLayers.getData('cityValidation');

    const lines = [
      `<b>City Stats</b>`,
      `Seed: ${this._seed ?? '—'}`,
      `Population: ${Math.round(population)} / ${targetPop}`,
      `Buildings: ${bCount}`,
      `Road segments: ${rCount}`,
      `Amenities: ${aCount}`,
    ];

    if (validation) {
      lines.push('');
      lines.push(`<b>Validation</b>`);
      lines.push(`Valid: ${validation.valid ? '<span style="color:#6f6">YES</span>' : '<span style="color:#f66">NO</span>'}`);
      lines.push(`Structural: ${(validation.structural * 100).toFixed(0)}%`);
      lines.push(`Quality: ${(validation.quality * 100).toFixed(0)}%`);
      lines.push(`Overall: ${(validation.overall * 100).toFixed(0)}%`);

      // Show T1 failures
      const t1Fails = validation.tier1.filter(e => !e.value);
      if (t1Fails.length > 0) {
        lines.push(`<span style="color:#f66">Fails: ${t1Fails.map(e => e.name).join(', ')}</span>`);
      }

      // Show T2 scores
      for (const e of validation.tier2) {
        const pct = (e.value * 100).toFixed(0);
        const color = e.value > 0.7 ? '#6f6' : e.value > 0.4 ? '#ff6' : '#f66';
        lines.push(`<span style="color:${color}">${e.name}: ${pct}%</span>`);
      }

      // Show T3 scores
      for (const e of validation.tier3) {
        const pct = (e.value * 100).toFixed(0);
        const color = e.value > 0.7 ? '#6f6' : e.value > 0.4 ? '#ff6' : '#f66';
        lines.push(`<span style="color:${color}">${e.name}: ${pct}%</span>`);
      }
    }

    cityInfo.innerHTML = lines.join('<br>');
    document.body.appendChild(cityInfo);
    this._hud.push(cityInfo);
  }

  _buildRegionMinimap(settlement) {
    const layers = this._regionalLayers;
    const params = layers.getData('params');
    if (!params) return;

    // Render the regional map to an offscreen canvas
    const offscreen = document.createElement('canvas');
    renderMap(layers, offscreen, { mode: 'elevation' });
    const ctx = offscreen.getContext('2d');

    // Draw rivers, roads, and settlements on top
    drawRivers(layers, ctx);
    drawRoads(layers, ctx);
    drawSettlements(layers, ctx);

    // Draw city extent rectangle
    const cityParams = this._layers.terrain
      ? this._app.scene.children[0] // fallback
      : null;
    const cp = layers.getData('params');
    const cityRadius = { 1: 40, 2: 30, 3: 20 }[settlement.tier] ?? 20;
    const minGx = Math.max(0, settlement.gx - cityRadius);
    const minGz = Math.max(0, settlement.gz - cityRadius);
    const maxGx = Math.min(cp.width - 1, settlement.gx + cityRadius);
    const maxGz = Math.min(cp.height - 1, settlement.gz + cityRadius);

    ctx.strokeStyle = '#ff3333';
    ctx.lineWidth = 2;
    ctx.strokeRect(minGx, minGz, maxGx - minGx, maxGz - minGz);

    // Create the HTML overlay element
    const minimapEl = document.createElement('canvas');
    const displaySize = 180;
    minimapEl.width = displaySize;
    minimapEl.height = displaySize;
    minimapEl.style.cssText =
      `position:fixed;top:10px;right:10px;width:${displaySize}px;height:${displaySize}px;border:2px solid rgba(255,255,255,0.5);border-radius:4px;z-index:100;image-rendering:pixelated;pointer-events:none`;

    const displayCtx = minimapEl.getContext('2d');
    displayCtx.imageSmoothingEnabled = false;
    displayCtx.drawImage(offscreen, 0, 0, displaySize, displaySize);

    document.body.appendChild(minimapEl);
    this._hud.push(minimapEl);
  }

  dispose() {
    if (this._app) {
      this._app.dispose();
      this._app = null;
    }
    for (const el of this._hud) {
      el.remove();
    }
    this._hud = [];
    this.container.innerHTML = '';
  }
}
