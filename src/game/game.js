import * as THREE from 'three';
import { MaterialRegistry } from '../rendering/materials.js';
import { buildTerrainMesh } from '../rendering/terrainMesh.js';
import { buildWaterMesh } from '../rendering/waterMesh.js';
import { createCarMesh, CarPhysics } from './car.js';
import { CameraController } from './camera.js';
import { createUI } from './ui.js';

/**
 * Main game class -- orchestrates scene, rendering, car, camera, UI, and game modes.
 */
export class Game {
  /**
   * @param {HTMLElement} container - DOM element to mount the renderer into
   */
  constructor(container) {
    this.container = container;

    // Three.js core objects (created in init())
    this.scene = null;
    this.renderer = null;
    this.camera = null;

    // Game systems (created in init())
    this.materials = null;
    this.car = null;          // { mesh: THREE.Group, physics: CarPhysics }
    this.cameraController = null;
    this.ui = null;

    // World state
    this.heightmap = null;
    this.seaLevel = 0;
    this.buildings = [];
    this.cityData = null;     // set by main.js after generation
    this.minimap = null;      // set by main.js after minimap creation

    // Internal
    this._terrainMesh = null;
    this._waterMesh = null;
    this._cityMeshes = [];    // additional meshes added via loadTerrain
    this._input = {
      forward: false,
      backward: false,
      left: false,
      right: false,
      handbrake: false,
    };
    this._freeInput = {
      forward: false,
      backward: false,
      left: false,
      right: false,
      up: false,
      down: false,
    };
    this._lastTimestamp = 0;
    this._animFrameId = null;
    this._keydownHandler = null;
    this._keyupHandler = null;
    this._mouseMoveHandler = null;
    this._pointerLockHandler = null;
    this._resizeHandler = null;
  }

  /**
   * Set up scene, renderer, lights, car, camera, UI, and input handling.
   * Does NOT generate a city -- call loadTerrain() for that.
   */
  init() {
    // --- Scene ---
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87CEEB);
    this.scene.fog = new THREE.Fog(0x87CEEB, 400, 1800);

    // --- Renderer ---
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.container.appendChild(this.renderer.domElement);

    // --- Camera ---
    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.5,
      2000
    );
    this.cameraController = new CameraController(this.camera);

    // --- Lighting ---
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambient);

    this._sun = new THREE.DirectionalLight(0xffeedd, 0.8);
    this._sun.position.set(200, 300, 150);
    this.scene.add(this._sun);
    this.scene.add(this._sun.target);

    // --- Materials ---
    this.materials = new MaterialRegistry();

    // --- Car ---
    const carMesh = createCarMesh(this.materials);
    const carPhysics = new CarPhysics();
    this.car = { mesh: carMesh, physics: carPhysics };
    carMesh.visible = false; // hidden until terrain loads
    this.scene.add(carMesh);

    // --- UI ---
    this.ui = createUI();

    // --- Input ---
    this._setupInput();

    // --- Resize ---
    this._resizeHandler = () => this._onResize();
    window.addEventListener('resize', this._resizeHandler);
  }

  /**
   * Load terrain and objects from generation data.
   * Clears previous city objects, adds terrain mesh and water.
   *
   * @param {import('../core/heightmap.js').Heightmap} heightmap
   * @param {number} seaLevel
   * @param {Array<{x: number, z: number, w: number, d: number}>} [buildings]
   * @param {THREE.Object3D[]} [meshes] - additional meshes to add to the scene
   */
  loadTerrain(heightmap, seaLevel, buildings = [], meshes = []) {
    // Dispose previous terrain
    if (this._terrainMesh) {
      this.scene.remove(this._terrainMesh);
      this._terrainMesh.geometry.dispose();
      this._terrainMesh = null;
    }
    if (this._waterMesh) {
      this.scene.remove(this._waterMesh);
      this._waterMesh.geometry.dispose();
      this._waterMesh = null;
    }
    // Remove previous city meshes
    for (const m of this._cityMeshes) {
      this.scene.remove(m);
      if (m.traverse) {
        m.traverse(obj => { if (obj.geometry) obj.geometry.dispose(); });
      }
    }
    this._cityMeshes = [];

    // Store state
    this.heightmap = heightmap;
    this.seaLevel = seaLevel;
    this.buildings = buildings;

    // Build terrain mesh
    this._terrainMesh = buildTerrainMesh(heightmap, seaLevel, this.materials);
    this.scene.add(this._terrainMesh);

    // Build water mesh
    this._waterMesh = buildWaterMesh(heightmap, seaLevel, this.materials);
    this.scene.add(this._waterMesh);

    // Add extra meshes
    for (const m of meshes) {
      this.scene.add(m);
      this._cityMeshes.push(m);
    }

    // Place car at center of map, on terrain
    const cx = heightmap.worldWidth / 2;
    const cz = heightmap.worldHeight / 2;
    this.car.physics.x = cx;
    this.car.physics.z = cz;
    this.car.physics.y = heightmap.sample(cx, cz) + 1;
    this.car.physics.speed = 0;
    this.car.physics.angle = 0;
    this.car.physics.verticalVelocity = 0;
    this.car.mesh.visible = true;

    // Reset camera to car position
    this.cameraController._initialized = false;

    // Redraw minimap base layer if it exists
    if (this.minimap && this.cityData) {
      this.minimap.drawBase(this.cityData);
    }
  }

  /**
   * Main game loop. Called via requestAnimationFrame.
   * @param {number} timestamp - performance.now() timestamp
   */
  loop(timestamp) {
    this._animFrameId = requestAnimationFrame(t => this.loop(t));

    // Delta time in seconds, capped at 50ms to prevent spiral
    const dt = Math.min((timestamp - this._lastTimestamp) / 1000, 0.05);
    this._lastTimestamp = timestamp;

    if (!this.heightmap) {
      this.renderer.render(this.scene, this.camera);
      return;
    }

    const getHeight = (x, z) => this.heightmap.sample(x, z);

    // 1. Update car physics
    this.car.physics.update(dt, this._input, getHeight, this.buildings);

    // 2. Apply car state to mesh
    this.car.physics.applyToMesh(this.car.mesh, getHeight, dt);

    // 3. Update camera
    const p = this.car.physics;
    this.cameraController.update(p.x, p.y, p.z, p.angle, getHeight, dt, this._freeInput);

    // 4. Move sun to follow car
    this._sun.position.set(p.x + 200, 300, p.z + 150);
    this._sun.target.position.set(p.x, p.y, p.z);

    // 5. Update UI
    const mph = Math.abs(p.speed) * 2.237;
    this.ui.updateSpeed(mph);

    // 6. Render
    this.renderer.render(this.scene, this.camera);

    // 7. Update minimap
    if (this.minimap) {
      this.minimap.update(p.x, p.z, p.angle);
    }
  }

  /**
   * Start the game loop.
   */
  start() {
    this._lastTimestamp = performance.now();
    this._animFrameId = requestAnimationFrame(t => this.loop(t));
  }

  /**
   * Clean up all resources: renderer, materials, UI, event listeners.
   */
  dispose() {
    // Stop loop
    if (this._animFrameId !== null) {
      cancelAnimationFrame(this._animFrameId);
      this._animFrameId = null;
    }

    // Remove event listeners
    if (this._keydownHandler) {
      window.removeEventListener('keydown', this._keydownHandler);
    }
    if (this._keyupHandler) {
      window.removeEventListener('keyup', this._keyupHandler);
    }
    if (this._mouseMoveHandler) {
      document.removeEventListener('mousemove', this._mouseMoveHandler);
    }
    if (this._pointerLockHandler) {
      document.removeEventListener('pointerlockchange', this._pointerLockHandler);
    }
    if (this._resizeHandler) {
      window.removeEventListener('resize', this._resizeHandler);
    }

    // Dispose terrain/water
    if (this._terrainMesh) {
      this.scene.remove(this._terrainMesh);
      this._terrainMesh.geometry.dispose();
    }
    if (this._waterMesh) {
      this.scene.remove(this._waterMesh);
      this._waterMesh.geometry.dispose();
    }
    for (const m of this._cityMeshes) {
      this.scene.remove(m);
      if (m.traverse) {
        m.traverse(obj => { if (obj.geometry) obj.geometry.dispose(); });
      }
    }

    // Dispose materials
    if (this.materials) {
      this.materials.dispose();
    }

    // Dispose minimap
    if (this.minimap) {
      this.minimap.destroy();
      this.minimap = null;
    }

    // Dispose UI
    if (this.ui) {
      this.ui.destroy();
    }

    // Dispose renderer
    if (this.renderer) {
      this.renderer.dispose();
      if (this.renderer.domElement && this.renderer.domElement.parentNode) {
        this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
      }
    }
  }

  /**
   * Set up keyboard input handlers for WASD/Arrows/Space/C
   * and mouse/pointer-lock for the free camera mode.
   */
  _setupInput() {
    const carKeyMap = {
      'KeyW': 'forward', 'ArrowUp': 'forward',
      'KeyS': 'backward', 'ArrowDown': 'backward',
      'KeyA': 'left', 'ArrowLeft': 'left',
      'KeyD': 'right', 'ArrowRight': 'right',
      'Space': 'handbrake',
    };

    const freeKeyMap = {
      'ArrowUp': 'forward', 'KeyW': 'forward',
      'ArrowDown': 'backward', 'KeyS': 'backward',
      'ArrowLeft': 'left', 'KeyA': 'left',
      'ArrowRight': 'right', 'KeyD': 'right',
      'Space': 'up',
      'ShiftLeft': 'down', 'ShiftRight': 'down',
    };

    this._keydownHandler = (e) => {
      const inFree = this.cameraController.mode === 'free';

      if (inFree) {
        if (freeKeyMap[e.code]) {
          this._freeInput[freeKeyMap[e.code]] = true;
          e.preventDefault();
        }
      } else {
        if (carKeyMap[e.code]) {
          this._input[carKeyMap[e.code]] = true;
          e.preventDefault();
        }
      }

      if (e.code === 'KeyC') {
        const wasFree = inFree;
        this.cameraController.cycleMode();
        const nowFree = this.cameraController.mode === 'free';

        if (!wasFree && nowFree) {
          this.renderer.domElement.requestPointerLock();
        } else if (wasFree && !nowFree) {
          document.exitPointerLock();
          // Clear free input state
          for (const k in this._freeInput) this._freeInput[k] = false;
        }
      }
    };

    this._keyupHandler = (e) => {
      const inFree = this.cameraController.mode === 'free';

      if (inFree) {
        if (freeKeyMap[e.code]) {
          this._freeInput[freeKeyMap[e.code]] = false;
          e.preventDefault();
        }
      } else {
        if (carKeyMap[e.code]) {
          this._input[carKeyMap[e.code]] = false;
          e.preventDefault();
        }
      }
    };

    // Mouse look for free cam (only active under pointer lock)
    this._mouseMoveHandler = (e) => {
      if (document.pointerLockElement === this.renderer.domElement) {
        this.cameraController.handleMouseMove(e.movementX, e.movementY);
      }
    };

    // If user presses Escape to exit pointer lock, switch back to chase cam
    this._pointerLockHandler = () => {
      if (!document.pointerLockElement && this.cameraController.mode === 'free') {
        this.cameraController.cycleMode(); // exits free → chase
        for (const k in this._freeInput) this._freeInput[k] = false;
      }
    };

    window.addEventListener('keydown', this._keydownHandler);
    window.addEventListener('keyup', this._keyupHandler);
    document.addEventListener('mousemove', this._mouseMoveHandler);
    document.addEventListener('pointerlockchange', this._pointerLockHandler);
  }

  /**
   * Handle window resize.
   */
  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}
