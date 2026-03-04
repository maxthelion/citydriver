/**
 * In-game minimap overlay showing the local city area.
 * Uses a base canvas (drawn once per city) as a pre-rendered buffer,
 * and a dynamic canvas that composites a zoomed/panned view each frame.
 * Mouse scroll over the minimap zooms in/out, centered on the car.
 */

/** Minimap size in pixels. */
const MAP_SIZE = 500;

/** Region minimap size in pixels. */
const REGION_SIZE = 180;

/** Default city extent in world units (updated by drawBase from actual heightmap). */
const DEFAULT_CITY_EXTENT = 10000;

/**
 * Create and manage the in-game minimap.
 *
 * @returns {{
 *   canvas: HTMLCanvasElement,
 *   drawBase: (cityData: object) => void,
 *   update: (carX: number, carZ: number, carAngle: number, modes: Array) => void,
 *   destroy: () => void,
 * }}
 */
export function createMinimap() {
  // --- Outer wrapper (stacks region map above city map) ---
  const wrapper = document.createElement('div');
  Object.assign(wrapper.style, {
    position: 'fixed',
    bottom: '20px',
    right: '20px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: '6px',
    zIndex: '100',
    pointerEvents: 'none',
  });

  // --- Region minimap (static bitmap, shown above city map) ---
  const regionCanvas = document.createElement('canvas');
  regionCanvas.width = REGION_SIZE;
  regionCanvas.height = REGION_SIZE;
  regionCanvas.dataset.ui = 'region-minimap';
  Object.assign(regionCanvas.style, {
    width: `${REGION_SIZE}px`,
    height: `${REGION_SIZE}px`,
    borderRadius: '4px',
    border: '2px solid rgba(255, 255, 255, 0.3)',
    display: 'none', // hidden until setRegionMap is called
  });
  wrapper.appendChild(regionCanvas);

  // --- City minimap container ---
  const container = document.createElement('div');
  container.dataset.ui = 'minimap';
  Object.assign(container.style, {
    width: `${MAP_SIZE}px`,
    height: `${MAP_SIZE}px`,
    borderRadius: '4px',
    border: '2px solid rgba(255, 255, 255, 0.3)',
    overflow: 'hidden',
    position: 'relative',
    pointerEvents: 'auto',
  });

  // --- Base canvas (offscreen buffer: terrain, roads, buildings, water) ---
  const baseCanvas = document.createElement('canvas');
  baseCanvas.width = MAP_SIZE;
  baseCanvas.height = MAP_SIZE;
  // Not appended to DOM — used only as a render buffer

  // --- Dynamic canvas (visible: zoomed base + car + mode overlays) ---
  const dynCanvas = document.createElement('canvas');
  dynCanvas.width = MAP_SIZE;
  dynCanvas.height = MAP_SIZE;
  Object.assign(dynCanvas.style, {
    position: 'absolute',
    top: '0',
    left: '0',
    width: '100%',
    height: '100%',
  });
  container.appendChild(dynCanvas);

  wrapper.appendChild(container);
  document.body.appendChild(wrapper);

  // Track city extent for coordinate conversion
  let cityWorldW = DEFAULT_CITY_EXTENT;
  let cityWorldH = DEFAULT_CITY_EXTENT;

  // Zoom state: 1 = full city view, higher = zoomed in
  let zoom = 1;
  const MIN_ZOOM = 1;
  const MAX_ZOOM = 20;

  // Scroll to zoom
  container.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.85 : 1.18;
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * factor));
  }, { passive: false });

  /**
   * Convert world coordinates to base-canvas pixel coordinates (unzoomed).
   */
  function worldToBase(worldX, worldZ) {
    return {
      bx: (worldX / cityWorldW) * MAP_SIZE,
      by: (worldZ / cityWorldH) * MAP_SIZE,
    };
  }

  /**
   * Convert world coordinates to zoomed minimap canvas coordinates.
   * Accounts for current zoom level and view center.
   */
  let _viewCX = 0, _viewCZ = 0; // set each frame in update()
  function toMinimap(worldX, worldZ) {
    const visW = cityWorldW / zoom;
    const visH = cityWorldH / zoom;
    const left = _viewCX - visW / 2;
    const top = _viewCZ - visH / 2;
    return {
      mx: ((worldX - left) / visW) * MAP_SIZE,
      my: ((worldZ - top) / visH) * MAP_SIZE,
    };
  }

  /**
   * Map elevation to a terrain tint color for the minimap.
   */
  function terrainTint(h, seaLevel) {
    if (h < seaLevel) {
      const depth = Math.min(1, Math.max(0, (seaLevel - h) / 20));
      const r = Math.floor(25 * (1 - depth * 0.5));
      const g = Math.floor(80 * (1 - depth * 0.3));
      const b = Math.floor(150 + depth * 80);
      return `rgb(${r}, ${g}, ${b})`;
    }
    const above = h - seaLevel;
    if (above < 15) {
      const t = above / 15;
      const g = Math.floor(90 + t * 60);
      return `rgb(50, ${g}, 40)`;
    }
    if (above < 50) {
      const t = (above - 15) / 35;
      const g = Math.floor(150 - t * 50);
      return `rgb(${Math.floor(60 + t * 60)}, ${g}, 50)`;
    }
    const t = Math.min(1, (above - 50) / 60);
    const v = Math.floor(120 + t * 80);
    return `rgb(${v}, ${v - 10}, ${v - 20})`;
  }

  return {
    canvas: dynCanvas,

    /**
     * Draw the static base layer (terrain, roads, buildings, water).
     * Call once per city generation. Renders to an offscreen buffer.
     * @param {object} cityData - CityData from generateCity
     */
    drawBase(cityData) {
      const ctx = baseCanvas.getContext('2d');
      ctx.clearRect(0, 0, MAP_SIZE, MAP_SIZE);

      const { heightmap, seaLevel, network, buildings, rivers } = cityData;
      cityWorldW = heightmap.worldWidth;
      cityWorldH = heightmap.worldHeight;

      // --- Elevation-tinted background ---
      const step = Math.max(1, Math.floor(Math.min(cityWorldW, cityWorldH) / MAP_SIZE));
      const pixelSize = Math.max(1, Math.ceil(step / cityWorldW * MAP_SIZE));

      for (let wz = 0; wz < cityWorldH; wz += step) {
        for (let wx = 0; wx < cityWorldW; wx += step) {
          const h = heightmap.sample(wx, wz);
          ctx.fillStyle = terrainTint(h, seaLevel);
          const { bx, by } = worldToBase(wx, wz);
          ctx.fillRect(bx, by, pixelSize + 0.5, pixelSize + 0.5);
        }
      }

      // --- Rivers (blue lines) ---
      if (rivers && rivers.length > 0) {
        ctx.strokeStyle = '#3388cc';
        ctx.lineCap = 'round';
        for (const river of rivers) {
          if (!river.cells || river.cells.length < 2) continue;
          ctx.lineWidth = river.rank === 'majorRiver' ? 3 : 2;
          ctx.beginPath();
          for (let i = 0; i < river.cells.length; i++) {
            const cell = river.cells[i];
            const worldPos = heightmap.gridToWorld(cell.gx, cell.gz);
            const { bx, by } = worldToBase(worldPos.x, worldPos.z);
            if (i === 0) ctx.moveTo(bx, by);
            else ctx.lineTo(bx, by);
          }
          ctx.stroke();
        }
      }

      // --- Roads ---
      if (network && network.edges) {
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        for (const edge of network.edges) {
          if (!edge.points || edge.points.length < 2) continue;

          const hierarchy = edge.hierarchy || 'secondary';
          ctx.strokeStyle = '#333333';
          ctx.lineWidth = hierarchy === 'primary' ? 2 : 1;

          ctx.beginPath();
          const p0 = worldToBase(edge.points[0].x, edge.points[0].z);
          ctx.moveTo(p0.bx, p0.by);
          for (let i = 1; i < edge.points.length; i++) {
            const pt = worldToBase(edge.points[i].x, edge.points[i].z);
            ctx.lineTo(pt.bx, pt.by);
          }
          ctx.stroke();
        }
      }

      // --- Parks (green patches) ---
      if (network && network.blocks) {
        const parkBlocks = network.blocks.filter(b => b.landUse === 'park');
        ctx.fillStyle = 'rgba(50, 160, 50, 0.6)';
        for (const block of parkBlocks) {
          if (!block.polygon || block.polygon.length < 3) continue;
          ctx.beginPath();
          const first = worldToBase(block.polygon[0].x, block.polygon[0].z);
          ctx.moveTo(first.bx, first.by);
          for (let i = 1; i < block.polygon.length; i++) {
            const pt = worldToBase(block.polygon[i].x, block.polygon[i].z);
            ctx.lineTo(pt.bx, pt.by);
          }
          ctx.closePath();
          ctx.fill();
        }
      }

      // --- Buildings (bright dots sized by height) ---
      if (buildings && buildings.length > 0) {
        ctx.fillStyle = '#ccccaa';
        for (const b of buildings) {
          const { bx, by } = worldToBase(b.x, b.z);
          const r = Math.max(0.5, Math.min(2.5, (b.h || 5) / 10));
          ctx.fillRect(bx - r, by - r, r * 2, r * 2);
        }
      }
    },

    /**
     * Update the dynamic layer (zoomed base + car position).
     * Call every frame.
     */
    update(carX, carZ, carAngle) {
      const ctx = dynCanvas.getContext('2d');
      ctx.clearRect(0, 0, MAP_SIZE, MAP_SIZE);

      // View centered on car, clamped so we don't go outside the map
      const visW = cityWorldW / zoom;
      const visH = cityWorldH / zoom;
      _viewCX = Math.max(visW / 2, Math.min(cityWorldW - visW / 2, carX));
      _viewCZ = Math.max(visH / 2, Math.min(cityWorldH - visH / 2, carZ));

      // Draw zoomed portion of base canvas
      const srcX = ((_viewCX - visW / 2) / cityWorldW) * MAP_SIZE;
      const srcY = ((_viewCZ - visH / 2) / cityWorldH) * MAP_SIZE;
      const srcW = (visW / cityWorldW) * MAP_SIZE;
      const srcH = (visH / cityWorldH) * MAP_SIZE;

      ctx.imageSmoothingEnabled = zoom < 4;
      ctx.drawImage(baseCanvas, srcX, srcY, srcW, srcH, 0, 0, MAP_SIZE, MAP_SIZE);

      // --- Car arrow ---
      const { mx, my } = toMinimap(carX, carZ);

      ctx.save();
      ctx.translate(mx, my);
      ctx.rotate(carAngle + Math.PI);

      ctx.fillStyle = '#ff2222';
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, -6);
      ctx.lineTo(-4, 4);
      ctx.lineTo(0, 1);
      ctx.lineTo(4, 4);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    },

    /**
     * Display a pre-rendered region map bitmap above the city minimap.
     * @param {HTMLCanvasElement} sourceCanvas - rendered regional map canvas
     */
    setRegionMap(sourceCanvas) {
      const ctx = regionCanvas.getContext('2d');
      ctx.clearRect(0, 0, REGION_SIZE, REGION_SIZE);
      ctx.drawImage(sourceCanvas, 0, 0, sourceCanvas.width, sourceCanvas.height,
                    0, 0, REGION_SIZE, REGION_SIZE);
      regionCanvas.style.display = 'block';
    },

    /**
     * Remove the minimap from the DOM.
     */
    destroy() {
      if (wrapper.parentNode) {
        wrapper.parentNode.removeChild(wrapper);
      }
    },
  };
}
