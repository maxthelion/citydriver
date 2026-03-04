/**
 * 2D canvas renderer for regional maps.
 * Renders elevation as colored pixels to a canvas element.
 */

/**
 * Render a LayerStack to a 2D canvas.
 *
 * @param {import('../core/LayerStack.js').LayerStack} layers
 * @param {HTMLCanvasElement} canvas
 * @param {object} [options]
 * @param {string} [options.mode='elevation'] - Rendering mode
 */
export function renderMap(layers, canvas, options = {}) {
  const { mode = 'elevation' } = options;
  const params = layers.getData('params');
  const seaLevel = params?.seaLevel ?? 0;

  const elevation = layers.getGrid('elevation');
  if (!elevation) return;

  canvas.width = elevation.width;
  canvas.height = elevation.height;
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(elevation.width, elevation.height);
  const data = imageData.data;

  const { min, max } = elevation.bounds();

  for (let gz = 0; gz < elevation.height; gz++) {
    for (let gx = 0; gx < elevation.width; gx++) {
      const idx = (gz * elevation.width + gx) * 4;
      const h = elevation.get(gx, gz);

      if (mode === 'elevation') {
        if (h < seaLevel) {
          // Water: blue
          const depth = Math.min(1, (seaLevel - h) / 30);
          data[idx] = Math.floor(30 - depth * 20);
          data[idx + 1] = Math.floor(80 - depth * 40);
          data[idx + 2] = Math.floor(150 + depth * 50);
        } else {
          // Land: green to brown to white
          const t = (h - seaLevel) / (max - seaLevel + 0.01);
          if (t < 0.3) {
            // Lowlands: green
            data[idx] = Math.floor(60 + t * 100);
            data[idx + 1] = Math.floor(120 + t * 80);
            data[idx + 2] = Math.floor(40 + t * 30);
          } else if (t < 0.7) {
            // Hills: brown/tan
            const u = (t - 0.3) / 0.4;
            data[idx] = Math.floor(100 + u * 60);
            data[idx + 1] = Math.floor(140 - u * 40);
            data[idx + 2] = Math.floor(50 + u * 20);
          } else {
            // Highlands: grey to white
            const u = (t - 0.7) / 0.3;
            data[idx] = Math.floor(160 + u * 80);
            data[idx + 1] = Math.floor(160 + u * 80);
            data[idx + 2] = Math.floor(160 + u * 80);
          }
        }
      }

      data[idx + 3] = 255; // alpha
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

/**
 * Draw settlement markers on the map.
 */
export function drawSettlements(layers, ctx) {
  const settlements = layers.getData('settlements');
  if (!settlements) return;

  const elevation = layers.getGrid('elevation');
  if (!elevation) return;

  for (const s of settlements) {
    const gx = s.gx ?? Math.round(s.x / elevation.cellSize);
    const gz = s.gz ?? Math.round(s.z / elevation.cellSize);

    ctx.fillStyle = s.tier === 1 ? '#ff0000' : s.tier === 2 ? '#ff8800' : '#ffff00';
    const size = s.tier === 1 ? 4 : s.tier === 2 ? 3 : 2;
    ctx.fillRect(gx - size / 2, gz - size / 2, size, size);
  }
}

/**
 * Draw road lines on the map.
 */
export function drawRoads(layers, ctx) {
  const roads = layers.getData('roads');
  if (!roads) return;

  const elevation = layers.getGrid('elevation');
  if (!elevation) return;

  ctx.strokeStyle = '#8b7355';
  ctx.lineWidth = 1;

  for (const road of roads) {
    if (!road.path || road.path.length < 2) continue;
    ctx.beginPath();
    for (let i = 0; i < road.path.length; i++) {
      const p = road.path[i];
      const gx = p.gx ?? Math.round(p.x / elevation.cellSize);
      const gz = p.gz ?? Math.round(p.z / elevation.cellSize);
      if (i === 0) ctx.moveTo(gx, gz);
      else ctx.lineTo(gx, gz);
    }
    ctx.stroke();
  }
}

/**
 * Draw river lines on the map.
 */
export function drawRivers(layers, ctx) {
  const rivers = layers.getData('rivers');
  if (!rivers) return;

  function drawSegment(seg) {
    if (!seg.cells || seg.cells.length < 2) return;

    ctx.strokeStyle = '#3355aa';
    ctx.lineWidth = seg.rank === 'majorRiver' ? 3 : seg.rank === 'river' ? 2 : 1;

    ctx.beginPath();
    ctx.moveTo(seg.cells[0].gx, seg.cells[0].gz);
    for (let i = 1; i < seg.cells.length; i++) {
      ctx.lineTo(seg.cells[i].gx, seg.cells[i].gz);
    }
    ctx.stroke();

    for (const child of (seg.children || [])) {
      drawSegment(child);
    }
  }

  for (const root of rivers) {
    drawSegment(root);
  }
}
