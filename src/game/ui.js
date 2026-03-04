import { renderRegionalMap, pickSettlement } from '../rendering/regionalMap.js';
import { generateRegion } from '../regional/region.js';
import { createRegionPreview3D } from '../rendering/regionPreview3D.js';

/**
 * Create the region selection modal shown at startup.
 * Side-by-side layout: 3D terrain preview (left) + 2D map (right).
 * Two buttons: Regenerate and Enter City.
 *
 * @returns {{
 *   show: () => void,
 *   hide: () => void,
 *   onEnterCity: (callback: (region, settlement) => void) => void,
 *   destroy: () => void,
 * }}
 */
export function createRegionModal() {
  let region = null;
  let selectedSettlement = null;
  let hoveredSettlement = null;
  let enterCityCallback = null;
  let preview3D = null;

  // --- Overlay ---
  const overlay = document.createElement('div');
  overlay.dataset.ui = 'region-modal';
  Object.assign(overlay.style, {
    position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.85)', zIndex: '300',
    fontFamily: 'monospace', color: 'white',
  });
  document.body.appendChild(overlay);

  // --- Modal container (near-fullscreen) ---
  const modal = document.createElement('div');
  Object.assign(modal.style, {
    display: 'flex', flexDirection: 'column', gap: '12px',
    width: '95vw', maxWidth: '1400px', height: '90vh', maxHeight: '900px',
  });
  overlay.appendChild(modal);

  // --- Title ---
  const title = document.createElement('h1');
  title.textContent = 'Open World Driving';
  Object.assign(title.style, {
    margin: '0', fontSize: '24px', textAlign: 'center', fontWeight: 'normal',
    color: 'rgba(255,255,255,0.9)', flexShrink: '0',
  });
  modal.appendChild(title);

  // --- Main row: 3D preview + 2D map ---
  const row = document.createElement('div');
  Object.assign(row.style, {
    display: 'flex', gap: '12px', flex: '1', minHeight: '0',
  });
  modal.appendChild(row);

  // --- Left panel: 3D preview ---
  const previewWrap = document.createElement('div');
  Object.assign(previewWrap.style, {
    flex: '1', minWidth: '0', borderRadius: '4px', overflow: 'hidden',
    background: '#111', position: 'relative',
  });
  row.appendChild(previewWrap);

  // --- Right panel: 2D map canvas ---
  const mapWrap = document.createElement('div');
  Object.assign(mapWrap.style, {
    flex: '1', minWidth: '0', display: 'flex', alignItems: 'center', justifyContent: 'center',
  });
  row.appendChild(mapWrap);

  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 600;
  Object.assign(canvas.style, {
    maxWidth: '100%', maxHeight: '100%', aspectRatio: '1',
    borderRadius: '4px', cursor: 'crosshair', background: '#111',
  });
  mapWrap.appendChild(canvas);

  // --- Bottom bar: info + Regenerate + Enter City ---
  const bottomBar = document.createElement('div');
  Object.assign(bottomBar.style, {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '16px',
    flexShrink: '0',
  });
  modal.appendChild(bottomBar);

  const infoText = document.createElement('div');
  infoText.textContent = 'Generating region...';
  Object.assign(infoText.style, {
    fontSize: '14px', color: 'rgba(255,255,255,0.6)', flex: '1',
  });
  bottomBar.appendChild(infoText);

  // Regenerate button
  const regenBtn = document.createElement('button');
  regenBtn.textContent = 'Regenerate';
  Object.assign(regenBtn.style, {
    padding: '12px 24px', background: '#2266aa', color: 'white', border: 'none',
    borderRadius: '4px', fontFamily: 'monospace', fontSize: '15px', cursor: 'pointer',
  });
  regenBtn.addEventListener('mouseenter', () => { regenBtn.style.background = '#3388cc'; });
  regenBtn.addEventListener('mouseleave', () => { regenBtn.style.background = '#2266aa'; });
  bottomBar.appendChild(regenBtn);

  // Enter City button
  const enterBtn = document.createElement('button');
  enterBtn.textContent = 'Enter City';
  enterBtn.disabled = true;
  Object.assign(enterBtn.style, {
    padding: '12px 32px', background: '#44aa44', color: 'white', border: 'none',
    borderRadius: '4px', fontFamily: 'monospace', fontSize: '15px', cursor: 'pointer',
    opacity: '0.4', transition: 'opacity 0.2s',
  });
  enterBtn.addEventListener('mouseenter', () => { if (!enterBtn.disabled) enterBtn.style.background = '#55cc55'; });
  enterBtn.addEventListener('mouseleave', () => { enterBtn.style.background = '#44aa44'; });
  bottomBar.appendChild(enterBtn);

  // --- 3D Preview setup ---
  preview3D = createRegionPreview3D(previewWrap);

  // --- Interaction logic ---

  function redrawMap() {
    if (!region) return;
    renderRegionalMap(canvas, region, { selectedSettlement, hoveredSettlement });
  }

  function updateSelection(settlement) {
    selectedSettlement = settlement;
    if (settlement) {
      const role = settlement.economicRole || 'settlement';
      const rank = settlement.rank;
      infoText.textContent = `${rank.charAt(0).toUpperCase() + rank.slice(1)}: ${role.replace(/_/g, ' ')}`;
      enterBtn.disabled = false;
      enterBtn.style.opacity = '1';
    } else {
      infoText.textContent = 'Click a settlement on the map';
      enterBtn.disabled = true;
      enterBtn.style.opacity = '0.4';
    }
    redrawMap();
    if (preview3D) preview3D.highlight(settlement);
  }

  // Map hover
  canvas.addEventListener('mousemove', (e) => {
    if (!region) return;
    const rect = canvas.getBoundingClientRect();
    const scaleFactorX = canvas.width / rect.width;
    const scaleFactorY = canvas.height / rect.height;
    const cx = (e.clientX - rect.left) * scaleFactorX;
    const cy = (e.clientY - rect.top) * scaleFactorY;
    const hit = pickSettlement(cx, cy, canvas, region);
    if (hit !== hoveredSettlement) {
      hoveredSettlement = hit;
      canvas.style.cursor = hit ? 'pointer' : 'crosshair';
      redrawMap();
    }
  });

  // Map click
  canvas.addEventListener('click', (e) => {
    if (!region) return;
    const rect = canvas.getBoundingClientRect();
    const scaleFactorX = canvas.width / rect.width;
    const scaleFactorY = canvas.height / rect.height;
    const cx = (e.clientX - rect.left) * scaleFactorX;
    const cy = (e.clientY - rect.top) * scaleFactorY;
    const hit = pickSettlement(cx, cy, canvas, region);
    if (hit) updateSelection(hit);
  });

  function doGenerate() {
    regenBtn.disabled = true;
    regenBtn.textContent = 'Generating...';
    selectedSettlement = null;
    hoveredSettlement = null;
    updateSelection(null);
    infoText.textContent = 'Generating region...';

    // Defer to let UI update
    setTimeout(() => {
      const seed = Math.floor(Math.random() * 100000);
      region = generateRegion({
        seed,
        gridSize: 256,
        cellSize: 200,
        mountainousness: 0.5,
        roughness: 0.5,
        coastEdges: ['south'],
      });

      redrawMap();
      if (preview3D) preview3D.update(region);

      // Auto-select the top city
      const cities = region.settlements.filter(s => s.rank === 'city');
      if (cities.length > 0) {
        updateSelection(cities[0]);
      } else {
        infoText.textContent = `${region.settlements.length} settlements — click one on the map`;
      }

      regenBtn.disabled = false;
      regenBtn.textContent = 'Regenerate';
    }, 30);
  }

  // Regenerate button
  regenBtn.addEventListener('click', doGenerate);

  // Enter button
  enterBtn.addEventListener('click', () => {
    if (!region || !selectedSettlement) return;
    if (enterCityCallback) enterCityCallback(region, selectedSettlement);
  });

  // --- Auto-generate on first show ---
  let hasGenerated = false;

  return {
    show() {
      overlay.style.display = 'flex';
      if (!hasGenerated) {
        hasGenerated = true;
        doGenerate();
      }
    },
    hide() {
      overlay.style.display = 'none';
    },
    onEnterCity(callback) {
      enterCityCallback = callback;
    },
    dispose3D() {
      if (preview3D) {
        preview3D.dispose();
        preview3D = null;
      }
    },
    destroy() {
      if (preview3D) preview3D.dispose();
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    },
  };
}

/**
 * Create all HUD elements and append to document.body.
 * Uses plain DOM manipulation. All elements have data-* attributes for testing.
 *
 * @returns {{
 *   updateSpeed: (mph: number) => void,
 *   showLoading: () => void,
 *   hideLoading: () => void,
 *   onRegenerate: (callback: function) => void,
 *   destroy: () => void,
 * }}
 */
export function createUI() {
  // --- Speedometer (bottom-left) ---
  const speedEl = document.createElement('div');
  speedEl.dataset.ui = 'speedometer';
  Object.assign(speedEl.style, {
    position: 'fixed',
    bottom: '20px',
    left: '20px',
    color: 'white',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    padding: '20px',
    fontSize: '24px',
    fontFamily: 'monospace',
    zIndex: '100',
    borderRadius: '4px',
    minWidth: '120px',
    textAlign: 'center',
  });
  speedEl.textContent = '0 MPH';
  document.body.appendChild(speedEl);

  // --- Controls help (top-right) ---
  const controlsEl = document.createElement('div');
  controlsEl.dataset.ui = 'controls';
  Object.assign(controlsEl.style, {
    position: 'fixed',
    top: '10px',
    right: '10px',
    color: 'rgba(255, 255, 255, 0.7)',
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    padding: '10px 14px',
    fontSize: '12px',
    fontFamily: 'monospace',
    lineHeight: '1.6',
    textAlign: 'right',
    zIndex: '100',
    borderRadius: '4px',
  });
  controlsEl.innerHTML = [
    'WASD / Arrows &mdash; Drive',
    'Space &mdash; Handbrake',
    'C &mdash; Camera (free cam = fly mode)',
  ].join('<br>');
  document.body.appendChild(controlsEl);

  // --- Regenerate button (top-left) ---
  const regenBtn = document.createElement('button');
  regenBtn.dataset.ui = 'regenerate';
  regenBtn.textContent = 'New City';
  Object.assign(regenBtn.style, {
    position: 'fixed',
    top: '10px',
    left: '10px',
    padding: '8px 16px',
    background: 'rgba(255, 255, 255, 0.15)',
    color: 'white',
    border: '1px solid rgba(255, 255, 255, 0.3)',
    fontFamily: 'monospace',
    fontSize: '14px',
    cursor: 'pointer',
    borderRadius: '4px',
    zIndex: '100',
  });
  regenBtn.addEventListener('mouseenter', () => {
    regenBtn.style.background = 'rgba(255, 255, 255, 0.25)';
  });
  regenBtn.addEventListener('mouseleave', () => {
    regenBtn.style.background = 'rgba(255, 255, 255, 0.15)';
  });
  document.body.appendChild(regenBtn);

  // --- Loading overlay ---
  const loadingEl = document.createElement('div');
  loadingEl.dataset.ui = 'loading';
  Object.assign(loadingEl.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '100%',
    height: '100%',
    display: 'none',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'white',
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    fontSize: '24px',
    fontFamily: 'monospace',
    zIndex: '200',
  });
  const loadingText = document.createElement('div');
  loadingText.textContent = 'Generating...';
  loadingEl.appendChild(loadingText);

  const loadingDetail = document.createElement('div');
  Object.assign(loadingDetail.style, {
    fontSize: '14px',
    color: 'rgba(255, 255, 255, 0.5)',
    marginTop: '8px',
    whiteSpace: 'pre-line',
    lineHeight: '1.5',
  });
  loadingEl.appendChild(loadingDetail);

  document.body.appendChild(loadingEl);

  // Collect all elements for cleanup
  const elements = [speedEl, controlsEl, regenBtn, loadingEl];

  return {
    /**
     * Update the speedometer display.
     * @param {number} mph
     */
    updateSpeed(mph) {
      speedEl.textContent = `${Math.round(mph)} MPH`;
    },

    /**
     * Show the loading overlay.
     */
    showLoading() {
      loadingText.textContent = 'Generating...';
      loadingDetail.textContent = '';
      loadingEl.style.display = 'flex';
    },

    /**
     * Hide the loading overlay.
     */
    hideLoading() {
      loadingEl.style.display = 'none';
    },

    /**
     * Update the loading overlay text.
     * @param {string} main - main status text
     * @param {string} [detail] - detail text (smaller, below main)
     */
    setLoadingText(main, detail) {
      loadingText.textContent = main;
      loadingDetail.textContent = detail || '';
    },

    /**
     * Register a callback for the regenerate button.
     * @param {function} callback
     */
    onRegenerate(callback) {
      regenBtn.addEventListener('click', callback);
    },

    /**
     * Remove all UI elements from the DOM.
     */
    destroy() {
      for (const el of elements) {
        if (el.parentNode) {
          el.parentNode.removeChild(el);
        }
      }
    },
  };
}
