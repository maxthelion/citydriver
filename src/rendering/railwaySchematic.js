// src/rendering/railwaySchematic.js
/**
 * 2D canvas rendering functions for railway schematic.
 * Draws terrain background, railway lines, settlements, and off-map city labels.
 */

import { chaikinSmooth } from '../core/math.js';

const HIERARCHY_STYLES = {
  trunk:  { color: '#cc2222', width: 4 },
  main:   { color: '#cc6622', width: 3 },
  branch: { color: '#888888', width: 2 },
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

    // Smooth the path (path is in grid coords {gx, gz})
    let points = pathData.map(p => ({
      x: p.gx * scale,
      z: p.gz * scale,
    }));
    points = chaikinSmooth(points);
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
 * Render settlement dots at station locations.
 */
export function renderSchematicStations(ctx, settlements, railGrid, scale) {
  for (const s of settlements) {
    if (s.tier > 3) continue;
    const onRail = railGrid && railGrid.get(s.gx, s.gz) > 0;

    let nearRail = onRail;
    if (!nearRail && railGrid) {
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]]) {
        const nx = s.gx + dx, nz = s.gz + dz;
        if (nx >= 0 && nx < railGrid.width && nz >= 0 && nz < railGrid.height) {
          if (railGrid.get(nx, nz) > 0) { nearRail = true; break; }
        }
      }
    }

    if (!nearRail) continue;

    const x = s.gx * scale;
    const z = s.gz * scale;
    const r = s.tier === 1 ? 5 : s.tier === 2 ? 4 : 3;

    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#333333';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, z, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

/**
 * Render off-map city labels at region edges.
 */
export function renderSchematicOffMapCities(ctx, offMapCities, scale, canvasWidth, canvasHeight) {
  ctx.font = '11px monospace';
  ctx.textBaseline = 'middle';

  for (const c of offMapCities) {
    const x = c.gx * scale;
    const z = c.gz * scale;

    ctx.fillStyle = c.role === 'capital' ? '#cc2222' : '#666666';
    ctx.beginPath();
    ctx.arc(x, z, 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#444444';
    const label = c.role === 'capital' ? `${c.name} (Capital)` : c.name;

    if (c.edge === 'north') {
      ctx.textAlign = 'center';
      ctx.fillText(label, x, z + 10);
    } else if (c.edge === 'south') {
      ctx.textAlign = 'center';
      ctx.fillText(label, x, z - 10);
    } else if (c.edge === 'west') {
      ctx.textAlign = 'left';
      ctx.fillText(label, x + 8, z);
    } else {
      ctx.textAlign = 'right';
      ctx.fillText(label, x - 8, z);
    }
  }
}
