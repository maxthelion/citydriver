/**
 * Simple loading overlay shown during city generation.
 */
export class LoadingOverlay {
  constructor(container) {
    this._root = document.createElement('div');
    this._root.style.cssText =
      'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(0,0,0,0.85);z-index:200;';

    this._label = document.createElement('div');
    this._label.style.cssText = 'color:#eee;font-family:monospace;font-size:16px;margin-bottom:16px';
    this._label.textContent = 'Generating city...';
    this._root.appendChild(this._label);

    // Progress bar
    const barOuter = document.createElement('div');
    barOuter.style.cssText = 'width:240px;height:6px;background:#333;border-radius:3px;overflow:hidden';
    this._barInner = document.createElement('div');
    this._barInner.style.cssText = 'width:0%;height:100%;background:#6af;border-radius:3px;transition:width 0.2s';
    barOuter.appendChild(this._barInner);
    this._root.appendChild(barOuter);

    container.appendChild(this._root);
  }

  setProgress(fraction, message) {
    this._barInner.style.width = `${Math.round(fraction * 100)}%`;
    if (message) this._label.textContent = message;
  }

  dispose() {
    this._root.remove();
  }
}
