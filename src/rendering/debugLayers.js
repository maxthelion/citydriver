/**
 * Debug layer renderers for the FeatureMap.
 * Each function renders a single layer onto a canvas 2D context.
 *
 * All renderers have the signature:
 *   render(ctx, map, options) where ctx is a CanvasRenderingContext2D
 */

// Color utilities
function gray(v) {
  const c = Math.round(v * 255);
  return `rgb(${c},${c},${c})`;
}

function heatColor(v) {
  // 0 = blue, 0.5 = green, 1 = red
  const r = Math.round(v < 0.5 ? 0 : (v - 0.5) * 2 * 255);
  const g = Math.round(v < 0.5 ? v * 2 * 255 : (1 - v) * 2 * 255);
  const b = Math.round(v < 0.5 ? (1 - v * 2) * 255 : 0);
  return `rgb(${r},${g},${b})`;
}

/**
 * Terrain elevation with color gradient.
 */
export function renderTerrain(ctx, map) {
  const { width, height } = map;
  const elev = map.elevation;
  if (!elev) return;

  const { min, max } = elev.bounds();
  const range = max - min || 1;

  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      const v = (elev.get(gx, gz) - min) / range;
      // Green-brown gradient
      const r = Math.round(80 + v * 140);
      const g = Math.round(120 + v * 80);
      const b = Math.round(40 + v * 40);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(gx, gz, 1, 1);
    }
  }
}

/**
 * Slope visualization.
 */
export function renderSlope(ctx, map) {
  const { width, height } = map;
  const slope = map.slope;
  if (!slope) return;

  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      const v = Math.min(1, slope.get(gx, gz) / 0.7);
      ctx.fillStyle = heatColor(v);
      ctx.fillRect(gx, gz, 1, 1);
    }
  }
}

/**
 * Buildability heatmap.
 */
export function renderBuildability(ctx, map) {
  const { width, height } = map;

  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      const b = map.buildability.get(gx, gz);
      // Green = buildable, black = not
      const r = Math.round((1 - b) * 60);
      const g = Math.round(b * 200 + 20);
      const bl = Math.round(20);
      ctx.fillStyle = `rgb(${r},${g},${bl})`;
      ctx.fillRect(gx, gz, 1, 1);
    }
  }
}

/**
 * Water mask (blue for water, transparent for land).
 */
export function renderWaterMask(ctx, map) {
  const { width, height } = map;

  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      if (map.waterMask.get(gx, gz) > 0) {
        ctx.fillStyle = '#2266cc';
      } else {
        ctx.fillStyle = '#ddeedd';
      }
      ctx.fillRect(gx, gz, 1, 1);
    }
  }
}

/**
 * Water classification (sea=blue, lake=cyan, river=darkblue, land=tan).
 */
export function renderWaterType(ctx, map) {
  const { width, height } = map;
  if (!map.waterType) return renderWaterMask(ctx, map);

  const colors = { 0: '#ddeedd', 1: '#2255aa', 2: '#44aacc', 3: '#1144aa' };

  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      const t = map.waterType.get(gx, gz);
      ctx.fillStyle = colors[t] || colors[0];
      ctx.fillRect(gx, gz, 1, 1);
    }
  }
}

/**
 * Bridge grid overlay.
 */
export function renderBridgeGrid(ctx, map) {
  const { width, height } = map;

  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      if (map.bridgeGrid.get(gx, gz) > 0) {
        ctx.fillStyle = '#ff6600';
      } else if (map.waterMask.get(gx, gz) > 0) {
        ctx.fillStyle = '#2266cc';
      } else {
        ctx.fillStyle = '#ddeedd';
      }
      ctx.fillRect(gx, gz, 1, 1);
    }
  }
}

/**
 * Road grid overlay.
 */
export function renderRoadGrid(ctx, map) {
  const { width, height } = map;

  // Base: terrain
  renderTerrain(ctx, map);

  // Overlay roads
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      if (map.roadGrid.get(gx, gz) > 0) {
        ctx.fillStyle = 'rgba(60, 60, 60, 0.8)';
        ctx.fillRect(gx, gz, 1, 1);
      }
      if (map.waterMask.get(gx, gz) > 0) {
        ctx.fillStyle = 'rgba(34, 102, 204, 0.7)';
        ctx.fillRect(gx, gz, 1, 1);
      }
    }
  }
}

/**
 * Composite view: terrain + water + roads + nuclei.
 */
export function renderComposite(ctx, map) {
  const { width, height } = map;

  // Base terrain
  renderTerrain(ctx, map);

  // Water overlay
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      if (map.waterMask.get(gx, gz) > 0) {
        ctx.fillStyle = 'rgba(34, 102, 204, 0.7)';
        ctx.fillRect(gx, gz, 1, 1);
      }
    }
  }

  // Road overlay
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      if (map.roadGrid.get(gx, gz) > 0) {
        ctx.fillStyle = 'rgba(60, 60, 60, 0.8)';
        ctx.fillRect(gx, gz, 1, 1);
      }
      if (map.bridgeGrid.get(gx, gz) > 0) {
        ctx.fillStyle = 'rgba(255, 102, 0, 0.8)';
        ctx.fillRect(gx, gz, 1, 1);
      }
    }
  }

  // Regional settlement markers (colored by tier)
  if (map.regionalSettlements) {
    for (const s of map.regionalSettlements) {
      const r = s.tier === 1 ? 6 : s.tier === 2 ? 4 : 3;
      ctx.fillStyle = s.tier === 1 ? '#ff0000' : s.tier === 2 ? '#ff8800' : '#ffff00';
      ctx.beginPath();
      ctx.arc(s.cityGx, s.cityGz, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }
  }

  // Nucleus markers
  if (map.nuclei) {
    const typeColors = {
      waterfront: '#00aaff',
      market: '#ff4444',
      hilltop: '#ffaa00',
      valley: '#44cc44',
      roadside: '#aa44ff',
      suburban: '#888888',
    };

    for (const n of map.nuclei) {
      const color = typeColors[n.type] || '#ffffff';
      ctx.fillStyle = color;
      ctx.fillRect(n.gx - 2, n.gz - 2, 5, 5);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(n.gx - 2, n.gz - 2, 5, 5);
    }
  }
}

/**
 * Path cost visualization for a given preset.
 */
export function renderPathCost(ctx, map, preset = 'growth') {
  const { width, height } = map;
  const costFn = map.createPathCost(preset);

  // Sample costs from center of map
  const cx = Math.floor(width / 2);
  const cz = Math.floor(height / 2);
  const costs = [];
  let maxCost = 0;

  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      const c = costFn(cx, cz, gx, gz);
      const idx = gz * width + gx;
      costs[idx] = isFinite(c) ? c : -1;
      if (isFinite(c) && c > maxCost) maxCost = c;
    }
  }

  // Use log scale so road discount is visible against flat terrain
  const logMax = Math.log1p(maxCost);

  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      const idx = gz * width + gx;
      if (costs[idx] < 0) {
        ctx.fillStyle = '#000';
      } else {
        const v = 1 - Math.log1p(costs[idx]) / (logMax || 1);
        ctx.fillStyle = gray(v);
      }
      ctx.fillRect(gx, gz, 1, 1);
    }
  }
}

/**
 * Land value heatmap (warm = high value, cool = low).
 */
export function renderLandValue(ctx, map) {
  const { width, height } = map;

  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      if (map.waterMask.get(gx, gz) > 0) {
        ctx.fillStyle = '#1a3355';
        ctx.fillRect(gx, gz, 1, 1);
        continue;
      }
      const v = map.landValue.get(gx, gz);
      // Purple (low) → orange (mid) → yellow (high)
      const r = Math.round(Math.min(255, v * 400));
      const g = Math.round(Math.min(255, v * v * 300));
      const b = Math.round(Math.max(0, 80 - v * 200));
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(gx, gz, 1, 1);
    }
  }
}

/**
 * Nucleus locations overlay on terrain.
 */
export function renderNuclei(ctx, map) {
  renderComposite(ctx, map);
}

/**
 * Road popularity: brighter = more original A* paths share this cell.
 */
export function renderRoadPopularity(ctx, map) {
  const { width, height } = map;
  if (!map.roadPopularity) return;

  // Find max popularity for normalization
  let maxPop = 1;
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      const v = map.roadPopularity.get(gx, gz);
      if (v > maxPop) maxPop = v;
    }
  }

  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      if (map.waterMask.get(gx, gz) > 0) {
        ctx.fillStyle = '#0a1a2e';
      } else {
        const pop = map.roadPopularity.get(gx, gz);
        if (pop === 0) {
          ctx.fillStyle = '#111';
        } else {
          // Yellow-orange heat: more popular = brighter
          const t = pop / maxPop;
          const r = Math.round(255 * Math.min(1, t * 2));
          const g = Math.round(200 * Math.min(1, t * 1.5));
          const b = Math.round(50 * t);
          ctx.fillStyle = `rgb(${r},${g},${b})`;
        }
      }
      ctx.fillRect(gx, gz, 1, 1);
    }
  }
}

/**
 * Water depth: distance from land into water. Brighter = deeper.
 */
export function renderWaterDepth(ctx, map) {
  const { width, height } = map;
  if (!map.waterDepth) return;

  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      if (map.waterMask.get(gx, gz) === 0) {
        ctx.fillStyle = '#ddeedd';
      } else {
        const depth = map.waterDepth.get(gx, gz);
        // Shallow = bright cyan, deep = dark blue
        const t = Math.min(1, depth / 10);
        const r = Math.round(30 * (1 - t));
        const g = Math.round(200 * (1 - t) + 40);
        const b = Math.round(220 - 100 * t);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
      }
      ctx.fillRect(gx, gz, 1, 1);
    }
  }
}

/**
 * Road sources: red = anchor (regional imports), green = MST, blue = extras.
 */
export function renderRoadSources(ctx, map) {
  const { width, height } = map;

  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      // Dark base
      if (map.waterMask.get(gx, gz) > 0) {
        ctx.fillStyle = '#0a1a2e';
      } else {
        ctx.fillStyle = '#1a1a1a';
      }
      ctx.fillRect(gx, gz, 1, 1);

      // Overlay road sources (priority: anchor > mst > extra)
      if (map.debugAnchorGrid && map.debugAnchorGrid.get(gx, gz) > 0) {
        ctx.fillStyle = '#ff4444';
        ctx.fillRect(gx, gz, 1, 1);
      } else if (map.debugMstGrid && map.debugMstGrid.get(gx, gz) > 0) {
        ctx.fillStyle = '#44ff44';
        ctx.fillRect(gx, gz, 1, 1);
      } else if (map.debugExtraGrid && map.debugExtraGrid.get(gx, gz) > 0) {
        ctx.fillStyle = '#4488ff';
        ctx.fillRect(gx, gz, 1, 1);
      }
    }
  }
}

/**
 * City blocks — enclosed faces from the planar graph, each filled with a distinct color.
 */
export function renderCityBlocks(ctx, map) {
  const { width, height } = map;

  // Dark background
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      if (map.waterMask.get(gx, gz) > 0) {
        ctx.fillStyle = '#1a3355';
      } else {
        ctx.fillStyle = '#1a1a1a';
      }
      ctx.fillRect(gx, gz, 1, 1);
    }
  }

  const graph = map.graph;
  if (!graph) return;

  const faces = graph.faces();
  const hueStep = 137.508;
  const ox = map.originX, oz = map.originZ, cs = map.cellSize;

  for (let fi = 0; fi < faces.length; fi++) {
    const face = faces[fi];
    if (face.length < 3) continue;

    // Convert node IDs to grid coordinates
    const pts = face.map(nid => {
      const node = graph.nodes.get(nid);
      if (!node) return null;
      return {
        gx: (node.x - ox) / cs,
        gz: (node.z - oz) / cs,
      };
    }).filter(Boolean);

    if (pts.length < 3) continue;

    // Skip the outer (unbounded) face — it will have very large area
    let area = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      area += (a.gx * b.gz - b.gx * a.gz);
    }
    area = Math.abs(area) / 2;
    if (area > width * height * 0.5) continue; // skip outer face
    if (area < 4) continue; // skip degenerate faces

    const hue = (fi * hueStep) % 360;
    ctx.fillStyle = `hsla(${hue}, 70%, 50%, 0.6)`;
    ctx.strokeStyle = `hsla(${hue}, 70%, 40%, 0.9)`;
    ctx.lineWidth = 0.5;

    ctx.beginPath();
    ctx.moveTo(pts[0].gx, pts[0].gz);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i].gx, pts[i].gz);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  // Overlay roads on top
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      if (map.roadGrid.get(gx, gz) > 0) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
        ctx.fillRect(gx, gz, 1, 1);
      }
    }
  }
}

/**
 * Development zones — flood-filled zones colored by nucleus ownership.
 */
export function renderDevZones(ctx, map) {
  renderTerrain(ctx, map);

  const { width, height } = map;

  // Water
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      if (map.waterMask.get(gx, gz) > 0) {
        ctx.fillStyle = 'rgba(34, 102, 204, 0.7)';
        ctx.fillRect(gx, gz, 1, 1);
      }
    }
  }

  // Zones colored by nucleus
  if (map.developmentZones) {
    const hueStep = 137.508;
    const ox = map.originX, oz = map.originZ, cs = map.cellSize;
    for (let i = 0; i < map.developmentZones.length; i++) {
      const zone = map.developmentZones[i];
      const hue = (zone.nucleusIdx * hueStep + 30) % 360;
      ctx.fillStyle = `hsla(${hue}, 70%, 55%, 0.5)`;
      for (const c of zone.cells) {
        ctx.fillRect(c.gx, c.gz, 1, 1);
      }

      // Draw boundary
      if (zone.boundary && zone.boundary.length > 2) {
        ctx.strokeStyle = `hsla(${hue}, 70%, 70%, 0.8)`;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo((zone.boundary[0].x - ox) / cs, (zone.boundary[0].z - oz) / cs);
        for (let j = 1; j < zone.boundary.length; j++) {
          ctx.lineTo((zone.boundary[j].x - ox) / cs, (zone.boundary[j].z - oz) / cs);
        }
        ctx.closePath();
        ctx.stroke();
      }
    }
  }

  // Roads
  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      if (map.roadGrid.get(gx, gz) > 0) {
        ctx.fillStyle = 'rgba(60, 60, 60, 0.8)';
        ctx.fillRect(gx, gz, 1, 1);
      }
    }
  }

  // Nuclei
  if (map.nuclei) {
    for (const n of map.nuclei) {
      ctx.fillStyle = '#ff4444';
      ctx.fillRect(n.gx - 2, n.gz - 2, 5, 5);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(n.gx - 2, n.gz - 2, 5, 5);
    }
  }
}

/**
 * Zone priority — zones colored by development order (first = bright, last = dim).
 */
export function renderZonePriority(ctx, map) {
  renderTerrain(ctx, map);

  const { width, height } = map;

  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      if (map.waterMask.get(gx, gz) > 0) {
        ctx.fillStyle = 'rgba(34, 102, 204, 0.7)';
        ctx.fillRect(gx, gz, 1, 1);
      }
    }
  }

  if (map.developmentZones && map.developmentZones.length > 0) {
    const total = map.developmentZones.length;
    for (let i = 0; i < total; i++) {
      const zone = map.developmentZones[i];
      const brightness = 1 - (i / total) * 0.7;
      const r = Math.round(255 * brightness);
      const g = Math.round(200 * brightness);
      const b = Math.round(50);
      ctx.fillStyle = `rgba(${r},${g},${b},0.6)`;
      for (const c of zone.cells) {
        ctx.fillRect(c.gx, c.gz, 1, 1);
      }
    }
  }
}

/**
 * Street orientation — zones with arrows showing ribbon direction.
 */
export function renderStreetOrientation(ctx, map) {
  renderDevZones(ctx, map);

  if (map.developmentZones && map.nuclei) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    for (const zone of map.developmentZones) {
      const n = map.nuclei[zone.nucleusIdx];
      if (!n) continue;

      // Compute ribbon direction (same logic as computeRibbonOrientation)
      let dirX, dirZ;
      if (zone.avgSlope > 0.1 && (zone.slopeDir.x !== 0 || zone.slopeDir.z !== 0)) {
        dirX = -zone.slopeDir.z;
        dirZ = zone.slopeDir.x;
        const len = Math.sqrt(dirX * dirX + dirZ * dirZ);
        dirX /= len; dirZ /= len;
      } else {
        const bx = n.gx - zone.centroidGx;
        const bz = n.gz - zone.centroidGz;
        const len = Math.sqrt(bx * bx + bz * bz) || 1;
        dirX = bx / len; dirZ = bz / len;
      }

      const cx = zone.centroidGx;
      const cz = zone.centroidGz;
      const arrowLen = 15;
      ctx.beginPath();
      ctx.moveTo(cx - dirX * arrowLen, cz - dirZ * arrowLen);
      ctx.lineTo(cx + dirX * arrowLen, cz + dirZ * arrowLen);
      ctx.stroke();

      const headLen = 4;
      const ax = cx + dirX * arrowLen;
      const az = cz + dirZ * arrowLen;
      ctx.beginPath();
      ctx.moveTo(ax, az);
      ctx.lineTo(
        ax - dirX * headLen + dirZ * headLen * 0.5,
        az - dirZ * headLen - dirX * headLen * 0.5,
      );
      ctx.moveTo(ax, az);
      ctx.lineTo(
        ax - dirX * headLen - dirZ * headLen * 0.5,
        az - dirZ * headLen + dirX * headLen * 0.5,
      );
      ctx.stroke();
    }
  }
}

/**
 * Generic coverage layer heatmap renderer.
 * Reads from map._coverage[layerName].
 */
function renderCoverageLayer(ctx, map, layerName, color) {
  const { width, height } = map;
  const layer = map._coverage && map._coverage[layerName];
  if (!layer) return;

  for (let gz = 0; gz < height; gz++) {
    for (let gx = 0; gx < width; gx++) {
      const v = layer[gz * width + gx];
      const r = Math.round(color[0] * v * 255);
      const g = Math.round(color[1] * v * 255);
      const b = Math.round(color[2] * v * 255);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(gx, gz, 1, 1);
    }
  }
}

/**
 * Available layer definitions for the debug viewer.
 */
export const LAYERS = [
  { name: 'Composite', render: renderComposite },
  { name: 'Terrain', render: renderTerrain },
  { name: 'Slope', render: renderSlope },
  { name: 'Buildability', render: renderBuildability },
  { name: 'Water Mask', render: renderWaterMask },
  { name: 'Water Type', render: renderWaterType },
  { name: 'Bridge Grid', render: renderBridgeGrid },
  { name: 'Road Grid', render: renderRoadGrid },
  { name: 'Land Value', render: renderLandValue },
  { name: 'Nuclei', render: renderNuclei },
  { name: 'Path Cost (growth)', render: (ctx, map) => renderPathCost(ctx, map, 'growth') },
  { name: 'Path Cost (nucleus)', render: (ctx, map) => renderPathCost(ctx, map, 'nucleus') },
  { name: 'Road Sources', render: renderRoadSources },
  { name: 'Road Popularity', render: renderRoadPopularity },
  { name: 'Water Depth', render: renderWaterDepth },
  { name: 'Development Zones', render: renderDevZones },
  { name: 'Zone Priority', render: renderZonePriority },
  { name: 'Street Orientation', render: renderStreetOrientation },
  { name: 'City Blocks', render: renderCityBlocks },
  { name: 'Coverage: Water', render: (ctx, map) => renderCoverageLayer(ctx, map, 'water', [0.2, 0.4, 1.0]) },
  { name: 'Coverage: Road', render: (ctx, map) => renderCoverageLayer(ctx, map, 'road', [0.8, 0.8, 0.7]) },
  { name: 'Coverage: Development', render: (ctx, map) => renderCoverageLayer(ctx, map, 'development', [1.0, 0.7, 0.3]) },
  { name: 'Coverage: Forest', render: (ctx, map) => renderCoverageLayer(ctx, map, 'forest', [0.1, 0.7, 0.1]) },
  { name: 'Coverage: Land Cover', render: (ctx, map) => renderCoverageLayer(ctx, map, 'landCover', [0.7, 0.6, 0.3]) },
  { name: 'Development Pressure', render: (ctx, map) => {
    if (!map.developmentZones) return;
    for (const zone of map.developmentZones) {
      const pressure = zone.pressure ?? 0;
      const r = Math.round(pressure * 255);
      const b = Math.round((1 - pressure) * 255);
      ctx.fillStyle = `rgb(${r},0,${b})`;
      for (const c of zone.cells) {
        ctx.fillRect(c.gx, c.gz, 1, 1);
      }
    }
  }},
];
