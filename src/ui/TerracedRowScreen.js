import * as THREE from 'three';
import { generateRow, victorianTerrace } from '../buildings/archetypes.js';

export class TerracedRowScreen {
  constructor(container, onBack) {
    this.container = container;
    this._onBack = onBack;
    this._running = true;
    this._count = 6;
    this._seed = 42;

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
    title.textContent = 'Terraced Row';
    title.style.cssText = 'color:#ffaa88;font-family:monospace;font-size:16px;font-weight:bold;margin-bottom:8px';
    sidebar.appendChild(title);

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

    // Ground plane
    const groundGeo = new THREE.PlaneGeometry(200, 200);
    const ground = new THREE.Mesh(groundGeo, new THREE.MeshLambertMaterial({ color: 0x3a6b35 }));
    ground.rotation.x = -Math.PI / 2;
    this._scene.add(ground);

    this._camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 500);

    this._orbit = { theta: Math.PI / 4, phi: Math.PI / 5, dist: 40 };
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
      this._orbit.dist = Math.max(5, Math.min(150, this._orbit.dist * (1 + e.deltaY * 0.001)));
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

  _rebuild() {
    if (this._rowGroup) {
      this._scene.remove(this._rowGroup);
      this._rowGroup.traverse(c => {
        if (c.geometry) c.geometry.dispose();
      });
    }

    this._rowGroup = generateRow(victorianTerrace, this._count, this._seed);

    // Center the row horizontally
    const box = new THREE.Box3().setFromObject(this._rowGroup);
    const centerX = (box.min.x + box.max.x) / 2;
    const centerZ = (box.min.z + box.max.z) / 2;
    this._rowGroup.position.x -= centerX;
    this._rowGroup.position.z -= centerZ;

    this._scene.add(this._rowGroup);

    // Fit camera
    const rowWidth = box.max.x - box.min.x;
    const height = box.max.y - box.min.y;
    this._orbit.dist = Math.max(rowWidth, height) * 1.5;
    this._orbitTarget.set(0, height * 0.4, 0);
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
    if (this._rowGroup) {
      this._rowGroup.traverse(c => {
        if (c.geometry) c.geometry.dispose();
        if (c.material) {
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
