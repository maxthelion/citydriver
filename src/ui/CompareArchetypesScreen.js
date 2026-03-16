import { setupCity } from '../city/setup.js';
import { LAYERS, layerSlug, layerIndexFromSlug } from '../rendering/debugLayers.js';
import { ARCHETYPES } from '../city/archetypes.js';
import { LandFirstDevelopment } from '../city/strategies/landFirstDevelopment.js';
import { SeededRandom } from '../core/rng.js';

const ARCHETYPE_KEYS = Object.keys(ARCHETYPES);

const TICK_LABELS = [
  'setup', 'skeleton', 'land value', 'zones',
  'spatial layers', 'reservations', 'ribbons', 'connections',
];

export class CompareArchetypesScreen {
  constructor(container, layers, settlement, seed, onBack) {
    this.container = container;
    this.layers = layers;
    this.settlement = settlement;
    this.seed = seed;
    this.onBack = onBack;
    this._disposed = false;

    // Read URL params
    const params = new URLSearchParams(location.search);
    const archParam = params.get('archetypes');
    this.selectedArchetypes = archParam
      ? archParam.split(',').filter(k => ARCHETYPES[k])
      : [...ARCHETYPE_KEYS];
    this.currentTick = Math.min(7, parseInt(params.get('tick')) || 0);
    const lensParam = params.get('lens');
    this.currentLayerIndex = (lensParam && layerIndexFromSlug(lensParam) >= 0)
      ? layerIndexFromSlug(lensParam)
      : 0;

    this.maps = {};       // archetype key → FeatureMap
    this.strategies = {};  // archetype key → LandFirstDevelopment

    this._buildUI();
    this._generate();
  }

  _buildUI() {
    this.container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex; flex-direction:column; height:100vh; background:#1a1a2e; color:#eee; font-family:monospace;';

    // Top controls bar
    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex; gap:12px; align-items:center; padding:8px 12px; border-bottom:1px solid #333; flex-wrap:wrap;';

    // Title
    const title = document.createElement('span');
    title.textContent = 'Compare Archetypes';
    title.style.cssText = 'font-size:14px; font-weight:bold; color:#88aaff;';
    controls.appendChild(title);

    // Tick controls
    const tickRow = document.createElement('span');
    tickRow.style.cssText = 'display:flex; gap:4px; align-items:center;';
    this.tickLabel = document.createElement('span');
    this.tickLabel.style.cssText = 'font-size:12px; min-width:90px;';
    tickRow.appendChild(this.tickLabel);

    const prevBtn = document.createElement('button');
    prevBtn.textContent = '◀';
    prevBtn.style.cssText = 'background:#335; color:#eee; border:1px solid #557; padding:2px 8px; cursor:pointer; font-family:monospace;';
    prevBtn.onclick = () => this._setTick(Math.max(0, this.currentTick - 1));
    tickRow.appendChild(prevBtn);

    const nextBtn = document.createElement('button');
    nextBtn.textContent = '▶';
    nextBtn.style.cssText = 'background:#335; color:#eee; border:1px solid #557; padding:2px 8px; cursor:pointer; font-family:monospace;';
    nextBtn.onclick = () => this._setTick(Math.min(7, this.currentTick + 1));
    tickRow.appendChild(nextBtn);
    controls.appendChild(tickRow);

    // Lens dropdown
    this.lensSelect = document.createElement('select');
    this.lensSelect.style.cssText = 'background:#2a2a3e; color:#eee; border:1px solid #555; padding:3px; font-family:monospace; font-size:11px;';
    for (let i = 0; i < LAYERS.length; i++) {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = LAYERS[i].name;
      this.lensSelect.appendChild(opt);
    }
    this.lensSelect.value = this.currentLayerIndex;
    this.lensSelect.onchange = () => {
      this.currentLayerIndex = parseInt(this.lensSelect.value);
      this._updateURL();
      this._renderAll();
    };
    controls.appendChild(this.lensSelect);

    // Archetype checkboxes
    const archRow = document.createElement('span');
    archRow.style.cssText = 'display:flex; gap:8px; align-items:center;';
    this._archCheckboxes = {};
    for (const key of ARCHETYPE_KEYS) {
      const label = document.createElement('label');
      label.style.cssText = 'font-size:11px; display:flex; align-items:center; gap:2px; cursor:pointer;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = this.selectedArchetypes.includes(key);
      cb.onchange = () => {
        this.selectedArchetypes = ARCHETYPE_KEYS.filter(k => this._archCheckboxes[k].checked);
        if (this.selectedArchetypes.length === 0) {
          cb.checked = true;
          this.selectedArchetypes = [key];
        }
        this._updateURL();
        this._rebuildGrid();
        this._generate();
      };
      this._archCheckboxes[key] = cb;
      label.appendChild(cb);
      label.appendChild(document.createTextNode(ARCHETYPES[key].name));
      archRow.appendChild(label);
    }
    controls.appendChild(archRow);

    // Back button
    const backBtn = document.createElement('button');
    backBtn.textContent = 'Back';
    backBtn.style.cssText = 'background:#444; color:#eee; border:1px solid #666; padding:3px 10px; cursor:pointer; font-family:monospace; font-size:11px; margin-left:auto;';
    backBtn.onclick = () => this.onBack();
    controls.appendChild(backBtn);

    wrapper.appendChild(controls);

    // Grid area
    this._gridArea = document.createElement('div');
    this._gridArea.style.cssText = 'flex:1; overflow:hidden; padding:4px;';
    wrapper.appendChild(this._gridArea);

    this.container.appendChild(wrapper);

    // Keyboard shortcut
    this._onKeyDown = (e) => {
      if (e.key === 'ArrowRight') this._setTick(Math.min(7, this.currentTick + 1));
      if (e.key === 'ArrowLeft') this._setTick(Math.max(0, this.currentTick - 1));
    };
    document.addEventListener('keydown', this._onKeyDown);

    this._rebuildGrid();
  }

  _rebuildGrid() {
    this._gridArea.innerHTML = '';
    const count = this.selectedArchetypes.length;
    const cols = count <= 2 ? count : count <= 4 ? 2 : 3;
    this._gridArea.style.display = 'grid';
    this._gridArea.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    this._gridArea.style.gap = '4px';

    this._panels = {};
    for (const key of this.selectedArchetypes) {
      const cell = document.createElement('div');
      cell.style.cssText = 'display:flex; flex-direction:column; min-height:0; overflow:hidden;';

      const label = document.createElement('div');
      label.style.cssText = 'font-size:11px; color:#88aaff; text-align:center; padding:2px 0; flex-shrink:0;';
      label.textContent = ARCHETYPES[key].name;
      cell.appendChild(label);

      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'flex:1; width:100%; image-rendering:pixelated; cursor:pointer; object-fit:contain;';
      canvas.onclick = () => {
        // Navigate to debug screen for this archetype
        const url = new URL(location.href);
        url.searchParams.set('mode', 'debug');
        url.searchParams.set('archetype', key);
        url.searchParams.set('tick', this.currentTick);
        url.searchParams.set('lens', layerSlug(LAYERS[this.currentLayerIndex].name));
        url.searchParams.delete('archetypes');
        location.href = url.toString();
      };
      cell.appendChild(canvas);

      this._gridArea.appendChild(cell);
      this._panels[key] = canvas;
    }
  }

  _generate() {
    const rng = new SeededRandom(this.seed);
    const baseMap = setupCity(this.layers, this.settlement, rng.fork('city'));

    for (const key of this.selectedArchetypes) {
      const map = baseMap.clone();
      const strategy = new LandFirstDevelopment(map, { archetype: ARCHETYPES[key] });

      // Advance to current tick
      for (let t = 0; t < this.currentTick; t++) {
        strategy.tick();
      }

      this.maps[key] = map;
      this.strategies[key] = strategy;
    }

    this._updateTickLabel();
    this._updateURL();
    this._renderAll();
  }

  _setTick(tick) {
    if (tick === this.currentTick) return;
    this.currentTick = tick;
    this._generate();
  }

  _updateTickLabel() {
    const label = TICK_LABELS[this.currentTick] || 'done';
    this.tickLabel.textContent = `Tick: ${this.currentTick} (${label})`;
  }

  _updateURL() {
    const url = new URL(location.href);
    url.searchParams.set('seed', this.seed);
    url.searchParams.set('mode', 'compare-archetypes');
    url.searchParams.set('gx', this.settlement.gx);
    url.searchParams.set('gz', this.settlement.gz);
    url.searchParams.set('tick', this.currentTick);
    url.searchParams.set('lens', layerSlug(LAYERS[this.currentLayerIndex].name));

    if (this.selectedArchetypes.length < ARCHETYPE_KEYS.length) {
      url.searchParams.set('archetypes', this.selectedArchetypes.join(','));
    } else {
      url.searchParams.delete('archetypes');
    }

    history.replaceState(null, '', url);
  }

  _renderAll() {
    if (this._disposed) return;
    const layer = LAYERS[this.currentLayerIndex];
    if (!layer || !layer.render) return;

    for (const key of this.selectedArchetypes) {
      const map = this.maps[key];
      const canvas = this._panels[key];
      if (!map || !canvas) continue;

      canvas.width = map.width;
      canvas.height = map.height;
      const ctx = canvas.getContext('2d');
      layer.render(ctx, map);
    }
  }

  dispose() {
    this._disposed = true;
    if (this._onKeyDown) {
      document.removeEventListener('keydown', this._onKeyDown);
    }
    this.container.innerHTML = '';
  }
}
