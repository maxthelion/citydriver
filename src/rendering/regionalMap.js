/**
 * 2D canvas-based regional overview map.
 * Renders terrain, rivers, roads, and settlements on a canvas.
 * Shown to the player before they zoom into a city.
 */
import { distance2D } from '../core/math.js';

/**
 * Map a terrain elevation to a color.
 * @param {number} h - Height value
 * @param {number} seaLevel - Sea level elevation
 * @returns {string} CSS color string
 */
function terrainColor(h, seaLevel) {
  if (h < seaLevel) {
    return '#2266aa';
  }

  const above = h - seaLevel;

  if (above < 20) {
    // Low land: dark green to light green
    const t = above / 20;
    const g = Math.floor(100 + t * 80);
    return `rgb(50, ${g}, 40)`;
  }

  if (above < 60) {
    // Mid land: green transitioning to brown
    const t = (above - 20) / 40;
    const r = Math.floor(50 + t * 110);
    const g = Math.floor(180 - t * 80);
    const b = Math.floor(40 + t * 20);
    return `rgb(${r}, ${g}, ${b})`;
  }

  if (above < 120) {
    // High land: brown to gray
    const t = (above - 60) / 60;
    const r = Math.floor(160 - t * 30);
    const g = Math.floor(100 + t * 30);
    const b = Math.floor(60 + t * 60);
    return `rgb(${r}, ${g}, ${b})`;
  }

  // Mountains: gray to white
  const t = Math.min(1, (above - 120) / 80);
  const v = Math.floor(130 + t * 125);
  return `rgb(${v}, ${v}, ${v})`;
}

/**
 * Render a regional overview map to a canvas.
 *
 * @param {HTMLCanvasElement} canvas - Target canvas element
 * @param {object} region - RegionData from generateRegion
 * @param {object} [options]
 * @param {object} [options.selectedSettlement] - Currently selected settlement
 * @param {object} [options.hoveredSettlement] - Currently hovered settlement
 */
export function renderRegionalMap(canvas, region, options = {}) {
  const { selectedSettlement, hoveredSettlement, showGeology } = options;
  const ctx = canvas.getContext('2d');
  const cw = canvas.width;
  const ch = canvas.height;

  const { heightmap, seaLevel, drainage, settlements, roads } = region;
  const worldW = heightmap.worldWidth;
  const worldH = heightmap.worldHeight;

  // Scale factor: canvas pixels per world unit
  const scaleX = cw / worldW;
  const scaleZ = ch / worldH;

  // Helper: world to canvas coordinates
  function toCanvas(worldX, worldZ) {
    return {
      cx: worldX * scaleX,
      cy: worldZ * scaleZ,
    };
  }

  // --- 1. Draw terrain as colored pixel grid ---
  // Sample at a resolution that fills the canvas without being too slow
  const step = Math.max(1, Math.floor(Math.min(worldW / cw, worldH / ch)));
  const pixelW = Math.max(1, Math.ceil(step * scaleX));
  const pixelH = Math.max(1, Math.ceil(step * scaleZ));

  for (let wz = 0; wz < worldH; wz += step) {
    for (let wx = 0; wx < worldW; wx += step) {
      const h = heightmap.sample(wx, wz);
      ctx.fillStyle = terrainColor(h, seaLevel);
      const { cx, cy } = toCanvas(wx, wz);
      ctx.fillRect(cx, cy, pixelW + 0.5, pixelH + 0.5);
    }
  }

  // --- 1b. Optional geology overlay ---
  if (showGeology && region.geology) {
    const { rockTypes, springLine } = region.geology;
    const W = heightmap.width;
    const H = heightmap.height;

    // Semi-transparent rock type coloring
    const ROCK_COLORS = [
      'rgba(180, 80, 80, 0.35)',   // IGNEOUS: reddish
      'rgba(200, 180, 120, 0.35)', // HARD_SED: tan
      'rgba(140, 160, 80, 0.35)',  // SOFT_SED: olive
      'rgba(230, 225, 210, 0.35)', // CHALK: off-white
      'rgba(140, 100, 60, 0.35)',  // ALLUVIAL: brown
    ];

    const geoCellW = cw / W;
    const geoCellH = ch / H;

    for (let gz = 0; gz < H; gz++) {
      for (let gx = 0; gx < W; gx++) {
        const idx = gz * W + gx;
        ctx.fillStyle = ROCK_COLORS[rockTypes[idx]];
        ctx.fillRect(gx * geoCellW, gz * geoCellH, geoCellW + 0.5, geoCellH + 0.5);
      }
    }

    // Spring-line cells as thin yellow lines
    ctx.fillStyle = 'rgba(220, 200, 50, 0.6)';
    for (let gz = 0; gz < H; gz++) {
      for (let gx = 0; gx < W; gx++) {
        const idx = gz * W + gx;
        if (springLine[idx]) {
          ctx.fillRect(gx * geoCellW, gz * geoCellH, geoCellW + 0.5, geoCellH + 0.5);
        }
      }
    }
  }

  // --- 2. Draw rivers ---
  if (drainage && drainage.accumulation) {
    const { accumulation } = drainage;
    const W = heightmap.width;
    const H = heightmap.height;
    const cellSize = heightmap.cellSize;

    const streamThreshold = (region.params && region.params.streamThreshold) || 100;
    const riverThreshold = (region.params && region.params.riverThreshold) || 1000;
    const majorRiverThreshold = (region.params && region.params.majorRiverThreshold) || 5000;

    ctx.lineCap = 'round';

    for (let gz = 0; gz < H; gz++) {
      for (let gx = 0; gx < W; gx++) {
        const acc = accumulation[gz * W + gx];
        // Only draw rivers and major rivers (skip minor streams for clarity)
        if (acc < riverThreshold) continue;

        // Skip cells below sea level (already rendered as ocean)
        const elev = heightmap.get(gx, gz);
        if (elev < seaLevel) continue;

        const worldPos = heightmap.gridToWorld(gx, gz);
        const { cx, cy } = toCanvas(worldPos.x, worldPos.z);

        let lineWidth;
        if (acc >= majorRiverThreshold) {
          lineWidth = 3;
        } else {
          lineWidth = 2;
        }

        ctx.fillStyle = '#3388cc';
        const r = lineWidth * 0.5;
        ctx.fillRect(cx - r, cy - r, lineWidth, lineWidth);
      }
    }
  }

  // --- 3. Draw roads ---
  if (roads && roads.length > 0) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const road of roads) {
      const path = road.worldPath;
      if (!path || path.length < 2) continue;

      ctx.strokeStyle = '#444444';
      switch (road.hierarchy) {
        case 'major':
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = '#333333';
          break;
        case 'secondary':
          ctx.lineWidth = 1.5;
          break;
        default:
          ctx.lineWidth = 1;
          ctx.strokeStyle = '#555555';
          break;
      }

      ctx.beginPath();
      const start = toCanvas(path[0].x, path[0].z);
      ctx.moveTo(start.cx, start.cy);
      for (let i = 1; i < path.length; i++) {
        const pt = toCanvas(path[i].x, path[i].z);
        ctx.lineTo(pt.cx, pt.cy);
      }
      ctx.stroke();
    }
  }

  // --- 4. Draw settlements ---
  if (settlements && settlements.length > 0) {
    for (const s of settlements) {
      const { cx, cy } = toCanvas(s.x, s.z);

      let radius, fillColor, strokeColor, strokeWidth, label;

      switch (s.rank) {
        case 'city':
          radius = 6;
          fillColor = '#dd3333';
          strokeColor = '#ffffff';
          strokeWidth = 2;
          label = s.name || s.economicRole;
          break;
        case 'town':
          radius = 4;
          fillColor = '#ee8833';
          strokeColor = null;
          strokeWidth = 0;
          label = null;
          break;
        case 'village':
        default:
          radius = 2.5;
          fillColor = '#ddcc33';
          strokeColor = null;
          strokeWidth = 0;
          label = null;
          break;
      }

      // Draw settlement dot
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fillStyle = fillColor;
      ctx.fill();

      if (strokeColor) {
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = strokeWidth;
        ctx.stroke();
      }

      // Draw label for cities
      if (label) {
        ctx.font = '11px monospace';
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 2;
        ctx.textAlign = 'center';
        ctx.strokeText(label, cx, cy - radius - 4);
        ctx.fillText(label, cx, cy - radius - 4);
      }
    }
  }

  // --- 5. Highlight selected/hovered settlement ---
  function drawHighlightRing(settlement, color, ringRadius) {
    if (!settlement) return;
    const { cx, cy } = toCanvas(settlement.x, settlement.z);

    ctx.beginPath();
    ctx.arc(cx, cy, ringRadius, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  if (hoveredSettlement && hoveredSettlement !== selectedSettlement) {
    drawHighlightRing(hoveredSettlement, '#ffff66', 12);
  }

  if (selectedSettlement) {
    drawHighlightRing(selectedSettlement, '#00ffff', 14);
  }
}

/**
 * Convert canvas click position to settlement selection.
 * Returns the closest settlement within a click radius, or null.
 *
 * @param {number} canvasX - Click x position on canvas
 * @param {number} canvasY - Click y position on canvas
 * @param {HTMLCanvasElement} canvas - The canvas element
 * @param {object} region - RegionData
 * @returns {object|null} Settlement or null
 */
export function pickSettlement(canvasX, canvasY, canvas, region) {
  const { heightmap, settlements } = region;
  if (!settlements || settlements.length === 0) return null;

  const worldW = heightmap.worldWidth;
  const worldH = heightmap.worldHeight;
  const scaleX = canvas.width / worldW;
  const scaleZ = canvas.height / worldH;

  // Click radius in canvas pixels (larger for smaller settlements)
  const maxClickDist = 15;

  let closest = null;
  let closestDist = Infinity;

  for (const s of settlements) {
    const cx = s.x * scaleX;
    const cy = s.z * scaleZ;
    const dist = Math.sqrt((canvasX - cx) * (canvasX - cx) + (canvasY - cy) * (canvasY - cy));

    if (dist < maxClickDist && dist < closestDist) {
      closestDist = dist;
      closest = s;
    }
  }

  return closest;
}
