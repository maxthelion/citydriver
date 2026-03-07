/**
 * Debug viewer for city generation.
 * Shows the FeatureMap state with layer selection, tick controls, and seed input.
 */

import { setupCity } from '../city/setup.js';
import { buildSkeleton } from '../city/skeleton.js';
import { LAYERS } from '../rendering/debugLayers.js';
import { SeededRandom } from '../core/rng.js';

export class DebugScreen {
  constructor(container, layers, settlement, seed, onBack) {
    this.container = container;
    this.layers = layers;
    this.settlement = settlement;
    this.seed = seed;
    this.onBack = onBack;
    this.map = null;
    this.currentTick = -1;
    this.currentLayerIndex = 0;
    this._disposed = false;

    this._buildUI();
    this._generate();
  }

  _buildUI() {
    this.container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex; height:100vh; background:#1a1a2e; color:#eee; font-family:monospace;';

    // Canvas area
    const canvasArea = document.createElement('div');
    canvasArea.style.cssText = 'flex:1; display:flex; align-items:center; justify-content:center; padding:10px;';

    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'image-rendering:pixelated; border:1px solid #444;';
    canvasArea.appendChild(this.canvas);
    wrapper.appendChild(canvasArea);

    // Control panel
    const panel = document.createElement('div');
    panel.style.cssText = 'width:280px; padding:16px; overflow-y:auto; border-left:1px solid #333; display:flex; flex-direction:column; gap:12px;';

    // Title
    const title = document.createElement('div');
    title.style.cssText = 'font-size:16px; font-weight:bold; color:#88aaff;';
    title.textContent = 'V5 Debug Viewer';
    panel.appendChild(title);

    // Seed controls
    const seedRow = document.createElement('div');
    seedRow.style.cssText = 'display:flex; gap:6px; align-items:center;';
    const seedLabel = document.createElement('span');
    seedLabel.textContent = 'Seed:';
    seedLabel.style.cssText = 'font-size:12px;';
    this.seedInput = document.createElement('input');
    this.seedInput.type = 'number';
    this.seedInput.value = this.seed;
    this.seedInput.style.cssText = 'width:80px; background:#2a2a3e; color:#eee; border:1px solid #555; padding:4px; font-family:monospace;';
    seedRow.appendChild(seedLabel);
    seedRow.appendChild(this.seedInput);
    panel.appendChild(seedRow);

    // Tick controls
    const tickRow = document.createElement('div');
    tickRow.style.cssText = 'display:flex; gap:6px; align-items:center;';

    this.tickLabel = document.createElement('span');
    this.tickLabel.style.cssText = 'font-size:13px; min-width:80px;';
    this.tickLabel.textContent = 'Tick: -';
    tickRow.appendChild(this.tickLabel);

    const nextBtn = document.createElement('button');
    nextBtn.textContent = 'Next Tick';
    nextBtn.style.cssText = 'background:#335; color:#eee; border:1px solid #557; padding:4px 10px; cursor:pointer; font-family:monospace;';
    nextBtn.onclick = () => this._nextTick();
    tickRow.appendChild(nextBtn);

    const resetBtn = document.createElement('button');
    resetBtn.textContent = 'Reset';
    resetBtn.style.cssText = 'background:#533; color:#eee; border:1px solid #755; padding:4px 10px; cursor:pointer; font-family:monospace;';
    resetBtn.onclick = () => this._reset();
    tickRow.appendChild(resetBtn);

    panel.appendChild(tickRow);

    // Layer selector
    const layerTitle = document.createElement('div');
    layerTitle.textContent = 'Layers';
    layerTitle.style.cssText = 'font-size:13px; font-weight:bold; margin-top:8px; color:#aaa;';
    panel.appendChild(layerTitle);

    this.layerButtons = [];
    for (let i = 0; i < LAYERS.length; i++) {
      const btn = document.createElement('button');
      btn.textContent = LAYERS[i].name;
      btn.style.cssText = 'display:block; width:100%; text-align:left; background:#2a2a3e; color:#ccc; border:1px solid #444; padding:5px 8px; cursor:pointer; font-family:monospace; font-size:12px; margin-bottom:2px;';
      btn.onclick = () => {
        this.currentLayerIndex = i;
        this._updateLayerButtons();
        this._render();
      };
      panel.appendChild(btn);
      this.layerButtons.push(btn);
    }

    // Info area
    this.infoDiv = document.createElement('div');
    this.infoDiv.style.cssText = 'font-size:11px; color:#888; margin-top:auto; padding-top:12px; border-top:1px solid #333; line-height:1.5;';
    panel.appendChild(this.infoDiv);

    // Back button
    const backBtn = document.createElement('button');
    backBtn.textContent = 'Back to Region';
    backBtn.style.cssText = 'background:#444; color:#eee; border:1px solid #666; padding:6px 12px; cursor:pointer; font-family:monospace; margin-top:8px;';
    backBtn.onclick = () => this.onBack();
    panel.appendChild(backBtn);

    wrapper.appendChild(panel);
    this.container.appendChild(wrapper);

    this._updateLayerButtons();
  }

  _updateLayerButtons() {
    for (let i = 0; i < this.layerButtons.length; i++) {
      if (i === this.currentLayerIndex) {
        this.layerButtons[i].style.background = '#446';
        this.layerButtons[i].style.color = '#fff';
        this.layerButtons[i].style.borderColor = '#88aaff';
      } else {
        this.layerButtons[i].style.background = '#2a2a3e';
        this.layerButtons[i].style.color = '#ccc';
        this.layerButtons[i].style.borderColor = '#444';
      }
    }
  }

  _generate() {
    const rng = new SeededRandom(this.seed);
    this.map = setupCity(this.layers, this.settlement, rng.fork('city'));
    this.currentTick = 0;
    this.tickLabel.textContent = 'Tick: 0 (setup)';
    this._updateInfo();
    this._setupCanvas();
    this._render();
  }

  _nextTick() {
    if (!this.map) return;

    this.currentTick++;

    if (this.currentTick === 1) {
      buildSkeleton(this.map);
      this.tickLabel.textContent = 'Tick: 1 (skeleton)';
    } else {
      // Future: growth ticks
      this.tickLabel.textContent = `Tick: ${this.currentTick} (no growth yet)`;
    }

    this._updateInfo();
    this._render();
  }

  _reset() {
    this.seed = parseInt(this.seedInput.value) || 42;

    // Update URL
    const url = new URL(location.href);
    url.searchParams.set('seed', this.seed);
    url.searchParams.set('mode', 'debug');
    url.searchParams.set('gx', this.settlement.gx);
    url.searchParams.set('gz', this.settlement.gz);
    history.replaceState(null, '', url);

    this._generate();
  }

  _setupCanvas() {
    if (!this.map) return;
    this.canvas.width = this.map.width;
    this.canvas.height = this.map.height;

    // Scale canvas for display
    const maxDisplaySize = Math.min(window.innerWidth - 320, window.innerHeight - 40);
    const scale = Math.floor(maxDisplaySize / Math.max(this.map.width, this.map.height));
    this.canvas.style.width = `${this.map.width * Math.max(1, scale)}px`;
    this.canvas.style.height = `${this.map.height * Math.max(1, scale)}px`;
  }

  _render() {
    if (!this.map || this._disposed) return;

    const ctx = this.canvas.getContext('2d');
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    const layer = LAYERS[this.currentLayerIndex];
    if (layer && layer.render) {
      layer.render(ctx, this.map);
    }
  }

  _updateInfo() {
    if (!this.map) return;

    const info = [];
    info.push(`Grid: ${this.map.width} x ${this.map.height}`);
    info.push(`Cell: ${this.map.cellSize}m`);
    info.push(`Roads: ${this.map.roads.length}`);
    info.push(`Rivers: ${this.map.rivers.length}`);
    info.push(`Nuclei: ${this.map.nuclei.length}`);
    info.push(`Graph: ${this.map.graph.nodes.size} nodes, ${this.map.graph.edges.size} edges`);

    if (this.map.nuclei.length > 0) {
      const typeCounts = {};
      for (const n of this.map.nuclei) {
        typeCounts[n.type] = (typeCounts[n.type] || 0) + 1;
      }
      info.push('');
      info.push('Nucleus types:');
      for (const [type, count] of Object.entries(typeCounts)) {
        info.push(`  ${type}: ${count}`);
      }
    }

    this.infoDiv.innerHTML = info.join('<br>');
  }

  dispose() {
    this._disposed = true;
    this.container.innerHTML = '';
  }
}
