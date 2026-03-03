import * as THREE from 'three';
import { GameMode } from './GameMode.js';
import { pickTargetLocation } from './targetPicker.js';
import { sampleHeightmap, CELL_SIZE, GRID_COUNT } from '../heightmap.js';

const PICKUP_RADIUS = 8;
const TIME_PER_TREASURE = 30;
const TIME_BONUS = 5;

export class TreasureHunt extends GameMode {
  constructor() {
    super('treasure-hunt');

    this.target = null;
    this.marker3D = null;
    this.score = 0;
    this.streak = 0;
    this.timeRemaining = TIME_PER_TREASURE;
    this.gameOver = false;
    this._animTime = 0;

    // HUD DOM element
    this.hudElement = document.createElement('div');
    this.hudElement.style.position = 'fixed';
    this.hudElement.style.top = '60px';
    this.hudElement.style.left = '20px';
    this.hudElement.style.color = 'gold';
    this.hudElement.style.fontFamily = 'monospace';
    this.hudElement.style.fontSize = '16px';
    this.hudElement.style.pointerEvents = 'none';
    this.hudElement.style.zIndex = '10';
    document.body.appendChild(this.hudElement);
  }

  cityGenerated(game) {
    this.score = 0;
    this.streak = 0;
    this.gameOver = false;
    this.timeRemaining = TIME_PER_TREASURE;
    this._animTime = 0;
    this._spawnTarget(game);
  }

  _spawnTarget(game) {
    // Remove old 3D marker
    if (this.marker3D) {
      game.scene.remove(this.marker3D);
      this.marker3D.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
      });
      this.marker3D = null;
    }

    this.target = pickTargetLocation(
      game.cityData,
      game.car.position,
      () => Math.random()
    );

    // Time with streak bonus
    this.timeRemaining = TIME_PER_TREASURE + this.streak * TIME_BONUS;

    this._createMarker3D(game);
  }

  _createMarker3D(game) {
    const group = new THREE.Group();
    const tx = this.target.x;
    const ty = this.target.y;
    const tz = this.target.z;

    // Gold pillar
    const pillarGeo = new THREE.CylinderGeometry(0.3, 0.3, 20, 8);
    const pillarMat = new THREE.MeshBasicMaterial({
      color: 0xffd700,
      transparent: true,
      opacity: 0.3,
    });
    const pillar = new THREE.Mesh(pillarGeo, pillarMat);
    pillar.position.set(tx, ty + 10, tz);
    group.add(pillar);

    // Top cone
    const coneGeo = new THREE.ConeGeometry(1.2, 2, 6);
    const coneMat = new THREE.MeshStandardMaterial({
      color: 0xffd700,
      emissive: 0xffd700,
      emissiveIntensity: 0.5,
    });
    this._topCone = new THREE.Mesh(coneGeo, coneMat);
    this._topCone.position.set(tx, ty + 3, tz);
    group.add(this._topCone);

    // Bottom cone (flipped)
    const bottomConeGeo = new THREE.ConeGeometry(1.2, 2, 6);
    const bottomConeMat = new THREE.MeshStandardMaterial({
      color: 0xffd700,
      emissive: 0xffd700,
      emissiveIntensity: 0.5,
    });
    this._bottomCone = new THREE.Mesh(bottomConeGeo, bottomConeMat);
    this._bottomCone.rotation.x = Math.PI;
    this._bottomCone.position.set(tx, ty + 1, tz);
    group.add(this._bottomCone);

    // Base ring
    const ringGeo = new THREE.TorusGeometry(2, 0.2, 8, 24);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffd700,
      transparent: true,
      opacity: 0.6,
    });
    this._ring = new THREE.Mesh(ringGeo, ringMat);
    this._ring.rotation.x = -Math.PI / 2;
    this._ring.position.set(tx, ty + 0.5, tz);
    group.add(this._ring);

    game.scene.add(group);
    this.marker3D = group;
  }

  update(dt, game) {
    this._animTime += dt;

    if (!this.target || this.gameOver) {
      this._updateHUD();
      return;
    }

    // Animate marker: bob
    const bob = Math.sin(this._animTime * 2) * 0.5;
    if (this._topCone) {
      this._topCone.position.y = this.target.y + 3 + bob;
      this._topCone.rotation.y += dt * 2;
    }
    if (this._bottomCone) {
      this._bottomCone.position.y = this.target.y + 1 + bob;
      this._bottomCone.rotation.y -= dt * 2;
    }
    if (this._ring) {
      this._ring.material.opacity = 0.3 + 0.3 * Math.sin(this._animTime * 3);
    }

    // Distance check
    const dx = game.car.position.x - this.target.x;
    const dz = game.car.position.z - this.target.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < PICKUP_RADIUS) {
      this.score += 100 + this.streak * 25;
      this.streak++;
      this._spawnTarget(game);
    }

    // Countdown
    this.timeRemaining -= dt;
    if (this.timeRemaining <= 0) {
      this.timeRemaining = 0;
      this.gameOver = true;
      // Remove marker
      if (this.marker3D) {
        game.scene.remove(this.marker3D);
        this.marker3D.traverse((child) => {
          if (child.geometry) child.geometry.dispose();
          if (child.material) child.material.dispose();
        });
        this.marker3D = null;
      }
    }

    this._updateHUD();
  }

  _updateHUD() {
    if (this.gameOver) {
      this.hudElement.innerHTML =
        `<span style="color: red; font-size: 24px;">TIME'S UP!</span><br>` +
        `Final Score: ${this.score}<br>` +
        `<span style="font-size: 12px;">Regenerate city to play again</span>`;
      return;
    }

    const timerColor = this.timeRemaining < 10 ? 'red' : 'gold';
    this.hudElement.innerHTML =
      `<span style="color: ${timerColor};">Time: ${Math.ceil(this.timeRemaining)}s</span><br>` +
      `Score: ${this.score}<br>` +
      `Streak: ${this.streak}`;
  }

  drawMinimap(ctx, game) {
    if (!this.target || this.gameOver) return;

    const halfCity = (GRID_COUNT * CELL_SIZE) / 2;
    const cityExtent = GRID_COUNT * CELL_SIZE;
    const scale = ctx.canvas.width / cityExtent;

    // Target position on minimap
    const tx = (this.target.x + halfCity) * scale;
    const tz = (this.target.z + halfCity) * scale;

    // Pulsing diamond size
    const size = 4 + Math.sin(this._animTime * 4) * 1.5;

    // Draw gold diamond at target position
    ctx.save();
    ctx.fillStyle = 'gold';
    ctx.beginPath();
    ctx.moveTo(tx, tz - size);
    ctx.lineTo(tx + size, tz);
    ctx.lineTo(tx, tz + size);
    ctx.lineTo(tx - size, tz);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Draw dashed line from car to target
    const carX = (game.car.position.x + halfCity) * scale;
    const carZ = (game.car.position.z + halfCity) * scale;

    ctx.save();
    ctx.strokeStyle = 'rgba(255, 215, 0, 0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(carX, carZ);
    ctx.lineTo(tx, tz);
    ctx.stroke();
    ctx.restore();
  }

  cleanup(game) {
    if (this.marker3D) {
      game.scene.remove(this.marker3D);
      this.marker3D.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) child.material.dispose();
      });
      this.marker3D = null;
    }
    this.target = null;
  }
}
