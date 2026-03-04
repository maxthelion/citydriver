import * as THREE from 'three';

/**
 * Pointer-lock WASD + mouse fly camera.
 * No car dependency — pure free-flight navigation.
 */
export class FlyCamera {
  /**
   * @param {THREE.PerspectiveCamera} camera
   * @param {HTMLElement} domElement
   */
  constructor(camera, domElement) {
    this.camera = camera;
    this.domElement = domElement;

    this._pos = new THREE.Vector3(0, 50, 0);
    this._yaw = 0;
    this._pitch = -0.3;
    this._speed = 100;
    this._sensitivity = 0.002;

    this._keys = {
      forward: false,
      backward: false,
      left: false,
      right: false,
      up: false,
      down: false,
    };

    this._locked = false;
    this._boundKeyDown = this._onKeyDown.bind(this);
    this._boundKeyUp = this._onKeyUp.bind(this);
    this._boundMouseMove = this._onMouseMove.bind(this);
    this._boundClick = this._onClick.bind(this);
    this._boundLockChange = this._onLockChange.bind(this);
    this._boundWheel = this._onWheel.bind(this);

    document.addEventListener('keydown', this._boundKeyDown);
    document.addEventListener('keyup', this._boundKeyUp);
    document.addEventListener('mousemove', this._boundMouseMove);
    domElement.addEventListener('click', this._boundClick);
    document.addEventListener('pointerlockchange', this._boundLockChange);
    domElement.addEventListener('wheel', this._boundWheel, { passive: true });
  }

  get position() { return this._pos; }

  setPosition(x, y, z) {
    this._pos.set(x, y, z);
  }

  _onClick() {
    if (!this._locked) {
      this.domElement.requestPointerLock();
    }
  }

  _onLockChange() {
    this._locked = document.pointerLockElement === this.domElement;
  }

  _onKeyDown(e) {
    switch (e.code) {
      case 'KeyW': case 'ArrowUp':    this._keys.forward = true; break;
      case 'KeyS': case 'ArrowDown':  this._keys.backward = true; break;
      case 'KeyA': case 'ArrowLeft':  this._keys.left = true; break;
      case 'KeyD': case 'ArrowRight': this._keys.right = true; break;
      case 'Space':                   this._keys.up = true; break;
      case 'ShiftLeft': case 'ShiftRight': this._keys.down = true; break;
    }
  }

  _onKeyUp(e) {
    switch (e.code) {
      case 'KeyW': case 'ArrowUp':    this._keys.forward = false; break;
      case 'KeyS': case 'ArrowDown':  this._keys.backward = false; break;
      case 'KeyA': case 'ArrowLeft':  this._keys.left = false; break;
      case 'KeyD': case 'ArrowRight': this._keys.right = false; break;
      case 'Space':                   this._keys.up = false; break;
      case 'ShiftLeft': case 'ShiftRight': this._keys.down = false; break;
    }
  }

  _onMouseMove(e) {
    if (!this._locked) return;
    this._yaw -= e.movementX * this._sensitivity;
    this._pitch -= e.movementY * this._sensitivity;
    this._pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this._pitch));
  }

  _onWheel(e) {
    // Scroll up = faster, scroll down = slower
    if (e.deltaY < 0) {
      this._speed = Math.min(this._speed * 1.25, 2000);
    } else {
      this._speed = Math.max(this._speed / 1.25, 10);
    }
  }

  get speed() { return this._speed; }

  /**
   * Update camera position and orientation.
   * @param {number} dt - delta time in seconds
   */
  update(dt) {
    const speed = this._speed * dt;
    const yaw = this._yaw;

    const fwdX = Math.sin(yaw);
    const fwdZ = Math.cos(yaw);
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);

    if (this._keys.forward)  { this._pos.x += fwdX * speed; this._pos.z += fwdZ * speed; }
    if (this._keys.backward) { this._pos.x -= fwdX * speed; this._pos.z -= fwdZ * speed; }
    if (this._keys.left)     { this._pos.x -= rightX * speed; this._pos.z -= rightZ * speed; }
    if (this._keys.right)    { this._pos.x += rightX * speed; this._pos.z += rightZ * speed; }
    if (this._keys.up)       { this._pos.y += speed; }
    if (this._keys.down)     { this._pos.y -= speed; }

    this.camera.position.copy(this._pos);

    const cosPitch = Math.cos(this._pitch);
    this.camera.lookAt(
      this._pos.x + Math.sin(yaw) * cosPitch,
      this._pos.y + Math.sin(this._pitch),
      this._pos.z + Math.cos(yaw) * cosPitch,
    );
  }

  dispose() {
    document.removeEventListener('keydown', this._boundKeyDown);
    document.removeEventListener('keyup', this._boundKeyUp);
    document.removeEventListener('mousemove', this._boundMouseMove);
    this.domElement.removeEventListener('click', this._boundClick);
    document.removeEventListener('pointerlockchange', this._boundLockChange);
    this.domElement.removeEventListener('wheel', this._boundWheel);
  }
}
