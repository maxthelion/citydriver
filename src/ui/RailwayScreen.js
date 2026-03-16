// src/ui/RailwayScreen.js
/**
 * 2D railway schematic screen.
 * Shows the regional railway network as curved lines on a muted terrain background.
 */

import {
  renderSchematicTerrain,
  renderSchematicLines,
  renderSchematicStations,
  renderSchematicOffMapCities,
} from '../rendering/railwaySchematic.js';

export class RailwayScreen {
  constructor(container, layers, seed, onBack) {
    this.container = container;
    this.layers = layers;
    this.seed = seed;
    this.onBack = onBack;
    this._disposed = false;

    this._buildUI();
    this._render();
  }

  _buildUI() {
    this._root = document.createElement('div');
    this._root.style.cssText = 'position:fixed;inset:0;background:#f0f0f0;display:flex;flex-direction:column;z-index:50';
    this.container.appendChild(this._root);

    // Top bar
    const topBar = document.createElement('div');
    topBar.style.cssText = 'display:flex;align-items:center;gap:12px;padding:8px 12px;background:#333;color:#eee;font-family:monospace;font-size:13px';

    const backBtn = document.createElement('button');
    backBtn.textContent = 'Back';
    backBtn.style.cssText = 'padding:6px 12px;background:#555;color:#eee;border:1px solid #777;cursor:pointer;font-family:monospace;border-radius:4px';
    backBtn.addEventListener('click', () => this.onBack());
    topBar.appendChild(backBtn);

    const title = document.createElement('span');
    title.textContent = `Railway Network — Seed ${this.seed}`;
    topBar.appendChild(title);

    this._root.appendChild(topBar);

    // Canvas container (fills remaining space)
    const canvasWrap = document.createElement('div');
    canvasWrap.style.cssText = 'flex:1;display:flex;align-items:center;justify-content:center;overflow:hidden;padding:20px';
    this._root.appendChild(canvasWrap);

    this._canvas = document.createElement('canvas');
    this._canvas.style.cssText = 'max-width:100%;max-height:100%;image-rendering:auto;border:1px solid #ccc;box-shadow:0 2px 8px rgba(0,0,0,0.1)';
    canvasWrap.appendChild(this._canvas);
  }

  _render() {
    const elevation = this.layers.getGrid('elevation');
    if (!elevation) return;

    const params = this.layers.getData('params');
    const seaLevel = params?.seaLevel ?? 0;
    const railways = this.layers.getData('railways') || [];
    const settlements = this.layers.getData('settlements') || [];
    const offMapCities = this.layers.getData('offMapCities') || [];
    const railGrid = this.layers.hasGrid('railGrid') ? this.layers.getGrid('railGrid') : null;

    // Canvas size: 1 pixel per grid cell, scaled up for display
    const displayScale = 4;
    const w = elevation.width;
    const h = elevation.height;
    this._canvas.width = w * displayScale;
    this._canvas.height = h * displayScale;

    const ctx = this._canvas.getContext('2d');

    // Scale everything up
    ctx.save();
    ctx.scale(displayScale, displayScale);

    // Background terrain
    renderSchematicTerrain(ctx, elevation, seaLevel);

    // Railway lines (scale=1 since we're in grid coords after ctx.scale)
    renderSchematicLines(ctx, railways, 1);

    // Station dots
    renderSchematicStations(ctx, settlements, railGrid, 1);

    // Off-map city labels
    renderSchematicOffMapCities(ctx, offMapCities, 1, w, h);

    ctx.restore();
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._root && this._root.parentNode) {
      this._root.parentNode.removeChild(this._root);
    }
  }
}
