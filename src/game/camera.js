import * as THREE from 'three';

/**
 * Four camera modes: chase, topdown, hood, free.
 * Smoothly follows the car with terrain-aware positioning.
 * Free mode: Minecraft creative-style fly camera with mouse look and keyboard pan.
 */
export class CameraController {
  /**
   * @param {THREE.PerspectiveCamera} camera
   */
  constructor(camera) {
    this.camera = camera;
    this.mode = 'chase'; // 'chase' | 'topdown' | 'hood' | 'free'
    this._modes = ['chase', 'topdown', 'hood', 'free'];

    // Smooth follow position (chase cam)
    this._pos = new THREE.Vector3();
    this._initialized = false;

    // Free cam state
    this._freePos = new THREE.Vector3();
    this._freeYaw = 0;    // radians, 0 = looking along +Z
    this._freePitch = 0;   // radians, positive = look up
    this._freeMoveSpeed = 100; // world units per second
  }

  /**
   * Cycle to the next camera mode.
   */
  cycleMode() {
    const idx = this._modes.indexOf(this.mode);
    this.mode = this._modes[(idx + 1) % this._modes.length];
    this._initialized = false;
  }

  /**
   * Handle raw mouse movement deltas for free cam look.
   * @param {number} dx - horizontal pixels
   * @param {number} dy - vertical pixels
   */
  handleMouseMove(dx, dy) {
    if (this.mode !== 'free') return;
    const sensitivity = 0.002;
    this._freeYaw -= dx * sensitivity;
    this._freePitch -= dy * sensitivity;
    this._freePitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this._freePitch));
  }

  /**
   * Update camera position and look target based on car state.
   *
   * @param {number} carX - car world X
   * @param {number} carY - car world Y (height)
   * @param {number} carZ - car world Z
   * @param {number} carAngle - car heading in radians (0 = +Z)
   * @param {function(number, number): number} getHeight - terrain height at (x, z)
   * @param {number} dt - delta time in seconds
   * @param {Object} [freeInput] - free cam input { forward, backward, left, right, up, down }
   */
  update(carX, carY, carZ, carAngle, getHeight, dt, freeInput) {
    switch (this.mode) {
      case 'chase':
        this._updateChase(carX, carY, carZ, carAngle, getHeight, dt);
        break;
      case 'topdown':
        this._updateTopdown(carX, carY, carZ, carAngle, getHeight, dt);
        break;
      case 'hood':
        this._updateHood(carX, carY, carZ, carAngle, getHeight, dt);
        break;
      case 'free':
        this._updateFree(carX, carY, carZ, carAngle, getHeight, dt, freeInput);
        break;
    }
  }

  /**
   * Chase cam: 12 units behind car, 5 units up. Smooth follow with lerp.
   * Camera Y clamped above terrain + 2.
   */
  _updateChase(carX, carY, carZ, carAngle, getHeight, dt) {
    // Target: behind the car along heading
    const targetX = carX - Math.sin(carAngle) * 12;
    const targetZ = carZ - Math.cos(carAngle) * 12;
    let targetY = carY + 5;

    // Clamp above terrain
    const groundAtCam = getHeight(targetX, targetZ) + 2;
    if (targetY < groundAtCam) {
      targetY = groundAtCam;
    }

    if (!this._initialized) {
      this._pos.set(targetX, targetY, targetZ);
      this._initialized = true;
    }

    // Exponential smooth follow (~3*dt factor)
    const factor = 1 - Math.exp(-3 * dt);
    this._pos.x += (targetX - this._pos.x) * factor;
    this._pos.y += (targetY - this._pos.y) * factor;
    this._pos.z += (targetZ - this._pos.z) * factor;

    this.camera.position.copy(this._pos);
    this.camera.lookAt(carX, carY + 1.5, carZ);
  }

  /**
   * Top-down cam: directly above the car, 80 units up, looking straight down.
   * Smooth follow with faster lerp.
   */
  _updateTopdown(carX, carY, carZ, carAngle, getHeight, dt) {
    const targetX = carX;
    const targetY = carY + 80;
    const targetZ = carZ;

    if (!this._initialized) {
      this._pos.set(targetX, targetY, targetZ);
      this._initialized = true;
    }

    const factor = 1 - Math.exp(-6 * dt);
    this._pos.x += (targetX - this._pos.x) * factor;
    this._pos.y += (targetY - this._pos.y) * factor;
    this._pos.z += (targetZ - this._pos.z) * factor;

    this.camera.position.copy(this._pos);
    // Look slightly offset so Three.js doesn't get confused by perfectly vertical look
    this.camera.lookAt(carX, carY, carZ + 0.01);
  }

  /**
   * Hood cam: at car position + (0, 1.8, 0), looking 20 units ahead along heading.
   */
  _updateHood(carX, carY, carZ, carAngle, getHeight, dt) {
    this.camera.position.set(carX, carY + 1.8, carZ);
    this.camera.lookAt(
      carX + Math.sin(carAngle) * 20,
      carY + 1,
      carZ + Math.cos(carAngle) * 20
    );
  }

  /**
   * Free cam: Minecraft creative-style fly camera.
   * Mouse look (via pointer lock), arrow keys to pan, space/shift for vertical.
   */
  _updateFree(carX, carY, carZ, carAngle, getHeight, dt, input) {
    if (!this._initialized) {
      // Start at current camera position, facing car's direction
      this._freePos.copy(this.camera.position);
      this._freeYaw = carAngle;
      this._freePitch = -0.3;
      this._initialized = true;
    }

    // Movement
    const speed = this._freeMoveSpeed * dt;
    const yaw = this._freeYaw;

    // Forward/backward along yaw (horizontal plane)
    const fwdX = Math.sin(yaw);
    const fwdZ = Math.cos(yaw);
    // Strafe perpendicular
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);

    if (input) {
      if (input.forward)  { this._freePos.x += fwdX * speed; this._freePos.z += fwdZ * speed; }
      if (input.backward) { this._freePos.x -= fwdX * speed; this._freePos.z -= fwdZ * speed; }
      if (input.left)     { this._freePos.x -= rightX * speed; this._freePos.z -= rightZ * speed; }
      if (input.right)    { this._freePos.x += rightX * speed; this._freePos.z += rightZ * speed; }
      if (input.up)       { this._freePos.y += speed; }
      if (input.down)     { this._freePos.y -= speed; }
    }

    this.camera.position.copy(this._freePos);

    // Look direction from yaw + pitch
    const cosPitch = Math.cos(this._freePitch);
    this.camera.lookAt(
      this._freePos.x + Math.sin(yaw) * cosPitch,
      this._freePos.y + Math.sin(this._freePitch),
      this._freePos.z + Math.cos(yaw) * cosPitch
    );
  }
}
