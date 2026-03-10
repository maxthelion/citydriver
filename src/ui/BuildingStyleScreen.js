import * as THREE from 'three';
import {
  createHouse, addFloor, removeFloor,
  addPitchedRoof, addFrontDoor, addBackDoor, addPorch, addWindows,
  addExtension, addDormer, addBalcony, addBayWindow, addWindowSills, addGroundLevel,
} from '../buildings/generate.js';

const SLIDERS = [
  { key: 'width',      label: 'Width',        min: 3, max: 12, step: 0.5, default: 6 },
  { key: 'depth',      label: 'Depth',        min: 3, max: 10, step: 0.5, default: 5 },
  { key: 'floorHeight',label: 'Floor height',  min: 2.4, max: 4.5, step: 0.1, default: 3 },
  { key: 'roofPitch',  label: 'Roof pitch',    min: 0, max: 60, step: 1, default: 35 },
  { key: 'overhang',   label: 'Eaves',         min: 0, max: 1.0, step: 0.05, default: 0 },
  { key: 'winWidth',   label: 'Window width',  min: 0.5, max: 2.0, step: 0.1, default: 1.0 },
  { key: 'winHeight',  label: 'Window height', min: 0.6, max: 2.5, step: 0.1, default: 1.5 },
  { key: 'winSpacing', label: 'Window spacing', min: 1.5, max: 5.0, step: 0.1, default: 2.5 },
  { key: 'porchDepth', label: 'Porch depth', min: 0.8, max: 3.5, step: 0.1, default: 1.8 },
  { key: 'dormerWidth', label: 'Dormer width', min: 0.8, max: 2.5, step: 0.1, default: 1.2 },
  { key: 'sillProtrusion', label: 'Sill depth', min: 0, max: 0.2, step: 0.01, default: 0 },
  { key: 'groundHeight', label: 'Ground floor ht', min: 0, max: 1.5, step: 0.05, default: 0 },
];

const DOOR_PLACEMENTS = ['left', 'center', 'right'];

export class BuildingStyleScreen {
  constructor(container, onBack) {
    this.container = container;
    this._onBack = onBack;
    this._running = true;

    this._params = {};
    for (const s of SLIDERS) this._params[s.key] = s.default;
    this._params.floors = 2;
    this._params.roofDirection = 'sides';
    this._params.doorPlacement = 'left';
    this._params.hasBackDoor = false;
    this._params.backDoorPlacement = 'center';
    this._params.hasPorch = false;
    this._params.hasBackPorch = false;
    this._params.hasExtension = false;
    this._params.extWidth = 'half';    // 'half' or 'full'
    this._params.extSide = 'left';     // 'left', 'right', 'center'
    this._params.extFloors = 1;
    this._params.extRoof = 'sides';
    this._params.dormers = 0;
    this._params.dormerStyle = 'window'; // 'window' or 'balcony'
    this._params.dormerWidth = 1.2;
    this._params.balconyStyle = 'off'; // 'off', 'full', 'window'
    this._params.porchSpan = 'full';    // 'door' or 'full'
    this._params.porchRoof = 'slope';  // 'slope', 'hip', 'gable'
    this._params.porchDepth = 1.8;
    this._params.hasBay = false;
    this._params.bayStyle = 'box';      // 'box' or 'angled'
    this._params.baySpan = 1;
    this._params.bayFloors = 1;
    this._params.bayPosition = 'center';
    this._params.sillProtrusion = 0;    // 0 = off

    this._buildUI();
    this._initRenderer();
    this._rebuild();
    this._animate();
  }

  // ── UI ─────────────────────────────────────────────────────

  _buildUI() {
    this._root = document.createElement('div');
    this._root.style.cssText = 'position:fixed;inset:0;display:flex;background:#1a1a2e;z-index:50';
    this.container.appendChild(this._root);

    this._buildSidebar();

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

  _buildSidebar() {
    const sidebar = document.createElement('div');
    sidebar.style.cssText = 'width:220px;display:flex;flex-direction:column;padding:12px;background:#1a1a2e;border-right:1px solid #333;overflow-y:auto;gap:6px';
    this._root.appendChild(sidebar);

    const title = document.createElement('div');
    title.textContent = 'Building Lab';
    title.style.cssText = 'color:#ffaa88;font-family:monospace;font-size:16px;font-weight:bold;margin-bottom:8px';
    sidebar.appendChild(title);

    // Floors: label + buttons
    const floorRow = document.createElement('div');
    floorRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px';
    const floorLabel = document.createElement('span');
    floorLabel.style.cssText = 'color:#aaa;font-family:monospace;font-size:12px';
    floorLabel.textContent = `Floors: ${this._params.floors}`;
    this._floorLabel = floorLabel;

    const btnGroup = document.createElement('div');
    btnGroup.style.cssText = 'display:flex;gap:4px';
    const minusBtn = this._makeBtn('-', () => {
      if (this._params.floors > 1) { this._params.floors--; this._rebuild(); }
    }, '28px');
    const plusBtn = this._makeBtn('+', () => {
      if (this._params.floors < 8) { this._params.floors++; this._rebuild(); }
    }, '28px');
    btnGroup.appendChild(minusBtn);
    btnGroup.appendChild(plusBtn);
    floorRow.appendChild(floorLabel);
    floorRow.appendChild(btnGroup);
    sidebar.appendChild(floorRow);

    // Roof direction toggle
    const dirRow = document.createElement('div');
    dirRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px';
    const dirLabel = document.createElement('span');
    dirLabel.style.cssText = 'color:#aaa;font-family:monospace;font-size:12px';
    dirLabel.textContent = 'Roof direction';
    const roofModes = ['sides', 'frontback', 'all', 'mansard'];
    const roofLabels = { sides: 'Sides', frontback: 'Front/Back', all: 'Hip', mansard: 'Mansard' };
    const dirBtn = this._makeBtn(roofLabels[this._params.roofDirection], () => {
      const idx = roofModes.indexOf(this._params.roofDirection);
      this._params.roofDirection = roofModes[(idx + 1) % roofModes.length];
      dirBtn.textContent = roofLabels[this._params.roofDirection];
      this._rebuild();
    }, '80px');
    dirRow.appendChild(dirLabel);
    dirRow.appendChild(dirBtn);
    sidebar.appendChild(dirRow);

    // Door placement toggle
    const doorRow = document.createElement('div');
    doorRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px';
    const doorLabel = document.createElement('span');
    doorLabel.style.cssText = 'color:#aaa;font-family:monospace;font-size:12px';
    doorLabel.textContent = 'Front door';
    const doorBtn = this._makeBtn('Left', () => {
      const idx = DOOR_PLACEMENTS.indexOf(this._params.doorPlacement);
      this._params.doorPlacement = DOOR_PLACEMENTS[(idx + 1) % 3];
      doorBtn.textContent = this._params.doorPlacement.charAt(0).toUpperCase() + this._params.doorPlacement.slice(1);
      this._rebuild();
    }, '80px');
    doorRow.appendChild(doorLabel);
    doorRow.appendChild(doorBtn);
    sidebar.appendChild(doorRow);

    // Porch toggle
    const porchRow = document.createElement('div');
    porchRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px';
    const porchLabel = document.createElement('span');
    porchLabel.style.cssText = 'color:#aaa;font-family:monospace;font-size:12px';
    porchLabel.textContent = 'Porch';
    const porchBtn = this._makeBtn('Off', () => {
      this._params.hasPorch = !this._params.hasPorch;
      porchBtn.textContent = this._params.hasPorch ? 'On' : 'Off';
      this._rebuild();
    }, '80px');
    porchRow.appendChild(porchLabel);
    porchRow.appendChild(porchBtn);
    sidebar.appendChild(porchRow);

    // Porch width toggle
    const porchSpanRow = this._makeToggleRow('Porch width', ['full', 'door'], 'porchSpan', v => v === 'full' ? 'Full' : 'Door');
    sidebar.appendChild(porchSpanRow);

    // Porch roof style
    const porchRoofRow = this._makeToggleRow('Porch roof', ['slope', 'hip', 'gable'], 'porchRoof',
      v => ({ slope: 'Slope', hip: 'Hip', gable: 'Gable' })[v]);
    sidebar.appendChild(porchRoofRow);

    // Back door toggle + placement
    const backDoorRow = document.createElement('div');
    backDoorRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px';
    const backDoorLabel = document.createElement('span');
    backDoorLabel.style.cssText = 'color:#aaa;font-family:monospace;font-size:12px';
    backDoorLabel.textContent = 'Back door';
    const backDoorBtn = this._makeBtn('Off', () => {
      if (!this._params.hasBackDoor) {
        this._params.hasBackDoor = true;
        backDoorBtn.textContent = this._params.backDoorPlacement.charAt(0).toUpperCase() + this._params.backDoorPlacement.slice(1);
      } else {
        const idx = DOOR_PLACEMENTS.indexOf(this._params.backDoorPlacement);
        if (idx === DOOR_PLACEMENTS.length - 1) {
          this._params.hasBackDoor = false;
          backDoorBtn.textContent = 'Off';
        } else {
          this._params.backDoorPlacement = DOOR_PLACEMENTS[idx + 1];
          backDoorBtn.textContent = this._params.backDoorPlacement.charAt(0).toUpperCase() + this._params.backDoorPlacement.slice(1);
        }
      }
      this._rebuild();
    }, '80px');
    backDoorRow.appendChild(backDoorLabel);
    backDoorRow.appendChild(backDoorBtn);
    sidebar.appendChild(backDoorRow);

    // Back porch toggle
    const backPorchRow = document.createElement('div');
    backPorchRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px';
    const backPorchLabel = document.createElement('span');
    backPorchLabel.style.cssText = 'color:#aaa;font-family:monospace;font-size:12px';
    backPorchLabel.textContent = 'Back porch';
    const backPorchBtn = this._makeBtn('Off', () => {
      this._params.hasBackPorch = !this._params.hasBackPorch;
      backPorchBtn.textContent = this._params.hasBackPorch ? 'On' : 'Off';
      this._rebuild();
    }, '80px');
    backPorchRow.appendChild(backPorchLabel);
    backPorchRow.appendChild(backPorchBtn);
    sidebar.appendChild(backPorchRow);

    // Bay window toggle
    const bayRow = document.createElement('div');
    bayRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px';
    const bayLabel = document.createElement('span');
    bayLabel.style.cssText = 'color:#aaa;font-family:monospace;font-size:12px';
    bayLabel.textContent = 'Bay window';
    const bayBtn = this._makeBtn('Off', () => {
      this._params.hasBay = !this._params.hasBay;
      bayBtn.textContent = this._params.hasBay ? 'On' : 'Off';
      this._rebuild();
    }, '80px');
    bayRow.appendChild(bayLabel);
    bayRow.appendChild(bayBtn);
    sidebar.appendChild(bayRow);

    // Bay options
    const bayStyleRow = this._makeToggleRow('Bay style', ['box', 'angled'], 'bayStyle', v => v === 'box' ? 'Box' : 'Angled');
    sidebar.appendChild(bayStyleRow);

    const bayPosRow = this._makeToggleRow('Bay pos', ['left', 'center', 'right'], 'bayPosition', v => v.charAt(0).toUpperCase() + v.slice(1));
    sidebar.appendChild(bayPosRow);

    // Bay span
    const baySpanRow = document.createElement('div');
    baySpanRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px';
    const baySpanLabel = document.createElement('span');
    baySpanLabel.style.cssText = 'color:#aaa;font-family:monospace;font-size:12px';
    baySpanLabel.textContent = `Bay span: ${this._params.baySpan}`;
    this._baySpanLabel = baySpanLabel;
    const baySpanBtns = document.createElement('div');
    baySpanBtns.style.cssText = 'display:flex;gap:4px';
    baySpanBtns.appendChild(this._makeBtn('-', () => {
      if (this._params.baySpan > 1) { this._params.baySpan--; this._rebuild(); }
    }, '28px'));
    baySpanBtns.appendChild(this._makeBtn('+', () => {
      if (this._params.baySpan < 4) { this._params.baySpan++; this._rebuild(); }
    }, '28px'));
    baySpanRow.appendChild(baySpanLabel);
    baySpanRow.appendChild(baySpanBtns);
    sidebar.appendChild(baySpanRow);

    // Bay floors
    const bayFloorRow = document.createElement('div');
    bayFloorRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px';
    const bayFloorLabel = document.createElement('span');
    bayFloorLabel.style.cssText = 'color:#aaa;font-family:monospace;font-size:12px';
    bayFloorLabel.textContent = `Bay floors: ${this._params.bayFloors}`;
    this._bayFloorLabel = bayFloorLabel;
    const bayFloorBtns = document.createElement('div');
    bayFloorBtns.style.cssText = 'display:flex;gap:4px';
    bayFloorBtns.appendChild(this._makeBtn('-', () => {
      if (this._params.bayFloors > 1) { this._params.bayFloors--; this._rebuild(); }
    }, '28px'));
    bayFloorBtns.appendChild(this._makeBtn('+', () => {
      if (this._params.bayFloors < this._params.floors) { this._params.bayFloors++; this._rebuild(); }
    }, '28px'));
    bayFloorRow.appendChild(bayFloorLabel);
    bayFloorRow.appendChild(bayFloorBtns);
    sidebar.appendChild(bayFloorRow);

    // Extension toggle
    const extRow = document.createElement('div');
    extRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px';
    const extLabel = document.createElement('span');
    extLabel.style.cssText = 'color:#aaa;font-family:monospace;font-size:12px';
    extLabel.textContent = 'Extension';
    const extBtn = this._makeBtn('Off', () => {
      this._params.hasExtension = !this._params.hasExtension;
      extBtn.textContent = this._params.hasExtension ? 'On' : 'Off';
      this._rebuild();
    }, '80px');
    extRow.appendChild(extLabel);
    extRow.appendChild(extBtn);
    sidebar.appendChild(extRow);

    // Extension options (width, side, floors, roof) — shown inline
    const extWidthRow = this._makeToggleRow('Ext width', ['half', 'full'], 'extWidth', v => v.charAt(0).toUpperCase() + v.slice(1));
    sidebar.appendChild(extWidthRow);

    const extSideRow = this._makeToggleRow('Ext side', ['left', 'right', 'center'], 'extSide', v => v.charAt(0).toUpperCase() + v.slice(1));
    sidebar.appendChild(extSideRow);

    const extRoofRow = this._makeToggleRow('Ext roof', ['sides', 'frontback', 'all', 'mansard'], 'extRoof',
      v => ({ sides: 'Sides', frontback: 'F/B', all: 'Hip', mansard: 'Mansard' })[v]);
    sidebar.appendChild(extRoofRow);

    // Extension floors
    const extFloorRow = document.createElement('div');
    extFloorRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px';
    const extFloorLabel = document.createElement('span');
    extFloorLabel.style.cssText = 'color:#aaa;font-family:monospace;font-size:12px';
    extFloorLabel.textContent = `Ext floors: ${this._params.extFloors}`;
    this._extFloorLabel = extFloorLabel;
    const extFloorBtns = document.createElement('div');
    extFloorBtns.style.cssText = 'display:flex;gap:4px';
    extFloorBtns.appendChild(this._makeBtn('-', () => {
      if (this._params.extFloors > 1) { this._params.extFloors--; this._rebuild(); }
    }, '28px'));
    extFloorBtns.appendChild(this._makeBtn('+', () => {
      if (this._params.extFloors < this._params.floors) { this._params.extFloors++; this._rebuild(); }
    }, '28px'));
    extFloorRow.appendChild(extFloorLabel);
    extFloorRow.appendChild(extFloorBtns);
    sidebar.appendChild(extFloorRow);

    // Balcony style toggle
    const balconyRow = this._makeToggleRow('Balconies', ['off', 'full', 'window'], 'balconyStyle',
      v => ({ off: 'Off', full: 'Full', window: 'Window' })[v]);
    sidebar.appendChild(balconyRow);

    // Dormers: label + buttons
    const dormerRow = document.createElement('div');
    dormerRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px';
    const dormerLabel = document.createElement('span');
    dormerLabel.style.cssText = 'color:#aaa;font-family:monospace;font-size:12px';
    dormerLabel.textContent = `Dormers: ${this._params.dormers}`;
    this._dormerLabel = dormerLabel;
    const dormerBtnGroup = document.createElement('div');
    dormerBtnGroup.style.cssText = 'display:flex;gap:4px';
    const dormerMinus = this._makeBtn('-', () => {
      if (this._params.dormers > 0) { this._params.dormers--; this._rebuild(); }
    }, '28px');
    const dormerPlus = this._makeBtn('+', () => {
      if (this._params.dormers < 5) { this._params.dormers++; this._rebuild(); }
    }, '28px');
    dormerBtnGroup.appendChild(dormerMinus);
    dormerBtnGroup.appendChild(dormerPlus);
    dormerRow.appendChild(dormerLabel);
    dormerRow.appendChild(dormerBtnGroup);
    sidebar.appendChild(dormerRow);

    // Dormer style
    const dormerStyleRow = this._makeToggleRow('Dormer style', ['window', 'balcony'], 'dormerStyle',
      v => v === 'window' ? 'Window' : 'Balcony');
    sidebar.appendChild(dormerStyleRow);

    // Separator
    const sep = document.createElement('div');
    sep.style.cssText = 'border-top:1px solid #333;margin:4px 0';
    sidebar.appendChild(sep);

    // Sliders
    this._sliders = {};
    for (const def of SLIDERS) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;flex-direction:column;gap:1px';

      const labelRow = document.createElement('div');
      labelRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center';
      const lbl = document.createElement('span');
      lbl.textContent = def.label;
      lbl.style.cssText = 'color:#aaa;font-family:monospace;font-size:11px';
      const val = document.createElement('span');
      val.style.cssText = 'color:#eee;font-family:monospace;font-size:11px;min-width:36px;text-align:right';
      val.textContent = this._fmtVal(this._params[def.key], def.step);
      labelRow.appendChild(lbl);
      labelRow.appendChild(val);

      const input = document.createElement('input');
      input.type = 'range';
      input.min = def.min;
      input.max = def.max;
      input.step = def.step;
      input.value = this._params[def.key];
      input.style.cssText = 'width:100%;accent-color:#ffaa88';

      input.addEventListener('input', () => {
        this._params[def.key] = parseFloat(input.value);
        val.textContent = this._fmtVal(this._params[def.key], def.step);
        this._rebuild();
      });

      row.appendChild(labelRow);
      row.appendChild(input);
      sidebar.appendChild(row);
      this._sliders[def.key] = { input, val, def };
    }

    // Spacer + back button
    const spacer = document.createElement('div');
    spacer.style.cssText = 'flex:1';
    sidebar.appendChild(spacer);

    const backBtn = this._makeBtn('Back', () => { if (this._onBack) this._onBack(); });
    backBtn.style.background = '#333';
    sidebar.appendChild(backBtn);
  }

  _makeBtn(text, onClick, width) {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.style.cssText = `padding:6px;background:#444;color:#eee;border:1px solid #666;cursor:pointer;font-family:monospace;font-size:13px;border-radius:4px;${width ? 'width:' + width : ''}`;
    btn.addEventListener('click', onClick);
    return btn;
  }

  _makeToggleRow(label, values, paramKey, formatFn) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:6px';
    const lbl = document.createElement('span');
    lbl.style.cssText = 'color:#aaa;font-family:monospace;font-size:12px';
    lbl.textContent = label;
    const btn = this._makeBtn(formatFn(this._params[paramKey]), () => {
      const idx = values.indexOf(this._params[paramKey]);
      this._params[paramKey] = values[(idx + 1) % values.length];
      btn.textContent = formatFn(this._params[paramKey]);
      this._rebuild();
    }, '80px');
    row.appendChild(lbl);
    row.appendChild(btn);
    return row;
  }

  _fmtVal(v, step) {
    return Number(v).toFixed(step < 1 ? (step < 0.1 ? 2 : 1) : 0);
  }

  // ── 3D setup ───────────────────────────────────────────────

  _initRenderer() {
    const w = this._viewContainer.clientWidth || 600;
    const h = this._viewContainer.clientHeight || 600;

    this._renderer = new THREE.WebGLRenderer({ antialias: true });
    this._renderer.setSize(w, h);
    this._renderer.setPixelRatio(window.devicePixelRatio);
    this._renderer.setClearColor(0x87ceeb); // sky blue
    this._viewContainer.appendChild(this._renderer.domElement);

    this._scene = new THREE.Scene();
    this._scene.add(new THREE.AmbientLight(0x8899aa, 0.6));
    const sun = new THREE.DirectionalLight(0xffeedd, 1.2);
    sun.position.set(20, 40, 30);
    this._scene.add(sun);

    // Ground
    const groundGeo = new THREE.PlaneGeometry(80, 80);
    const ground = new THREE.Mesh(groundGeo, new THREE.MeshLambertMaterial({ color: 0x3a6b35 }));
    ground.rotation.x = -Math.PI / 2;
    this._scene.add(ground);

    this._camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 200);

    // Orbit state (spherical coords around the target)
    this._orbit = { theta: Math.PI / 4, phi: Math.PI / 5, dist: 20 };
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
      this._orbit.dist = Math.max(5, Math.min(80, this._orbit.dist * (1 + e.deltaY * 0.001)));
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

  // ── Build house ────────────────────────────────────────────

  _rebuild() {
    // Remove old
    if (this._building) {
      this._scene.remove(this._building);
      this._building.traverse(c => {
        if (c.geometry) c.geometry.dispose();
      });
    }

    this._floorLabel.textContent = `Floors: ${this._params.floors}`;
    this._dormerLabel.textContent = `Dormers: ${this._params.dormers}`;
    this._extFloorLabel.textContent = `Ext floors: ${this._params.extFloors}`;
    this._baySpanLabel.textContent = `Bay span: ${this._params.baySpan}`;
    this._bayFloorLabel.textContent = `Bay floors: ${this._params.bayFloors}`;

    const p = this._params;
    const house = createHouse(p.width, p.depth, p.floorHeight);
    for (let i = 1; i < p.floors; i++) addFloor(house);
    addPitchedRoof(house, p.roofPitch, p.roofDirection, p.overhang);
    // Set window spacing so doors snap to the same grid
    house._winSpacing = p.winSpacing;
    house._groundHeight = p.groundHeight || 0;
    addFrontDoor(house, p.doorPlacement);
    if (p.hasBackDoor) addBackDoor(house, p.backDoorPlacement);
    if (p.hasPorch) {
      const pw = p.porchSpan === 'door' ? 2.0 : undefined;
      const pc = p.porchSpan === 'door' ? house._doorX : undefined;
      addPorch(house, { face: 'front', porchWidth: pw, porchCenter: pc, porchDepth: p.porchDepth, roofStyle: p.porchRoof });
    }
    if (p.hasBackPorch) addPorch(house, { face: 'back', porchDepth: p.porchDepth, roofStyle: p.porchRoof });
    if (p.hasExtension) {
      addExtension(house, {
        widthFrac: p.extWidth === 'full' ? 1 : 0.5,
        side: p.extSide,
        floors: p.extFloors,
        roofDirection: p.extRoof,
        roofPitch: p.roofPitch,
      });
    }
    if (p.hasBay) {
      addBayWindow(house, {
        floors: p.bayFloors,
        style: p.bayStyle,
        span: p.baySpan,
        position: p.bayPosition,
      });
    }
    addWindows(house, {
      width: p.winWidth,
      height: p.winHeight,
      spacing: p.winSpacing,
    });

    if (p.sillProtrusion > 0) {
      addWindowSills(house, { protrusion: p.sillProtrusion });
    }

    // Balconies on all upper floors
    if (p.balconyStyle !== 'off') {
      for (let f = 1; f < p.floors; f++) {
        addBalcony(house, f, p.balconyStyle);
      }
    }

    // Evenly space dormers along the roof
    for (let i = 0; i < p.dormers; i++) {
      const t = (i + 1) / (p.dormers + 1);
      addDormer(house, { position: t, width: p.dormerWidth, style: p.dormerStyle });
    }

    if (p.groundHeight > 0) {
      addGroundLevel(house, p.groundHeight);
    }

    const group = house.group;
    // Center horizontally, preserve Y from ground level
    const groundY = group.position.y || 0;
    group.position.set(-p.width / 2, groundY, -p.depth / 2);

    this._building = group;
    this._scene.add(group);
    this._fitCamera();
  }

  _fitCamera() {
    const p = this._params;
    const h = p.floors * p.floorHeight;
    const maxDim = Math.max(p.width, h, p.depth);
    this._orbit.dist = maxDim * 2.2;
    this._orbitTarget.set(0, h * 0.4, 0);
    this._updateCamera();
  }

  // ── Render loop ────────────────────────────────────────────

  _animate() {
    if (!this._running) return;
    requestAnimationFrame(() => this._animate());
    if (this._renderer) {
      this._renderer.render(this._scene, this._camera);
    }
  }

  // ── Cleanup ────────────────────────────────────────────────

  dispose() {
    this._running = false;
    if (this._onKeyDown) {
      document.removeEventListener('keydown', this._onKeyDown);
    }
    if (this._onResize) {
      window.removeEventListener('resize', this._onResize);
    }
    if (this._building) {
      this._building.traverse(c => {
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
