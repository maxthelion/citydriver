import * as THREE from 'three';
import { generateRegion } from '../regional/pipeline.js';
import { runValidators } from '../validators/framework.js';
import { getRegionalValidators } from '../regional/validators.js';
import { renderMap, drawSettlements, drawRivers, drawRoads } from '../rendering/mapRenderer.js';
import { buildRegionTerrain, buildWaterPlane, buildSettlementMarkers, buildRegionRoads, buildRegionRiverMeshes, buildCityBoundary } from '../rendering/regionPreview3D.js';
import { createScorePanel, updateScorePanel } from './ScorePanel.js';
import { SeededRandom } from '../core/rng.js';

const RING_HOVER_OPACITY = 0.4;
const RING_SELECTED_OPACITY = 0.8;
const RING_HOVER_COLOR = 0xccccff;
const RING_SELECTED_COLOR = 0xffffff;

/**
 * Region selection screen.
 * Shows 3D orbit preview (left) + 2D map (right) + Regenerate/Enter buttons.
 */
export class RegionScreen {
  constructor(container, callbacks, initialSeed) {
    this.container = container;
    // Support both old-style (single function) and new-style ({ onEnter, onDebug })
    if (typeof callbacks === 'function') {
      this.onEnter = callbacks;
      this.onDebug = null;
    } else {
      this.onEnter = callbacks.onEnter;
      this.onDebug = callbacks.onDebug || null;
      this.onCompare = callbacks.onCompare || null;
      this.onCompareArchetypes = callbacks.onCompareArchetypes || null;
      this.onBuildings = callbacks.onBuildings || null;
      this.onTerraced = callbacks.onTerraced || null;
      this.onRailways = callbacks.onRailways || null;
    }
    this._layers = null;
    this._seed = initialSeed ?? Math.floor(Math.random() * 999999);
    this._selectedSettlement = null;

    this._buildUI();
    this._generate();
  }

  _buildUI() {
    // Main layout
    this._root = document.createElement('div');
    this._root.style.cssText = 'position:fixed;inset:0;display:flex;background:#111;z-index:50';
    this.container.appendChild(this._root);

    // Left: 3D preview
    this._preview3D = document.createElement('div');
    this._preview3D.style.cssText = 'flex:1;position:relative;';
    this._root.appendChild(this._preview3D);

    // Land cover legend overlay
    this._legend = this._buildLegend();
    this._preview3D.appendChild(this._legend);

    // Right: 2D map + controls
    const rightPanel = document.createElement('div');
    rightPanel.style.cssText = 'width:320px;display:flex;flex-direction:column;padding:10px;background:#1a1a1a';
    this._root.appendChild(rightPanel);

    // 2D map canvas
    this._mapCanvas = document.createElement('canvas');
    this._mapCanvas.style.cssText = 'width:100%;aspect-ratio:1;border:1px solid #333;cursor:crosshair';
    this._mapCanvas.addEventListener('click', (e) => this._onMapClick(e));
    rightPanel.appendChild(this._mapCanvas);

    // Info
    this._info = document.createElement('div');
    this._info.style.cssText = 'color:#aaa;font-family:monospace;font-size:12px;margin:8px 0;min-height:40px';
    rightPanel.appendChild(this._info);

    // Seed input
    const seedRow = document.createElement('div');
    seedRow.style.cssText = 'display:flex;gap:8px;margin:8px 0';
    const seedLabel = document.createElement('span');
    seedLabel.textContent = 'Seed:';
    seedLabel.style.cssText = 'color:#aaa;font-family:monospace;font-size:13px;align-self:center';
    this._seedInput = document.createElement('input');
    this._seedInput.type = 'number';
    this._seedInput.value = this._seed;
    this._seedInput.style.cssText = 'flex:1;background:#333;color:#eee;border:1px solid #555;padding:4px 8px;font-family:monospace';
    seedRow.appendChild(seedLabel);
    seedRow.appendChild(this._seedInput);
    rightPanel.appendChild(seedRow);

    // Buttons
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;margin-top:8px;flex-wrap:wrap';

    this._regenBtn = this._makeBtn('Regenerate', () => {
      this._seed = parseInt(this._seedInput.value) || Math.floor(Math.random() * 999999);
      this._seedInput.value = this._seed;
      this._generate();
    });
    btnRow.appendChild(this._regenBtn);

    this._enterBtn = this._makeBtn('Enter City', () => {
      if (this._layers && this._selectedSettlement && this.onEnter) {
        this.onEnter(this._layers, this._selectedSettlement, this._seed);
      }
    });
    this._enterBtn.style.opacity = '0.5';
    btnRow.appendChild(this._enterBtn);

    if (this.onDebug) {
      this._debugBtn = this._makeBtn('Debug City', () => {
        if (this._layers && this._selectedSettlement && this.onDebug) {
          this.onDebug(this._layers, this._selectedSettlement, this._seed);
        }
      });
      this._debugBtn.style.opacity = '0.5';
      this._debugBtn.style.background = '#335';
      btnRow.appendChild(this._debugBtn);
    }

    if (this.onCompare) {
      this._compareBtn = this._makeBtn('Compare Growth', () => {
        if (this._layers && this._selectedSettlement && this.onCompare) {
          this.onCompare(this._layers, this._selectedSettlement, this._seed);
        }
      });
      this._compareBtn.style.opacity = '0.5';
      this._compareBtn.style.background = '#353';
      btnRow.appendChild(this._compareBtn);
    }

    if (this.onCompareArchetypes) {
      this._compareArchetypesBtn = this._makeBtn('Compare Archetypes', () => {
        if (this._layers && this._selectedSettlement && this.onCompareArchetypes) {
          this.onCompareArchetypes(this._layers, this._selectedSettlement, this._seed);
        }
      });
      this._compareArchetypesBtn.style.opacity = '0.5';
      this._compareArchetypesBtn.style.background = '#353';
      btnRow.appendChild(this._compareArchetypesBtn);
    }

    if (this.onBuildings) {
      this._buildingsBtn = this._makeBtn('Building Styles', () => {
        if (this.onBuildings) {
          this.onBuildings();
        }
      });
      this._buildingsBtn.style.background = '#534';
      btnRow.appendChild(this._buildingsBtn);
    }

    if (this.onTerraced) {
      this._terracedBtn = this._makeBtn('Terraced Row', () => {
        if (this.onTerraced) {
          this.onTerraced();
        }
      });
      this._terracedBtn.style.background = '#543';
      btnRow.appendChild(this._terracedBtn);
    }

    if (this.onRailways) {
      this._railwaysBtn = this._makeBtn('Railways', () => {
        if (this._layers && this.onRailways) {
          this.onRailways(this._layers, this._seed);
        }
      });
      this._railwaysBtn.style.background = '#345';
      btnRow.appendChild(this._railwaysBtn);
    }

    rightPanel.appendChild(btnRow);

    // Score panel
    this._scorePanel = createScorePanel();
    this._scorePanel.style.position = 'static';
    this._scorePanel.style.marginTop = '10px';
    this._scorePanel.style.maxHeight = '300px';
    rightPanel.appendChild(this._scorePanel);
  }

  _makeBtn(text, onClick) {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.style.cssText = 'flex:1;padding:8px;background:#444;color:#eee;border:1px solid #666;cursor:pointer;font-family:monospace;font-size:13px;border-radius:4px';
    btn.addEventListener('click', onClick);
    return btn;
  }

  _generate() {
    const rng = new SeededRandom(this._seed);
    this._layers = generateRegion({
      width: 128,
      height: 128,
      cellSize: 200,
      seaLevel: 0,
    }, rng);

    // Run validators
    const validators = getRegionalValidators(5);
    const scores = runValidators(this._layers, validators);
    updateScorePanel(this._scorePanel, scores);

    // Build 3D preview (before selection so markers exist)
    this._build3D();

    // Auto-select first settlement
    const settlements = this._layers.getData('settlements');
    if (settlements && settlements.length > 0) {
      this._selectSettlement(settlements[0]);
    } else {
      this._selectSettlement(null);
    }

    this._info.textContent = 'Click a settlement on the map or 3D view to select it.';
  }

  _build3D() {
    // Clean up previous
    if (this._renderer3D) {
      this._renderer3D.dispose();
      this._preview3D.innerHTML = '';
    }
    this._3dMarkers = [];
    this._hoveredMarker = null;

    const w = this._preview3D.clientWidth;
    const h = this._preview3D.clientHeight || 500;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(w, h);
    renderer.setClearColor(0x1a1a2e);
    this._preview3D.appendChild(renderer.domElement);
    this._renderer3D = renderer;

    const scene = new THREE.Scene();
    this._scene = scene;
    scene.fog = new THREE.Fog(0x87ceeb, 8000, 20000);
    scene.add(new THREE.AmbientLight(0x8899aa, 0.6));
    const sun = new THREE.DirectionalLight(0xffeedd, 1.2);
    sun.position.set(200, 400, 300);
    scene.add(sun);

    // Scale the world so it renders at a consistent visual size regardless of cellSize.
    // Reference size: 6400 world units (the old 128*50m extent).
    const elevation = this._layers.getGrid('elevation');
    const worldSize = elevation.width * elevation.cellSize;
    const renderScale = 6400 / worldSize;
    const worldGroup = new THREE.Group();
    worldGroup.scale.set(renderScale, renderScale, renderScale);
    scene.add(worldGroup);
    this._worldGroup = worldGroup;

    // Add terrain
    const terrainMesh = buildRegionTerrain(this._layers);
    worldGroup.add(terrainMesh);

    const waterPlane = buildWaterPlane(this._layers);
    worldGroup.add(waterPlane);

    const { group: markerGroup, markers } = buildSettlementMarkers(this._layers);
    worldGroup.add(markerGroup);
    this._3dMarkers = markers;

    const roadLines = buildRegionRoads(this._layers);
    worldGroup.add(roadLines);

    const riverMeshes = buildRegionRiverMeshes(this._layers);
    worldGroup.add(riverMeshes);

    const { line: cityLine, update: cityUpdate } = buildCityBoundary(this._layers);
    worldGroup.add(cityLine);
    this._cityBoundaryUpdate = cityUpdate;

    // Orbit camera
    const camera = new THREE.PerspectiveCamera(50, w / h, 10, 20000);
    this._camera = camera;
    // Camera positioned relative to the scaled render size (6400 reference)
    camera.position.set(6400 * 0.5, 6400 * 0.4, 6400 * 0.5);
    camera.lookAt(0, 0, 0);

    // Raycaster for 3D picking
    this._raycaster = new THREE.Raycaster();
    const domEl = renderer.domElement;
    domEl.style.cursor = 'default';

    domEl.addEventListener('mousemove', (e) => this._on3DHover(e));
    domEl.addEventListener('click', (e) => this._on3DClick(e));

    // Update ring state for initial selection
    this._updateRings();

    // Simple auto-orbit (use reference size 6400 for consistent visual)
    let angle = 0;
    const refSize = 6400;
    const animate = () => {
      if (!this._renderer3D) return;
      requestAnimationFrame(animate);
      angle += 0.003;
      const radius = refSize * 0.9;
      camera.position.set(
        Math.sin(angle) * radius,
        refSize * 0.45,
        Math.cos(angle) * radius,
      );
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
    };
    animate();
  }

  /**
   * Shared selection logic — updates both 2D and 3D views.
   */
  _selectSettlement(settlement) {
    this._selectedSettlement = settlement;
    this._enterBtn.style.opacity = settlement ? '1' : '0.5';
    this._enterBtn.disabled = !settlement;
    if (this._debugBtn) {
      this._debugBtn.style.opacity = settlement ? '1' : '0.5';
      this._debugBtn.disabled = !settlement;
    }
    if (this._compareBtn) {
      this._compareBtn.style.opacity = settlement ? '1' : '0.5';
      this._compareBtn.disabled = !settlement;
    }
    if (this._compareArchetypesBtn) {
      this._compareArchetypesBtn.style.opacity = settlement ? '1' : '0.5';
      this._compareArchetypesBtn.disabled = !settlement;
    }

    if (settlement) {
      this._info.textContent = `Selected: ${settlement.type} (tier ${settlement.tier}) at (${settlement.gx}, ${settlement.gz})`;
    }

    this._redrawMap();
    this._updateRings();
    if (this._cityBoundaryUpdate) this._cityBoundaryUpdate(settlement);
  }

  _redrawMap() {
    renderMap(this._layers, this._mapCanvas);
    const ctx = this._mapCanvas.getContext('2d');
    drawRivers(this._layers, ctx);
    drawRoads(this._layers, ctx);
    drawSettlements(this._layers, ctx);

    if (this._selectedSettlement) {
      const s = this._selectedSettlement;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(s.gx, s.gz, 6, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /**
   * Update 3D ring visibility based on selection and hover state.
   */
  _updateRings() {
    for (const m of this._3dMarkers) {
      const isSelected = this._selectedSettlement === m.settlement;
      const isHovered = this._hoveredMarker === m;

      if (isSelected) {
        m.ring.material.color.setHex(RING_SELECTED_COLOR);
        m.ring.material.opacity = RING_SELECTED_OPACITY;
      } else if (isHovered) {
        m.ring.material.color.setHex(RING_HOVER_COLOR);
        m.ring.material.opacity = RING_HOVER_OPACITY;
      } else {
        m.ring.material.opacity = 0;
      }
    }
  }

  _get3DMouseCoords(e) {
    const rect = this._renderer3D.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  _hitTestMarkers(e) {
    const mouse = this._get3DMouseCoords(e);
    this._raycaster.setFromCamera(mouse, this._camera);
    const meshes = this._3dMarkers.map(m => m.mesh);
    const hits = this._raycaster.intersectObjects(meshes);
    if (hits.length > 0) {
      const hit = hits[0].object;
      return this._3dMarkers.find(m => m.mesh === hit) || null;
    }
    return null;
  }

  _on3DHover(e) {
    const marker = this._hitTestMarkers(e);
    const prev = this._hoveredMarker;
    this._hoveredMarker = marker;
    if (marker !== prev) {
      this._renderer3D.domElement.style.cursor = marker ? 'pointer' : 'default';
      this._updateRings();
    }
  }

  _on3DClick(e) {
    const marker = this._hitTestMarkers(e);
    if (marker) {
      this._selectSettlement(marker.settlement);
    }
  }

  _onMapClick(e) {
    const rect = this._mapCanvas.getBoundingClientRect();
    const scaleX = this._mapCanvas.width / rect.width;
    const scaleY = this._mapCanvas.height / rect.height;
    const gx = Math.round((e.clientX - rect.left) * scaleX);
    const gz = Math.round((e.clientY - rect.top) * scaleY);

    const settlements = this._layers.getData('settlements');
    if (!settlements) return;

    let closest = null;
    let closestDist = Infinity;
    for (const s of settlements) {
      const dx = s.gx - gx;
      const dz = s.gz - gz;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < closestDist) {
        closestDist = dist;
        closest = s;
      }
    }

    if (closest && closestDist < 20) {
      this._selectSettlement(closest);
    }
  }

  _buildLegend() {
    const legend = document.createElement('div');
    legend.style.cssText = 'position:absolute;bottom:12px;left:12px;background:rgba(0,0,0,0.7);padding:8px 12px;border-radius:6px;font-family:monospace;font-size:11px;color:#ccc;pointer-events:none';

    const entries = [
      ['Water',         '#1a4d99'],
      ['Farmland',      '#8ca633'],
      ['Forest',        '#145210'],
      ['Moorland',      '#736650'],
      ['Marsh',         '#4d734d'],
      ['Settlement',    '#997f66'],
      ['Open woodland', '#4d8026'],
      ['Bare rock',     '#8c857a'],
      ['Scrubland',     '#807a40'],
    ];

    for (const [label, color] of entries) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:2px 0';
      const swatch = document.createElement('span');
      swatch.style.cssText = `display:inline-block;width:12px;height:12px;border-radius:2px;background:${color}`;
      const text = document.createElement('span');
      text.textContent = label;
      row.appendChild(swatch);
      row.appendChild(text);
      legend.appendChild(row);
    }

    return legend;
  }

  dispose() {
    if (this._renderer3D) {
      this._renderer3D.dispose();
      this._renderer3D = null;
    }
    this._root.remove();
  }
}
