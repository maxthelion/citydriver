/**
 * Pure-JS pixel buffer rendering for city pipeline debug output.
 * No Canvas API — works in Node without a browser.
 */

// --- Buffer primitives ---

export function createBuffer(w, h) {
  return { data: new Uint8Array(w * h * 4), width: w, height: h };
}

export function setPixel(buf, x, y, r, g, b, a = 255) {
  x = x | 0; y = y | 0;
  if (x < 0 || x >= buf.width || y < 0 || y >= buf.height) return;
  const i = (y * buf.width + x) * 4;
  buf.data[i] = r;
  buf.data[i + 1] = g;
  buf.data[i + 2] = b;
  buf.data[i + 3] = a;
}

export function blendPixel(buf, x, y, r, g, b, a) {
  x = x | 0; y = y | 0;
  if (x < 0 || x >= buf.width || y < 0 || y >= buf.height) return;
  const i = (y * buf.width + x) * 4;
  const aa = a / 255;
  const inv = 1 - aa;
  buf.data[i] = Math.round(buf.data[i] * inv + r * aa);
  buf.data[i + 1] = Math.round(buf.data[i + 1] * inv + g * aa);
  buf.data[i + 2] = Math.round(buf.data[i + 2] * inv + b * aa);
  buf.data[i + 3] = Math.min(255, buf.data[i + 3] + a);
}

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
  // Draw multiple parallel lines for thickness
  const dx = x1 - x0, dz = y1 - y0;
  const len = Math.sqrt(dx * dx + dz * dz) || 1;
  const px = -dz / len, pz = dx / len;
  const half = (thickness - 1) / 2;
  for (let t = -half; t <= half; t += 0.5) {
    drawLine(buf, x0 + px * t, y0 + pz * t, x1 + px * t, y1 + pz * t, r, g, b);
  }
}

function fillRect(buf, x, y, w, h, r, g, b, a = 255) {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      if (a < 255) blendPixel(buf, x + dx, y + dy, r, g, b, a);
      else setPixel(buf, x + dx, y + dy, r, g, b, a);
    }
  }
}

// Scanline polygon fill
function fillPolygon(buf, points, r, g, b, a = 255) {
  if (!points || points.length < 3) return;
  let minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  minY = Math.max(0, Math.floor(minY));
  maxY = Math.min(buf.height - 1, Math.ceil(maxY));

  for (let y = minY; y <= maxY; y++) {
    const intersections = [];
    for (let i = 0; i < points.length; i++) {
      const a1 = points[i], b1 = points[(i + 1) % points.length];
      const y0 = a1.y, y1 = b1.y;
      if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) {
        const t = (y - y0) / (y1 - y0);
        intersections.push(a1.x + t * (b1.x - a1.x));
      }
    }
    intersections.sort((a2, b2) => a2 - b2);
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

function strokePolygon(buf, points, r, g, b, a = 255) {
  if (!points || points.length < 2) return;
  for (let i = 0; i < points.length; i++) {
    const a1 = points[i], b1 = points[(i + 1) % points.length];
    drawLine(buf, a1.x, a1.y, b1.x, b1.y, r, g, b, a);
  }
}

// --- Tiny bitmap font (5x7) ---
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
  'a':[0,0,14,1,15,17,15],'b':[16,16,30,17,17,17,30],'c':[0,0,14,17,16,17,14],
  'd':[1,1,15,17,17,17,15],'e':[0,0,14,17,31,16,14],'f':[6,8,8,28,8,8,8],
  'g':[0,0,15,17,15,1,14],'h':[16,16,30,17,17,17,17],'i':[4,0,12,4,4,4,14],
  'k':[16,16,18,20,24,20,18],'l':[12,4,4,4,4,4,14],'m':[0,0,26,21,21,17,17],
  'n':[0,0,30,17,17,17,17],'o':[0,0,14,17,17,17,14],'p':[0,0,30,17,30,16,16],
  'r':[0,0,22,25,16,16,16],'s':[0,0,15,16,14,1,30],'t':[8,8,28,8,8,9,6],
  'u':[0,0,17,17,17,17,15],'v':[0,0,17,17,17,10,4],'w':[0,0,17,17,21,21,10],
  'y':[0,0,17,17,15,1,14],'z':[0,0,31,2,4,8,31],
  '-':[0,0,0,31,0,0,0],'(':[2,4,8,8,8,4,2],')':[8,4,2,2,2,4,8],
  ':':[0,4,0,0,0,4,0],'/':[1,2,2,4,8,8,16],
};

function drawLabel(buf, x, y, text, r = 255, g = 255, b = 255) {
  const str = text.toUpperCase ? text : String(text);
  let cx = x;
  for (const ch of str) {
    const glyph = FONT[ch] || FONT[ch.toUpperCase()] || FONT[' '];
    if (glyph) {
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if (glyph[row] & (1 << (4 - col))) {
            // Shadow
            setPixel(buf, cx + col + 1, y + row + 1, 0, 0, 0);
            setPixel(buf, cx + col, y + row, r, g, b);
          }
        }
      }
    }
    cx += 6;
  }
}

// --- Elevation colour ramp (matches mapRenderer) ---

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

// --- Per-tile renderers ---

export function renderElevation(buf, elevation, seaLevel) {
  const { min, max } = elevation.bounds();
  for (let gz = 0; gz < buf.height; gz++) {
    for (let gx = 0; gx < buf.width; gx++) {
      const h = elevation.get(gx, gz);
      const [r, g, b] = elevationColor(h, seaLevel, min, max);
      setPixel(buf, gx, gz, r, g, b);
    }
  }
}

export function renderElevationFaint(buf, elevation, seaLevel) {
  const { min, max } = elevation.bounds();
  for (let gz = 0; gz < buf.height; gz++) {
    for (let gx = 0; gx < buf.width; gx++) {
      const h = elevation.get(gx, gz);
      const [r, g, b] = elevationColor(h, seaLevel, min, max);
      // Desaturate and dim
      const grey = (r + g + b) / 3;
      setPixel(buf, gx, gz,
        Math.floor(grey * 0.5 + r * 0.2),
        Math.floor(grey * 0.5 + g * 0.2),
        Math.floor(grey * 0.5 + b * 0.2),
      );
    }
  }
}

export function renderSlope(buf, slope) {
  const { max } = slope.bounds();
  const scale = max > 0 ? 1 / max : 1;
  for (let gz = 0; gz < buf.height; gz++) {
    for (let gx = 0; gx < buf.width; gx++) {
      const v = Math.min(255, Math.floor(slope.get(gx, gz) * scale * 255));
      setPixel(buf, gx, gz, v, v, v);
    }
  }
}

export function renderWaterMask(buf, waterMask) {
  for (let gz = 0; gz < buf.height; gz++) {
    for (let gx = 0; gx < buf.width; gx++) {
      if (waterMask.get(gx, gz) > 0) {
        blendPixel(buf, gx, gz, 30, 80, 200, 180);
      }
    }
  }
}

export function renderDensity(buf, density) {
  for (let gz = 0; gz < buf.height; gz++) {
    for (let gx = 0; gx < buf.width; gx++) {
      const d = density.get(gx, gz);
      if (d < 0.01) continue;
      // Black -> yellow -> red
      let r, g, b;
      if (d < 0.5) {
        const t = d / 0.5;
        r = Math.floor(t * 255);
        g = Math.floor(t * 200);
        b = 0;
      } else {
        const t = (d - 0.5) / 0.5;
        r = 255;
        g = Math.floor(200 * (1 - t));
        b = 0;
      }
      setPixel(buf, gx, gz, r, g, b);
    }
  }
}

const DISTRICT_COLORS = [
  [204, 51, 51],   // 0: commercial
  [221, 136, 51],  // 1: dense residential
  [221, 204, 68],  // 2: suburban
  [136, 68, 170],  // 3: industrial
  [51, 170, 68],   // 4: parkland
];

export function renderDistricts(buf, districts) {
  for (let gz = 0; gz < buf.height; gz++) {
    for (let gx = 0; gx < buf.width; gx++) {
      const d = districts.get(gx, gz);
      const c = DISTRICT_COLORS[d] || [100, 100, 100];
      setPixel(buf, gx, gz, c[0], c[1], c[2]);
    }
  }
}

const COVER_COLORS = {
  1: [107, 170, 64],  // garden
  2: [51, 170, 34],   // park
  3: [31, 85, 17],    // woodland
  4: [68, 170, 136],  // river buffer
  5: [153, 149, 136], // paved
};

export function renderUrbanCover(buf, urbanCover) {
  for (let gz = 0; gz < buf.height; gz++) {
    for (let gx = 0; gx < buf.width; gx++) {
      const v = urbanCover.get(gx, gz);
      const c = COVER_COLORS[v];
      if (c) setPixel(buf, gx, gz, c[0], c[1], c[2]);
    }
  }
}

const ROAD_COLORS = {
  arterial: [255, 255, 255],
  collector: [255, 204, 68],
  structural: [100, 200, 255],
  local: [160, 160, 160],
};
const HIGHLIGHT_COLOR = [0, 255, 255];
const ROAD_WIDTHS = { arterial: 2, collector: 1, structural: 1, local: 1 };

export function renderRoads(buf, roadGraph, edgeIds, newEdgeIds, cellSize) {
  const cs = cellSize;
  for (const edgeId of edgeIds) {
    const edge = roadGraph.getEdge(edgeId);
    if (!edge) continue;
    const polyline = roadGraph.edgePolyline(edgeId);
    if (polyline.length < 2) continue;

    const hierarchy = edge.attrs?.hierarchy || edge.hierarchy || 'local';
    const isNew = newEdgeIds && newEdgeIds.has(edgeId);
    const [r, g, b] = isNew ? HIGHLIGHT_COLOR : (ROAD_COLORS[hierarchy] || ROAD_COLORS.local);
    const w = ROAD_WIDTHS[hierarchy] || 1;

    for (let i = 0; i < polyline.length - 1; i++) {
      drawThickLine(buf,
        polyline[i].x / cs, polyline[i].z / cs,
        polyline[i + 1].x / cs, polyline[i + 1].z / cs,
        r, g, b, w,
      );
    }
  }

  // Draw nodes as 2px dots for anchor/entry
  for (const [, node] of roadGraph.nodes) {
    const gx = Math.round(node.x / cs);
    const gz = Math.round(node.z / cs);
    if (node.attrs?.type === 'seed') {
      fillRect(buf, gx - 1, gz - 1, 3, 3, 255, 0, 0);
    } else if (node.attrs?.type === 'entry') {
      fillRect(buf, gx - 1, gz - 1, 3, 3, 255, 200, 0);
    }
  }
}

const MATERIAL_COLORS = {
  pale_stone: [232, 220, 192],
  warm_stone: [201, 150, 94],
  dark_stone: [138, 138, 138],
  brick:      [184, 85, 51],
  flint:      [160, 152, 128],
};

export function renderBuildings(buf, buildings, cellSize) {
  const cs = cellSize;
  for (const b of buildings) {
    if (!b.footprint || b.footprint.length < 3) continue;
    const c = MATERIAL_COLORS[b.material] || MATERIAL_COLORS.brick;
    const pts = b.footprint.map(p => ({ x: p.x / cs, y: p.z / cs }));
    fillPolygon(buf, pts, c[0], c[1], c[2]);
    strokePolygon(buf, pts, 0, 0, 0);
  }
}

const PLOT_COLORS = [
  [255, 130, 130], // commercial
  [255, 190, 130], // dense res
  [255, 240, 150], // suburban
  [190, 140, 220], // industrial
  [130, 220, 140], // parkland
];

export function renderPlots(buf, plots, cellSize) {
  const cs = cellSize;
  for (const plot of plots) {
    if (!plot.vertices || plot.vertices.length < 3) continue;
    const d = plot.district ?? 2;
    const c = PLOT_COLORS[d] || PLOT_COLORS[2];
    const pts = plot.vertices.map(p => ({ x: p.x / cs, y: p.z / cs }));
    fillPolygon(buf, pts, c[0], c[1], c[2], 180);
    strokePolygon(buf, pts, 80, 80, 80);
  }
}

const AMENITY_COLORS = {
  park: [51, 170, 68],
  school: [51, 100, 220],
  commercial: [220, 50, 50],
};

export function renderAmenities(buf, amenities, cellSize) {
  const cs = cellSize;
  for (const a of amenities) {
    const gx = Math.round(a.x / cs);
    const gz = Math.round(a.z / cs);
    const [r, g, b] = AMENITY_COLORS[a.type] || [200, 200, 50];
    const sz = a.type === 'park' ? 3 : 2;
    fillRect(buf, gx - sz, gz - sz, sz * 2 + 1, sz * 2 + 1, r, g, b);
  }
}

// --- Region overview renderer ---

/**
 * Render a regional overview with rivers, roads, settlements, and city boundary.
 */
export function renderRegionOverview(regionalLayers, settlement, cityRadius) {
  const params = regionalLayers.getData('params');
  const elevation = regionalLayers.getGrid('elevation');
  const seaLevel = params.seaLevel ?? 0;
  const w = elevation.width;
  const h = elevation.height;

  const buf = createBuffer(w, h);

  // Elevation base
  renderElevation(buf, elevation, seaLevel);

  // Rivers
  const rivers = regionalLayers.getData('rivers');
  if (rivers) {
    function drawRiverSeg(seg) {
      if (!seg.cells || seg.cells.length < 2) {
        for (const child of (seg.children || [])) drawRiverSeg(child);
        return;
      }
      for (let i = 0; i < seg.cells.length - 1; i++) {
        drawLine(buf,
          seg.cells[i].gx, seg.cells[i].gz,
          seg.cells[i + 1].gx, seg.cells[i + 1].gz,
          50, 80, 180,
        );
      }
      for (const child of (seg.children || [])) drawRiverSeg(child);
    }
    for (const root of rivers) drawRiverSeg(root);
  }

  // Roads
  const roads = regionalLayers.getData('roads');
  if (roads) {
    for (const road of roads) {
      if (!road.path || road.path.length < 2) continue;
      const regionRoadColors = { arterial: [200, 180, 120], collector: [160, 140, 100], local: [120, 110, 80] };
      const c = regionRoadColors[road.hierarchy] || [120, 110, 80];
      for (let i = 0; i < road.path.length - 1; i++) {
        drawLine(buf,
          road.path[i].gx, road.path[i].gz,
          road.path[i + 1].gx, road.path[i + 1].gz,
          c[0], c[1], c[2],
        );
      }
    }
  }

  // Settlements
  const settlements = regionalLayers.getData('settlements');
  if (settlements) {
    for (const s of settlements) {
      const tierColors = {
        1: [255, 0, 0],     // city — red
        2: [255, 136, 0],   // town — orange
        3: [255, 255, 0],   // village — yellow
        4: [255, 200, 255], // hamlet — pink
        5: [200, 160, 255], // farm — lavender
      };
      const tierSizes = { 1: 4, 2: 3, 3: 2, 4: 2, 5: 1 };
      const c = tierColors[s.tier] || [255, 255, 0];
      const sz = tierSizes[s.tier] || 1;
      fillRect(buf, s.gx - Math.floor(sz / 2), s.gz - Math.floor(sz / 2), sz, sz, c[0], c[1], c[2]);
    }
  }

  // City boundary rectangle
  const minGx = Math.max(0, settlement.gx - cityRadius);
  const minGz = Math.max(0, settlement.gz - cityRadius);
  const maxGx = Math.min(w - 1, settlement.gx + cityRadius);
  const maxGz = Math.min(h - 1, settlement.gz + cityRadius);

  // Draw rectangle outline (red, 2px)
  for (let t = -1; t <= 0; t++) {
    // Top edge
    for (let x = minGx + t; x <= maxGx - t; x++) {
      setPixel(buf, x, minGz + t, 255, 50, 50);
      setPixel(buf, x, maxGz - t, 255, 50, 50);
    }
    // Left/right edges
    for (let y = minGz + t; y <= maxGz - t; y++) {
      setPixel(buf, minGx + t, y, 255, 50, 50);
      setPixel(buf, maxGx - t, y, 255, 50, 50);
    }
  }

  drawLabel(buf, 2, 2, 'Region');

  return buf;
}

// --- Tile renderer ---

/**
 * Render a single step tile.
 */
function renderTile(tileW, tileH, step, idx, cityLayers, roadGraph) {
  const params = cityLayers.getData('params');
  const cs = params.cellSize;
  const seaLevel = params.seaLevel ?? 0;
  const elevation = cityLayers.getGrid('elevation');
  const tile = createBuffer(tileW, tileH);

  switch (step.render) {
    case 'elevation':
      renderElevation(tile, elevation, seaLevel);
      break;
    case 'slope':
      renderSlope(tile, cityLayers.getGrid('slope'));
      break;
    case 'waterMask':
      renderElevationFaint(tile, elevation, seaLevel);
      renderWaterMask(tile, cityLayers.getGrid('waterMask'));
      break;
    case 'density':
      renderDensity(tile, step.grid || cityLayers.getGrid('density'));
      break;
    case 'districts':
      renderDistricts(tile, step.grid || cityLayers.getGrid('districts'));
      break;
    case 'urbanCover':
      renderUrbanCover(tile, cityLayers.getGrid('urbanCover'));
      break;
    case 'roads':
      renderElevationFaint(tile, elevation, seaLevel);
      renderRoads(tile, roadGraph, step.edgeIds, step.newEdgeIds, cs);
      break;
    case 'plots':
      renderElevationFaint(tile, elevation, seaLevel);
      renderPlots(tile, cityLayers.getData('plots'), cs);
      break;
    case 'buildings':
      renderElevationFaint(tile, elevation, seaLevel);
      renderBuildings(tile, cityLayers.getData('buildings'), cs);
      break;
    case 'amenities':
      renderElevationFaint(tile, elevation, seaLevel);
      renderAmenities(tile, cityLayers.getData('amenities'), cs);
      break;
  }

  drawLabel(tile, 2, 2, `${idx + 1}. ${step.name}`);
  return tile;
}

// --- Grid compositor ---

/**
 * Render all steps as individual tiles and a composited 4x4 grid.
 * @returns {{ grid: {data,width,height}, tiles: Array<{data,width,height,name}> }}
 */
export function renderDebugGrid(cityLayers, roadGraph, steps) {
  const params = cityLayers.getData('params');
  const tileW = params.width;
  const tileH = params.height;
  const border = 2;
  const cols = 4, rows = 4;
  const totalW = cols * tileW + (cols + 1) * border;
  const totalH = rows * tileH + (rows + 1) * border;

  const output = createBuffer(totalW, totalH);
  output.data.fill(40);
  for (let i = 3; i < output.data.length; i += 4) output.data[i] = 255;

  const tiles = [];

  for (let idx = 0; idx < steps.length && idx < 16; idx++) {
    const step = steps[idx];
    const tile = renderTile(tileW, tileH, step, idx, cityLayers, roadGraph);
    tiles.push({ data: tile.data, width: tile.width, height: tile.height, name: step.name });

    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const ox = border + col * (tileW + border);
    const oy = border + row * (tileH + border);

    for (let y = 0; y < tileH; y++) {
      const srcOff = y * tileW * 4;
      const dstOff = ((oy + y) * totalW + ox) * 4;
      output.data.set(tile.data.subarray(srcOff, srcOff + tileW * 4), dstOff);
    }
  }

  return { grid: output, tiles };
}
