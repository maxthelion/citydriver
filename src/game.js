import * as THREE from 'three';
import { generateHeightmap, sampleHeightmap, CELL_SIZE, GRID_COUNT, ROAD_WIDTH } from './heightmap.js';
import { CityGenerator } from './city.js';
import { initMaterials, initGeometries, materials, sharedGeo } from './materials.js';
import { createTerrain, buildRoadChunk, buildIntersection, buildBuilding, buildPark, ROAD_LIFT } from './builders.js';
import { createCar } from './car.js';

function nextFrame() {
  return new Promise(resolve => requestAnimationFrame(resolve));
}

export class Game {
  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.5, 1500);
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    document.body.prepend(this.renderer.domElement);

    this.carSpeed = 0;
    this.carAngle = 0;
    this.steerAngle = 0;
    this.carVelocityY = 0;
    this.carGrounded = false;
    this.cameraMode = 0;
    this.generating = false;
    this.generationId = 0;

    this.keys = {};
    window.addEventListener('keydown', (e) => {
      this.keys[e.code] = true;
      if (e.code === 'KeyC') this.cameraMode = (this.cameraMode + 1) % 3;
    });
    window.addEventListener('keyup', (e) => this.keys[e.code] = false);
    window.addEventListener('resize', () => this.onResize());

    this.minimapCanvas = document.getElementById('minimap-canvas');
    this.minimapCtx = this.minimapCanvas.getContext('2d');
    this.minimapCanvas.width = 200;
    this.minimapCanvas.height = 200;

    document.getElementById('regenerate-btn').addEventListener('click', () => {
      if (!this.generating) this.regenerateCity();
    });

    this.cityGroup = null;
    this.cityData = null;
    this.terrain = null;

    initMaterials();
    initGeometries();
    this.init();
  }

  init() {
    this.setupLighting();
    this.setupSky();

    this.car = createCar();
    this.car.position.set(0, 100, 0);
    this.scene.add(this.car);

    this.regenerateCity();

    this.clock = new THREE.Clock();
    this.animate();
  }

  setupLighting() {
    this.scene.add(new THREE.AmbientLight(0x404060, 0.6));
    this.scene.add(new THREE.HemisphereLight(0x87CEEB, 0x556B2F, 0.4));

    this.sun = new THREE.DirectionalLight(0xFFEECC, 1.5);
    this.sun.position.set(200, 300, 200);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.width = 2048;
    this.sun.shadow.mapSize.height = 2048;
    this.sun.shadow.camera.near = 10;
    this.sun.shadow.camera.far = 800;
    this.sun.shadow.camera.left = -200;
    this.sun.shadow.camera.right = 200;
    this.sun.shadow.camera.top = 200;
    this.sun.shadow.camera.bottom = -200;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
  }

  setupSky() {
    this.scene.background = new THREE.Color(0x87CEEB);
    this.scene.fog = new THREE.FogExp2(0x9AB8D0, 0.0012);
  }

  async regenerateCity() {
    this.generating = true;
    const myId = ++this.generationId;
    const loading = document.getElementById('loading');

    if (this.cityGroup) {
      this.scene.remove(this.cityGroup);
      this.cityGroup.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
      });
    }
    if (this.terrain) {
      this.scene.remove(this.terrain);
      this.terrain.geometry.dispose();
      this.terrain.material.dispose();
    }

    // PHASE 1: Heightmap + terrain
    loading.style.display = 'flex';
    loading.textContent = 'Generating terrain...';
    await nextFrame();
    if (myId !== this.generationId) return;

    const gen = new CityGenerator();
    const hmData = generateHeightmap(gen.perlin);
    this.terrain = createTerrain(hmData);
    this.scene.add(this.terrain);

    const spawnX = CELL_SIZE / 2;
    const spawnZ = CELL_SIZE / 2;
    this.car.position.set(spawnX, sampleHeightmap(spawnX, spawnZ) + 0.5, spawnZ);
    this.carSpeed = 0;
    this.carAngle = 0;
    this.carVelocityY = 0;

    loading.style.display = 'none';
    await nextFrame();
    if (myId !== this.generationId) return;

    // PHASE 2: City data
    this.cityData = gen.generate();
    this.cityGroup = new THREE.Group();
    this.scene.add(this.cityGroup);

    // PHASE 3: Roads
    const BATCH = 4;
    const roads = this.cityData.roads;
    for (let i = 0; i < roads.length; i += BATCH) {
      for (let j = i; j < Math.min(i + BATCH, roads.length); j++) {
        this.cityGroup.add(buildRoadChunk(roads[j]));
      }
      if (i % (BATCH * 3) === 0) {
        await nextFrame();
        if (myId !== this.generationId) return;
      }
    }

    const halfCity = (GRID_COUNT * CELL_SIZE) / 2;
    for (let gx = 0; gx <= GRID_COUNT; gx++) {
      for (let gz = 0; gz <= GRID_COUNT; gz++) {
        this.cityGroup.add(buildIntersection(gx * CELL_SIZE - halfCity, gz * CELL_SIZE - halfCity));
      }
      if (gx % 3 === 0) {
        await nextFrame();
        if (myId !== this.generationId) return;
      }
    }

    // PHASE 4: Buildings
    const buildings = this.cityData.buildings;
    for (let i = 0; i < buildings.length; i += BATCH) {
      for (let j = i; j < Math.min(i + BATCH, buildings.length); j++) {
        this.cityGroup.add(buildBuilding(buildings[j]));
      }
      if (i % (BATCH * 2) === 0) {
        await nextFrame();
        if (myId !== this.generationId) return;
      }
    }

    // PHASE 5: Parks
    for (let i = 0; i < this.cityData.parks.length; i++) {
      this.cityGroup.add(buildPark(this.cityData.parks[i]));
      if (i % 2 === 0) {
        await nextFrame();
        if (myId !== this.generationId) return;
      }
    }

    // PHASE 6: Streetlights
    for (let gx = 0; gx <= GRID_COUNT; gx++) {
      for (let gz = 0; gz <= GRID_COUNT; gz++) {
        if ((gx + gz) % 2 !== 0) continue;
        const x = gx * CELL_SIZE - halfCity;
        const z = gz * CELL_SIZE - halfCity;
        const px = x + ROAD_WIDTH / 2 + 1;
        const pz = z + ROAD_WIDTH / 2 + 1;
        const elev = sampleHeightmap(px, pz);

        const pole = new THREE.Mesh(sharedGeo.pole, materials.pole);
        pole.position.set(px, elev + 3.5, pz);
        this.cityGroup.add(pole);

        const light = new THREE.Mesh(sharedGeo.streetLight, materials.streetLight);
        light.position.set(px, elev + 7, pz);
        this.cityGroup.add(light);
      }
      if (gx % 4 === 0) {
        await nextFrame();
        if (myId !== this.generationId) return;
      }
    }

    this.drawMinimap();
    this.generating = false;
  }

  updateCar(dt) {
    const accel = 30;
    const brakeForce = 40;
    const maxSpeed = 60;
    const maxReverseSpeed = -15;
    const friction = 8;
    const turnSpeed = 2.5;
    const handbrakeDecel = 60;
    const gravity = -50;
    const groundOffset = 0.35;

    if (this.keys['KeyW'] || this.keys['ArrowUp']) this.carSpeed += accel * dt;
    if (this.keys['KeyS'] || this.keys['ArrowDown']) {
      if (this.carSpeed > 0) this.carSpeed -= brakeForce * dt;
      else this.carSpeed -= accel * 0.5 * dt;
    }

    if (this.keys['Space']) {
      if (this.carSpeed > 0) this.carSpeed -= handbrakeDecel * dt;
      else if (this.carSpeed < 0) this.carSpeed += handbrakeDecel * dt;
      if (Math.abs(this.carSpeed) < 0.5) this.carSpeed = 0;
    }

    if (!this.keys['KeyW'] && !this.keys['ArrowUp'] && !this.keys['KeyS'] && !this.keys['ArrowDown']) {
      if (this.carSpeed > 0) this.carSpeed = Math.max(0, this.carSpeed - friction * dt);
      else this.carSpeed = Math.min(0, this.carSpeed + friction * dt);
    }

    this.carSpeed = Math.max(maxReverseSpeed, Math.min(maxSpeed, this.carSpeed));

    let targetSteer = 0;
    if (this.keys['KeyA'] || this.keys['ArrowLeft']) targetSteer = 1;
    if (this.keys['KeyD'] || this.keys['ArrowRight']) targetSteer = -1;
    this.steerAngle += (targetSteer - this.steerAngle) * dt * 5;

    const speedFactor = Math.min(1, Math.abs(this.carSpeed) / 5);
    const turnDir = this.carSpeed >= 0 ? 1 : -1;
    this.carAngle += this.steerAngle * turnSpeed * speedFactor * turnDir * dt;

    this.car.position.x += Math.sin(this.carAngle) * this.carSpeed * dt;
    this.car.position.z += Math.cos(this.carAngle) * this.carSpeed * dt;

    this.carVelocityY += gravity * dt;
    this.car.position.y += this.carVelocityY * dt;

    const groundY = sampleHeightmap(this.car.position.x, this.car.position.z) + groundOffset;
    if (this.car.position.y <= groundY) {
      this.car.position.y = groundY;
      this.carVelocityY = 0;
      this.carGrounded = true;
    } else {
      this.carGrounded = false;
    }

    if (this.carGrounded) {
      const d = 2;
      const fX = this.car.position.x + Math.sin(this.carAngle) * d;
      const fZ = this.car.position.z + Math.cos(this.carAngle) * d;
      const bX = this.car.position.x - Math.sin(this.carAngle) * d;
      const bZ = this.car.position.z - Math.cos(this.carAngle) * d;
      const pitch = Math.atan2(sampleHeightmap(fX, fZ) - sampleHeightmap(bX, bZ), d * 2);

      const rA = this.carAngle - Math.PI / 2;
      const rX = this.car.position.x + Math.sin(rA) * d;
      const rZ = this.car.position.z + Math.cos(rA) * d;
      const lX = this.car.position.x - Math.sin(rA) * d;
      const lZ = this.car.position.z - Math.cos(rA) * d;
      const roll = Math.atan2(sampleHeightmap(rX, rZ) - sampleHeightmap(lX, lZ), d * 2);

      this.car.rotation.set(0, 0, 0);
      this.car.rotation.y = this.carAngle;
      this.car.rotateX(-pitch);
      this.car.rotateZ(roll);
    } else {
      this.car.rotation.y = this.carAngle;
    }

    for (const wheel of this.car.wheels) wheel.rotation.x += this.carSpeed * 2 * dt;

    if (this.cityData) {
      for (const b of this.cityData.buildings) {
        const bdx = this.car.position.x - b.x;
        const bdz = this.car.position.z - b.z;
        const hw = b.w / 2 + 1.5;
        const hd = b.d / 2 + 1.5;
        if (Math.abs(bdx) < hw && Math.abs(bdz) < hd) {
          const ox = hw - Math.abs(bdx);
          const oz = hd - Math.abs(bdz);
          if (ox < oz) this.car.position.x += Math.sign(bdx) * ox;
          else this.car.position.z += Math.sign(bdz) * oz;
          this.carSpeed *= 0.2;
        }
      }
    }

    document.getElementById('speed-display').textContent = `${Math.round(Math.abs(this.carSpeed) * 2.5)} MPH`;
  }

  updateCamera(dt) {
    const p = this.car.position;

    if (this.cameraMode === 0) {
      const tX = p.x - Math.sin(this.carAngle) * 12;
      const tZ = p.z - Math.cos(this.carAngle) * 12;
      let tY = p.y + 5;
      const gY = sampleHeightmap(tX, tZ) + 2;
      if (tY < gY) tY = gY;
      this.camera.position.x += (tX - this.camera.position.x) * dt * 4;
      this.camera.position.y += (tY - this.camera.position.y) * dt * 4;
      this.camera.position.z += (tZ - this.camera.position.z) * dt * 4;
      this.camera.lookAt(p.x, p.y + 1, p.z);
    } else if (this.cameraMode === 1) {
      this.camera.position.set(p.x, p.y + 80, p.z + 0.1);
      this.camera.lookAt(p);
    } else {
      const hx = p.x + Math.sin(this.carAngle) * 2;
      const hz = p.z + Math.cos(this.carAngle) * 2;
      this.camera.position.set(hx, p.y + 1.5, hz);
      this.camera.lookAt(p.x + Math.sin(this.carAngle) * 20, p.y + 1, p.z + Math.cos(this.carAngle) * 20);
    }

    this.sun.position.set(p.x + 200, 300, p.z + 200);
    this.sun.target.position.copy(p);
  }

  drawMinimap() {
    if (!this.cityData) return;

    const ctx = this.minimapCtx;
    const w = this.minimapCanvas.width;
    const h = this.minimapCanvas.height;
    const halfCity = (GRID_COUNT * CELL_SIZE) / 2;
    const cityExtent = GRID_COUNT * CELL_SIZE;
    const scale = w / cityExtent;
    const toX = (x) => (x + halfCity) * scale;
    const toZ = (z) => (z + halfCity) * scale;

    const imgData = ctx.createImageData(w, h);
    const step = 4;
    for (let py = 0; py < h; py += step) {
      for (let px = 0; px < w; px += step) {
        const worldX = (px / w) * cityExtent - halfCity;
        const worldZ = (py / h) * cityExtent - halfCity;
        const elev = sampleHeightmap(worldX, worldZ);
        const br = Math.max(0, Math.min(255, Math.floor(elev * 2 + 40)));
        const r = Math.floor(br * 0.3);
        const g = Math.floor(br * 0.6 + 20);
        const b = Math.floor(br * 0.3);
        for (let dy = 0; dy < step && py + dy < h; dy++) {
          for (let dx = 0; dx < step && px + dx < w; dx++) {
            const idx = ((py + dy) * w + (px + dx)) * 4;
            imgData.data[idx] = r;
            imgData.data[idx + 1] = g;
            imgData.data[idx + 2] = b;
            imgData.data[idx + 3] = 255;
          }
        }
      }
    }
    ctx.putImageData(imgData, 0, 0);

    ctx.fillStyle = '#2a6b2a';
    for (const park of this.cityData.parks) {
      ctx.fillRect(toX(park.x - park.size / 2), toZ(park.z - park.size / 2), park.size * scale, park.size * scale);
    }

    ctx.fillStyle = '#555';
    const roadW = ROAD_WIDTH * scale;
    for (const road of this.cityData.roads) {
      if (road.horizontal) {
        ctx.fillRect(toX(road.x), toZ(road.z) - roadW / 2, (road.endX - road.x) * scale, roadW);
      } else {
        ctx.fillRect(toX(road.x) - roadW / 2, toZ(road.z), roadW, (road.endZ - road.z) * scale);
      }
    }

    for (const b of this.cityData.buildings) {
      const br = Math.min(255, Math.floor(b.h * 2 + 60));
      ctx.fillStyle = `rgb(${br},${br},${Math.floor(br * 1.1)})`;
      ctx.fillRect(toX(b.x - b.w / 2), toZ(b.z - b.d / 2), b.w * scale, b.d * scale);
    }

    this.minimapBase = ctx.getImageData(0, 0, w, h);
  }

  updateMinimap() {
    if (!this.minimapBase) return;
    const ctx = this.minimapCtx;
    const w = this.minimapCanvas.width;
    const halfCity = (GRID_COUNT * CELL_SIZE) / 2;
    const cityExtent = GRID_COUNT * CELL_SIZE;
    const scale = w / cityExtent;

    ctx.putImageData(this.minimapBase, 0, 0);

    const cx = (this.car.position.x + halfCity) * scale;
    const cz = (this.car.position.z + halfCity) * scale;
    ctx.save();
    ctx.translate(cx, cz);
    ctx.rotate(-this.carAngle);
    ctx.fillStyle = '#ff3333';
    ctx.beginPath();
    ctx.moveTo(0, -5);
    ctx.lineTo(-3, 4);
    ctx.lineTo(3, 4);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.updateCar(dt);
    this.updateCamera(dt);
    this.updateMinimap();
    this.renderer.render(this.scene, this.camera);
  }
}
