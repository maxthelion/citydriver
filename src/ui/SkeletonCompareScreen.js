import { setupCity } from '../city/setup.js';
import { LAYERS } from '../rendering/debugLayers.js';
import { SeededRandom } from '../core/rng.js';
import { currentSkeleton, straightLineSkeleton, topologySkeleton } from '../city/skeletonStrategies.js';

const SKELETON_STRATEGIES = [currentSkeleton, straightLineSkeleton, topologySkeleton];
const SKELETON_NAMES = ['Current (A*)', 'Straight Line', 'Topology First'];
const DETAIL_SCALE = 4;
const GRID_DIVISIONS = 6;

export class SkeletonCompareScreen {
  constructor(container, layers, settlement, seed, onBack) {
    this.container = container;
    this.layers = layers;
    this.settlement = settlement;
    this.seed = seed;
    this.onBack = onBack;
    this.maps = SKELETON_STRATEGIES.map(() => null);
    this.currentLayerIndex = 0;
    this._selectedCell = null;
    this._disposed = false;

    this._buildUI();
    this._generate();
  }

  _buildUI() {
    this.container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex; height:100vh; background:#1a1a2e; color:#eee; font-family:monospace;';

    // Sidebar
    const sidebar = document.createElement('div');
    sidebar.style.cssText = 'width:240px; padding:12px; overflow-y:auto; border-right:1px solid #333; display:flex; flex-direction:column; gap:10px;';

    const title = document.createElement('div');
    title.style.cssText = 'font-size:14px; font-weight:bold; color:#ffaa88;';
    title.textContent = 'Skeleton Comparison';
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

    const goBtn = document.createElement('button');
    goBtn.textContent = 'Go';
    goBtn.style.cssText = 'background:#553; color:#eee; border:1px solid #775; padding:3px 8px; cursor:pointer; font-family:monospace; font-size:11px;';
    goBtn.onclick = () => this._reset();
    seedRow.appendChild(goBtn);
    sidebar.appendChild(seedRow);

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

    // Grid area (2 rows x 3 cols)
    const gridArea = document.createElement('div');
    const cols = SKELETON_STRATEGIES.length;
    gridArea.style.cssText = `flex:1; display:grid; grid-template-columns:repeat(${cols},1fr); grid-template-rows:1fr 1fr; gap:4px; padding:4px; overflow:hidden;`;

    this.macroCanvases = [];
    this.microCanvases = [];
    this._microLabels = [];

    // Row 1: macro
    for (let i = 0; i < SKELETON_STRATEGIES.length; i++) {
      const cell = document.createElement('div');
      cell.style.cssText = 'display:flex; flex-direction:column; min-height:0;';

      const label = document.createElement('div');
      label.style.cssText = 'font-size:10px; color:#ffaa88; text-align:center; padding:2px 0; flex-shrink:0;';
      label.textContent = SKELETON_NAMES[i];
      cell.appendChild(label);

      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'flex:1; width:100%; image-rendering:pixelated; cursor:crosshair; object-fit:contain;';
      canvas.addEventListener('click', (e) => this._onMacroClick(e, i));
      cell.appendChild(canvas);

      this.macroCanvases.push(canvas);
      gridArea.appendChild(cell);
    }

    // Row 2: micro
    for (let i = 0; i < SKELETON_STRATEGIES.length; i++) {
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
        this.layerButtons[i].style.borderColor = '#ffaa88';
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

    this.maps = SKELETON_STRATEGIES.map((strategyFn, i) => {
      const map = baseMap.clone();
      strategyFn(map);
      return map;
    });

    this._selectedCell = null;

    // Update URL
    const url = new URL(location.href);
    url.searchParams.set('seed', this.seed);
    url.searchParams.set('mode', 'skeletons');
    url.searchParams.set('gx', this.settlement.gx);
    url.searchParams.set('gz', this.settlement.gz);
    history.replaceState(null, '', url);

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
    for (let i = 0; i < SKELETON_STRATEGIES.length; i++) {
      if (this._microLabels[i]) {
        this._microLabels[i].textContent = this._selectedCell
          ? `Detail: ${SKELETON_NAMES[i]}`
          : 'Click macro to zoom';
      }
    }

    for (let i = 0; i < SKELETON_STRATEGIES.length; i++) {
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

    const layer = LAYERS[this.currentLayerIndex];
    if (layer && layer.render) {
      layer.render(ctx, map);
    }

    // Grid overlay
    const cellW = Math.floor(map.width / GRID_DIVISIONS);
    const cellH = Math.floor(map.height / GRID_DIVISIONS);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 0.5;
    for (let c = 1; c < GRID_DIVISIONS; c++) {
      ctx.beginPath();
      ctx.moveTo(c * cellW, 0); ctx.lineTo(c * cellW, map.height);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, c * cellH); ctx.lineTo(map.width, c * cellH);
      ctx.stroke();
    }

    // Selected cell highlight
    if (this._selectedCell) {
      ctx.strokeStyle = '#ffaa88';
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

    // Render layer at 1:1 then scale up
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = map.width;
    tempCanvas.height = map.height;
    const tempCtx = tempCanvas.getContext('2d');

    const layer = LAYERS[this.currentLayerIndex];
    if (layer && layer.render) {
      layer.render(tempCtx, map);
    }

    ctx.drawImage(
      tempCanvas,
      gxStart, gzStart, cellW, cellH,
      0, 0, cellW * S, cellH * S
    );

    // Draw road polylines in detail
    ctx.lineWidth = 1.5;
    for (const road of map.roads) {
      if (!road.polyline || road.polyline.length < 2) continue;

      // Color by hierarchy; bridges get a distinct cyan
      if (road.bridge) ctx.strokeStyle = 'rgba(0,220,255,0.9)';
      else if (road.hierarchy === 'arterial') ctx.strokeStyle = 'rgba(255,200,100,0.8)';
      else if (road.hierarchy === 'collector') ctx.strokeStyle = 'rgba(200,200,255,0.7)';
      else ctx.strokeStyle = 'rgba(255,255,255,0.5)';

      ctx.beginPath();
      let started = false;
      for (const p of road.polyline) {
        const lx = ((p.x - map.originX) / map.cellSize - gxStart) * S;
        const lz = ((p.z - map.originZ) / map.cellSize - gzStart) * S;
        if (!started) { ctx.moveTo(lx, lz); started = true; }
        else ctx.lineTo(lx, lz);
      }
      ctx.stroke();

      // Draw vertices as dots
      ctx.fillStyle = 'rgba(255,100,100,0.6)';
      for (const p of road.polyline) {
        const lx = ((p.x - map.originX) / map.cellSize - gxStart) * S;
        const lz = ((p.z - map.originZ) / map.cellSize - gzStart) * S;
        ctx.fillRect(lx - 1, lz - 1, 2, 2);
      }
    }

    // Draw graph nodes
    ctx.fillStyle = '#00ff88';
    for (const [, node] of map.graph.nodes) {
      const lx = ((node.x - map.originX) / map.cellSize - gxStart) * S;
      const lz = ((node.z - map.originZ) / map.cellSize - gzStart) * S;
      if (lx >= -4 && lx <= cellW * S + 4 && lz >= -4 && lz <= cellH * S + 4) {
        const degree = map.graph.degree(node.id);
        const r = degree === 1 ? 3 : degree >= 3 ? 4 : 2;
        ctx.beginPath();
        ctx.arc(lx, lz, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  _updateInfo() {
    if (!this.infoDiv) return;
    const lines = [];
    for (let i = 0; i < SKELETON_STRATEGIES.length; i++) {
      const m = this.maps[i];
      if (!m) continue;

      let totalLength = 0;
      let totalPoints = 0;
      for (const road of m.roads) {
        if (!road.polyline) continue;
        totalPoints += road.polyline.length;
        for (let j = 0; j < road.polyline.length - 1; j++) {
          const dx = road.polyline[j + 1].x - road.polyline[j].x;
          const dz = road.polyline[j + 1].z - road.polyline[j].z;
          totalLength += Math.sqrt(dx * dx + dz * dz);
        }
      }

      const degrees = {};
      for (const [id] of m.graph.nodes) {
        const d = m.graph.degree(id);
        degrees[d] = (degrees[d] || 0) + 1;
      }

      lines.push(`<b style="color:#ffaa88">${SKELETON_NAMES[i]}</b>`);
      lines.push(`  ${m.roads.length} roads, ${Math.round(totalLength)}m`);
      lines.push(`  ${totalPoints} polyline pts`);
      lines.push(`  ${m.graph.nodes.size} nodes, ${m.graph.edges.size} edges`);
      lines.push(`  dead ends: ${degrees[1] || 0}`);
      lines.push(`  pass-thru (deg 2): ${degrees[2] || 0}`);
      lines.push(`  junctions (3+): ${Object.entries(degrees).filter(([d]) => d >= 3).reduce((s, [, c]) => s + c, 0)}`);
      lines.push('');
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
