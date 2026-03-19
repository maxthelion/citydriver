import { setupCity } from '../city/setup.js';
import { LAYERS } from '../rendering/debugLayers.js';
import { SeededRandom } from '../core/rng.js';
import { LandFirstDevelopment } from '../city/strategies/landFirstDevelopment.js';

const STRATEGY_CLASSES = [
  LandFirstDevelopment,
  LandFirstDevelopment,
  LandFirstDevelopment,
  LandFirstDevelopment,
];

const STRATEGY_NAMES = [
  'Land First 1',
  'Land First 2',
  'Land First 3',
  'Land First 4',
];
const DETAIL_SCALE = 4;
const GRID_DIVISIONS = 6;

export class CompareScreen {
  constructor(container, layers, settlement, seed, onBack) {
    this.container = container;
    this.layers = layers;
    this.settlement = settlement;
    this.seed = seed;
    this.onBack = onBack;
    this.maps = STRATEGY_CLASSES.map(() => null);
    this.strategies = STRATEGY_CLASSES.map(() => null);
    this.currentLayerIndex = 0;
    this._selectedCell = null;
    this.currentTick = 0;
    this._disposed = false;

    this._buildUI();
    this._generate();
  }

  _buildUI() {
    this.container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex; height:100vh; background:#1a1a2e; color:#eee; font-family:monospace;';

    // Sidebar (240px)
    const sidebar = document.createElement('div');
    sidebar.style.cssText = 'width:240px; padding:12px; overflow-y:auto; border-right:1px solid #333; display:flex; flex-direction:column; gap:10px;';

    // Title
    const title = document.createElement('div');
    title.style.cssText = 'font-size:14px; font-weight:bold; color:#88aaff;';
    title.textContent = 'Growth Comparison';
    sidebar.appendChild(title);

    // Seed controls
    const seedRow = document.createElement('div');
    seedRow.style.cssText = 'display:flex; gap:4px; align-items:center;';
    const seedLabel = document.createElement('span');
    seedLabel.textContent = 'Seed:';
    seedLabel.style.cssText = 'font-size:11px;';
    this.seedInput = document.createElement('input');
    this.seedInput.type = 'number';
    this.seedInput.value = this.seed;
    this.seedInput.style.cssText = 'width:70px; background:#2a2a3e; color:#eee; border:1px solid #555; padding:3px; font-family:monospace; font-size:11px;';
    seedRow.appendChild(seedLabel);
    seedRow.appendChild(this.seedInput);
    sidebar.appendChild(seedRow);

    // Tick controls
    const tickRow = document.createElement('div');
    tickRow.style.cssText = 'display:flex; gap:4px; align-items:center;';
    this.tickLabel = document.createElement('span');
    this.tickLabel.style.cssText = 'font-size:11px; min-width:60px;';
    this.tickLabel.textContent = 'Tick: 0';
    tickRow.appendChild(this.tickLabel);

    const stepBtn = document.createElement('button');
    stepBtn.textContent = 'Step';
    stepBtn.style.cssText = 'background:#335; color:#eee; border:1px solid #557; padding:3px 8px; cursor:pointer; font-family:monospace; font-size:11px;';
    stepBtn.onclick = () => this._step();
    tickRow.appendChild(stepBtn);

    const resetBtn = document.createElement('button');
    resetBtn.textContent = 'Reset';
    resetBtn.style.cssText = 'background:#533; color:#eee; border:1px solid #755; padding:3px 8px; cursor:pointer; font-family:monospace; font-size:11px;';
    resetBtn.onclick = () => this._reset();
    tickRow.appendChild(resetBtn);
    sidebar.appendChild(tickRow);

    // Layer selector
    const layerTitle = document.createElement('div');
    layerTitle.textContent = 'Layers';
    layerTitle.style.cssText = 'font-size:11px; font-weight:bold; margin-top:6px; color:#aaa;';
    sidebar.appendChild(layerTitle);

    this.layerButtons = [];
    for (let i = 0; i < LAYERS.length; i++) {
      const btn = document.createElement('button');
      btn.textContent = LAYERS[i].name;
      btn.style.cssText = 'display:block; width:100%; text-align:left; background:#2a2a3e; color:#ccc; border:1px solid #444; padding:3px 6px; cursor:pointer; font-family:monospace; font-size:10px; margin-bottom:1px;';
      btn.onclick = () => {
        this.currentLayerIndex = i;
        this._updateLayerButtons();
        this._renderAll();
      };
      sidebar.appendChild(btn);
      this.layerButtons.push(btn);
    }

    // Info area
    this.infoDiv = document.createElement('div');
    this.infoDiv.style.cssText = 'font-size:10px; color:#888; margin-top:auto; padding-top:8px; border-top:1px solid #333; line-height:1.4;';
    sidebar.appendChild(this.infoDiv);

    // Back button
    const backBtn = document.createElement('button');
    backBtn.textContent = 'Back to Region';
    backBtn.style.cssText = 'background:#444; color:#eee; border:1px solid #666; padding:4px 8px; cursor:pointer; font-family:monospace; font-size:11px; margin-top:6px;';
    backBtn.onclick = () => this.onBack();
    sidebar.appendChild(backBtn);

    wrapper.appendChild(sidebar);

    // Grid area (2 rows x 4 cols)
    const gridArea = document.createElement('div');
    const cols = STRATEGY_CLASSES.length;
    gridArea.style.cssText = `flex:1; display:grid; grid-template-columns:repeat(${cols},1fr); grid-template-rows:1fr 1fr; gap:4px; padding:4px; overflow:hidden;`;

    this.macroCanvases = [];
    this.microCanvases = [];
    this._microLabels = [];

    // Row 1: macro canvases
    for (let i = 0; i < STRATEGY_CLASSES.length; i++) {
      const cell = document.createElement('div');
      cell.style.cssText = 'display:flex; flex-direction:column; min-height:0;';

      const label = document.createElement('div');
      label.style.cssText = 'font-size:10px; color:#88aaff; text-align:center; padding:2px 0; flex-shrink:0;';
      label.textContent = STRATEGY_NAMES[i];
      cell.appendChild(label);

      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'flex:1; width:100%; image-rendering:pixelated; cursor:crosshair; object-fit:contain;';
      canvas.addEventListener('click', (e) => this._onMacroClick(e, i));
      cell.appendChild(canvas);

      this.macroCanvases.push(canvas);
      gridArea.appendChild(cell);
    }

    // Row 2: micro canvases
    for (let i = 0; i < STRATEGY_CLASSES.length; i++) {
      const cell = document.createElement('div');
      cell.style.cssText = 'display:flex; flex-direction:column; min-height:0;';

      const label = document.createElement('div');
      label.style.cssText = 'font-size:10px; color:#666; text-align:center; padding:2px 0; flex-shrink:0;';
      label.textContent = 'Click macro to zoom';
      cell.appendChild(label);

      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'flex:1; width:100%; image-rendering:auto; object-fit:contain;';
      cell.appendChild(canvas);

      this.microCanvases.push(canvas);
      this._microLabels.push(label);
      gridArea.appendChild(cell);
    }

    wrapper.appendChild(gridArea);
    this.container.appendChild(wrapper);

    this._onKeyDown = (e) => {
      if (e.key === 'Escape' && this._selectedCell) {
        this._selectedCell = null;
        this._renderAll();
      }
    };
    document.addEventListener('keydown', this._onKeyDown);

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
    const baseMap = setupCity(this.layers, this.settlement, rng.fork('city'));
    this.maps = STRATEGY_CLASSES.map((_, i) => baseMap.clone());
    this.strategies = this.maps.map((map, i) => new STRATEGY_CLASSES[i](map));
    this.currentTick = 0;
    this._selectedCell = null;
    this.tickLabel.textContent = 'Tick: 0';

    // Auto-run ticks 1-8 (skeleton + subdivision passes)
    for (let t = 0; t < 8; t++) {
      for (const s of this.strategies) s.tick();
      this.currentTick++;
    }
    this.tickLabel.textContent = `Tick: ${this.currentTick}`;

    // Update URL
    const url = new URL(location.href);
    url.searchParams.set('seed', this.seed);
    url.searchParams.set('mode', 'compare');
    url.searchParams.set('gx', this.settlement.gx);
    url.searchParams.set('gz', this.settlement.gz);
    history.replaceState(null, '', url);

    this._updateInfo();
    this._renderAll();
  }

  _step() {
    for (const s of this.strategies) s.tick();
    this.currentTick++;
    this.tickLabel.textContent = `Tick: ${this.currentTick}`;
    this._updateInfo();
    this._renderAll();
  }

  _reset() {
    this.seed = parseInt(this.seedInput.value) || 42;
    this._generate();
  }

  _onMacroClick(e, panelIndex) {
    const map = this.maps[panelIndex];
    if (!map) return;

    const canvas = this.macroCanvases[panelIndex];
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const gx = Math.floor((e.clientX - rect.left) * scaleX);
    const gz = Math.floor((e.clientY - rect.top) * scaleY);

    const cellW = Math.floor(map.width / GRID_DIVISIONS);
    const cellH = Math.floor(map.height / GRID_DIVISIONS);
    const col = Math.floor(gx / cellW);
    const row = Math.floor(gz / cellH);

    if (col >= 0 && col < GRID_DIVISIONS && row >= 0 && row < GRID_DIVISIONS) {
      this._selectedCell = { col, row };
      this._renderAll();
    }
  }

  _renderAll() {
    // Update micro labels
    for (let i = 0; i < STRATEGY_CLASSES.length; i++) {
      if (this._microLabels[i]) {
        this._microLabels[i].textContent = this._selectedCell
          ? `Detail: ${STRATEGY_NAMES[i]}`
          : 'Click macro to zoom';
      }
    }

    for (let i = 0; i < STRATEGY_CLASSES.length; i++) {
      this._renderMacro(i);
      this._renderMicro(i);
    }
  }

  _renderMacro(idx) {
    const map = this.maps[idx];
    if (!map) return;

    const canvas = this.macroCanvases[idx];
    canvas.width = map.width;
    canvas.height = map.height;
    const ctx = canvas.getContext('2d');

    // Render current layer
    const layer = LAYERS[this.currentLayerIndex];
    if (layer && layer.render) {
      layer.render(ctx, map);
    }

    // Draw grid overlay
    const cellW = Math.floor(map.width / GRID_DIVISIONS);
    const cellH = Math.floor(map.height / GRID_DIVISIONS);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 0.5;
    for (let c = 1; c < GRID_DIVISIONS; c++) {
      ctx.beginPath();
      ctx.moveTo(c * cellW, 0);
      ctx.lineTo(c * cellW, map.height);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, c * cellH);
      ctx.lineTo(map.width, c * cellH);
      ctx.stroke();
    }

    // Highlight selected cell
    if (this._selectedCell) {
      ctx.strokeStyle = '#88aaff';
      ctx.lineWidth = 1;
      ctx.strokeRect(
        this._selectedCell.col * cellW,
        this._selectedCell.row * cellH,
        cellW, cellH
      );
    }
  }

  _renderMicro(idx) {
    const map = this.maps[idx];
    const canvas = this.microCanvases[idx];
    if (!map || !this._selectedCell) {
      canvas.width = 100;
      canvas.height = 100;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(0, 0, 100, 100);
      ctx.fillStyle = '#444';
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Click macro', 50, 45);
      ctx.fillText('to zoom', 50, 58);
      return;
    }

    const cellW = Math.floor(map.width / GRID_DIVISIONS);
    const cellH = Math.floor(map.height / GRID_DIVISIONS);
    const S = DETAIL_SCALE;

    canvas.width = cellW * S;
    canvas.height = cellH * S;
    const ctx = canvas.getContext('2d');

    const gxStart = this._selectedCell.col * cellW;
    const gzStart = this._selectedCell.row * cellH;

    // Render the zoomed region using the current layer
    // Create a temporary canvas at 1:1, render the layer, then draw scaled
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = map.width;
    tempCanvas.height = map.height;
    const tempCtx = tempCanvas.getContext('2d');

    const layer = LAYERS[this.currentLayerIndex];
    if (layer && layer.render) {
      layer.render(tempCtx, map);
    }

    // Draw the selected region scaled up
    ctx.drawImage(
      tempCanvas,
      gxStart, gzStart, cellW, cellH,
      0, 0, cellW * S, cellH * S
    );

    // Draw roads in detail
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1.5;
    for (const road of map.roads) {
      if (!road.polyline || road.polyline.length < 2) continue;
      ctx.beginPath();
      let started = false;
      for (const p of road.polyline) {
        const lx = ((p.x - map.originX) / map.cellSize - gxStart) * S;
        const lz = ((p.z - map.originZ) / map.cellSize - gzStart) * S;
        if (!started) { ctx.moveTo(lx, lz); started = true; }
        else ctx.lineTo(lx, lz);
      }
      ctx.stroke();
    }
  }

  _updateInfo() {
    if (!this.infoDiv) return;
    const lines = [`Tick: ${this.currentTick}`, ''];
    for (let i = 0; i < STRATEGY_CLASSES.length; i++) {
      const m = this.maps[i];
      if (m) {
        const faces = m.graph.faces();
        const simpleFaces = faces.filter(f => f.length === new Set(f).size);
        let totalLength = 0;
        for (const road of m.roads) {
          if (!road.polyline) continue;
          for (let j = 0; j < road.polyline.length - 1; j++) {
            const dx = road.polyline[j + 1].x - road.polyline[j].x;
            const dz = road.polyline[j + 1].z - road.polyline[j].z;
            totalLength += Math.sqrt(dx * dx + dz * dz);
          }
        }
        const slivers = m.graph.detectSliverFaces();
        const crossings = m.graph.detectCrossingEdges();
        const shallow = m.graph.detectShallowAngles(5);
        lines.push(`<b>${STRATEGY_NAMES[i]}</b>`);
        lines.push(`  ${m.roads.length} roads, ${Math.round(totalLength)}m`);
        lines.push(`  ${simpleFaces.length} faces`);
        const bad = slivers.length + crossings.length + shallow.length;
        lines.push(`  <span style="color:${bad > 0 ? '#ff6666' : '#66ff66'}">${slivers.length} sliver, ${crossings.length} cross, ${shallow.length} shallow</span>`);
      }
    }
    this.infoDiv.innerHTML = lines.join('<br>');
  }

  dispose() {
    if (this._onKeyDown) {
      document.removeEventListener('keydown', this._onKeyDown);
    }
    this._disposed = true;
  }
}
