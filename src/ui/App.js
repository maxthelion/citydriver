import * as THREE from 'three';
import { FlyCamera } from './FlyCamera.js';

/**
 * Three.js application shell: scene, renderer, lights, resize, animation loop.
 */
export class App {
  constructor(container) {
    this.container = container;

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x87ceeb); // sky blue
    container.appendChild(this.renderer.domElement);

    // Scene
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x87ceeb, 800, 3000);

    // Camera
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.5, 10000);

    // Lights
    const ambient = new THREE.AmbientLight(0x8899aa, 0.6);
    this.scene.add(ambient);

    const sun = new THREE.DirectionalLight(0xffeedd, 1.2);
    sun.position.set(200, 400, 300);
    this.scene.add(sun);

    // Fly camera
    this.flyCamera = new FlyCamera(this.camera, this.renderer.domElement);

    // Resize handler
    this._onResize = () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', this._onResize);

    // Clock
    this._clock = new THREE.Clock();
    this._running = false;
  }

  /**
   * Add an object to the scene.
   */
  add(object) {
    this.scene.add(object);
  }

  /**
   * Start the animation loop.
   */
  start() {
    this._running = true;
    this._clock.start();
    this._animate();
  }

  /**
   * Set up an orthographic minimap camera looking straight down.
   * @param {number} cityWidth - city extent in world units
   * @param {number} cityHeight - city extent in world units
   */
  setupMinimap(cityWidth, cityHeight) {
    const hw = cityWidth / 2;
    const hh = cityHeight / 2;
    this._minimapCamera = new THREE.OrthographicCamera(-hw, hw, hh, -hh, 1, 2000);
    this._minimapCamera.position.set(hw, 500, hh);
    this._minimapCamera.lookAt(hw, 0, hh);
    this._minimapCamera.layers.enableAll();

    // Player position indicator (red dot visible only to minimap via layers)
    const dotGeo = new THREE.CircleGeometry(cityWidth * 0.012, 16);
    const dotMat = new THREE.MeshBasicMaterial({ color: 0xff3333, depthTest: false });
    this._minimapDot = new THREE.Mesh(dotGeo, dotMat);
    this._minimapDot.rotation.x = -Math.PI / 2;
    this._minimapDot.renderOrder = 999;
    this._minimapDot.layers.set(1); // Only on layer 1
    this._minimapCamera.layers.enable(1); // Minimap sees layer 1
    this.scene.add(this._minimapDot);
  }

  _animate() {
    if (!this._running) return;
    requestAnimationFrame(() => this._animate());

    const dt = Math.min(this._clock.getDelta(), 0.1);
    this.flyCamera.update(dt);

    const w = window.innerWidth;
    const h = window.innerHeight;

    // Main render (full viewport)
    this.renderer.setViewport(0, 0, w, h);
    this.renderer.setScissorTest(false);
    this.renderer.render(this.scene, this.camera);

    // Minimap render (bottom-right corner)
    if (this._minimapCamera) {
      // Update dot position to match fly camera
      this._minimapDot.position.set(this.camera.position.x, 400, this.camera.position.z);

      const mapSize = 200;
      const mx = w - mapSize - 10;
      const my = 10;
      this.renderer.setViewport(mx, my, mapSize, mapSize);
      this.renderer.setScissor(mx, my, mapSize, mapSize);
      this.renderer.setScissorTest(true);
      this.renderer.render(this.scene, this._minimapCamera);
      this.renderer.setScissorTest(false);
    }
  }

  stop() {
    this._running = false;
  }

  dispose() {
    this.stop();
    this.flyCamera.dispose();
    window.removeEventListener('resize', this._onResize);
    this.renderer.dispose();
  }
}
