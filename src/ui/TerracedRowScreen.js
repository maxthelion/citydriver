import * as THREE from 'three';
import {
  generateRow, victorianTerrace, parisianHaussmann, germanTownhouse,
  suburbanDetached, lowRiseApartments, ROAD_HALF_WIDTH, SIDEWALK_WIDTH, HOUSE_Z,
} from '../buildings/archetypes.js';

const PRESETS = [
  { label: 'Flat',           streetSlope: 0,    crossSlope: 0 },
  { label: '5% uphill',      streetSlope: 0.05, crossSlope: 0 },
  { label: '12% uphill',     streetSlope: 0.12, crossSlope: 0 },
  { label: 'Hillside up',    streetSlope: 0,    crossSlope: 0.08 },
  { label: 'Hillside down',  streetSlope: 0,    crossSlope: -0.08 },
  { label: '6% + cross',     streetSlope: 0.06, crossSlope: 0.05 },
];

const ROW_SPACING = 35; // Z distance between preset rows

const ARCHETYPES = [
  { label: 'Victorian Terrace', value: victorianTerrace },
  { label: 'Parisian Haussmann', value: parisianHaussmann },
  { label: 'German Townhouse', value: germanTownhouse },
  { label: 'Suburban Detached', value: suburbanDetached },
  { label: 'Low-rise Apartments', value: lowRiseApartments },
];

export class TerracedRowScreen {
  constructor(container, onBack) {
    this.container = container;
    this._onBack = onBack;
    this._running = true;
    this._count = 6;
    this._seed = 42;
    this._archetype = victorianTerrace;

    this._buildUI();
    this._initRenderer();
    this._rebuild();
    this._animate();
  }

  _buildUI() {
    this._root = document.createElement('div');
    this._root.style.cssText = 'position:fixed;inset:0;display:flex;background:#1a1a2e;z-index:50';
    this.container.appendChild(this._root);

    // Sidebar
    const sidebar = document.createElement('div');
    sidebar.style.cssText = 'width:220px;display:flex;flex-direction:column;padding:12px;background:#1a1a2e;border-right:1px solid #333;overflow-y:auto;gap:6px';
    this._root.appendChild(sidebar);

    const title = document.createElement('div');
    title.textContent = 'Sloping Streets';
    title.style.cssText = 'color:#ffaa88;font-family:monospace;font-size:16px;font-weight:bold;margin-bottom:8px';
    sidebar.appendChild(title);

    // Archetype selector
    const archRow = document.createElement('div');
    archRow.style.cssText = 'display:flex;flex-direction:column;gap:1px;margin-bottom:8px';
    const archLbl = document.createElement('span');
    archLbl.textContent = 'Archetype';
    archLbl.style.cssText = 'color:#aaa;font-family:monospace;font-size:11px';
    const archSelect = document.createElement('select');
    archSelect.style.cssText = 'width:100%;padding:4px;background:#333;color:#eee;border:1px solid #666;font-family:monospace;font-size:13px;border-radius:4px';
    ARCHETYPES.forEach((a, idx) => {
      const opt = document.createElement('option');
      opt.value = idx;
      opt.textContent = a.label;
      archSelect.appendChild(opt);
    });
    archSelect.addEventListener('change', () => {
      this._archetype = ARCHETYPES[parseInt(archSelect.value)].value;
      this._rebuild();
    });
    archRow.appendChild(archLbl);
    archRow.appendChild(archSelect);
    sidebar.appendChild(archRow);

    // Count slider
    const countRow = document.createElement('div');
    countRow.style.cssText = 'display:flex;flex-direction:column;gap:1px';
    const countLabelRow = document.createElement('div');
    countLabelRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center';
    const countLbl = document.createElement('span');
    countLbl.textContent = 'Houses';
    countLbl.style.cssText = 'color:#aaa;font-family:monospace;font-size:11px';
    const countVal = document.createElement('span');
    countVal.textContent = this._count;
    countVal.style.cssText = 'color:#eee;font-family:monospace;font-size:11px;min-width:36px;text-align:right';
    countLabelRow.appendChild(countLbl);
    countLabelRow.appendChild(countVal);
    const countInput = document.createElement('input');
    countInput.type = 'range';
    countInput.min = 3;
    countInput.max = 10;
    countInput.step = 1;
    countInput.value = this._count;
    countInput.style.cssText = 'width:100%;accent-color:#ffaa88';
    countInput.addEventListener('input', () => {
      this._count = parseInt(countInput.value);
      countVal.textContent = this._count;
      this._rebuild();
    });
    countRow.appendChild(countLabelRow);
    countRow.appendChild(countInput);
    sidebar.appendChild(countRow);

    // Seed input
    const seedRow = document.createElement('div');
    seedRow.style.cssText = 'display:flex;flex-direction:column;gap:1px;margin-top:8px';
    const seedLbl = document.createElement('span');
    seedLbl.textContent = 'Seed';
    seedLbl.style.cssText = 'color:#aaa;font-family:monospace;font-size:11px';
    const seedInput = document.createElement('input');
    seedInput.type = 'number';
    seedInput.value = this._seed;
    seedInput.style.cssText = 'width:100%;padding:4px;background:#333;color:#eee;border:1px solid #666;font-family:monospace;font-size:13px;border-radius:4px;box-sizing:border-box';
    seedInput.addEventListener('change', () => {
      this._seed = parseInt(seedInput.value) || 0;
      this._rebuild();
    });
    seedRow.appendChild(seedLbl);
    seedRow.appendChild(seedInput);
    sidebar.appendChild(seedRow);

    // Randomise seed button
    const randBtn = document.createElement('button');
    randBtn.textContent = 'Random seed';
    randBtn.style.cssText = 'margin-top:8px;padding:6px;background:#444;color:#eee;border:1px solid #666;cursor:pointer;font-family:monospace;font-size:13px;border-radius:4px';
    randBtn.addEventListener('click', () => {
      this._seed = Math.floor(Math.random() * 1000000);
      seedInput.value = this._seed;
      this._rebuild();
    });
    sidebar.appendChild(randBtn);

    // Spacer + back button
    const spacer = document.createElement('div');
    spacer.style.cssText = 'flex:1';
    sidebar.appendChild(spacer);

    const backBtn = document.createElement('button');
    backBtn.textContent = 'Back';
    backBtn.style.cssText = 'padding:6px;background:#333;color:#eee;border:1px solid #666;cursor:pointer;font-family:monospace;font-size:13px;border-radius:4px';
    backBtn.addEventListener('click', () => { if (this._onBack) this._onBack(); });
    sidebar.appendChild(backBtn);

    // View container
    this._viewContainer = document.createElement('div');
    this._viewContainer.style.cssText = 'flex:1;position:relative;overflow:hidden';
    this._root.appendChild(this._viewContainer);

    this._onKeyDown = (e) => {
      if (e.key === 'Escape' && this._onBack) this._onBack();
    };
    document.addEventListener('keydown', this._onKeyDown);

    this._onResize = () => {
      if (!this._renderer) return;
      const w = this._viewContainer.clientWidth;
      const h = this._viewContainer.clientHeight;
      this._renderer.setSize(w, h);
      this._camera.aspect = w / h;
      this._camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', this._onResize);
  }

  _initRenderer() {
    const w = this._viewContainer.clientWidth || 600;
    const h = this._viewContainer.clientHeight || 600;

    this._renderer = new THREE.WebGLRenderer({ antialias: true });
    this._renderer.setSize(w, h);
    this._renderer.setPixelRatio(window.devicePixelRatio);
    this._renderer.setClearColor(0x87ceeb);
    this._viewContainer.appendChild(this._renderer.domElement);

    this._scene = new THREE.Scene();
    this._scene.add(new THREE.AmbientLight(0x8899aa, 0.6));
    const sun = new THREE.DirectionalLight(0xffeedd, 1.2);
    sun.position.set(20, 40, 30);
    this._scene.add(sun);

    this._camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 800);

    this._orbit = { theta: Math.PI / 4, phi: Math.PI / 5, dist: 100 };
    this._orbitTarget = new THREE.Vector3(0, 0, 0);
    this._setupOrbitControls();
  }

  _setupOrbitControls() {
    const canvas = this._renderer.domElement;
    let dragging = false;
    let lastX, lastY;

    canvas.addEventListener('pointerdown', (e) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      this._orbit.theta -= dx * 0.008;
      this._orbit.phi = Math.max(0.05, Math.min(Math.PI / 2 - 0.05, this._orbit.phi - dy * 0.008));
      this._updateCamera();
    });

    canvas.addEventListener('pointerup', (e) => {
      dragging = false;
      canvas.releasePointerCapture(e.pointerId);
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._orbit.dist = Math.max(10, Math.min(300, this._orbit.dist * (1 + e.deltaY * 0.001)));
      this._updateCamera();
    }, { passive: false });
  }

  _updateCamera() {
    const { theta, phi, dist } = this._orbit;
    const t = this._orbitTarget;
    this._camera.position.set(
      t.x + dist * Math.sin(phi) * Math.sin(theta),
      t.y + dist * Math.cos(phi),
      t.z + dist * Math.sin(phi) * Math.cos(theta),
    );
    this._camera.lookAt(t);
  }

  /**
   * Build a road + sidewalk strip for one preset row.
   * Returns a THREE.Group with road and sidewalk meshes.
   */
  _buildStreet(heightFn, rowLength, zOffset) {
    const street = new THREE.Group();
    const roadMat = new THREE.MeshLambertMaterial({ color: 0x555555 });
    const swMat = new THREE.MeshLambertMaterial({ color: 0x999999 });
    const grassMat = new THREE.MeshLambertMaterial({ color: 0x3a6b35 });

    // Helper: build a strip as a quad with corners at terrain height
    const buildStrip = (z0, z1, mat) => {
      const geo = new THREE.BufferGeometry();
      const x0 = 0, x1 = rowLength;
      const positions = new Float32Array([
        x0, heightFn(x0, z0), z0 + zOffset,
        x1, heightFn(x1, z0), z0 + zOffset,
        x1, heightFn(x1, z1), z1 + zOffset,
        x0, heightFn(x0, z1), z1 + zOffset,
      ]);
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setIndex([0, 2, 1, 0, 3, 2]);
      geo.computeVertexNormals();
      street.add(new THREE.Mesh(geo, mat));
    };

    const swEdge = ROAD_HALF_WIDTH + SIDEWALK_WIDTH;

    // Ground strips (grass)
    buildStrip(-swEdge - 8, -swEdge, grassMat);           // far side of road
    buildStrip(swEdge, HOUSE_Z, grassMat);                 // setback between sidewalk and houses
    buildStrip(HOUSE_Z, HOUSE_Z + 20, grassMat);           // behind houses (covers depth + rear garden)

    // Road (centered on z=0)
    buildStrip(-ROAD_HALF_WIDTH, ROAD_HALF_WIDTH, roadMat);
    // Near sidewalk (between road and houses)
    buildStrip(ROAD_HALF_WIDTH, swEdge, swMat);
    // Far sidewalk (other side of road)
    buildStrip(-swEdge, -ROAD_HALF_WIDTH, swMat);

    return street;
  }

  /**
   * Create a text label sprite.
   */
  _makeLabel(text) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 32px monospace';
    ctx.fillText(text, 10, 42);

    const texture = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: texture, transparent: true });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(8, 1, 1);
    return sprite;
  }

  _rebuild() {
    // Remove old scene content (except ground, lights)
    if (this._sceneGroup) {
      this._scene.remove(this._sceneGroup);
      this._sceneGroup.traverse(c => {
        if (c.geometry) c.geometry.dispose();
        if (c.material) {
          if (c.material.map) c.material.map.dispose();
          if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
          else c.material.dispose();
        }
      });
    }

    this._sceneGroup = new THREE.Group();

    // Estimate row length for street geometry
    const avgPlotWidth = (this._archetype.perHouse.plotWidth[0] + this._archetype.perHouse.plotWidth[1]) / 2;
    const rowLength = avgPlotWidth * this._count;

    for (let p = 0; p < PRESETS.length; p++) {
      const preset = PRESETS[p];
      const zOffset = p * ROW_SPACING;

      const heightFn = (x, z) => x * preset.streetSlope + z * preset.crossSlope;

      // Generate houses
      const row = generateRow(this._archetype, this._count, this._seed, heightFn);
      row.position.z += zOffset;
      this._sceneGroup.add(row);

      // Build road/sidewalk
      const street = this._buildStreet(heightFn, rowLength, zOffset);
      this._sceneGroup.add(street);

      // Label
      const label = this._makeLabel(preset.label);
      label.position.set(-3, heightFn(0, 0) + 5, zOffset);
      this._sceneGroup.add(label);
    }

    // Center the whole scene
    const box = new THREE.Box3().setFromObject(this._sceneGroup);
    const cx = (box.min.x + box.max.x) / 2;
    const cz = (box.min.z + box.max.z) / 2;
    this._sceneGroup.position.x -= cx;
    this._sceneGroup.position.z -= cz;

    this._scene.add(this._sceneGroup);

    // Fit camera to see all rows
    const sceneWidth = box.max.x - box.min.x;
    const sceneDepth = box.max.z - box.min.z;
    this._orbit.dist = Math.max(sceneWidth, sceneDepth) * 1.2;
    this._orbitTarget.set(0, 5, 0);
    this._updateCamera();
  }

  _animate() {
    if (!this._running) return;
    requestAnimationFrame(() => this._animate());
    if (this._renderer) {
      this._renderer.render(this._scene, this._camera);
    }
  }

  dispose() {
    this._running = false;
    if (this._onKeyDown) document.removeEventListener('keydown', this._onKeyDown);
    if (this._onResize) window.removeEventListener('resize', this._onResize);
    if (this._sceneGroup) {
      this._sceneGroup.traverse(c => {
        if (c.geometry) c.geometry.dispose();
        if (c.material) {
          if (c.material.map) c.material.map.dispose();
          if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
          else c.material.dispose();
        }
      });
    }
    if (this._renderer) {
      this._renderer.dispose();
      this._renderer = null;
    }
    this.container.innerHTML = '';
  }
}
