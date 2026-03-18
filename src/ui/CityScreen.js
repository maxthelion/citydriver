/**
 * CityScreen — 3D city view with fly camera.
 * Runs the city pipeline (setup + skeleton), then renders terrain, water,
 * rivers, and roads in a THREE.js scene with WASD + mouse-look controls.
 */

import * as THREE from 'three';
import { setupCity } from '../city/setup.js';
import { LandFirstDevelopment } from '../city/strategies/landFirstDevelopment.js';
import { ARCHETYPES } from '../city/archetypes.js';
import { scoreSettlement } from '../city/archetypeScoring.js';
import { prepareCityScene } from '../rendering/prepareCityScene.js';
import { getRoadMaterial, getRiverMaterial } from '../rendering/materials.js';
import { FlyCamera } from './FlyCamera.js';
import { renderMap, drawRivers, drawRoads, drawRailways, drawSettlements } from '../rendering/mapRenderer.js';
import { CITY_RADIUS } from '../city/constants.js';
import { placeBuildings, placeTerracedRows } from '../city/placeBuildings.js';
import { chaikinSmooth } from '../core/math.js';
import { LAYERS } from '../rendering/debugLayers.js';
import { computeCoverageLayers } from '../city/coverageLayers.js';

// Land cover colors (same as regionPreview3D.js)
const COVER_COLORS = {
  0: [0.1, 0.25, 0.5],     // Water
  1: [0.55, 0.65, 0.2],    // Farmland
  2: [0.08, 0.32, 0.05],   // Forest
  3: [0.45, 0.4, 0.3],     // Moorland
  4: [0.3, 0.45, 0.3],     // Marsh
  5: [0.6, 0.5, 0.4],      // Settlement
  6: [0.3, 0.5, 0.15],     // Open woodland
  7: [0.55, 0.52, 0.48],   // Bare rock
  8: [0.5, 0.48, 0.25],    // Scrubland
};
const DEFAULT_COLOR = [0.35, 0.5, 0.2];
const PAVED_COLOR = [0.55, 0.53, 0.5];
const BALLAST_COLOR = [0.45, 0.42, 0.38];

export class CityScreen {
  constructor(container, layers, settlement, rng, seed, onBack) {
    this.container = container;
    this.onBack = onBack;
    this._regionalLayers = layers;
    this._settlement = settlement;
    this._seed = seed || 42;
    this._hud = [];

    // Run city pipeline with land-first development strategy
    const map = setupCity(layers, settlement, rng);

    // Auto-select best-fit archetype from geography
    const scores = scoreSettlement(map);
    const bestArchetype = scores[0].archetype;
    console.log(`City archetype: ${bestArchetype.name} (score ${scores[0].score.toFixed(2)})`);
    for (const s of scores) {
      console.log(`  ${s.archetype.name}: ${s.score.toFixed(2)} — ${s.factors.join(', ')}`);
    }

    const strategy = new LandFirstDevelopment(map, { archetype: bestArchetype });
    while (strategy.tick()) { /* run all ticks */ }

    // Smooth road polylines in-place (2 Chaikin iterations).
    // Done once here so all consumers (rendering, building placement) see the same curves.
    // roadGrid is already stamped from the cell-based paths, so grid data is unaffected.
    for (const road of map.roads) {
      if (!road.polyline || road.polyline.length < 3) continue;
      for (let i = 0; i < 2; i++) road.polyline = chaikinSmooth(road.polyline);
    }

    this._map = map;

    this._buildScene();
  }

  _buildScene() {
    const map = this._map;

    // Renderer — full window, device pixel ratio for sharp rendering
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0x87ceeb);
    this.container.appendChild(renderer.domElement);
    this._renderer = renderer;

    // Scene
    const scene = new THREE.Scene();
    this._scene = scene;
    // No fog — let the full city terrain be visible
    scene.add(new THREE.AmbientLight(0x8899aa, 0.6));
    const sun = new THREE.DirectionalLight(0xffeedd, 1.2);
    sun.position.set(200, 400, 300);
    scene.add(sun);

    // Pre-process city data for 3D (coord conversion, camber, river flow, terrain cuts)
    this._sceneData = prepareCityScene(this._map);

    // Unified coverage layers — continuous float grids for organic rendering boundaries
    this._coverage = computeCoverageLayers(this._map, this._seed);
    this._map._coverage = this._coverage;

    // Meshes (tracked for layer toggle)
    this._meshLayers = {};

    const terrain = this._buildTerrain();
    scene.add(terrain);
    this._meshLayers.terrain = terrain;

    const roads = this._buildRoads();
    scene.add(roads);
    this._meshLayers.roads = roads;

    const railwayMeshes = this._buildRailways();
    scene.add(railwayMeshes);
    this._meshLayers.railways = railwayMeshes;

    const stationMesh = this._buildStation();
    if (stationMesh) {
      scene.add(stationMesh);
      this._meshLayers.station = stationMesh;
    }

    const water = this._buildWater();
    scene.add(water);
    this._meshLayers.water = water;

    const rivers = this._buildRivers();
    scene.add(rivers);
    this._meshLayers.rivers = rivers;

    const trees = this._buildTrees();
    scene.add(trees);
    this._meshLayers.trees = trees;

    const buildings = placeTerracedRows(this._map, this._seed);
    scene.add(buildings);
    this._meshLayers.buildings = buildings;

    const debug = this._buildDebugMarkers();
    scene.add(debug);
    this._meshLayers.debug = debug;

    // Camera + fly controls
    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.5, 10000);
    this._camera = camera;
    this._flyCamera = new FlyCamera(camera, renderer.domElement, {
      getTerrainHeight: (x, z) => {
        const gx = Math.round(x / map.cellSize);
        const gz = Math.round(z / map.cellSize);
        if (gx < 0 || gx >= map.width || gz < 0 || gz >= map.height) return 0;
        return map.elevation.get(gx, gz);
      },
      minHeightAboveTerrain: 3,
    });

    // Position camera: 100m above ground, 200m from city center
    const cityW = map.width * map.cellSize;
    const cityH = map.height * map.cellSize;
    const cx = cityW / 2;
    const cz = cityH / 2;
    const cy = map.elevation.sample(map.width / 2, map.height / 2);
    this._flyCamera.setPosition(cx + 200, cy + 100, cz);

    // Minimap camera (top-down orthographic) — high enough to clear any terrain
    const hw = cityW / 2, hh = cityH / 2;
    this._minimapCamera = new THREE.OrthographicCamera(-hw, hw, hh, -hh, 1, 5000);
    this._minimapCamera.position.set(hw, 3000, hh);
    this._minimapCamera.lookAt(hw, 0, hh);

    // Player dot on minimap
    const dotGeo = new THREE.CircleGeometry(cityW * 0.012, 16);
    const dotMat = new THREE.MeshBasicMaterial({ color: 0xff3333, depthTest: false });
    this._minimapDot = new THREE.Mesh(dotGeo, dotMat);
    this._minimapDot.rotation.x = -Math.PI / 2;
    this._minimapDot.renderOrder = 999;
    this._minimapDot.layers.set(1);
    this._minimapCamera.layers.enableAll();
    scene.add(this._minimapDot);

    // Resize handler
    this._onResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', this._onResize);

    // Animation loop
    this._clock = new THREE.Clock();
    this._running = true;
    const animate = () => {
      if (!this._running) return;
      requestAnimationFrame(animate);
      const dt = Math.min(this._clock.getDelta(), 0.1);
      this._flyCamera.update(dt);

      // Update minimap dot
      this._minimapDot.position.set(camera.position.x, 400, camera.position.z);

      const w = window.innerWidth, h = window.innerHeight;

      // Main render
      renderer.setViewport(0, 0, w, h);
      renderer.setScissorTest(false);
      renderer.render(scene, camera);

      // Minimap (bottom-right)
      const mapSize = 180;
      const mx = w - mapSize - 10;
      const my = 10;
      renderer.setViewport(mx, my, mapSize, mapSize);
      renderer.setScissor(mx, my, mapSize, mapSize);
      renderer.setScissorTest(true);
      renderer.render(scene, this._minimapCamera);
      renderer.setScissorTest(false);
    };
    animate();

    // Build HUD
    this._buildHUD();

    // Region minimap overlay
    this._buildRegionMinimap();
  }

  _buildHUD() {
    // Back button
    const backBtn = document.createElement('button');
    backBtn.textContent = '\u2190 Back to Region';
    backBtn.style.cssText = 'position:fixed;top:10px;left:10px;padding:8px 16px;background:#444;color:#eee;border:1px solid #666;cursor:pointer;font-family:monospace;font-size:13px;border-radius:4px;z-index:100';
    backBtn.addEventListener('click', () => this.onBack());
    document.body.appendChild(backBtn);
    this._hud.push(backBtn);

    // Layer toggles
    const palette = document.createElement('div');
    palette.style.cssText = 'position:fixed;left:10px;top:50px;background:rgba(0,0,0,0.7);color:#eee;font-family:monospace;font-size:12px;padding:8px 10px;border-radius:4px;z-index:100';
    for (const [name, mesh] of Object.entries(this._meshLayers)) {
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

    // Debug layer overlay dropdown
    const overlayLabel = document.createElement('label');
    overlayLabel.style.cssText = 'display:block;margin-top:8px;border-top:1px solid #555;padding-top:6px';
    overlayLabel.appendChild(document.createTextNode('Overlay: '));
    const select = document.createElement('select');
    select.style.cssText = 'background:#333;color:#eee;border:1px solid #555;font-family:monospace;font-size:11px;margin-top:2px;width:100%';
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = 'None';
    select.appendChild(noneOpt);
    for (const layer of LAYERS) {
      const opt = document.createElement('option');
      opt.value = layer.name;
      opt.textContent = layer.name;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => this._setDebugOverlay(select.value));
    overlayLabel.appendChild(select);
    palette.appendChild(overlayLabel);

    // Instructions
    const info = document.createElement('div');
    info.style.cssText = 'position:fixed;bottom:10px;left:10px;color:white;font-family:monospace;font-size:13px;pointer-events:none;text-shadow:1px 1px 2px black;z-index:100';
    info.textContent = 'Click to capture mouse. WASD move, Mouse look, Space up, Double-click drop, Scroll speed.';
    document.body.appendChild(info);
    this._hud.push(info);
  }

  _buildRegionMinimap() {
    const layers = this._regionalLayers;
    const settlement = this._settlement;
    const params = layers.getData('params');
    if (!params) return;

    const offscreen = document.createElement('canvas');
    renderMap(layers, offscreen, { mode: 'elevation' });
    const ctx = offscreen.getContext('2d');
    drawRivers(layers, ctx);
    drawRoads(layers, ctx);
    drawRailways(layers, ctx);
    drawSettlements(layers, ctx);

    // Draw green dot at station location
    if (this._map.station) {
      const stGx = Math.round(this._map.station.x / params.cellSize);
      const stGz = Math.round(this._map.station.z / params.cellSize);
      ctx.fillStyle = '#00ff00';
      ctx.beginPath();
      ctx.arc(stGx, stGz, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Draw city extent rectangle
    const cityRadius = CITY_RADIUS;
    const minGx = Math.max(0, settlement.gx - cityRadius);
    const minGz = Math.max(0, settlement.gz - cityRadius);
    const maxGx = Math.min(params.width - 1, settlement.gx + cityRadius);
    const maxGz = Math.min(params.height - 1, settlement.gz + cityRadius);

    ctx.strokeStyle = '#ff3333';
    ctx.lineWidth = 2;
    ctx.strokeRect(minGx, minGz, maxGx - minGx, maxGz - minGz);

    const displaySize = 160;
    const minimapEl = document.createElement('canvas');
    minimapEl.width = displaySize;
    minimapEl.height = displaySize;
    minimapEl.style.cssText = `position:fixed;top:10px;right:10px;width:${displaySize}px;height:${displaySize}px;border:2px solid rgba(255,255,255,0.5);border-radius:4px;z-index:100;image-rendering:pixelated;pointer-events:none`;

    const displayCtx = minimapEl.getContext('2d');
    displayCtx.imageSmoothingEnabled = false;
    displayCtx.drawImage(offscreen, 0, 0, displaySize, displaySize);

    document.body.appendChild(minimapEl);
    this._hud.push(minimapEl);
  }

  /**
   * Apply a debug layer as a texture overlay on the terrain, or remove it.
   */
  _setDebugOverlay(layerName) {
    const terrain = this._meshLayers.terrain;
    if (!terrain) return;

    if (!layerName) {
      // Restore vertex colors
      if (this._debugTexture) {
        this._debugTexture.dispose();
        this._debugTexture = null;
      }
      terrain.material.map = null;
      terrain.material.vertexColors = true;
      terrain.material.needsUpdate = true;
      return;
    }

    const layer = LAYERS.find(l => l.name === layerName);
    if (!layer) return;

    const map = this._map;
    const canvas = document.createElement('canvas');
    canvas.width = map.width;
    canvas.height = map.height;
    const ctx = canvas.getContext('2d');
    layer.render(ctx, map);

    if (this._debugTexture) this._debugTexture.dispose();
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    // default flipY=true is correct: canvas gz=0 at top → UV v=1 → scene z=0
    this._debugTexture = tex;

    terrain.material.map = tex;
    terrain.material.vertexColors = false;
    terrain.material.needsUpdate = true;
  }

  /**
   * Terrain mesh colored by unified coverage layers (continuous float grids).
   * Uses pre-computed cut elevation from prepareCityScene (roads/rivers cut in).
   */
  _buildTerrain() {
    const map = this._map;
    const sd = this._sceneData;
    const w = map.width, h = map.height, cs = map.cellSize;

    const geometry = new THREE.PlaneGeometry((w - 1) * cs, (h - 1) * cs, w - 1, h - 1);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate((w - 1) * cs / 2, 0, (h - 1) * cs / 2);

    const positions = geometry.attributes.position.array;
    const colors = new Float32Array(positions.length);

    const seaLevel = map.seaLevel || 0;
    const WATER_SINK = 1.0;     // water cells sunk this far below sea level

    for (let gz = 0; gz < h; gz++) {
      for (let gx = 0; gx < w; gx++) {
        const idx = gz * w + gx;
        let elev = sd.cutElevation[idx];

        const wt = map.waterType ? map.waterType.get(gx, gz) : 0;
        if (wt === 1 || wt === 2) {
          // Sea/lake cells: sink below water plane
          elev = Math.min(elev, seaLevel - WATER_SINK);
        } else if (wt === 0 && elev < seaLevel) {
          // Non-water cells below sea level: let the water plane cover them
          elev = seaLevel - WATER_SINK;
        }
        // River cells (wt === 3): keep carved channel elevation as-is

        positions[idx * 3 + 1] = elev;

        // Coverage-layer-driven color blending
        const ci = gz * w + gx;
        const cov = this._coverage;

        // Start with base grass color
        let r = DEFAULT_COLOR[0], g = DEFAULT_COLOR[1], b = DEFAULT_COLOR[2];

        // Blend land cover (lowest priority — sets base terrain color)
        if (cov.landCover[ci] > 0.01) {
          const cover = cov.dominantCover[ci];
          const cc = COVER_COLORS[cover] || DEFAULT_COLOR;
          const t = cov.landCover[ci];
          r = r + (cc[0] - r) * t;
          g = g + (cc[1] - g) * t;
          b = b + (cc[2] - b) * t;
        }

        // Blend forest
        if (cov.forest[ci] > 0.01) {
          const fc = COVER_COLORS[2]; // forest green
          const t = cov.forest[ci];
          r = r + (fc[0] - r) * t;
          g = g + (fc[1] - g) * t;
          b = b + (fc[2] - b) * t;

          // Dappled canopy noise on forested areas
          const hash = ((gx * 2654435761 + gz * 2246822519) >>> 0) & 0xffff;
          const noise = (hash / 0xffff) * 0.15 - 0.075;
          r = Math.max(0, Math.min(1, r + noise * 0.5 * t));
          g = Math.max(0, Math.min(1, g + noise * t));
          b = Math.max(0, Math.min(1, b + noise * 0.3 * t));
        }

        // Blend development (urban ground tone)
        if (cov.development[ci] > 0.01) {
          const dc = COVER_COLORS[5]; // settlement color
          const t = cov.development[ci];
          r = r + (dc[0] - r) * t;
          g = g + (dc[1] - g) * t;
          b = b + (dc[2] - b) * t;
        }

        // Blend railway (ballast/gravel corridor)
        if (cov.railway && cov.railway[ci] > 0.01) {
          const t = cov.railway[ci];
          r = r + (BALLAST_COLOR[0] - r) * t;
          g = g + (BALLAST_COLOR[1] - g) * t;
          b = b + (BALLAST_COLOR[2] - b) * t;
        }

        // Blend road (pavement apron — ground coloring only, road ribbon mesh is separate)
        if (cov.road[ci] > 0.01) {
          const t = cov.road[ci];
          r = r + (PAVED_COLOR[0] - r) * t;
          g = g + (PAVED_COLOR[1] - g) * t;
          b = b + (PAVED_COLOR[2] - b) * t;
        }

        // Blend water → sand/beach in transition zone
        if (cov.water[ci] > 0.01) {
          const SAND_COLOR = [0.76, 0.70, 0.50];
          const WATER_COLOR = COVER_COLORS[0];
          // 0.0–0.4: blend toward sand; 0.4–1.0: blend toward water
          if (cov.water[ci] < 0.4) {
            const t = cov.water[ci] / 0.4;
            r = r + (SAND_COLOR[0] - r) * t;
            g = g + (SAND_COLOR[1] - g) * t;
            b = b + (SAND_COLOR[2] - b) * t;
          } else {
            const t = (cov.water[ci] - 0.4) / 0.6;
            r = SAND_COLOR[0] + (WATER_COLOR[0] - SAND_COLOR[0]) * t;
            g = SAND_COLOR[1] + (WATER_COLOR[1] - SAND_COLOR[1]) * t;
            b = SAND_COLOR[2] + (WATER_COLOR[2] - SAND_COLOR[2]) * t;
          }
        }

        const rgb = [r, g, b];

        colors[idx * 3] = rgb[0];
        colors[idx * 3 + 1] = rgb[1];
        colors[idx * 3 + 2] = rgb[2];
      }
    }

    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    return new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ vertexColors: true }));
  }

  /**
   * Water plane at sea level.
   */
  _buildWater() {
    const map = this._map;
    const size = Math.max(map.width, map.height) * map.cellSize;
    const geometry = new THREE.PlaneGeometry(size * 1.5, size * 1.5);
    geometry.rotateX(-Math.PI / 2);

    const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({
      color: 0x2255aa, transparent: true, opacity: 0.7,
    }));
    mesh.position.set(
      map.width * map.cellSize / 2,
      map.seaLevel,
      map.height * map.cellSize / 2,
    );
    return mesh;
  }

  /**
   * River ribbon meshes from pre-processed scene data (downhill-enforced, local coords).
   */
  _buildRivers() {
    const vertices = [];
    const indices = [];

    for (const river of this._sceneData.rivers) {
      const pts = river.localPts;
      if (pts.length < 2) continue;

      const baseVertex = vertices.length / 3;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const halfW = (p.width || 10) / 2;

        let dx, dz;
        if (i < pts.length - 1) {
          dx = pts[i + 1].x - p.x; dz = pts[i + 1].z - p.z;
        } else {
          dx = p.x - pts[i - 1].x; dz = p.z - pts[i - 1].z;
        }
        const len = Math.sqrt(dx * dx + dz * dz) || 1;
        const px = -dz / len * halfW, pz = dx / len * halfW;

        vertices.push(p.x + px, p.y, p.z + pz, p.x - px, p.y, p.z - pz);
        if (i > 0) {
          const b = baseVertex + (i - 1) * 2;
          indices.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
        }
      }
    }

    if (vertices.length < 6) return new THREE.Group();
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();

    const group = new THREE.Group();
    group.add(new THREE.Mesh(geom, getRiverMaterial()));
    return group;
  }

  /**
   * Road ribbon meshes from pre-processed scene data.
   * Uses bisector miter joins at corners and neutral camber (flat across width).
   */
  _buildRoads() {
    const group = new THREE.Group();
    const batches = {};

    for (const road of this._sceneData.roads) {
      const hier = road.hierarchy;
      if (!batches[hier]) batches[hier] = { vertices: [], indices: [] };
      const batch = batches[hier];
      const pts = road.localPts;
      const halfW = road.halfWidth;
      const baseVertex = batch.vertices.length / 3;

      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];

        // Bisector miter: average incoming and outgoing perpendiculars
        let perpX, perpZ;
        if (i === 0) {
          const dx = pts[1].x - p.x, dz = pts[1].z - p.z;
          const len = Math.sqrt(dx * dx + dz * dz) || 1;
          perpX = -dz / len; perpZ = dx / len;
        } else if (i === pts.length - 1) {
          const dx = p.x - pts[i - 1].x, dz = p.z - pts[i - 1].z;
          const len = Math.sqrt(dx * dx + dz * dz) || 1;
          perpX = -dz / len; perpZ = dx / len;
        } else {
          // Incoming perpendicular
          const dx0 = p.x - pts[i - 1].x, dz0 = p.z - pts[i - 1].z;
          const len0 = Math.sqrt(dx0 * dx0 + dz0 * dz0) || 1;
          const px0 = -dz0 / len0, pz0 = dx0 / len0;
          // Outgoing perpendicular
          const dx1 = pts[i + 1].x - p.x, dz1 = pts[i + 1].z - p.z;
          const len1 = Math.sqrt(dx1 * dx1 + dz1 * dz1) || 1;
          const px1 = -dz1 / len1, pz1 = dx1 / len1;
          // Average and normalize
          const ax = px0 + px1, az = pz0 + pz1;
          const alen = Math.sqrt(ax * ax + az * az) || 1;
          perpX = ax / alen; perpZ = az / alen;
        }

        const lx = p.x + perpX * halfW, lz = p.z + perpZ * halfW;
        const rx = p.x - perpX * halfW, rz = p.z - perpZ * halfW;

        batch.vertices.push(lx, p.y, lz, rx, p.y, rz);
        if (i > 0) {
          const b = baseVertex + (i - 1) * 2;
          batch.indices.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
        }
      }
    }

    for (const [hierarchy, batch] of Object.entries(batches)) {
      if (batch.vertices.length < 6) continue;
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.Float32BufferAttribute(batch.vertices, 3));
      geom.setIndex(batch.indices);
      geom.computeVertexNormals();
      group.add(new THREE.Mesh(geom, getRoadMaterial(hierarchy)));
    }

    return group;
  }

  /**
   * Railway ribbon meshes using pre-processed scene data (terrain-following).
   * Same approach as _buildRoads but single batch, bright green for visibility.
   */
  _buildRailways() {
    const group = new THREE.Group();
    const railways = this._sceneData.railways;
    if (!railways || railways.length === 0) return group;

    const vertices = [];
    const indices = [];

    for (const rail of railways) {
      const pts = rail.localPts;
      const halfW = rail.halfWidth;
      if (!pts || pts.length < 2) continue;

      const baseVertex = vertices.length / 3;

      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];

        let perpX, perpZ;
        if (i === 0) {
          const dx = pts[1].x - p.x, dz = pts[1].z - p.z;
          const len = Math.sqrt(dx * dx + dz * dz) || 1;
          perpX = -dz / len; perpZ = dx / len;
        } else if (i === pts.length - 1) {
          const dx = p.x - pts[i - 1].x, dz = p.z - pts[i - 1].z;
          const len = Math.sqrt(dx * dx + dz * dz) || 1;
          perpX = -dz / len; perpZ = dx / len;
        } else {
          const dx0 = p.x - pts[i - 1].x, dz0 = p.z - pts[i - 1].z;
          const len0 = Math.sqrt(dx0 * dx0 + dz0 * dz0) || 1;
          const px0 = -dz0 / len0, pz0 = dx0 / len0;
          const dx1 = pts[i + 1].x - p.x, dz1 = pts[i + 1].z - p.z;
          const len1 = Math.sqrt(dx1 * dx1 + dz1 * dz1) || 1;
          const px1 = -dz1 / len1, pz1 = dx1 / len1;
          const ax = px0 + px1, az = pz0 + pz1;
          const alen = Math.sqrt(ax * ax + az * az) || 1;
          perpX = ax / alen; perpZ = az / alen;
        }

        vertices.push(p.x + perpX * halfW, p.y, p.z + perpZ * halfW);
        vertices.push(p.x - perpX * halfW, p.y, p.z - perpZ * halfW);

        if (i > 0) {
          const b = baseVertex + (i - 1) * 2;
          indices.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
        }
      }
    }

    if (vertices.length < 6) return group;

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();

    const material = new THREE.MeshStandardMaterial({
      color: 0x00ff00,
      roughness: 0.8,
      metalness: 0.1,
      side: THREE.DoubleSide,
    });

    group.add(new THREE.Mesh(geom, material));
    return group;
  }

  /**
   * Station building: a flat rectangle aligned with the track direction.
   */
  _buildStation() {
    const station = this._map.station;
    if (!station) return null;

    const lx = station.x - this._map.originX;
    const lz = station.z - this._map.originZ;
    const gx = Math.round(lx / this._map.cellSize);
    const gz = Math.round(lz / this._map.cellSize);

    if (gx < 0 || gx >= this._map.width || gz < 0 || gz >= this._map.height) return null;

    const y = this._map.elevation.get(gx, gz) + 0.5;

    // Station dimensions: 40m long (along track), 15m wide, 4m tall
    const length = 40, width = 15, height = 4;
    const angle = station.angle;
    const cosA = Math.cos(angle), sinA = Math.sin(angle);

    // Rotated box — 4 corners of the roof
    const hw = width / 2, hl = length / 2;
    const corners = [
      { x: -hl, z: -hw }, { x: hl, z: -hw },
      { x: hl, z: hw }, { x: -hl, z: hw },
    ].map(c => ({
      x: lx + c.x * cosA - c.z * sinA,
      z: lz + c.x * sinA + c.z * cosA,
    }));

    const vertices = [];
    const indices = [];

    // Floor (y)
    for (const c of corners) vertices.push(c.x, y, c.z);
    // Roof (y + height)
    for (const c of corners) vertices.push(c.x, y + height, c.z);

    // Walls (4 sides)
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const base = vertices.length / 3;
      vertices.push(corners[i].x, y, corners[i].z);
      vertices.push(corners[j].x, y, corners[j].z);
      vertices.push(corners[j].x, y + height, corners[j].z);
      vertices.push(corners[i].x, y + height, corners[i].z);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }

    // Roof face
    indices.push(4, 5, 6, 4, 6, 7);

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();

    const material = new THREE.MeshStandardMaterial({
      color: 0x8B7355,
      roughness: 0.9,
    });

    return new THREE.Mesh(geom, material);
  }

  /**
   * Debug markers: nuclei as coloured circles, regional settlements as
   * larger circles, bridge cells as red rectangles.
   */
  _buildDebugMarkers() {
    const map = this._map;
    const cs = map.cellSize;
    const sd = this._sceneData;
    const group = new THREE.Group();

    const _elev = (gx, gz) => {
      const gi = Math.max(0, Math.min(gz, map.height - 1)) * map.width +
                 Math.max(0, Math.min(gx, map.width - 1));
      return sd.cutElevation[gi] + 1.5;
    };

    // Nuclei as circles
    const nucleusColors = { 1: 0x00aaff, 2: 0x44cc44, 3: 0xffaa00 };
    for (const n of map.nuclei) {
      const radius = n.tier === 1 ? 20 : 12;
      const geo = new THREE.CircleGeometry(radius, 24);
      geo.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({
        color: nucleusColors[n.tier] || 0xffffff,
        transparent: true, opacity: 0.7, depthTest: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(n.gx * cs, _elev(n.gx, n.gz), n.gz * cs);
      mesh.renderOrder = 10;
      group.add(mesh);
    }

    // Regional settlements as larger magenta circles
    for (const s of (map.regionalSettlements || [])) {
      const geo = new THREE.CircleGeometry(30, 24);
      geo.rotateX(-Math.PI / 2);
      const mat = new THREE.MeshBasicMaterial({
        color: 0xff00ff, transparent: true, opacity: 0.5, depthTest: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(s.cityGx * cs, _elev(s.cityGx, s.cityGz), s.cityGz * cs);
      mesh.renderOrder = 10;
      group.add(mesh);
    }

    // Bridge cells as red rectangles (batched)
    const bridgeVerts = [], bridgeIdx = [];
    for (let gz = 0; gz < map.height; gz++) {
      for (let gx = 0; gx < map.width; gx++) {
        if (map.bridgeGrid.get(gx, gz) <= 0) continue;
        const x = gx * cs, z = gz * cs;
        const y = _elev(gx, gz);
        const half = cs / 2;
        const bi = bridgeVerts.length / 3;
        bridgeVerts.push(
          x - half, y, z - half,
          x + half, y, z - half,
          x + half, y, z + half,
          x - half, y, z + half,
        );
        bridgeIdx.push(bi, bi + 1, bi + 2, bi, bi + 2, bi + 3);
      }
    }
    if (bridgeVerts.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(bridgeVerts, 3));
      geo.setIndex(bridgeIdx);
      const mat = new THREE.MeshBasicMaterial({
        color: 0xff2222, transparent: true, opacity: 0.8,
        depthTest: false, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 10;
      group.add(mesh);
    }

    return group;
  }

  /**
   * Forest trees as instanced cones. Tree density and size scale with
   * the continuous forest coverage layer for organic woodland edges.
   */
  _buildTrees() {
    const map = this._map;
    const cs = map.cellSize;
    const cov = this._coverage;
    const w = map.width;

    // Deterministic hash with proper bit mixing → 0-1
    function hash(a, b, seed) {
      let h = (a * 374761393 + b * 668265263 + seed) | 0;
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      h = Math.imul(h ^ (h >>> 16), 1911520717);
      h = h ^ (h >>> 13);
      return ((h >>> 0) & 0xffffff) / 0xffffff;
    }

    const treeData = [];
    for (let gz = 1; gz < map.height - 1; gz++) {
      for (let gx = 1; gx < map.width - 1; gx++) {
        const ci = gz * w + gx;
        const forestVal = cov.forest[ci];

        // Skip cells with negligible forest coverage
        if (forestVal < 0.1) continue;
        // Skip water
        if (cov.water[ci] > 0.3) continue;

        // Tree count scales with forest coverage: 0-2 trees
        const maxTrees = Math.round(forestVal * 2);
        const count = Math.floor(hash(gx, gz, 0) * (maxTrees + 1));

        for (let t = 0; t < count; t++) {
          const rx = hash(gx, gz, t * 3 + 1);
          const rz = hash(gx, gz, t * 3 + 2);
          const rv = hash(gx, gz, t * 3 + 3);

          const x = (gx + rx) * cs;
          const z = (gz + rz) * cs;
          const y = map.elevation.sample(x / cs, z / cs);

          // Tree size: woodland (forestVal < 0.7) vs forest dimensions
          // Matches old behavior: woodland ~60% height, ~65% radius of forest
          let treeH, rad;
          if (forestVal < 0.7) {
            treeH = 4 + rv * 5;   // 4-9m (old woodland range)
            rad = 1.5 + rx * 2;   // 1.5-3.5m
          } else {
            treeH = 7 + rv * 8;   // 7-15m (old forest range)
            rad = 2.5 + rx * 2.5; // 2.5-5m
          }

          treeData.push(x, y, z, treeH, rad);
        }
      }
    }

    if (treeData.length === 0) return new THREE.Group();

    const total = treeData.length / 5;
    const coneGeo = new THREE.ConeGeometry(1, 1, 5);
    coneGeo.translate(0, 0.5, 0);

    const mat = new THREE.MeshLambertMaterial({ color: 0x1a5c10 });
    const mesh = new THREE.InstancedMesh(coneGeo, mat, total);

    const dummy = new THREE.Object3D();
    for (let i = 0; i < total; i++) {
      dummy.position.set(treeData[i * 5], treeData[i * 5 + 1], treeData[i * 5 + 2]);
      dummy.scale.set(treeData[i * 5 + 4], treeData[i * 5 + 3], treeData[i * 5 + 4]);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }

    mesh.instanceMatrix.needsUpdate = true;
    const group = new THREE.Group();
    group.add(mesh);
    return group;
  }

  dispose() {
    this._running = false;
    if (this._debugTexture) {
      this._debugTexture.dispose();
      this._debugTexture = null;
    }
    if (this._flyCamera) {
      this._flyCamera.dispose();
      this._flyCamera = null;
    }
    if (this._renderer) {
      this._renderer.dispose();
      this._renderer = null;
    }
    window.removeEventListener('resize', this._onResize);
    for (const el of this._hud) el.remove();
    this._hud = [];
    this.container.innerHTML = '';
  }
}
