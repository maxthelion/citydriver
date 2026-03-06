/**
 * 9 layer renderers for the interactive viewer.
 * Each returns a transparent RGBA buffer { data, width, height }.
 */

import {
  createBuffer, setPixel, blendPixel, renderElevation,
  renderNuclei, renderRoads,
} from './debugTiles.js';
import { createPathCost } from '../city/pathCost.js';

// Re-export drawLine, drawThickLine, drawLabel from debugTiles via local wrappers
// since they're not exported. We replicate the minimal pieces we need.

function drawLine(buf, x0, y0, x1, y1, r, g, b, a = 255) {
  x0 = Math.round(x0); y0 = Math.round(y0);
  x1 = Math.round(x1); y1 = Math.round(y1);
  let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  while (true) {
    setPixel(buf, x0, y0, r, g, b, a);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx) { err += dx; y0 += sy; }
  }
}

function drawThickLine(buf, x0, y0, x1, y1, r, g, b, thickness = 1) {
  if (thickness <= 1) { drawLine(buf, x0, y0, x1, y1, r, g, b); return; }
  const dx = x1 - x0, dz = y1 - y0;
  const len = Math.sqrt(dx * dx + dz * dz) || 1;
  const px = -dz / len, pz = dx / len;
  const half = (thickness - 1) / 2;
  for (let t = -half; t <= half; t += 0.5) {
    drawLine(buf, x0 + px * t, y0 + pz * t, x1 + px * t, y1 + pz * t, r, g, b);
  }
}

function elevationColor(h, seaLevel, min, max) {
  if (h < seaLevel) {
    const depth = Math.min(1, (seaLevel - h) / 30);
    return [Math.floor(30 - depth * 20), Math.floor(80 - depth * 40), Math.floor(150 + depth * 50)];
  }
  const t = (h - seaLevel) / (max - seaLevel + 0.01);
  if (t < 0.3) return [Math.floor(60 + t * 100), Math.floor(120 + t * 80), Math.floor(40 + t * 30)];
  if (t < 0.7) {
    const u = (t - 0.3) / 0.4;
    return [Math.floor(100 + u * 60), Math.floor(140 - u * 40), Math.floor(50 + u * 20)];
  }
  const u = (t - 0.7) / 0.3;
  const v = Math.floor(160 + u * 80);
  return [v, v, v];
}

// ============================================================
// Layer 1: Elevation
// ============================================================

export function renderElevationLayer(state) {
  const { cityLayers } = state;
  const params = cityLayers.getData('params');
  const elevation = cityLayers.getGrid('elevation');
  const seaLevel = params.seaLevel ?? 0;
  const w = params.width, h = params.height;

  const buf = createBuffer(w, h);
  const { min, max } = elevation.bounds();

  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      const elev = elevation.get(gx, gz);
      const [r, g, b] = elevationColor(elev, seaLevel, min, max);
      setPixel(buf, gx, gz, r, g, b);
    }
  }
  return buf;
}

// ============================================================
// Layer 2: Clusters (nuclei)
// ============================================================

const NUCLEUS_COLORS = {
  oldTown:    [255, 80, 80],
  waterfront: [80, 150, 255],
  market:     [255, 180, 50],
  hilltop:    [180, 130, 80],
  valley:     [80, 200, 120],
  roadside:   [180, 180, 180],
  suburban:   [200, 180, 255],
};

export function renderClustersLayer(state) {
  const { cityLayers, nuclei } = state;
  const params = cityLayers.getData('params');
  const cs = params.cellSize;
  const w = params.width, h = params.height;

  const buf = createBuffer(w, h);
  // Transparent background — only draw nuclei markers

  if (!nuclei) return buf;

  for (const n of nuclei) {
    const gx = Math.round(n.x / cs);
    const gz = Math.round(n.z / cs);
    const c = NUCLEUS_COLORS[n.type] || [255, 255, 255];
    const radius = n.id === 0 ? 3 : 2;

    // Filled circle
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dz * dz <= radius * radius) {
          setPixel(buf, gx + dx, gz + dz, c[0], c[1], c[2]);
        }
      }
    }

    // White outline
    for (let angle = 0; angle < Math.PI * 2; angle += 0.15) {
      const px = Math.round(gx + Math.cos(angle) * (radius + 1));
      const pz = Math.round(gz + Math.sin(angle) * (radius + 1));
      setPixel(buf, px, pz, 255, 255, 255);
    }
  }

  return buf;
}

// ============================================================
// Layer 3: Connections (nuclei to nearest road)
// ============================================================

export function renderConnectionsLayer(state) {
  const { cityLayers, nuclei, roadGraph } = state;
  const params = cityLayers.getData('params');
  const cs = params.cellSize;
  const w = params.width, h = params.height;

  const buf = createBuffer(w, h);
  if (!nuclei || !roadGraph) return buf;

  for (const n of nuclei) {
    const gx = Math.round(n.x / cs);
    const gz = Math.round(n.z / cs);
    const c = NUCLEUS_COLORS[n.type] || [255, 255, 255];

    const nearest = roadGraph.nearestNode(n.x, n.z);
    if (!nearest) continue;

    const rn = roadGraph.getNode(nearest.id);
    const rnx = Math.round(rn.x / cs);
    const rnz = Math.round(rn.z / cs);

    // Dashed line
    const dx = rnx - gx, dz = rnz - gz;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    for (let t = 0; t < len; t += 2) {
      const px = Math.round(gx + (dx / len) * t);
      const pz = Math.round(gz + (dz / len) * t);
      setPixel(buf, px, pz, c[0], c[1], c[2], 180);
    }

    // Small dot at road end
    for (let ddz = -1; ddz <= 1; ddz++) {
      for (let ddx = -1; ddx <= 1; ddx++) {
        setPixel(buf, rnx + ddx, rnz + ddz, 255, 255, 255);
      }
    }
  }

  return buf;
}

// ============================================================
// Layer 4: Arterials (road hierarchy)
// ============================================================

const ROAD_COLORS = {
  arterial: [255, 255, 255],
  collector: [255, 204, 68],
  structural: [100, 200, 255],
  local: [160, 160, 160],
};
const ROAD_WIDTHS = { arterial: 3, collector: 2, structural: 2, local: 1 };

export function renderArterialsLayer(state) {
  const { cityLayers, roadGraph } = state;
  const params = cityLayers.getData('params');
  const cs = params.cellSize;
  const w = params.width, h = params.height;

  const buf = createBuffer(w, h);
  if (!roadGraph) return buf;

  for (const [edgeId, edge] of roadGraph.edges) {
    const polyline = roadGraph.edgePolyline(edgeId);
    if (polyline.length < 2) continue;

    const hierarchy = edge.attrs?.hierarchy || edge.hierarchy || 'local';
    const [r, g, b] = ROAD_COLORS[hierarchy] || ROAD_COLORS.local;
    const thickness = ROAD_WIDTHS[hierarchy] || 1;

    for (let i = 0; i < polyline.length - 1; i++) {
      drawThickLine(buf,
        polyline[i].x / cs, polyline[i].z / cs,
        polyline[i + 1].x / cs, polyline[i + 1].z / cs,
        r, g, b, thickness,
      );
    }
  }

  // Node markers
  for (const [, node] of roadGraph.nodes) {
    const gx = Math.round(node.x / cs);
    const gz = Math.round(node.z / cs);
    if (node.attrs?.type === 'seed') {
      setPixel(buf, gx, gz, 255, 0, 0);
    } else if (node.attrs?.type === 'entry') {
      setPixel(buf, gx, gz, 255, 200, 0);
    }
  }

  return buf;
}

// ============================================================
// Layer 5: Rivers / water
// ============================================================

export function renderRiversLayer(state) {
  const { cityLayers } = state;
  const params = cityLayers.getData('params');
  const w = params.width, h = params.height;
  const cs = params.cellSize;
  const waterType = cityLayers.getGrid('waterType');
  const waterMask = cityLayers.getGrid('waterMask');

  const buf = createBuffer(w, h);

  // Water overlay colored by type
  if (waterType) {
    for (let gz = 0; gz < h; gz++) {
      for (let gx = 0; gx < w; gx++) {
        const t = waterType.get(gx, gz);
        if (t === 1) setPixel(buf, gx, gz, 20, 60, 180, 180);      // sea: deep blue
        else if (t === 2) setPixel(buf, gx, gz, 40, 120, 180, 160); // lake: teal
        else if (t === 3) setPixel(buf, gx, gz, 50, 100, 200, 160); // river: medium blue
      }
    }
  } else if (waterMask) {
    // Fallback to unclassified water mask
    for (let gz = 0; gz < h; gz++) {
      for (let gx = 0; gx < w; gx++) {
        if (waterMask.get(gx, gz) > 0) {
          setPixel(buf, gx, gz, 30, 80, 200, 180);
        }
      }
    }
  }

  // Smooth variable-width river polylines from imported paths
  const riverPaths = cityLayers.getData('riverPaths');
  if (riverPaths) {
    for (const path of riverPaths) {
      const pts = path.points;
      if (pts.length < 2) continue;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const thickness = Math.max(1, Math.round((a.width + b.width) / 2 / cs));
        drawThickLine(buf,
          a.x / cs, a.z / cs,
          b.x / cs, b.z / cs,
          50, 120, 220, thickness,
        );
      }
    }
  }

  return buf;
}

// ============================================================
// Layer 6: Available land
// ============================================================

export function renderAvailableLandLayer(state) {
  const { cityLayers } = state;
  const params = cityLayers.getData('params');
  const w = params.width, h = params.height;
  const buildability = cityLayers.getGrid('buildability');

  const buf = createBuffer(w, h);
  if (!buildability) return buf;

  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      const v = buildability.get(gx, gz);
      if (v < 0.01) continue;

      // Direct visualization of the buildability grid.
      // Bright green = highly buildable, dim red = marginal.
      const t = Math.min(1, v);
      const r = Math.floor(40 + (1 - t) * 180);
      const g = Math.floor(80 + t * 160);
      const b = 40;
      const a = Math.floor(40 + t * 100);
      setPixel(buf, gx, gz, r, g, b, a);
    }
  }

  return buf;
}

// ============================================================
// Layer 7: High-value terrain (attraction heat map)
// ============================================================

export function renderHighValueLayer(state) {
  const { cityLayers, terrainFields } = state;
  const params = cityLayers.getData('params');
  const w = params.width, h = params.height;

  const buf = createBuffer(w, h);
  if (!terrainFields?.terrainAttraction) return buf;

  const attraction = terrainFields.terrainAttraction;

  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      const v = attraction.get(gx, gz);
      if (v < 0.05) continue;

      // Yellow to red heat map
      let r, g, b;
      if (v < 0.5) {
        const t = v / 0.5;
        r = Math.floor(200 + t * 55);
        g = Math.floor(200 - t * 80);
        b = 0;
      } else {
        const t = (v - 0.5) / 0.5;
        r = 255;
        g = Math.floor(120 * (1 - t));
        b = 0;
      }
      const a = Math.floor(40 + v * 120);
      setPixel(buf, gx, gz, r, g, b, a);
    }
  }

  return buf;
}

// ============================================================
// Layer 8: Path cost
// ============================================================

export function renderPathCostLayer(state) {
  const { cityLayers } = state;
  const params = cityLayers.getData('params');
  const w = params.width, h = params.height;

  // Use growthRoadCost-like settings (the most common preset)
  const costFn = createPathCost(cityLayers, {
    slopePenalty: 0,  // exclude slope — it's direction-dependent, show static cost only
    reuseDiscount: 0.5,
    plotPenalty: 5.0,
  });

  const buf = createBuffer(w, h);

  // Sample static cost at each cell (step from left neighbor; slopePenalty=0 so direction irrelevant)
  const raw = new Float32Array(w * h);
  let maxFinite = 0;
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      const fromGx = gx > 0 ? gx - 1 : gx + 1;
      const c = costFn(fromGx, gz, gx, gz);
      raw[gz * w + gx] = c;
      if (isFinite(c) && c > maxFinite) maxFinite = c;
    }
  }

  // Render: white = low cost (favoured), black = high cost / impassable
  const cap = Math.max(1, maxFinite * 0.4);
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      const c = raw[gz * w + gx];
      if (!isFinite(c)) {
        setPixel(buf, gx, gz, 0, 0, 0, 200);
        continue;
      }
      const t = 1 - Math.min(1, c / cap);
      const v = Math.floor(t * 255);
      setPixel(buf, gx, gz, v, v, v, 180);
    }
  }

  return buf;
}

// ============================================================
// Layer: Bridges
// ============================================================

export function renderBridgesLayer(state) {
  const { cityLayers } = state;
  const params = cityLayers.getData('params');
  const w = params.width, h = params.height;
  const bridges = cityLayers.getData('bridges');

  const buf = createBuffer(w, h);
  if (!bridges || bridges.length === 0) return buf;

  for (const bridge of bridges) {
    const { startGx, startGz, endGx, endGz, width: bWidth } = bridge;

    // Thick orange line from bank to bank
    drawThickLine(buf, startGx, startGz, endGx, endGz, 255, 140, 40, 3);

    // White endpoint circles (radius 2)
    for (const [px, pz] of [[startGx, startGz], [endGx, endGz]]) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (dx * dx + dz * dz <= 4) {
            setPixel(buf, px + dx, pz + dz, 255, 255, 255);
          }
        }
      }
    }

    // Label bridge width at midpoint
    const midX = Math.round((startGx + endGx) / 2);
    const midZ = Math.round((startGz + endGz) / 2);
    drawLabel(buf, midX + 3, midZ - 3, String(bWidth ?? ''), 255, 200, 100);
  }

  return buf;
}

// ============================================================
// Layer 9: River-roads (stub)
// ============================================================

export function renderRiverRoadsLayer(state) {
  const { cityLayers } = state;
  const params = cityLayers.getData('params');
  const buf = createBuffer(params.width, params.height);
  // Stub — will render once growth algorithm produces river-following roads
  return buf;
}

// ============================================================
// Layer 9: Promenades (stub)
// ============================================================

export function renderPromenadesLayer(state) {
  const { cityLayers } = state;
  const params = cityLayers.getData('params');
  const buf = createBuffer(params.width, params.height);
  // Stub — will render once growth algorithm produces coastal setback roads
  return buf;
}

// ============================================================
// Tiny bitmap font (copied from debugTiles — not exported there)
// ============================================================

const FONT = {
  ' ': [0,0,0,0,0,0,0], '.': [0,0,0,0,0,0,4],
  '0':[14,17,19,21,25,17,14],'1':[4,12,4,4,4,4,14],'2':[14,17,1,14,16,16,31],
  '3':[14,17,1,6,1,17,14],'4':[2,6,10,18,31,2,2],'5':[31,16,30,1,1,17,14],
  '6':[14,16,16,30,17,17,14],'7':[31,1,2,4,8,8,8],'8':[14,17,17,14,17,17,14],
  '9':[14,17,17,15,1,1,14],
  'A':[14,17,17,31,17,17,17],'B':[30,17,17,30,17,17,30],'C':[14,17,16,16,16,17,14],
  'D':[30,17,17,17,17,17,30],'E':[31,16,16,30,16,16,31],'F':[31,16,16,30,16,16,16],
  'G':[14,17,16,23,17,17,14],'H':[17,17,17,31,17,17,17],'I':[14,4,4,4,4,4,14],
  'K':[17,18,20,24,20,18,17],'L':[16,16,16,16,16,16,31],
  'M':[17,27,21,17,17,17,17],'N':[17,25,21,19,17,17,17],'O':[14,17,17,17,17,17,14],
  'P':[30,17,17,30,16,16,16],'R':[30,17,17,30,20,18,17],'S':[14,17,16,14,1,17,14],
  'T':[31,4,4,4,4,4,4],'U':[17,17,17,17,17,17,14],'V':[17,17,17,17,10,10,4],
  'W':[17,17,17,17,21,27,17],'Y':[17,17,10,4,4,4,4],'Z':[31,1,2,4,8,16,31],
};

function drawLabel(buf, x, y, text, r = 255, g = 255, b = 255) {
  const str = String(text);
  let cx = x;
  for (const ch of str) {
    const glyph = FONT[ch] || FONT[ch.toUpperCase()] || FONT[' '];
    if (glyph) {
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if (glyph[row] & (1 << (4 - col))) {
            setPixel(buf, cx + col + 1, y + row + 1, 0, 0, 0);
            setPixel(buf, cx + col, y + row, r, g, b);
          }
        }
      }
    }
    cx += 6;
  }
}

// ============================================================
// Registry
// ============================================================

export const LAYER_NAMES = [
  'elevation',
  'clusters',
  'connections',
  'arterials',
  'rivers',
  'bridges',
  'available-land',
  'high-value',
  'path-cost',
  'river-roads',
  'promenades',
];

export const LAYER_RENDERERS = {
  'elevation': renderElevationLayer,
  'clusters': renderClustersLayer,
  'connections': renderConnectionsLayer,
  'arterials': renderArterialsLayer,
  'rivers': renderRiversLayer,
  'bridges': renderBridgesLayer,
  'available-land': renderAvailableLandLayer,
  'high-value': renderHighValueLayer,
  'path-cost': renderPathCostLayer,
  'river-roads': renderRiverRoadsLayer,
  'promenades': renderPromenadesLayer,
};
