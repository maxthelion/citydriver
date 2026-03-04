import * as THREE from 'three';
import { generateRegion } from '../regional/pipeline.js';
import { runValidators } from '../validators/framework.js';
import { getRegionalValidators } from '../regional/validators.js';
import { renderMap, drawSettlements, drawRivers, drawRoads } from '../rendering/mapRenderer.js';
import { buildRegionTerrain, buildWaterPlane, buildSettlementMarkers, buildRegionRoads, buildRegionRiverMeshes } from '../rendering/regionPreview3D.js';
import { createScorePanel, updateScorePanel } from './ScorePanel.js';
import { SeededRandom } from '../core/rng.js';

/**
 * Region selection screen.
 * Shows 3D orbit preview (left) + 2D map (right) + Regenerate/Enter buttons.
 */
export class RegionScreen {
  constructor(container, onEnter) {
    this.container = container;
    this.onEnter = onEnter; // callback(layers, settlement)
    this._layers = null;
    this._seed = Math.floor(Math.random() * 999999);
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
    btnRow.style.cssText = 'display:flex;gap:8px;margin-top:8px';

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
    const edges = ['north', 'south', 'east', 'west'];
    const coastEdges = [edges[rng.int(0, 3)]];
    this._layers = generateRegion({
      width: 128,
      height: 128,
      cellSize: 50,
      seaLevel: 0,
      coastEdges,
    }, rng);

    // Auto-select first settlement
    const settlements = this._layers.getData('settlements');
    if (settlements && settlements.length > 0) {
      this._selectedSettlement = settlements[0];
      this._enterBtn.style.opacity = '1';
      this._enterBtn.disabled = false;
    } else {
      this._selectedSettlement = null;
      this._enterBtn.style.opacity = '0.5';
      this._enterBtn.disabled = true;
    }

    // Run validators
    const validators = getRegionalValidators(5);
    const scores = runValidators(this._layers, validators);
    updateScorePanel(this._scorePanel, scores);

    // Render 2D map
    renderMap(this._layers, this._mapCanvas);
    const ctx = this._mapCanvas.getContext('2d');
    drawRivers(this._layers, ctx);
    drawRoads(this._layers, ctx);
    drawSettlements(this._layers, ctx);

    // Build 3D preview
    this._build3D();

    this._info.textContent = 'Click a settlement marker on the map to select it.';
  }

  _build3D() {
    // Clean up previous
    if (this._renderer3D) {
      this._renderer3D.dispose();
      this._preview3D.innerHTML = '';
    }

    const w = this._preview3D.clientWidth;
    const h = this._preview3D.clientHeight || 500;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(w, h);
    renderer.setClearColor(0x1a1a2e);
    this._preview3D.appendChild(renderer.domElement);
    this._renderer3D = renderer;

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x87ceeb, 8000, 20000);
    scene.add(new THREE.AmbientLight(0x8899aa, 0.6));
    const sun = new THREE.DirectionalLight(0xffeedd, 1.2);
    sun.position.set(200, 400, 300);
    scene.add(sun);

    // Add terrain
    const terrainMesh = buildRegionTerrain(this._layers);
    scene.add(terrainMesh);

    const waterPlane = buildWaterPlane(this._layers);
    scene.add(waterPlane);

    const markers = buildSettlementMarkers(this._layers);
    scene.add(markers);

    const roadLines = buildRegionRoads(this._layers);
    scene.add(roadLines);

    const riverMeshes = buildRegionRiverMeshes(this._layers);
    scene.add(riverMeshes);

    // Orbit camera
    const camera = new THREE.PerspectiveCamera(50, w / h, 10, 20000);
    const elevation = this._layers.getGrid('elevation');
    const worldSize = elevation.width * elevation.cellSize;
    camera.position.set(worldSize * 0.5, worldSize * 0.4, worldSize * 0.5);
    camera.lookAt(0, 0, 0);

    // Simple auto-orbit
    let angle = 0;
    const animate = () => {
      if (!this._renderer3D) return;
      requestAnimationFrame(animate);
      angle += 0.003;
      const radius = worldSize * 0.9;
      camera.position.set(
        Math.sin(angle) * radius,
        worldSize * 0.45,
        Math.cos(angle) * radius,
      );
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
    };
    animate();
  }

  _onMapClick(e) {
    const rect = this._mapCanvas.getBoundingClientRect();
    const scaleX = this._mapCanvas.width / rect.width;
    const scaleY = this._mapCanvas.height / rect.height;
    const gx = Math.round((e.clientX - rect.left) * scaleX);
    const gz = Math.round((e.clientY - rect.top) * scaleY);

    const settlements = this._layers.getData('settlements');
    if (!settlements) return;

    // Find closest settlement
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
      this._selectedSettlement = closest;
      this._enterBtn.style.opacity = '1';
      this._info.textContent = `Selected: ${closest.type} (tier ${closest.tier}) at (${closest.gx}, ${closest.gz})`;

      // Redraw map with highlight
      renderMap(this._layers, this._mapCanvas);
      const ctx = this._mapCanvas.getContext('2d');
      drawRivers(this._layers, ctx);
      drawRoads(this._layers, ctx);
      drawSettlements(this._layers, ctx);

      // Highlight selected
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(closest.gx, closest.gz, 6, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  dispose() {
    if (this._renderer3D) {
      this._renderer3D.dispose();
      this._renderer3D = null;
    }
    this._root.remove();
  }
}
