/**
 * Debug viewer for city generation.
 * Two modes:
 *   - City overview: shows full FeatureMap with grid overlay. Minimap = region.
 *   - Cell detail: zoomed schematic of a grid cell. Minimap = city overview.
 * Click a grid cell to zoom in. Click "Back to City" or press Escape to zoom out.
 */

import { setupCity } from '../city/setup.js';
import { LandFirstDevelopment } from '../city/strategies/landFirstDevelopment.js';
import { ARCHETYPES } from '../city/archetypes.js';
import { scoreSettlement } from '../city/archetypeScoring.js';
import { LAYERS, layerSlug, layerIndexFromSlug } from '../rendering/debugLayers.js';
import { renderMap, drawRivers, drawRoads, drawSettlements } from '../rendering/mapRenderer.js';
import { SeededRandom } from '../core/rng.js';

// ── Pipeline step helpers ─────────────────────────────────────────────────────

/** Human-readable label for a pipeline step ID. */
function stepToLabel(stepId) {
  if (!stepId) return 'not started';
  const labels = {
    'skeleton': 'Skeleton roads', 'land-value': 'Land value',
    'zones': 'Zones', 'zone-boundary': 'Zone boundary roads',
    'zones-refine': 'Zones (refined)', 'spatial': 'Spatial layers',
    'growth:gpu-init': 'GPU init', 'connect': 'Connect to network',
  };
  if (labels[stepId]) return labels[stepId];
  const m = stepId.match(/^growth-(\d+):(.+)$/);
  if (m) return `Growth ${m[1]} — ${m[2]}`;
  return stepId;
}

/**
 * Return true when we should stop advancing after running stepId.
 * targetStep: URL param value ('skeleton','land-value','zones','spatial','growth','connect')
 * growthCount: number of growth ticks (for targetStep==='growth')
 */
function shouldStopAfter(stepId, targetStep, growthCount) {
  if (!targetStep || targetStep === 'connect') return false; // run to completion
  if (targetStep === 'skeleton')   return stepId === 'skeleton';
  if (targetStep === 'land-value') return stepId === 'land-value';
  if (targetStep === 'zones')      return stepId === 'zones' || stepId === 'zones-refine';
  if (targetStep === 'spatial')    return stepId === 'spatial';
  if (targetStep === 'growth') {
    const m = stepId.match(/^growth-(\d+):roads$/);
    return m ? parseInt(m[1]) >= growthCount : false;
  }
  return false;
}

/** Convert the current runner step ID back to URL params {step, growth}. */
function stepIdToParams(stepId) {
  if (!stepId) return {};
  if (stepId === 'skeleton')  return { step: 'skeleton' };
  if (stepId === 'land-value') return { step: 'land-value' };
  if (['zones', 'zone-boundary', 'zones-refine'].includes(stepId)) return { step: 'zones' };
  if (['spatial', 'growth:gpu-init'].includes(stepId)) return { step: 'spatial' };
  const m = stepId.match(/^growth-(\d+):/);
  if (m) return { step: 'growth', growth: parseInt(m[1]) };
  if (stepId === 'connect') return { step: 'connect' };
  return { step: stepId };
}

const GRID_DIVISIONS = 6; // city split into 6x6 cells
const DETAIL_SCALE = 4;   // detail view renders at 4x grid resolution

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

    // Read URL params for initial state
    const params = new URLSearchParams(location.search);
    this._initialArchetype = params.get('archetype') || 'auto';
    this._initialLens      = params.get('lens') || null;

    // Step-based navigation: ?step=spatial or ?step=growth&growth=3
    // Backward compat: ?tick=N (old raw-count scheme) → approximate step
    if (params.has('step')) {
      this._initialStep   = params.get('step');
      this._initialGrowth = parseInt(params.get('growth')) || 5;
    } else if (params.has('tick')) {
      const t = parseInt(params.get('tick')) || 0;
      if (t <= 0)      { this._initialStep = null;       this._initialGrowth = 0; }
      else if (t <= 1) { this._initialStep = 'skeleton'; this._initialGrowth = 0; }
      else if (t <= 3) { this._initialStep = 'zones';    this._initialGrowth = 0; }
      else if (t <= 6) { this._initialStep = 'spatial';  this._initialGrowth = 0; }
      else             { this._initialStep = 'growth';   this._initialGrowth = Math.max(1, t - 6); }
    } else {
      this._initialStep   = null;
      this._initialGrowth = 0;
    }

    // Cell detail state
    this._selectedCell = null; // { col, row } or null = overview mode

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
    this.canvas.style.cssText = 'image-rendering:pixelated; border:1px solid #444; cursor:crosshair;';
    this.canvas.addEventListener('click', (e) => this._onCanvasClick(e));
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

    // Minimap
    this.minimapCanvas = document.createElement('canvas');
    this.minimapCanvas.style.cssText = 'width:100%; aspect-ratio:1; border:1px solid #444; image-rendering:pixelated; cursor:crosshair;';
    this.minimapCanvas.addEventListener('click', (e) => this._onMinimapClick(e));
    panel.appendChild(this.minimapCanvas);

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

    // Archetype selector
    const archRow = document.createElement('div');
    archRow.style.cssText = 'display:flex; gap:6px; align-items:center; flex-wrap:wrap;';
    const archLabel = document.createElement('span');
    archLabel.textContent = 'Archetype:';
    archLabel.style.cssText = 'font-size:12px;';
    this.archSelect = document.createElement('select');
    this.archSelect.style.cssText = 'flex:1; background:#2a2a3e; color:#eee; border:1px solid #555; padding:4px; font-family:monospace; font-size:11px;';
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '(none)';
    this.archSelect.appendChild(noneOpt);
    const autoOpt = document.createElement('option');
    autoOpt.value = 'auto';
    autoOpt.textContent = 'Auto (best fit)';
    this.archSelect.appendChild(autoOpt);
    for (const [id, arch] of Object.entries(ARCHETYPES)) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = arch.name;
      this.archSelect.appendChild(opt);
    }
    if (this._initialArchetype === 'none') {
      this.archSelect.value = '';
    } else if (this._initialArchetype && this._initialArchetype !== 'auto') {
      this.archSelect.value = this._initialArchetype;
    } else {
      this.archSelect.value = 'auto';
    }
    this.archSelect.onchange = () => {
      this._generate(); // _generate() calls _updateURL() internally
    };
    archRow.appendChild(archLabel);
    archRow.appendChild(this.archSelect);
    panel.appendChild(archRow);

    // Archetype scores display
    this.archScoresDiv = document.createElement('div');
    this.archScoresDiv.style.cssText = 'font-size:10px; color:#888; line-height:1.4; max-height:100px; overflow-y:auto;';
    panel.appendChild(this.archScoresDiv);

    // Tick controls
    const tickRow = document.createElement('div');
    tickRow.style.cssText = 'display:flex; gap:6px; align-items:center;';

    this.tickLabel = document.createElement('span');
    this.tickLabel.style.cssText = 'font-size:11px; min-width:80px; color:#aaa;';
    this.tickLabel.textContent = '—';
    tickRow.appendChild(this.tickLabel);

    const nextBtn = document.createElement('button');
    nextBtn.textContent = 'Next Step';
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
        this._updateURL();
        this._render();
      };
      panel.appendChild(btn);
      this.layerButtons.push(btn);
    }

    // Info area
    this.infoDiv = document.createElement('div');
    this.infoDiv.style.cssText = 'font-size:11px; color:#888; margin-top:auto; padding-top:12px; border-top:1px solid #333; line-height:1.5;';
    panel.appendChild(this.infoDiv);

    // Compare Archetypes button
    const compareBtn = document.createElement('button');
    compareBtn.textContent = 'Compare Archetypes';
    compareBtn.style.cssText = 'background:#446; color:#eee; border:1px solid #668; padding:6px 12px; cursor:pointer; font-family:monospace; margin-top:8px;';
    compareBtn.onclick = () => {
      const url = new URL(location.href);
      url.searchParams.set('mode', 'compare-archetypes');
      url.searchParams.delete('archetype');
      url.searchParams.delete('col');
      url.searchParams.delete('row');
      const stepId = this._strategy?.runner?.currentStep;
      if (stepId) {
        const { step, growth } = stepIdToParams(stepId);
        if (step) url.searchParams.set('step', step);
        if (step === 'growth' && growth) url.searchParams.set('growth', String(growth));
      }
      url.searchParams.set('lens', layerSlug(LAYERS[this.currentLayerIndex].name));
      location.href = url.toString();
    };
    panel.appendChild(compareBtn);

    // Back button
    const backBtn = document.createElement('button');
    backBtn.textContent = 'Back to Region';
    backBtn.style.cssText = 'background:#444; color:#eee; border:1px solid #666; padding:6px 12px; cursor:pointer; font-family:monospace; margin-top:8px;';
    backBtn.onclick = () => this.onBack();
    panel.appendChild(backBtn);

    wrapper.appendChild(panel);
    this.container.appendChild(wrapper);

    // Escape key to zoom out
    this._onKeyDown = (e) => {
      if (e.key === 'Escape' && this._selectedCell) {
        this._selectCell(null);
      }
    };
    document.addEventListener('keydown', this._onKeyDown);

    this._updateLayerButtons();

    if (this._initialLens) {
      const idx = layerIndexFromSlug(this._initialLens);
      if (idx >= 0) {
        this.currentLayerIndex = idx;
        this._updateLayerButtons();
      }
    }
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

  _getArchetype() {
    const val = this.archSelect.value;
    if (!val) return null;
    if (val === 'auto') {
      const scores = scoreSettlement(this.map);
      this._showScores(scores);
      return scores[0].archetype;
    }
    return ARCHETYPES[val] || null;
  }

  _showScores(scores) {
    if (!scores) { this.archScoresDiv.textContent = ''; return; }
    this.archScoresDiv.innerHTML = scores.map(s =>
      `<div style="color:${s.score > 0.5 ? '#8c8' : s.score > 0.2 ? '#cc8' : '#c88'}">`
      + `${s.archetype.name}: ${s.score.toFixed(2)}`
      + `<br><span style="color:#666; margin-left:8px">${s.factors.join(', ')}</span></div>`
    ).join('');
  }

  _generate() {
    const rng = new SeededRandom(this.seed);
    this.map = setupCity(this.layers, this.settlement, rng.fork('city'));

    // Create strategy with archetype
    const archetype = this._getArchetype();
    this._strategy = new LandFirstDevelopment(this.map, { archetype });

    this.currentTick = 0;
    this._selectedCell = null;
    this.tickLabel.textContent = '—';

    this._updateURL();

    this._updateInfo();
    this._setupCanvas();
    this._renderMinimap();
    this._render();

    // Auto-advance to URL-requested step.
    // Async IIFE so GPU steps are awaited; outer _generate() stays synchronous.
    if (this._initialStep) {
      const targetStep   = this._initialStep;
      const growthCount  = this._initialGrowth;
      this._initialStep  = null; // only on first generate
      (async () => {
        while (this._strategy && !this._strategy.done) {
          const result = this._strategy.tick();
          if (result instanceof Promise) await result;
          this.currentTick++;
          const stepId = this._strategy.runner.currentStep;
          this.tickLabel.textContent = stepToLabel(stepId);
          if (shouldStopAfter(stepId, targetStep, growthCount)) break;
        }
        this._updateInfo();
        this._updateURL();
        this._render();
      })();
    }
  }

  _nextTick() {
    if (!this.map || !this._strategy) return;

    const result = this._strategy.tick();

    const handleDone = (more) => {
      this.currentTick++;
      const stepId = this._strategy.runner.currentStep;
      this.tickLabel.textContent = stepToLabel(stepId) + (more ? '' : ' — complete');
      this._updateInfo();
      this._render();
      this._updateURL();
    };

    // Handle both synchronous (CPU) and async (GPU) step results.
    if (result instanceof Promise) {
      result.then(handleDone);
    } else {
      handleDone(result);
    }
  }

  _reset() {
    this.seed = parseInt(this.seedInput.value) || 42;
    this._generate();
  }

  // --- Canvas setup ---

  _setupCanvas() {
    if (!this.map) return;

    if (this._selectedCell) {
      const cellW = Math.floor(this.map.width / GRID_DIVISIONS);
      const cellH = Math.floor(this.map.height / GRID_DIVISIONS);
      this.canvas.width = cellW * DETAIL_SCALE;
      this.canvas.height = cellH * DETAIL_SCALE;
      this.canvas.style.imageRendering = 'auto';
    } else {
      this.canvas.width = this.map.width;
      this.canvas.height = this.map.height;
      this.canvas.style.imageRendering = 'pixelated';
    }

    const maxDisplaySize = Math.min(window.innerWidth - 320, window.innerHeight - 40);
    const scale = Math.max(1, Math.floor(maxDisplaySize / Math.max(this.canvas.width, this.canvas.height)));
    this.canvas.style.width = `${this.canvas.width * scale}px`;
    this.canvas.style.height = `${this.canvas.height * scale}px`;
  }

  // --- Click handling ---

  _selectCell(cell) {
    this._selectedCell = cell;
    this._updateURL();
    this._setupCanvas();
    this._renderMinimap();
    this._render();
  }

  _updateURL() {
    const url = new URL(location.href);
    url.searchParams.set('seed', this.seed);
    url.searchParams.set('mode', 'debug');
    url.searchParams.set('gx', this.settlement.gx);
    url.searchParams.set('gz', this.settlement.gz);

    // Archetype
    const archVal = this.archSelect.value;
    if (archVal === '') {
      url.searchParams.set('archetype', 'none');
    } else if (archVal) {
      url.searchParams.set('archetype', archVal);
    }

    // Step (named, not raw count)
    const stepId = this._strategy?.runner?.currentStep;
    if (stepId) {
      const { step, growth } = stepIdToParams(stepId);
      if (step) url.searchParams.set('step', step);
      else url.searchParams.delete('step');
      if (step === 'growth' && growth) url.searchParams.set('growth', String(growth));
      else url.searchParams.delete('growth');
    } else {
      url.searchParams.delete('step');
      url.searchParams.delete('growth');
    }

    // Lens
    const currentLayer = LAYERS[this.currentLayerIndex];
    if (currentLayer) {
      url.searchParams.set('lens', layerSlug(currentLayer.name));
    }

    // Cell detail
    if (this._selectedCell) {
      url.searchParams.set('col', this._selectedCell.col);
      url.searchParams.set('row', this._selectedCell.row);
    } else {
      url.searchParams.delete('col');
      url.searchParams.delete('row');
    }
    history.replaceState(null, '', url);
  }

  _onCanvasClick(e) {
    if (!this.map) return;

    if (this._selectedCell) {
      // Detail view — click to go back to overview
      this._selectCell(null);
    } else {
      // Overview — pick a grid cell
      const rect = this.canvas.getBoundingClientRect();
      const px = (e.clientX - rect.left) / rect.width;
      const pz = (e.clientY - rect.top) / rect.height;
      const col = Math.min(GRID_DIVISIONS - 1, Math.floor(px * GRID_DIVISIONS));
      const row = Math.min(GRID_DIVISIONS - 1, Math.floor(pz * GRID_DIVISIONS));
      this._selectCell({ col, row });
    }
  }

  _onMinimapClick(e) {
    if (!this.map || !this._selectedCell) return;

    // Minimap is showing city — click to change cell
    const rect = this.minimapCanvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width;
    const pz = (e.clientY - rect.top) / rect.height;
    const col = Math.min(GRID_DIVISIONS - 1, Math.max(0, Math.floor(px * GRID_DIVISIONS)));
    const row = Math.min(GRID_DIVISIONS - 1, Math.max(0, Math.floor(pz * GRID_DIVISIONS)));
    this._selectCell({ col, row });
  }

  // --- Rendering ---

  _render() {
    if (!this.map || this._disposed) return;

    const ctx = this.canvas.getContext('2d');
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (this._selectedCell) {
      this._renderDetail(ctx);
    } else {
      this._renderOverview(ctx);
    }
  }

  _renderOverview(ctx) {
    // Render current layer
    const layer = LAYERS[this.currentLayerIndex];
    if (layer && layer.render) {
      layer.render(ctx, this.map);
    }

    // Draw grid overlay
    const cellW = this.map.width / GRID_DIVISIONS;
    const cellH = this.map.height / GRID_DIVISIONS;

    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 0.5;
    for (let i = 1; i < GRID_DIVISIONS; i++) {
      ctx.beginPath();
      ctx.moveTo(i * cellW, 0);
      ctx.lineTo(i * cellW, this.map.height);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i * cellH);
      ctx.lineTo(this.map.width, i * cellH);
      ctx.stroke();
    }
  }

  _renderDetail(ctx) {
    const { col, row } = this._selectedCell;
    const cellW = Math.floor(this.map.width / GRID_DIVISIONS);
    const cellH = Math.floor(this.map.height / GRID_DIVISIONS);
    const startGx = col * cellW;
    const startGz = row * cellH;
    const S = DETAIL_SCALE;

    // Draw the layer clipped to this cell, scaled up
    const layer = LAYERS[this.currentLayerIndex];
    if (layer && layer.render) {
      const offscreen = document.createElement('canvas');
      offscreen.width = this.map.width;
      offscreen.height = this.map.height;
      const offCtx = offscreen.getContext('2d');
      layer.render(offCtx, this.map);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(offscreen, startGx, startGz, cellW, cellH, 0, 0, cellW * S, cellH * S);
    }

    // World-space bounds of this cell
    const map = this.map;
    const wxMin = map.originX + startGx * map.cellSize;
    const wzMin = map.originZ + startGz * map.cellSize;
    const wxMax = wxMin + cellW * map.cellSize;
    const wzMax = wzMin + cellH * map.cellSize;

    // Helper: world coords to scaled canvas coords
    const toLocal = (wx, wz) => ({
      x: ((wx - wxMin) / map.cellSize) * S,
      y: ((wz - wzMin) / map.cellSize) * S,
    });

    // Draw road polylines
    for (const road of map.ways) {
      if (!road.polyline || road.polyline.length < 2) continue;

      let inView = false;
      for (const p of road.polyline) {
        if (p.x >= wxMin && p.x <= wxMax && p.z >= wzMin && p.z <= wzMax) {
          inView = true;
          break;
        }
      }
      if (!inView) continue;

      const hierColors = { arterial: '#ff6644', collector: '#ffaa44', local: '#cccc88', structural: '#aaaa66' };
      ctx.strokeStyle = hierColors[road.hierarchy] || '#cccc88';
      const baseWidth = road.hierarchy === 'arterial' ? 2 : road.hierarchy === 'collector' ? 1.5 : 1;
      ctx.lineWidth = baseWidth * S;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      ctx.beginPath();
      for (let i = 0; i < road.polyline.length; i++) {
        const p = toLocal(road.polyline[i].x, road.polyline[i].z);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }

    // Draw river polylines
    for (const river of map.rivers) {
      if (!river.polyline || river.polyline.length < 2) continue;

      let inView = false;
      for (const p of river.polyline) {
        if (p.x >= wxMin && p.x <= wxMax && p.z >= wzMin && p.z <= wzMax) {
          inView = true;
          break;
        }
      }
      if (!inView) continue;

      ctx.strokeStyle = '#4488cc';
      ctx.lineWidth = 3 * S;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < river.polyline.length; i++) {
        const p = toLocal(river.polyline[i].x, river.polyline[i].z);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }

    // Draw nucleus markers
    const typeColors = {
      waterfront: '#00aaff', market: '#ff4444', hilltop: '#ffaa00',
      valley: '#44cc44', roadside: '#aa44ff', suburban: '#888888',
    };
    for (const n of map.nuclei) {
      const wx = map.originX + n.gx * map.cellSize;
      const wz = map.originZ + n.gz * map.cellSize;
      if (wx < wxMin || wx > wxMax || wz < wzMin || wz > wzMax) continue;

      const p = toLocal(wx, wz);
      ctx.fillStyle = typeColors[n.type] || '#ffffff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4 * S, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Draw regional settlement markers (colored by tier)
    if (map.regionalSettlements) {
      for (const s of map.regionalSettlements) {
        const wx = map.originX + s.cityGx * map.cellSize;
        const wz = map.originZ + s.cityGz * map.cellSize;
        if (wx < wxMin || wx > wxMax || wz < wzMin || wz > wzMax) continue;

        const p = toLocal(wx, wz);
        const r = (s.tier === 1 ? 8 : s.tier === 2 ? 6 : 4) * S;
        ctx.fillStyle = s.tier === 1 ? '#ff0000' : s.tier === 2 ? '#ff8800' : '#ffff00';
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5 * S;
        ctx.stroke();
      }
    }

    // Draw graph nodes
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    for (const [, node] of map.graph.nodes) {
      if (node.x < wxMin || node.x > wxMax || node.z < wzMin || node.z > wzMax) continue;
      const p = toLocal(node.x, node.z);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2 * S, 0, Math.PI * 2);
      ctx.fill();
    }

    // Label
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = `${12 * S}px monospace`;
    ctx.fillText(`Cell (${col},${row})  [Esc/click to go back]`, 4 * S, 16 * S);
  }

  // --- Minimap ---

  _renderMinimap() {
    if (!this.layers || !this.map) return;

    if (this._selectedCell) {
      this._renderCityMinimap();
    } else {
      this._renderRegionMinimap();
    }
  }

  _renderRegionMinimap() {
    renderMap(this.layers, this.minimapCanvas);
    const ctx = this.minimapCanvas.getContext('2d');
    drawRivers(this.layers, ctx);
    drawRoads(this.layers, ctx);
    drawSettlements(this.layers, ctx);

    // Draw city bounding box
    const params = this.layers.getData('params');
    const rcs = params.cellSize;
    const map = this.map;

    const x0 = map.originX / rcs;
    const z0 = map.originZ / rcs;
    const x1 = (map.originX + map.width * map.cellSize) / rcs;
    const z1 = (map.originZ + map.height * map.cellSize) / rcs;

    ctx.strokeStyle = '#ff4444';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0, z0, x1 - x0, z1 - z0);

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(this.settlement.gx, this.settlement.gz, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  _renderCityMinimap() {
    const map = this.map;

    // Render the current layer at minimap resolution
    this.minimapCanvas.width = map.width;
    this.minimapCanvas.height = map.height;
    const ctx = this.minimapCanvas.getContext('2d');

    const layer = LAYERS[this.currentLayerIndex];
    if (layer && layer.render) {
      layer.render(ctx, map);
    }

    // Draw grid
    const cellW = map.width / GRID_DIVISIONS;
    const cellH = map.height / GRID_DIVISIONS;

    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 0.5;
    for (let i = 1; i < GRID_DIVISIONS; i++) {
      ctx.beginPath();
      ctx.moveTo(i * cellW, 0);
      ctx.lineTo(i * cellW, map.height);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i * cellH);
      ctx.lineTo(map.width, i * cellH);
      ctx.stroke();
    }

    // Highlight selected cell
    const { col, row } = this._selectedCell;
    ctx.strokeStyle = '#ff4444';
    ctx.lineWidth = 2;
    ctx.strokeRect(col * cellW, row * cellH, cellW, cellH);
  }

  // --- Info ---

  _updateInfo() {
    if (!this.map) return;

    const info = [];
    info.push(`Grid: ${this.map.width} x ${this.map.height}`);
    info.push(`Cell: ${this.map.cellSize}m`);
    info.push(`Roads: ${this.map.ways.length}`);
    info.push(`Rivers: ${this.map.rivers.length}`);
    info.push(`Nuclei: ${this.map.nuclei.length}`);
    info.push(`Graph: ${this.map.graph.nodes.size} nodes, ${this.map.graph.edges.size} edges`);
    const slivers = this.map.graph.detectSliverFaces();
    const crossings = this.map.graph.detectCrossingEdges();
    const shallow = this.map.graph.detectShallowAngles(5);
    info.push(`Slivers: ${slivers.length}, Crossings: ${crossings.length}, Shallow: ${shallow.length}`);

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
    if (this._onKeyDown) {
      document.removeEventListener('keydown', this._onKeyDown);
    }
    this.container.innerHTML = '';
  }
}
