import * as THREE from 'three';

/**
 * Create a car mesh from box primitives.
 *
 * The car faces +Z by default (Three.js convention for rotation.y = 0).
 * - Lower body: 5 x 0.8 x 2.5, car_body material
 * - Cabin: 2.5 x 0.7 x 2.2, car_glass, on top of body, slightly back
 * - 4 wheels: cylinder r=0.4 h=0.3, car_wheel, at corners
 * - 2 headlights: small boxes at front, car_headlight
 * - 2 taillights: small boxes at back, car_taillight
 *
 * @param {import('../rendering/materials.js').MaterialRegistry} materials
 * @returns {THREE.Group} Group with .wheels (THREE.Mesh[]) and .userData {width, length, height}
 */
export function createCarMesh(materials) {
  const group = new THREE.Group();
  group.userData = { width: 2.5, length: 5, height: 1.5 };

  // Lower body: 5 long (Z), 0.8 tall (Y), 2.5 wide (X)
  const bodyGeom = new THREE.BoxGeometry(2.5, 0.8, 5);
  const body = new THREE.Mesh(bodyGeom, materials.get('car_body'));
  body.position.y = 0.6; // bottom of body at ~0.2
  body.castShadow = true;
  group.add(body);

  // Cabin: 2.2 wide, 0.7 tall, 2.5 long, slightly back
  const cabinGeom = new THREE.BoxGeometry(2.2, 0.7, 2.5);
  const cabin = new THREE.Mesh(cabinGeom, materials.get('car_glass'));
  cabin.position.set(0, 1.35, -0.3); // on top of body, slightly rearward
  cabin.castShadow = true;
  group.add(cabin);

  // Wheels: cylinder radius=0.4, height=0.3
  const wheelGeom = new THREE.CylinderGeometry(0.4, 0.4, 0.3, 8);
  const wheelMat = materials.get('car_wheel');
  const wheels = [];

  const wheelPositions = [
    { x: -1.1, y: 0.4, z:  1.5 }, // front-left
    { x:  1.1, y: 0.4, z:  1.5 }, // front-right
    { x: -1.1, y: 0.4, z: -1.5 }, // rear-left
    { x:  1.1, y: 0.4, z: -1.5 }, // rear-right
  ];

  for (const pos of wheelPositions) {
    const wheel = new THREE.Mesh(wheelGeom, wheelMat);
    wheel.position.set(pos.x, pos.y, pos.z);
    wheel.rotation.z = Math.PI / 2; // lay cylinder on its side
    wheel.castShadow = true;
    group.add(wheel);
    wheels.push(wheel);
  }
  group.wheels = wheels;

  // Headlights: small boxes at front
  const lightGeom = new THREE.BoxGeometry(0.4, 0.25, 0.15);
  const headlightMat = materials.get('car_headlight');
  for (const xOff of [-0.8, 0.8]) {
    const hl = new THREE.Mesh(lightGeom, headlightMat);
    hl.position.set(xOff, 0.65, 2.55);
    group.add(hl);
  }

  // Taillights: small boxes at back
  const taillightMat = materials.get('car_taillight');
  for (const xOff of [-0.8, 0.8]) {
    const tl = new THREE.Mesh(lightGeom, taillightMat);
    tl.position.set(xOff, 0.65, -2.55);
    group.add(tl);
  }

  return group;
}

/**
 * Car physics state and update logic.
 * Arcade-style driving model with gravity, friction, steering, and building collision.
 *
 * Heading convention: angle=0 means the car faces +Z.
 *   x += sin(angle) * speed * dt
 *   z += cos(angle) * speed * dt
 */
export class CarPhysics {
  constructor() {
    // Position
    this.x = 0;
    this.z = 0;
    this.y = 0;

    // Heading in radians (0 = +Z direction)
    this.angle = 0;
    this.speed = 0;           // units per second, positive = forward
    this.verticalVelocity = 0;

    // Tuning constants
    this.maxSpeed = 60;
    this.maxReverse = -15;
    this.acceleration = 25;
    this.braking = 30;
    this.friction = 8;
    this.steerSpeed = 2.5;
    this.gravity = -40;
  }

  /**
   * Update physics for one frame.
   * @param {number} dt - delta time in seconds
   * @param {{ forward: boolean, backward: boolean, left: boolean, right: boolean, handbrake: boolean }} input
   * @param {function(number, number): number} getHeight - terrain height at (x, z)
   * @param {Array<{x: number, z: number, w: number, d: number}>} buildings - collision AABBs
   */
  update(dt, input, getHeight, buildings = []) {
    // --- Acceleration / Braking ---
    if (input.forward) {
      if (this.speed < 0) {
        // Braking from reverse
        this.speed += this.braking * dt;
        if (this.speed > 0) this.speed = 0;
      } else {
        this.speed += this.acceleration * dt;
      }
    }

    if (input.backward) {
      if (this.speed > 0) {
        // Braking from forward
        this.speed -= this.braking * dt;
        if (this.speed < 0) this.speed = 0;
      } else {
        // Reverse acceleration (slower)
        this.speed -= this.acceleration * 0.5 * dt;
      }
    }

    // --- Friction ---
    const frictionMultiplier = input.handbrake ? 3 : 1;
    const effectiveFriction = this.friction * frictionMultiplier;

    if (input.handbrake || (!input.forward && !input.backward)) {
      if (this.speed > 0) {
        this.speed = Math.max(0, this.speed - effectiveFriction * dt);
      } else if (this.speed < 0) {
        this.speed = Math.min(0, this.speed + effectiveFriction * dt);
      }
    }

    // --- Speed clamp ---
    if (this.speed > this.maxSpeed) this.speed = this.maxSpeed;
    if (this.speed < this.maxReverse) this.speed = this.maxReverse;

    // --- Steering ---
    // Speed-dependent: near-zero steering at low speed
    if (Math.abs(this.speed) > 0.5) {
      const speedFactor = Math.min(1, Math.abs(this.speed) / 10);
      let steerInput = 0;
      if (input.left) steerInput += 1;
      if (input.right) steerInput -= 1;

      // Invert steering when reversing
      if (this.speed < 0) steerInput = -steerInput;

      this.angle += steerInput * this.steerSpeed * speedFactor * dt;
    }

    // --- Position update ---
    this.x += Math.sin(this.angle) * this.speed * dt;
    this.z += Math.cos(this.angle) * this.speed * dt;

    // --- Gravity ---
    this.verticalVelocity += this.gravity * dt;
    this.y += this.verticalVelocity * dt;

    // --- Ground contact ---
    const groundY = getHeight(this.x, this.z);
    if (this.y <= groundY) {
      this.y = groundY;
      this.verticalVelocity = 0;
    }

    // --- Building collision (AABB) ---
    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i];
      const dx = this.x - b.x;
      const dz = this.z - b.z;
      const hw = b.w / 2 + 1.5; // car half-width buffer
      const hd = b.d / 2 + 1.5;

      if (Math.abs(dx) < hw && Math.abs(dz) < hd) {
        const overlapX = hw - Math.abs(dx);
        const overlapZ = hd - Math.abs(dz);

        if (overlapX < overlapZ) {
          this.x += Math.sign(dx) * overlapX;
        } else {
          this.z += Math.sign(dz) * overlapZ;
        }
        this.speed *= 0.2;
      }
    }
  }

  /**
   * Apply car physics state to a Three.js mesh group.
   * Sets position, heading rotation, terrain-following pitch/roll, and wheel spin.
   *
   * @param {THREE.Group} mesh - group from createCarMesh()
   * @param {function(number, number): number} getHeight - terrain height at (x, z)
   * @param {number} dt - delta time for wheel spin
   */
  applyToMesh(mesh, getHeight, dt) {
    // Position
    mesh.position.set(this.x, this.y, this.z);

    // Reset rotation then apply heading
    mesh.rotation.set(0, 0, 0);
    mesh.rotation.y = this.angle;

    // Terrain-following pitch and roll (only when on ground)
    const grounded = this.verticalVelocity === 0;
    if (grounded) {
      const sampleDist = 2;

      // Pitch: height difference between front and back
      const frontX = this.x + Math.sin(this.angle) * sampleDist;
      const frontZ = this.z + Math.cos(this.angle) * sampleDist;
      const backX = this.x - Math.sin(this.angle) * sampleDist;
      const backZ = this.z - Math.cos(this.angle) * sampleDist;
      const pitch = Math.atan2(
        getHeight(frontX, frontZ) - getHeight(backX, backZ),
        sampleDist * 2
      );

      // Roll: height difference between right and left
      const perpAngle = this.angle + Math.PI / 2;
      const rightX = this.x + Math.sin(perpAngle) * sampleDist;
      const rightZ = this.z + Math.cos(perpAngle) * sampleDist;
      const leftX = this.x - Math.sin(perpAngle) * sampleDist;
      const leftZ = this.z - Math.cos(perpAngle) * sampleDist;
      const roll = Math.atan2(
        getHeight(rightX, rightZ) - getHeight(leftX, leftZ),
        sampleDist * 2
      );

      mesh.rotateX(-pitch);
      mesh.rotateZ(roll);
    }

    // Spin wheels
    if (mesh.wheels) {
      const spinRate = this.speed * 2;
      for (const wheel of mesh.wheels) {
        wheel.rotation.x += spinRate * dt;
      }
    }
  }
}
