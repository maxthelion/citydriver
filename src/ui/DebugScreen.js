import { setupCity, tickGrowth } from '../city/interactivePipeline.js';
import { LAYER_NAMES, LAYER_RENDERERS } from '../rendering/layerRenderers.js';
import { SeededRandom } from '../core/rng.js';

const LAYER_DEFAULTS = {
  'elevation':      { visible: true,  opacity: 1.0 },
  'clusters':       { visible: true,  opacity: 1.0 },
  'connections':    { visible: false, opacity: 0.7 },
  'arterials':      { visible: true,  opacity: 1.0 },
  'rivers':         { visible: true,  opacity: 0.8 },
  'available-land': { visible: false, opacity: 0.5 },
  'high-value':     { visible: false, opacity: 0.6 },
  'river-roads':    { visible: false, opacity: 0.8 },
  'promenades':     { visible: false, opacity: 0.8 },
};

/**
 * Interactive debug layer viewer screen.
 * Runs city setup in-browser and renders 9 composited layer canvases.
 */
export class DebugScreen {
  constructor(container, regionalLayers, settlement, seed, onBack) {
    this.container = container;
    this.onBack = onBack;
    this._regionalLayers = regionalLayers;
    this._settlement = settlement;
    this._seed = seed;
    this._zoom = 2;
    this._layers = {};   // name -> { visible, opacity, canvas }
    this._state = null;
    this._rng = null;

    this._buildUI();
    this._pushURL();
    this._initCity();
  }

  _pushURL() {
    const s = this._settlement;
    const params = new URLSearchParams();
    params.set('mode', 'debug');
    params.set('seed', this._seed);
    params.set('gx', s.gx);
    params.set('gz', s.gz);
    history.replaceState(null, '', '?' + params.toString());
  }

  _buildUI() {
    this._root = document.createElement('div');
    this._root.style.cssText = 'position:fixed;inset:0;display:flex;background:#1a1a2e;z-index:50;font-family:monospace;font-size:13px;color:#eee';
    this.container.appendChild(this._root);

    // Left sidebar: layer controls
    this._sidebar = document.createElement('div');
    this._sidebar.style.cssText = 'width:260px;background:#16213e;border-right:1px solid #333;display:flex;flex-direction:column;flex-shrink:0;overflow-y:auto';
    this._root.appendChild(this._sidebar);

    const sidebarTitle = document.createElement('div');
    sidebarTitle.style.cssText = 'padding:8px 12px;color:#888;border-bottom:1px solid #333;font-size:12px;font-weight:bold';
    sidebarTitle.textContent = 'LAYERS';
    this._sidebar.appendChild(sidebarTitle);

    this._layerList = document.createElement('div');
    this._sidebar.appendChild(this._layerList);

    // Center: canvas viewport
    const viewport = document.createElement('div');
    viewport.style.cssText = 'flex:1;display:flex;flex-direction:column;overflow:hidden';
    this._root.appendChild(viewport);

    this._canvasContainer = document.createElement('div');
    this._canvasContainer.style.cssText = 'flex:1;overflow:auto;display:flex;align-items:flex-start;justify-content:center';
    viewport.appendChild(this._canvasContainer);

    this._canvasStack = document.createElement('div');
    this._canvasStack.style.cssText = 'position:relative;flex-shrink:0;margin:12px';
    this._canvasContainer.appendChild(this._canvasStack);

    // Mouse wheel zoom
    this._canvasContainer.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.deltaY < 0) this._zoom = Math.min(this._zoom * 2, 16);
      else this._zoom = Math.max(this._zoom / 2, 0.5);
      this._applyZoom();
    }, { passive: false });

    // Bottom controls
    const controls = document.createElement('div');
    controls.style.cssText = 'padding:8px 12px;background:#0f3460;border-top:1px solid #444;display:flex;gap:8px;align-items:center;flex-wrap:wrap';
    viewport.appendChild(controls);

    this._addBtn(controls, 'Back', () => this.onBack?.(), true);
    this._addBtn(controls, 'Tick +1', () => this._doTick(1));
    this._addBtn(controls, 'Tick +10', () => this._doTick(10));
    this._addBtn(controls, 'Reset', () => this._reset(), true);

    const seedLabel = document.createElement('label');
    seedLabel.textContent = 'Seed:';
    seedLabel.style.cssText = 'color:#aaa;margin-left:12px';
    controls.appendChild(seedLabel);

    this._seedInput = document.createElement('input');
    this._seedInput.type = 'number';
    this._seedInput.value = this._seed;
    this._seedInput.style.cssText = 'background:#1a1a2e;color:#eee;border:1px solid #444;padding:4px 8px;font-family:monospace;width:80px';
    controls.appendChild(this._seedInput);

    const zoomLabel = document.createElement('span');
    zoomLabel.textContent = 'Zoom:';
    zoomLabel.style.cssText = 'color:#aaa;margin-left:12px';
    controls.appendChild(zoomLabel);

    this._addBtn(controls, '-', () => { this._zoom = Math.max(this._zoom / 2, 0.5); this._applyZoom(); }, true);
    this._zoomSpan = document.createElement('span');
    this._zoomSpan.textContent = this._zoom + 'x';
    this._zoomSpan.style.cssText = 'color:#eee;min-width:32px;text-align:center';
    controls.appendChild(this._zoomSpan);
    this._addBtn(controls, '+', () => { this._zoom = Math.min(this._zoom * 2, 16); this._applyZoom(); }, true);

    this._statusSpan = document.createElement('span');
    this._statusSpan.style.cssText = 'color:#888;font-size:12px;margin-left:auto';
    controls.appendChild(this._statusSpan);

    // Right panel: state info
    const infoPanel = document.createElement('div');
    infoPanel.style.cssText = 'width:220px;background:#16213e;border-left:1px solid #333;display:flex;flex-direction:column;flex-shrink:0;overflow-y:auto';
    this._root.appendChild(infoPanel);

    const stateTitle = document.createElement('div');
    stateTitle.style.cssText = 'padding:8px 12px;color:#888;border-bottom:1px solid #333;font-size:12px;font-weight:bold';
    stateTitle.textContent = 'STATE';
    infoPanel.appendChild(stateTitle);

    this._stateInfo = document.createElement('div');
    this._stateInfo.style.cssText = 'padding:8px 12px;font-size:12px;line-height:1.6';
    infoPanel.appendChild(this._stateInfo);

    const nucleiTitle = document.createElement('div');
    nucleiTitle.style.cssText = 'padding:8px 12px;color:#888;border-bottom:1px solid #333;font-size:12px;font-weight:bold';
    nucleiTitle.textContent = 'NUCLEI';
    infoPanel.appendChild(nucleiTitle);

    this._nucleiList = document.createElement('div');
    this._nucleiList.style.cssText = 'padding:4px 12px;font-size:11px';
    infoPanel.appendChild(this._nucleiList);

    // Keyboard shortcuts
    this._keyHandler = (e) => {
      if (e.target.tagName === 'INPUT') return;
      if (e.key === ' ' || e.key === 't') { e.preventDefault(); this._doTick(1); }
      if (e.key === 'T') { e.preventDefault(); this._doTick(10); }
      if (e.key === '+' || e.key === '=') { this._zoom = Math.min(this._zoom * 2, 16); this._applyZoom(); }
      if (e.key === '-') { this._zoom = Math.max(this._zoom / 2, 0.5); this._applyZoom(); }
      if (e.key === 'Escape') { this.onBack?.(); }
    };
    document.addEventListener('keydown', this._keyHandler);
  }

  _addBtn(parent, text, onClick, secondary = false) {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.style.cssText = `padding:5px 14px;border:none;cursor:pointer;font-family:monospace;font-size:13px;border-radius:3px;color:#fff;background:${secondary ? '#444' : '#e94560'}`;
    btn.addEventListener('click', onClick);
    parent.appendChild(btn);
    return btn;
  }

  _initCity() {
    this._statusSpan.textContent = 'Generating...';
    this._rng = new SeededRandom(this._seed);

    const radiusByTier = { 1: 40, 2: 30, 3: 20 };
    const cityRadius = radiusByTier[this._settlement.tier] ?? 20;

    // Use setTimeout to let UI paint before blocking generation
    setTimeout(() => {
      this._state = setupCity(
        this._regionalLayers, this._settlement,
        this._rng.fork('city'),
        { cityRadius, cityCellSize: 10 },
      );

      this._buildLayerUI();
      this._renderAllLayers();
      this._updateStatePanel();
      this._statusSpan.textContent = `Tick ${this._state.tick}`;
    }, 30);
  }

  _buildLayerUI() {
    this._layerList.innerHTML = '';
    this._canvasStack.innerHTML = '';
    this._layers = {};

    for (const name of LAYER_NAMES) {
      const defaults = LAYER_DEFAULTS[name] || { visible: false, opacity: 0.7 };
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'position:absolute;top:0;left:0;image-rendering:pixelated';
      this._canvasStack.appendChild(canvas);

      this._layers[name] = {
        visible: defaults.visible,
        opacity: defaults.opacity,
        canvas,
      };

      this._buildLayerRow(name, defaults);
    }
  }

  _buildLayerRow(name, defaults) {
    const row = document.createElement('div');
    row.style.cssText = 'padding:4px 12px;display:flex;align-items:center;gap:8px;border-bottom:1px solid #222;cursor:pointer';
    row.addEventListener('mouseenter', () => { row.style.background = '#1a1a4e'; });
    row.addEventListener('mouseleave', () => { row.style.background = ''; });

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = defaults.visible;
    cb.style.flexShrink = '0';
    cb.addEventListener('change', () => {
      this._layers[name].visible = cb.checked;
      this._layers[name].canvas.style.display = cb.checked ? 'block' : 'none';
    });

    const label = document.createElement('span');
    label.textContent = name;
    label.style.cssText = 'flex:1;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = 0; slider.max = 100; slider.value = Math.round(defaults.opacity * 100);
    slider.style.width = '60px';

    const valSpan = document.createElement('span');
    valSpan.style.cssText = 'width:28px;text-align:right;color:#888;font-size:11px';
    valSpan.textContent = slider.value + '%';

    slider.addEventListener('input', () => {
      const v = slider.value / 100;
      this._layers[name].opacity = v;
      this._layers[name].canvas.style.opacity = v;
      valSpan.textContent = slider.value + '%';
    });

    row.appendChild(cb);
    row.appendChild(label);
    row.appendChild(slider);
    row.appendChild(valSpan);
    this._layerList.appendChild(row);
  }

  _renderLayer(name) {
    const renderer = LAYER_RENDERERS[name];
    const ls = this._layers[name];
    if (!renderer || !ls) return;

    const buf = renderer(this._state);
    const canvas = ls.canvas;
    canvas.width = buf.width;
    canvas.height = buf.height;

    const ctx = canvas.getContext('2d');
    const imageData = new ImageData(
      new Uint8ClampedArray(buf.data.buffer, buf.data.byteOffset, buf.data.byteLength),
      buf.width, buf.height,
    );
    ctx.putImageData(imageData, 0, 0);

    canvas.style.display = ls.visible ? 'block' : 'none';
    canvas.style.opacity = ls.opacity;
  }

  _renderAllLayers() {
    for (const name of LAYER_NAMES) {
      this._renderLayer(name);
    }
    this._applyZoom();
  }

  _applyZoom() {
    if (!this._state) return;
    const params = this._state.cityLayers.getData('params');
    const displayW = params.width * this._zoom;
    const displayH = params.height * this._zoom;
    this._canvasStack.style.width = displayW + 'px';
    this._canvasStack.style.height = displayH + 'px';
    for (const name of LAYER_NAMES) {
      const canvas = this._layers[name]?.canvas;
      if (canvas) {
        canvas.style.width = displayW + 'px';
        canvas.style.height = displayH + 'px';
      }
    }
    this._zoomSpan.textContent = this._zoom + 'x';
  }

  _doTick(count) {
    if (!this._state) return;
    this._statusSpan.textContent = `Ticking (${count})...`;

    setTimeout(() => {
      for (let i = 0; i < count; i++) {
        const result = tickGrowth(this._state, this._rng);
        for (const name of result.affectedLayers) {
          this._renderLayer(name);
        }
      }
      this._updateStatePanel();
      this._statusSpan.textContent = `Tick ${this._state.tick}`;
    }, 10);
  }

  _reset() {
    this._seed = parseInt(this._seedInput.value) || Math.floor(Math.random() * 999999);
    this._seedInput.value = this._seed;
    this._pushURL();
    this._initCity();
  }

  _updateStatePanel() {
    if (!this._state) return;
    const nuclei = this._state.nuclei || [];

    this._stateInfo.innerHTML = [
      `<div><span style="color:#888">Seed:</span> ${this._seed}</div>`,
      `<div><span style="color:#888">Tick:</span> ${this._state.tick}</div>`,
      `<div><span style="color:#888">Nuclei:</span> ${nuclei.length}</div>`,
    ].join('');

    this._nucleiList.innerHTML = nuclei.map(n => {
      const disc = n.connected ? '' : ' <span style="color:#e94560">disconn</span>';
      return `<div style="padding:2px 0;color:#aaa">#${n.id} <b>${n.type}</b> T${n.tier} ${n.population}/${n.targetPopulation}${disc}</div>`;
    }).join('');
  }

  dispose() {
    document.removeEventListener('keydown', this._keyHandler);
    this._root.remove();
  }
}
