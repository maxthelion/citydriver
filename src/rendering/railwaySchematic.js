// src/rendering/railwaySchematic.js
/**
 * 2D canvas rendering functions for railway schematic.
 * Draws terrain background, railway lines, settlements, and off-map city labels.
 */

import { chaikinSmooth } from '../core/math.js';

const HIERARCHY_STYLES = {
  trunk:  { color: '#cc2222', width: 1.5 },
  main:   { color: '#cc6622', width: 1 },
  branch: { color: '#888888', width: 0.5 },
};

/**
 * Render terrain background (muted, so lines stand out).
 * Uses a temporary canvas because putImageData ignores canvas transforms.
 */
export function renderSchematicTerrain(ctx, elevation, seaLevel) {
  const { width, height } = elevation;
  const { min, max } = elevation.bounds();
  const landRange = max - seaLevel || 1;

  // Render to temporary canvas at grid resolution
  const tmp = document.createElement('canvas');
  tmp.width = width;
  tmp.height = height;
  const tmpCtx = tmp.getContext('2d');
  const imageData = tmpCtx.createImageData(width, height);
  const data = imageData.data;

  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      const idx = (gz * width + gx) * 4;
      const h = elevation.get(gx, gz);

      if (h < seaLevel) {
        data[idx] = 200; data[idx + 1] = 210; data[idx + 2] = 220;
      } else {
        const t = Math.min(1, (h - seaLevel) / landRange);
        const v = 235 + t * 15;
        data[idx] = v - 10; data[idx + 1] = v; data[idx + 2] = v - 15;
      }
      data[idx + 3] = 255;
    }
  }
  tmpCtx.putImageData(imageData, 0, 0);

  // Draw scaled onto the main canvas (respects current transform)
  ctx.drawImage(tmp, 0, 0, width, height);
}

/**
 * Render railway lines with Chaikin smoothing.
 */
export function renderSchematicLines(ctx, railways, scale) {
  // Draw in order: branch first (behind), then main, then trunk (on top)
  const ordered = [...railways].sort((a, b) => {
    const order = { branch: 0, main: 1, trunk: 2 };
    return (order[a.hierarchy] ?? 0) - (order[b.hierarchy] ?? 0);
  });

  for (const rail of ordered) {
    // Use grid-coordinate path, not world-coordinate polyline
    const pathData = rail.path;
    if (!pathData || pathData.length < 2) continue;

    const style = HIERARCHY_STYLES[rail.hierarchy] || HIERARCHY_STYLES.branch;

    // Path is already simplified by generateRailways (RDP epsilon=8).
    // Chaikin-smooth for sweeping curves.
    let points = pathData.map(p => ({
      x: p.gx * scale,
      z: p.gz * scale,
    }));
    points = chaikinSmooth(points);

    // Draw line
    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].z);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].z);
    }
    ctx.stroke();
  }
}

/**
 * Render all settlements. Those near track get a filled station dot;
 * those not connected get a small hollow circle.
 */
export function renderSchematicStations(ctx, settlements, railGrid, scale, railways) {
  const NEAR_TRACK_RADIUS = 5; // cells — how close to count as "connected"

  for (const s of settlements) {
    if (s.tier > 3) continue;

    const x = s.gx * scale;
    const z = s.gz * scale;

    // Check if near track
    let connected = false;
    if (railGrid) {
      for (let dz = -NEAR_TRACK_RADIUS; dz <= NEAR_TRACK_RADIUS && !connected; dz++) {
        for (let dx = -NEAR_TRACK_RADIUS; dx <= NEAR_TRACK_RADIUS && !connected; dx++) {
          const nx = s.gx + dx, nz = s.gz + dz;
          if (nx >= 0 && nx < railGrid.width && nz >= 0 && nz < railGrid.height) {
            if (railGrid.get(nx, nz) > 0) connected = true;
          }
        }
      }
    }

    const r = s.tier === 1 ? 3 : s.tier === 2 ? 2 : 1.5;

    if (connected) {
      // Filled white dot with dark border — station
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#333333';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, z, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else {
      // Small hollow circle — unconnected settlement
      ctx.strokeStyle = '#999999';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.arc(x, z, r * 0.7, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

/**
 * Render off-map city labels at region edges.
 */
export function renderSchematicOffMapCities(ctx, offMapCities, scale, canvasWidth, canvasHeight) {
  for (const c of offMapCities) {
    const x = c.gx * scale;
    const z = c.gz * scale;

    ctx.fillStyle = c.role === 'capital' ? '#cc2222' : '#666666';
    ctx.beginPath();
    ctx.arc(x, z, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}
