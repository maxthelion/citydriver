/**
 * Schematic renderer: high-zoom plot-level view for debugging.
 * Renders a 500m x 500m area at 2px/m (1000x1000px) showing:
 *   - Road surfaces (grey, width-accurate)
 *   - Plot outlines (coloured by district)
 *   - Building footprints (dark fill)
 *   - Dimension labels on selected plots
 *   - Scale bar
 */

import {
  createBuffer, setPixel, blendPixel,
} from './debugTiles.js';

const PPM = 2; // pixels per metre
const VIEW_SIZE = 500; // metres
const IMG_SIZE = VIEW_SIZE * PPM; // 1000px

// Colours
const BG = [245, 242, 235];       // warm off-white
const ROAD_FILL = [180, 175, 168]; // asphalt grey
const ROAD_EDGE = [140, 135, 128]; // kerb line
const WATER = [160, 195, 220];
const GRASS = [200, 220, 180];

const PLOT_COLORS = {
  0: [220, 100, 100, 120],  // commercial — red
  1: [220, 160, 100, 120],  // dense residential — orange
  2: [220, 210, 140, 120],  // suburban — yellow
  3: [160, 120, 200, 120],  // industrial — purple
  4: [120, 200, 140, 120],  // parkland — green
};

const PLOT_STROKE = {
  0: [180, 60, 60],
  1: [180, 120, 60],
  2: [160, 150, 80],
  3: [120, 80, 160],
  4: [80, 160, 100],
};

const BUILDING_FILL = [80, 75, 70];
const BUILDING_STROKE = [50, 45, 40];
const LABEL_COLOR = [40, 35, 30];
const DIM_COLOR = [120, 50, 50];
const SCALE_COLOR = [60, 55, 50];

/**
 * Render a schematic view centred on (cx, cz) in world coords.
 *
 * @param {object} opts
 * @param {number} opts.cx - Centre X in world coordinates
 * @param {number} opts.cz - Centre Z in world coordinates
 * @param {import('../core/LayerStack.js').LayerStack} opts.cityLayers
 * @param {import('../core/PlanarGraph.js').PlanarGraph} opts.roadGraph
 * @param {Array} opts.plots
 * @param {Array} opts.buildings
 * @returns {{ data: Uint8Array, width: number, height: number }}
 */
export function renderSchematic({ cx, cz, cityLayers, roadGraph, plots, buildings }) {
  const buf = createBuffer(IMG_SIZE, IMG_SIZE);

  const params = cityLayers.getData('params');
  const cs = params.cellSize;
  const seaLevel = params.seaLevel ?? 0;
  const elevation = cityLayers.getGrid('elevation');
  const waterMask = cityLayers.getGrid('waterMask');

  // World-to-pixel transform
  const halfW = VIEW_SIZE / 2;
  const toPixX = (wx) => (wx - cx + halfW) * PPM;
  const toPixY = (wz) => (wz - cz + halfW) * PPM;
  const inView = (wx, wz) => Math.abs(wx - cx) < halfW && Math.abs(wz - cz) < halfW;

  // --- Background: solid fill, then water polygons ---
  for (let py = 0; py < IMG_SIZE; py++) {
    for (let px = 0; px < IMG_SIZE; px++) {
      setPixel(buf, px, py, BG[0], BG[1], BG[2]);
    }
  }

  // Draw smooth water polygons if available, fall back to grid
  const waterPolygons = cityLayers.getData('waterPolygons');
  if (waterPolygons && waterPolygons.length > 0) {
    for (const poly of waterPolygons) {
      fillPolygon(buf, poly, toPixX, toPixY, WATER, IMG_SIZE);
    }
  } else {
    // Fallback: blocky grid water
    for (let py = 0; py < IMG_SIZE; py++) {
      for (let px = 0; px < IMG_SIZE; px++) {
        const wx = cx - halfW + px / PPM;
        const wz = cz - halfW + py / PPM;
        const gx = Math.round(wx / cs);
        const gz = Math.round(wz / cs);
        if (gx >= 0 && gx < elevation.width && gz >= 0 && gz < elevation.height) {
          if ((waterMask && waterMask.get(gx, gz) > 0) || elevation.get(gx, gz) < seaLevel) {
            setPixel(buf, px, py, WATER[0], WATER[1], WATER[2]);
          }
        }
      }
    }
  }

  // --- Roads: filled ribbons ---
  for (const [edgeId, edge] of roadGraph.edges) {
    const polyline = roadGraph.edgePolyline(edgeId);
    if (polyline.length < 2) continue;

    const halfWidth = (edge.width || 9) / 2;

    for (let i = 0; i < polyline.length - 1; i++) {
      const p0 = polyline[i];
      const p1 = polyline[i + 1];

      // Skip if both endpoints out of view
      if (!inView(p0.x, p0.z) && !inView(p1.x, p1.z)) continue;

      const dx = p1.x - p0.x;
      const dz = p1.z - p0.z;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;
      const perpX = -dz / len;
      const perpZ = dx / len;

      // Draw filled road quad
      const quad = [
        { x: toPixX(p0.x + perpX * halfWidth), y: toPixY(p0.z + perpZ * halfWidth) },
        { x: toPixX(p1.x + perpX * halfWidth), y: toPixY(p1.z + perpZ * halfWidth) },
        { x: toPixX(p1.x - perpX * halfWidth), y: toPixY(p1.z - perpZ * halfWidth) },
        { x: toPixX(p0.x - perpX * halfWidth), y: toPixY(p0.z - perpZ * halfWidth) },
      ];
      fillPoly(buf, quad, ROAD_FILL[0], ROAD_FILL[1], ROAD_FILL[2]);

      // Kerb lines
      drawLineAA(buf,
        toPixX(p0.x + perpX * halfWidth), toPixY(p0.z + perpZ * halfWidth),
        toPixX(p1.x + perpX * halfWidth), toPixY(p1.z + perpZ * halfWidth),
        ROAD_EDGE[0], ROAD_EDGE[1], ROAD_EDGE[2]);
      drawLineAA(buf,
        toPixX(p0.x - perpX * halfWidth), toPixY(p0.z - perpZ * halfWidth),
        toPixX(p1.x - perpX * halfWidth), toPixY(p1.z - perpZ * halfWidth),
        ROAD_EDGE[0], ROAD_EDGE[1], ROAD_EDGE[2]);
    }
  }

  // --- Plots: filled + outlined ---
  let plotIndex = 0;
  for (const plot of plots) {
    if (!plot.vertices || plot.vertices.length < 3) continue;

    // Skip if centroid out of view
    const pc = plot.centroid;
    if (!pc || !inView(pc.x, pc.z)) continue;

    const d = plot.district ?? 2;
    const [pr, pg, pb, pa] = PLOT_COLORS[d] || PLOT_COLORS[2];
    const [sr, sg, sb] = PLOT_STROKE[d] || PLOT_STROKE[2];

    const pts = plot.vertices.map(v => ({ x: toPixX(v.x), y: toPixY(v.z) }));

    // Fill
    fillPoly(buf, pts, pr, pg, pb, pa);

    // Outline
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      drawLineAA(buf, a.x, a.y, b.x, b.y, sr, sg, sb);
    }

    // Dimension labels on every 8th plot
    if (plotIndex % 8 === 0 && plot.frontageWidth && plot.depth) {
      const fw = Math.round(plot.frontageWidth);
      const dp = Math.round(plot.depth);
      const labelX = Math.round(toPixX(pc.x));
      const labelY = Math.round(toPixY(pc.z));
      drawMiniText(buf, labelX - 10, labelY - 4, `${fw}x${dp}`, DIM_COLOR);
    }
    plotIndex++;
  }

  // --- Buildings: dark footprints ---
  if (buildings) {
    for (const b of buildings) {
      if (!b.footprint || b.footprint.length < 3) continue;
      if (!b.centroid || !inView(b.centroid.x, b.centroid.z)) continue;

      const pts = b.footprint.map(v => ({ x: toPixX(v.x), y: toPixY(v.z) }));
      fillPoly(buf, pts, BUILDING_FILL[0], BUILDING_FILL[1], BUILDING_FILL[2]);

      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const bn = pts[(i + 1) % pts.length];
        drawLineAA(buf, a.x, a.y, bn.x, bn.y, BUILDING_STROKE[0], BUILDING_STROKE[1], BUILDING_STROKE[2]);
      }
    }
  }

  // --- Road centre lines (dashed, on top) ---
  for (const [edgeId, edge] of roadGraph.edges) {
    const polyline = roadGraph.edgePolyline(edgeId);
    if (polyline.length < 2) continue;
    const hierarchy = edge.hierarchy || 'local';
    if (hierarchy !== 'arterial' && hierarchy !== 'collector' && hierarchy !== 'structural') continue;

    for (let i = 0; i < polyline.length - 1; i++) {
      const p0 = polyline[i];
      const p1 = polyline[i + 1];
      if (!inView(p0.x, p0.z) && !inView(p1.x, p1.z)) continue;
      drawDashedLine(buf,
        toPixX(p0.x), toPixY(p0.z),
        toPixX(p1.x), toPixY(p1.z),
        255, 255, 255, 6, 4);
    }
  }

  // --- Scale bar ---
  drawScaleBar(buf);

  // --- Title ---
  drawMiniText(buf, 4, 4, `SCHEMATIC ${Math.round(cx)},${Math.round(cz)}  ${VIEW_SIZE}m`, LABEL_COLOR);

  return buf;
}

// --- Drawing helpers ---

/** Fill a world-coordinate polygon onto the buffer using scanline fill. */
function fillPolygon(buf, worldPoly, toPixX, toPixY, color, imgSize) {
  const pixPts = [];
  for (const p of worldPoly) {
    const px = toPixX(p.x);
    const py = toPixY(p.z);
    // Skip points way outside viewport
    if (px < -imgSize || px > imgSize * 2 || py < -imgSize || py > imgSize * 2) continue;
    pixPts.push({ x: px, y: py });
  }
  if (pixPts.length < 3) return;
  fillPoly(buf, pixPts, color[0], color[1], color[2]);
}

function fillPoly(buf, pts, r, g, b, a = 255) {
  if (!pts || pts.length < 3) return;
  let minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  minY = Math.max(0, Math.floor(minY));
  maxY = Math.min(buf.height - 1, Math.ceil(maxY));

  for (let y = minY; y <= maxY; y++) {
    const intersections = [];
    for (let i = 0; i < pts.length; i++) {
      const a1 = pts[i], b1 = pts[(i + 1) % pts.length];
      if ((a1.y <= y && b1.y > y) || (b1.y <= y && a1.y > y)) {
        const t = (y - a1.y) / (b1.y - a1.y);
        intersections.push(a1.x + t * (b1.x - a1.x));
      }
    }
    intersections.sort((x1, x2) => x1 - x2);
    for (let i = 0; i < intersections.length - 1; i += 2) {
      const xStart = Math.max(0, Math.ceil(intersections[i]));
      const xEnd = Math.min(buf.width - 1, Math.floor(intersections[i + 1]));
      for (let x = xStart; x <= xEnd; x++) {
        if (a < 255) blendPixel(buf, x, y, r, g, b, a);
        else setPixel(buf, x, y, r, g, b, a);
      }
    }
  }
}

function drawLineAA(buf, x0, y0, x1, y1, r, g, b) {
  x0 = Math.round(x0); y0 = Math.round(y0);
  x1 = Math.round(x1); y1 = Math.round(y1);
  let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  while (true) {
    setPixel(buf, x0, y0, r, g, b);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
}

function drawDashedLine(buf, x0, y0, x1, y1, r, g, b, dashLen, gapLen) {
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return;
  const ux = dx / len, uy = dy / len;
  let d = 0;
  let drawing = true;
  let segLen = dashLen;

  while (d < len) {
    const end = Math.min(d + segLen, len);
    if (drawing) {
      drawLineAA(buf,
        Math.round(x0 + ux * d), Math.round(y0 + uy * d),
        Math.round(x0 + ux * end), Math.round(y0 + uy * end),
        r, g, b);
    }
    d = end;
    drawing = !drawing;
    segLen = drawing ? dashLen : gapLen;
  }
}

// Tiny 3x5 font for dimension labels
const MINI_GLYPHS = {
  '0': [7,5,5,5,7], '1': [2,6,2,2,7], '2': [7,1,7,4,7], '3': [7,1,7,1,7],
  '4': [5,5,7,1,1], '5': [7,4,7,1,7], '6': [7,4,7,5,7], '7': [7,1,2,2,2],
  '8': [7,5,7,5,7], '9': [7,5,7,1,7], 'x': [0,5,2,5,0], 'm': [0,5,7,5,5],
  ',': [0,0,0,2,4], ' ': [0,0,0,0,0], 'S': [7,4,7,1,7], 'C': [7,4,4,4,7],
  'H': [5,5,7,5,5], 'E': [7,4,7,4,7], 'M': [5,7,7,5,5], 'A': [7,5,7,5,5],
  'T': [7,2,2,2,2], 'I': [7,2,2,2,7], 'N': [5,7,7,7,5], 'R': [7,5,7,6,5],
  'P': [7,5,7,4,4], 'L': [4,4,4,4,7], 'O': [7,5,5,5,7], 'D': [6,5,5,5,6],
  'F': [7,4,7,4,4], 'G': [7,4,5,5,7], 'K': [5,6,4,6,5], 'U': [5,5,5,5,7],
  'V': [5,5,5,5,2], 'W': [5,5,7,7,5], 'Y': [5,5,2,2,2], 'Z': [7,1,2,4,7],
  '-': [0,0,7,0,0], '.': [0,0,0,0,2], ':': [0,2,0,2,0],
};

function drawMiniText(buf, x, y, text, [r, g, b]) {
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const glyph = MINI_GLYPHS[ch] || MINI_GLYPHS[' '];
    if (!glyph) { cx += 4; continue; }
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 3; col++) {
        if (glyph[row] & (1 << (2 - col))) {
          setPixel(buf, cx + col, y + row, r, g, b);
        }
      }
    }
    cx += 4;
  }
}

function drawScaleBar(buf) {
  const barLenM = 50; // 50m bar
  const barLenPx = barLenM * PPM;
  const x0 = IMG_SIZE - barLenPx - 20;
  const y0 = IMG_SIZE - 20;

  // Bar
  for (let px = 0; px < barLenPx; px++) {
    setPixel(buf, x0 + px, y0, SCALE_COLOR[0], SCALE_COLOR[1], SCALE_COLOR[2]);
    setPixel(buf, x0 + px, y0 + 1, SCALE_COLOR[0], SCALE_COLOR[1], SCALE_COLOR[2]);
  }
  // End ticks
  for (let dy = -3; dy <= 3; dy++) {
    setPixel(buf, x0, y0 + dy, SCALE_COLOR[0], SCALE_COLOR[1], SCALE_COLOR[2]);
    setPixel(buf, x0 + barLenPx - 1, y0 + dy, SCALE_COLOR[0], SCALE_COLOR[1], SCALE_COLOR[2]);
  }
  // Label
  drawMiniText(buf, x0 + barLenPx / 2 - 8, y0 + 5, '50M', SCALE_COLOR);
}
