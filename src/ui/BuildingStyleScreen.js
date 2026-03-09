import * as THREE from 'three';
import { CLIMATES, getClimateStyle, buildRecipe } from '../buildings/styles.js';
import { generateBuilding } from '../buildings/generate.js';

const PLOT_SIZES = ['small', 'medium', 'large'];
const RICHNESS_LEVELS = [0, 0.5, 1];
const COL_LABELS = ['Plain', 'Moderate', 'Ornate'];
const ROW_LABELS = ['S', 'M', 'L'];

const SLIDER_DEFS = [
  { key: 'floorHeight',    label: 'Floor height',   min: 2.4, max: 4.5, step: 0.1 },
  { key: 'roofPitch',      label: 'Roof pitch',     min: 0,   max: 60,  step: 1 },
  { key: 'windowWidth',    label: 'Window width',   min: 0.5, max: 2.0, step: 0.1 },
  { key: 'windowHeight',   label: 'Window height',  min: 0.6, max: 3.0, step: 0.1 },
  { key: 'windowSpacing',  label: 'Window spacing', min: 1.5, max: 5.0, step: 0.1 },
  { key: 'porchDepth',     label: 'Porch depth',    min: 0,   max: 4.0, step: 0.1 },
  { key: 'roofOverhang',   label: 'Overhang',       min: 0,   max: 1.0, step: 0.05 },
];

/**
 * Full-screen building style explorer with a sidebar and 3x3 grid of 3D previews.
 */
export class BuildingStyleScreen {
  constructor(container, onBack) {
    this.container = container;
    this._onBack = onBack;
    this._running = true;
    this._seed = Math.floor(Math.random() * 999999);
    this._climate = 'temperate';
    this._style = getClimateStyle(this._climate);
    this._zoomedCell = null; // { row, col } or null

    // 9 cells, each with its own scene + camera
    this._cells = [];

    this._buildUI();
    this._initRenderer();
    this._regenerateAll();
    this._animate();
  }

  // ── UI Construction ──────────────────────────────────────────

  _buildUI() {
    this._root = document.createElement('div');
    this._root.style.cssText = 'position:fixed;inset:0;display:flex;background:#1a1a2e;z-index:50';
    this.container.appendChild(this._root);

    this._buildSidebar();
    this._buildGrid();

    // Keyboard handler
    this._onKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (this._zoomedCell) {
          this._zoomedCell = null;
        } else if (this._onBack) {
          this._onBack();
        }
      }
    };
    document.addEventListener('keydown', this._onKeyDown);

    // Resize handler
    this._onResize = () => this._handleResize();
    window.addEventListener('resize', this._onResize);
  }

  _buildSidebar() {
    const sidebar = document.createElement('div');
    sidebar.style.cssText = 'width:220px;display:flex;flex-direction:column;padding:12px;background:#1a1a2e;border-right:1px solid #333;overflow-y:auto;gap:6px';
    this._root.appendChild(sidebar);

    // Title
    const title = document.createElement('div');
    title.textContent = 'Building Styles';
    title.style.cssText = 'color:#ffaa88;font-family:monospace;font-size:16px;font-weight:bold;margin-bottom:8px';
    sidebar.appendChild(title);

    // Climate dropdown
    const climateLabel = document.createElement('label');
    climateLabel.textContent = 'Climate';
    climateLabel.style.cssText = 'color:#aaa;font-family:monospace;font-size:11px;margin-top:4px';
    sidebar.appendChild(climateLabel);

    this._climateSelect = document.createElement('select');
    this._climateSelect.style.cssText = 'background:#333;color:#eee;border:1px solid #555;padding:4px;font-family:monospace;font-size:12px;border-radius:3px';
    for (const c of CLIMATES) {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c.charAt(0).toUpperCase() + c.slice(1);
      this._climateSelect.appendChild(opt);
    }
    this._climateSelect.value = this._climate;
    this._climateSelect.addEventListener('change', () => {
      this._climate = this._climateSelect.value;
      this._style = getClimateStyle(this._climate);
      this._syncSlidersToStyle();
      this._regenerateAll();
    });
    sidebar.appendChild(this._climateSelect);

    // Sliders
    const sliderSep = document.createElement('div');
    sliderSep.style.cssText = 'border-top:1px solid #333;margin:8px 0 4px';
    sidebar.appendChild(sliderSep);

    this._sliders = {};
    for (const def of SLIDER_DEFS) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;flex-direction:column;gap:1px';

      const labelRow = document.createElement('div');
      labelRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center';
      const lbl = document.createElement('span');
      lbl.textContent = def.label;
      lbl.style.cssText = 'color:#aaa;font-family:monospace;font-size:11px';
      const valSpan = document.createElement('span');
      valSpan.style.cssText = 'color:#eee;font-family:monospace;font-size:11px;min-width:36px;text-align:right';
      labelRow.appendChild(lbl);
      labelRow.appendChild(valSpan);

      const input = document.createElement('input');
      input.type = 'range';
      input.min = def.min;
      input.max = def.max;
      input.step = def.step;
      input.value = this._style[def.key];
      input.style.cssText = 'width:100%;accent-color:#ffaa88';

      valSpan.textContent = Number(input.value).toFixed(def.step < 1 ? (def.step < 0.1 ? 2 : 1) : 0);

      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        this._style[def.key] = v;
        valSpan.textContent = v.toFixed(def.step < 1 ? (def.step < 0.1 ? 2 : 1) : 0);
        this._regenerateAll();
      });

      row.appendChild(labelRow);
      row.appendChild(input);
      sidebar.appendChild(row);

      this._sliders[def.key] = { input, valSpan, def };
    }

    // Spacer
    const spacer = document.createElement('div');
    spacer.style.cssText = 'flex:1';
    sidebar.appendChild(spacer);

    // Randomize button
    const randomBtn = this._makeBtn('Randomize', () => {
      this._seed = Math.floor(Math.random() * 999999);
      this._regenerateAll();
    });
    sidebar.appendChild(randomBtn);

    // Back button
    const backBtn = this._makeBtn('Back', () => {
      if (this._onBack) this._onBack();
    });
    backBtn.style.marginTop = '4px';
    backBtn.style.background = '#333';
    sidebar.appendChild(backBtn);
  }

  _makeBtn(text, onClick) {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.style.cssText = 'padding:8px;background:#444;color:#eee;border:1px solid #666;cursor:pointer;font-family:monospace;font-size:13px;border-radius:4px';
    btn.addEventListener('click', onClick);
    return btn;
  }

  _syncSlidersToStyle() {
    for (const def of SLIDER_DEFS) {
      const s = this._sliders[def.key];
      const v = this._style[def.key];
      s.input.value = v;
      s.valSpan.textContent = Number(v).toFixed(def.step < 1 ? (def.step < 0.1 ? 2 : 1) : 0);
    }
  }

  _buildGrid() {
    // Grid container — holds the canvas and label overlays
    this._gridContainer = document.createElement('div');
    this._gridContainer.style.cssText = 'flex:1;position:relative;overflow:hidden';
    this._root.appendChild(this._gridContainer);

    // Column headers
    for (let col = 0; col < 3; col++) {
      const label = document.createElement('div');
      label.textContent = COL_LABELS[col];
      label.style.cssText = `position:absolute;top:4px;color:#aaa;font-family:monospace;font-size:12px;text-align:center;pointer-events:none;z-index:1`;
      label.dataset.colLabel = col;
      this._gridContainer.appendChild(label);
    }

    // Row labels
    for (let row = 0; row < 3; row++) {
      const label = document.createElement('div');
      label.textContent = ROW_LABELS[row];
      label.style.cssText = `position:absolute;left:6px;color:#aaa;font-family:monospace;font-size:12px;pointer-events:none;z-index:1`;
      label.dataset.rowLabel = row;
      this._gridContainer.appendChild(label);
    }
  }

  // ── Renderer & 3D ────────────────────────────────────────────

  _initRenderer() {
    const w = this._gridContainer.clientWidth || 600;
    const h = this._gridContainer.clientHeight || 600;

    this._renderer = new THREE.WebGLRenderer({ antialias: true });
    this._renderer.setSize(w, h);
    this._renderer.setPixelRatio(window.devicePixelRatio);
    this._renderer.setClearColor(0x1a1a2e);
    this._renderer.setScissorTest(true);
    this._renderer.domElement.style.cssText = 'display:block;width:100%;height:100%';
    this._gridContainer.appendChild(this._renderer.domElement);

    // Click handler for zoom
    this._renderer.domElement.addEventListener('click', (e) => this._onGridClick(e));

    // Build 9 cells
    this._cells = [];
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        this._cells.push(this._createCell(row, col));
      }
    }
  }

  _createCell(row, col) {
    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0x8899aa, 0.6));
    const sun = new THREE.DirectionalLight(0xffeedd, 1.2);
    sun.position.set(20, 40, 30);
    scene.add(sun);

    // Ground plane
    const groundGeo = new THREE.PlaneGeometry(60, 60);
    const groundMat = new THREE.MeshLambertMaterial({ color: 0x3a6b35 });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 0;
    scene.add(ground);

    const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 200);

    return { row, col, scene, camera, building: null };
  }

  // ── Building generation ──────────────────────────────────────

  _regenerateAll() {
    for (const cell of this._cells) {
      this._regenerateCell(cell);
    }
  }

  _regenerateCell(cell) {
    // Remove old building
    if (cell.building) {
      cell.scene.remove(cell.building);
      this._disposeObject(cell.building);
      cell.building = null;
    }

    const plotSize = PLOT_SIZES[cell.row];
    const richness = RICHNESS_LEVELS[cell.col];
    const cellSeed = this._seed + cell.row * 3 + cell.col;

    const recipe = buildRecipe(this._style, plotSize, richness, cellSeed);
    const building = generateBuilding(this._style, recipe);

    // Center building at origin, on the ground
    const box = new THREE.Box3().setFromObject(building);
    const center = box.getCenter(new THREE.Vector3());
    building.position.x -= center.x;
    building.position.z -= center.z;
    building.position.y -= box.min.y;

    cell.scene.add(building);
    cell.building = building;

    // Fit orthographic camera to building bounding box
    this._fitCamera(cell);
  }

  _fitCamera(cell) {
    if (!cell.building) return;

    const box = new THREE.Box3().setFromObject(cell.building);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    // 3/4 angle: look from front-right, elevated
    const dist = Math.max(size.x, size.y, size.z) * 2;
    const cam = cell.camera;
    cam.position.set(center.x + dist * 0.7, center.y + dist * 0.6, center.z + dist * 0.7);
    cam.lookAt(center);

    // Fit ortho frustum to the building
    const maxDim = Math.max(size.x, size.y, size.z) * 0.9;
    cam.left = -maxDim;
    cam.right = maxDim;
    cam.top = maxDim;
    cam.bottom = -maxDim;
    cam.near = 0.1;
    cam.far = dist * 4;
    cam.updateProjectionMatrix();
  }

  // ── Viewport layout ──────────────────────────────────────────

  _getGridMetrics() {
    const w = this._renderer.domElement.clientWidth;
    const h = this._renderer.domElement.clientHeight;
    const padding = 20; // space for labels at top/left
    const gap = 4;
    const cellW = Math.floor((w - padding - gap * 2) / 3);
    const cellH = Math.floor((h - padding - gap * 2) / 3);
    return { w, h, padding, gap, cellW, cellH };
  }

  _getCellViewport(row, col) {
    const { h, padding, gap, cellW, cellH } = this._getGridMetrics();
    const x = padding + col * (cellW + gap);
    // row 0 at top, but WebGL y=0 is bottom
    const y = h - padding - (row + 1) * (cellH + gap) + gap;
    return { x, y, w: cellW, h: cellH };
  }

  // ── Label positioning ────────────────────────────────────────

  _updateLabels() {
    const { padding, gap, cellW, cellH } = this._getGridMetrics();

    // Column headers
    const colLabels = this._gridContainer.querySelectorAll('[data-col-label]');
    colLabels.forEach((el) => {
      const col = parseInt(el.dataset.colLabel);
      const x = padding + col * (cellW + gap) + cellW / 2;
      el.style.left = `${x}px`;
      el.style.transform = 'translateX(-50%)';
    });

    // Row labels
    const rowLabels = this._gridContainer.querySelectorAll('[data-row-label]');
    rowLabels.forEach((el) => {
      const row = parseInt(el.dataset.rowLabel);
      const y = padding + row * (cellH + gap) + cellH / 2;
      el.style.top = `${y}px`;
      el.style.transform = 'translateY(-50%)';
    });
  }

  // ── Click-to-zoom ────────────────────────────────────────────

  _onGridClick(e) {
    if (this._zoomedCell) {
      // Unzoom
      this._zoomedCell = null;
      return;
    }

    const rect = this._renderer.domElement.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const { padding, gap, cellW, cellH } = this._getGridMetrics();

    const col = Math.floor((mx - padding) / (cellW + gap));
    const row = Math.floor((my - padding) / (cellH + gap));

    if (row >= 0 && row < 3 && col >= 0 && col < 3) {
      // Verify click is within the cell bounds (not in the gap)
      const cellX = padding + col * (cellW + gap);
      const cellY = padding + row * (cellH + gap);
      if (mx >= cellX && mx < cellX + cellW && my >= cellY && my < cellY + cellH) {
        this._zoomedCell = { row, col };
      }
    }
  }

  // ── Resize ───────────────────────────────────────────────────

  _handleResize() {
    if (!this._renderer) return;
    const w = this._gridContainer.clientWidth;
    const h = this._gridContainer.clientHeight;
    this._renderer.setSize(w, h);
  }

  // ── Animation loop ───────────────────────────────────────────

  _animate() {
    if (!this._running) return;
    requestAnimationFrame(() => this._animate());

    const renderer = this._renderer;
    if (!renderer) return;

    const pixelRatio = renderer.getPixelRatio();

    this._updateLabels();

    if (this._zoomedCell) {
      // Render only the zoomed cell at full viewport
      const cell = this._cells.find(
        (c) => c.row === this._zoomedCell.row && c.col === this._zoomedCell.col
      );
      if (cell) {
        const w = renderer.domElement.clientWidth;
        const h = renderer.domElement.clientHeight;
        renderer.setViewport(0, 0, w * pixelRatio, h * pixelRatio);
        renderer.setScissor(0, 0, w * pixelRatio, h * pixelRatio);
        renderer.setClearColor(0x1a1a2e);
        renderer.clear();
        renderer.render(cell.scene, cell.camera);
      }
    } else {
      // Render 9 cells with scissored viewports
      renderer.setClearColor(0x1a1a2e);
      renderer.clear();

      for (const cell of this._cells) {
        const vp = this._getCellViewport(cell.row, cell.col);
        renderer.setViewport(
          vp.x * pixelRatio, vp.y * pixelRatio,
          vp.w * pixelRatio, vp.h * pixelRatio
        );
        renderer.setScissor(
          vp.x * pixelRatio, vp.y * pixelRatio,
          vp.w * pixelRatio, vp.h * pixelRatio
        );
        renderer.render(cell.scene, cell.camera);
      }
    }
  }

  // ── Disposal ─────────────────────────────────────────────────

  _disposeObject(obj) {
    obj.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach((m) => m.dispose());
        } else {
          child.material.dispose();
        }
      }
    });
  }

  dispose() {
    this._running = false;

    if (this._onKeyDown) {
      document.removeEventListener('keydown', this._onKeyDown);
      this._onKeyDown = null;
    }
    if (this._onResize) {
      window.removeEventListener('resize', this._onResize);
      this._onResize = null;
    }

    // Dispose all cell scenes
    for (const cell of this._cells) {
      cell.scene.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          if (Array.isArray(child.material)) {
            child.material.forEach((m) => m.dispose());
          } else {
            child.material.dispose();
          }
        }
      });
    }
    this._cells = [];

    if (this._renderer) {
      this._renderer.dispose();
      this._renderer = null;
    }

    this.container.innerHTML = '';
  }
}
