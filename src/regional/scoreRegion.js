// ── Helpers ──────────────────────────────────────────────────────────────────

function collectSegments(nodes, result = []) {
  for (const node of nodes) {
    result.push(node);
    if (node.children) collectSegments(node.children, result);
  }
  return result;
}

function gridPathLength(path, cellSize) {
  let len = 0;
  for (let i = 1; i < path.length; i++) {
    const dx = (path[i].gx - path[i - 1].gx) * cellSize;
    const dz = (path[i].gz - path[i - 1].gz) * cellSize;
    len += Math.sqrt(dx * dx + dz * dz);
  }
  return len;
}

function computeElevationPercentile(heightmap, pct) {
  const W = heightmap.width;
  const H = heightmap.height;
  const elevs = new Float32Array(W * H);
  for (let gz = 0; gz < H; gz++) {
    for (let gx = 0; gx < W; gx++) {
      elevs[gz * W + gx] = heightmap.get(gx, gz);
    }
  }
  elevs.sort();
  return elevs[Math.floor(elevs.length * pct)];
}

function computeSlope(heightmap, gx, gz) {
  const W = heightmap.width;
  const H = heightmap.height;
  const cs = heightmap._cellSize;
  const x0 = Math.max(0, gx - 1);
  const x1 = Math.min(W - 1, gx + 1);
  const z0 = Math.max(0, gz - 1);
  const z1 = Math.min(H - 1, gz + 1);
  const dEdx = (heightmap.get(x1, gz) - heightmap.get(x0, gz)) / ((x1 - x0) * cs);
  const dEdz = (heightmap.get(gx, z1) - heightmap.get(gx, z0)) / ((z1 - z0) * cs);
  return Math.atan(Math.sqrt(dEdx * dEdx + dEdz * dEdz)) * (180 / Math.PI);
}

function weightedMean(checks, weights) {
  let sum = 0, wsum = 0;
  for (const [key, w] of Object.entries(weights)) {
    if (checks[key]) {
      sum += checks[key].score * w;
      wsum += w;
    }
  }
  return wsum > 0 ? sum / wsum : 0;
}

function gaussianScore(value, target, sigma) {
  const diff = (value - target) / sigma;
  return Math.exp(-(diff * diff));
}

function gridDist(a, b) {
  const dx = a.gx - b.gx;
  const dz = a.gz - b.gz;
  return Math.sqrt(dx * dx + dz * dz);
}

// ── Tier 1: Validity ─────────────────────────────────────────────────────────

/** V1: Roads on Land — no road path cell in waterCells (allow crossing tolerance) */
function checkV1(region) {
  const { roads, drainage } = region;
  const { waterCells, crossings } = drainage;
  if (!roads || roads.length === 0) return { pass: true, details: 'No roads' };

  // Build set of crossing-adjacent cells for tolerance
  const crossingCells = new Set();
  const W = region.heightmap.width;
  if (crossings) {
    for (const c of crossings) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          crossingCells.add((c.gz + dz) * W + (c.gx + dx));
        }
      }
    }
  }

  let violations = 0;
  for (const road of roads) {
    if (!road.path) continue;
    for (const cell of road.path) {
      const idx = cell.gz * W + cell.gx;
      if (waterCells.has(idx) && !crossingCells.has(idx)) {
        violations++;
        break;
      }
    }
  }

  const pass = violations === 0;
  return { pass, details: pass ? 'OK' : `${violations} road(s) with cells in water` };
}

/** V2: Settlements on Land — not in water, slope < 30° */
function checkV2(region) {
  const { settlements, drainage, heightmap } = region;
  if (!settlements || settlements.length === 0) return { pass: true, details: 'No settlements' };

  const W = heightmap.width;
  let violations = 0;
  const details = [];

  for (const s of settlements) {
    const idx = s.gz * W + s.gx;
    if (drainage.waterCells.has(idx)) {
      violations++;
      details.push(`${s.rank} at (${s.gx},${s.gz}) in water`);
      continue;
    }
    const slope = computeSlope(heightmap, s.gx, s.gz);
    if (slope > 30) {
      violations++;
      details.push(`${s.rank} at (${s.gx},${s.gz}) slope=${slope.toFixed(1)}°`);
    }
  }

  const pass = violations === 0;
  return { pass, details: pass ? 'OK' : details.join('; ') };
}

/** V3: Road Connectivity — BFS through road adjacency; all settlements reachable */
function checkV3(region) {
  const { settlements, roads } = region;
  if (!settlements || settlements.length <= 1) return { pass: true, details: 'OK' };
  if (!roads || roads.length === 0) return { pass: false, details: 'No roads but multiple settlements' };

  // Build adjacency by settlement reference
  const adj = new Map();
  for (const road of roads) {
    if (!adj.has(road.from)) adj.set(road.from, []);
    if (!adj.has(road.to)) adj.set(road.to, []);
    adj.get(road.from).push(road.to);
    adj.get(road.to).push(road.from);
  }

  // BFS from first settlement
  const visited = new Set();
  const queue = [settlements[0]];
  visited.add(settlements[0]);
  while (queue.length > 0) {
    const cur = queue.shift();
    for (const nb of (adj.get(cur) || [])) {
      if (!visited.has(nb)) {
        visited.add(nb);
        queue.push(nb);
      }
    }
  }

  const unreached = settlements.filter(s => !visited.has(s));
  const pass = unreached.length === 0;
  return {
    pass,
    details: pass ? 'OK' : `${unreached.length} settlement(s) unreachable`,
  };
}

/** V4: River Flow — elevation monotonically non-increasing along each segment */
function checkV4(region) {
  const { drainage } = region;
  if (!drainage.streams || drainage.streams.length === 0) return { pass: true, details: 'No streams' };

  const segments = collectSegments(drainage.streams);
  let violations = 0;
  const eps = 1e-4;

  for (const seg of segments) {
    for (let i = 1; i < seg.cells.length; i++) {
      if (seg.cells[i].elevation > seg.cells[i - 1].elevation + eps) {
        violations++;
        break;
      }
    }
  }

  const pass = violations === 0;
  return { pass, details: pass ? 'OK' : `${violations} segment(s) flow uphill` };
}

/** V5: River Termination — root stream's last cell adjacent to waterCell or at map edge */
function checkV5(region) {
  const { drainage, heightmap } = region;
  if (!drainage.streams || drainage.streams.length === 0) return { pass: true, details: 'No streams' };

  const W = heightmap.width;
  const H = heightmap.height;
  let violations = 0;

  for (const root of drainage.streams) {
    const lastCell = root.cells[root.cells.length - 1];
    const { gx, gz } = lastCell;

    // At map edge?
    if (gx <= 0 || gx >= W - 1 || gz <= 0 || gz >= H - 1) continue;

    // Adjacent to waterCell?
    let adjacentToWater = false;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const idx = (gz + dz) * W + (gx + dx);
        if (drainage.waterCells.has(idx)) {
          adjacentToWater = true;
          break;
        }
      }
      if (adjacentToWater) break;
    }

    if (!adjacentToWater) violations++;
  }

  const pass = violations === 0;
  return { pass, details: pass ? 'OK' : `${violations} root stream(s) not terminating at water/edge` };
}

/** V6: Settlement Spacing — same-rank pairs exceed minimum spacing */
function checkV6(region) {
  const { settlements, params } = region;
  if (!settlements || settlements.length < 2) return { pass: true, details: 'OK' };

  const minSpacings = {
    city: params.minCitySpacing || 80,
    town: params.minTownSpacing || 30,
    village: params.minVillageSpacing || 15,
  };

  let violations = 0;
  for (let i = 0; i < settlements.length; i++) {
    for (let j = i + 1; j < settlements.length; j++) {
      const a = settlements[i];
      const b = settlements[j];
      if (a.rank !== b.rank) continue;
      const dist = gridDist(a, b);
      // Allow 10% tolerance for grid-based placement
      if (dist < minSpacings[a.rank] * 0.9) {
        violations++;
      }
    }
  }

  const pass = violations === 0;
  return { pass, details: pass ? 'OK' : `${violations} same-rank pair(s) too close` };
}

/** V9: River Source Logic — leaf segment's first cell above 50th %ile, at map edge, or adjacent to water */
function checkV9(region) {
  const { drainage, heightmap } = region;
  if (!drainage.streams || drainage.streams.length === 0) return { pass: true, details: 'No streams' };

  const W = heightmap.width;
  const H = heightmap.height;
  const p50 = computeElevationPercentile(heightmap, 0.5);
  const segments = collectSegments(drainage.streams);

  // Leaf segments = those with no children
  const leaves = segments.filter(s => !s.children || s.children.length === 0);
  let violations = 0;

  for (const leaf of leaves) {
    const first = leaf.cells[0];
    const { gx, gz, elevation } = first;

    // Above 50th percentile?
    if (elevation >= p50) continue;

    // At map edge?
    if (gx <= 0 || gx >= W - 1 || gz <= 0 || gz >= H - 1) continue;

    // Adjacent to waterCell?
    let adjacentToWater = false;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const idx = (gz + dz) * W + (gx + dx);
        if (drainage.waterCells.has(idx)) {
          adjacentToWater = true;
          break;
        }
      }
      if (adjacentToWater) break;
    }

    if (!adjacentToWater) violations++;
  }

  const pass = violations === 0;
  return {
    pass,
    details: pass ? 'OK' : `${violations}/${leaves.length} leaf source(s) in lowland without water/edge`,
  };
}

// ── Tier 2: Structural ──────────────────────────────────────────────────────

/** S1: Road Gradient — gradient per path segment vs hierarchy limits */
function checkS1(region) {
  const { roads, heightmap } = region;
  if (!roads || roads.length === 0) return { score: 1, threshold: 0.85, details: 'No roads' };

  const cs = heightmap._cellSize;
  const gradLimits = { major: 0.06, secondary: 0.08, minor: 0.12 };

  let compliantLen = 0;
  let totalLen = 0;

  for (const road of roads) {
    if (!road.path || road.path.length < 2) continue;
    const limit = gradLimits[road.hierarchy] || 0.12;

    for (let i = 1; i < road.path.length; i++) {
      const a = road.path[i - 1];
      const b = road.path[i];
      const dx = (b.gx - a.gx) * cs;
      const dz = (b.gz - a.gz) * cs;
      const hDist = Math.sqrt(dx * dx + dz * dz);
      if (hDist < 0.1) continue;

      const e0 = heightmap.get(a.gx, a.gz);
      const e1 = heightmap.get(b.gx, b.gz);
      const gradient = Math.abs(e1 - e0) / hDist;

      totalLen += hDist;
      if (gradient <= limit) compliantLen += hDist;
    }
  }

  if (totalLen === 0) return { score: 1, threshold: 0.85, details: 'No measurable road length' };
  const score = compliantLen / totalLen;
  return { score, threshold: 0.85, details: `${(score * 100).toFixed(1)}% within gradient limits` };
}

/** S3: Road Hierarchy Coherence */
function checkS3(region) {
  const { settlements, roads } = region;
  if (!settlements || settlements.length === 0) return { score: 1, threshold: 0.80, details: 'No settlements' };
  if (!roads || roads.length === 0) return { score: 0, threshold: 0.80, details: 'No roads' };

  const cities = settlements.filter(s => s.rank === 'city');
  const towns = settlements.filter(s => s.rank === 'town');
  const villages = settlements.filter(s => s.rank === 'village');

  // Build adjacency with road hierarchy info
  const adj = new Map();
  for (const road of roads) {
    if (!adj.has(road.from)) adj.set(road.from, []);
    if (!adj.has(road.to)) adj.set(road.to, []);
    adj.get(road.from).push({ settlement: road.to, hierarchy: road.hierarchy });
    adj.get(road.to).push({ settlement: road.from, hierarchy: road.hierarchy });
  }

  let checks = 0;
  let passes = 0;

  // Cities have a major road
  for (const city of cities) {
    checks++;
    const edges = adj.get(city) || [];
    if (edges.some(e => e.hierarchy === 'major')) passes++;
  }

  // Towns within 1 hop of major/secondary
  for (const town of towns) {
    checks++;
    const edges = adj.get(town) || [];
    const directMajorSec = edges.some(e => e.hierarchy === 'major' || e.hierarchy === 'secondary');
    if (directMajorSec) { passes++; continue; }
    // 1-hop: check neighbors
    let found = false;
    for (const e of edges) {
      const neighborEdges = adj.get(e.settlement) || [];
      if (neighborEdges.some(ne => ne.hierarchy === 'major' || ne.hierarchy === 'secondary')) {
        found = true;
        break;
      }
    }
    if (found) passes++;
  }

  // Villages connected (have at least one road)
  for (const village of villages) {
    checks++;
    if (adj.has(village) && adj.get(village).length > 0) passes++;
  }

  if (checks === 0) return { score: 1, threshold: 0.80, details: 'No hierarchy checks' };
  const score = passes / checks;
  return { score, threshold: 0.80, details: `${passes}/${checks} hierarchy checks pass` };
}

/** S4: Settlement Geography — river proximity, flatness, route convergence */
function checkS4(region) {
  const { settlements, drainage, heightmap, roads } = region;
  if (!settlements || settlements.length === 0) return { score: 1, threshold: 0.80, details: 'No settlements' };

  const W = heightmap.width;
  const H = heightmap.height;
  let sumQuality = 0;

  for (const s of settlements) {
    // River proximity (0.4 weight): distance to nearest waterCell
    let minWaterDist = Infinity;
    const searchR = 15;
    for (let dz = -searchR; dz <= searchR; dz++) {
      for (let dx = -searchR; dx <= searchR; dx++) {
        const nx = s.gx + dx;
        const nz = s.gz + dz;
        if (nx < 0 || nx >= W || nz < 0 || nz >= H) continue;
        if (drainage.waterCells.has(nz * W + nx)) {
          const d = Math.sqrt(dx * dx + dz * dz);
          if (d < minWaterDist) minWaterDist = d;
        }
      }
    }
    const riverScore = minWaterDist <= searchR ? gaussianScore(minWaterDist, 0, 8) : 0;

    // Flatness (0.3 weight): average slope in 3-cell radius
    let slopeSum = 0;
    let slopeCount = 0;
    for (let dz = -3; dz <= 3; dz++) {
      for (let dx = -3; dx <= 3; dx++) {
        const nx = s.gx + dx;
        const nz = s.gz + dz;
        if (nx < 0 || nx >= W || nz < 0 || nz >= H) continue;
        slopeSum += computeSlope(heightmap, nx, nz);
        slopeCount++;
      }
    }
    const avgSlope = slopeCount > 0 ? slopeSum / slopeCount : 0;
    const flatScore = gaussianScore(avgSlope, 0, 15);

    // Route convergence (0.3 weight): number of road entries
    const roadEntries = s.roadEntries ? s.roadEntries.length : 0;
    const routeScore = Math.min(1, roadEntries / 3);

    const quality = riverScore * 0.4 + flatScore * 0.3 + routeScore * 0.3;
    sumQuality += quality;
  }

  const score = sumQuality / settlements.length;
  return { score, threshold: 0.80, details: `Mean geography quality ${score.toFixed(3)}` };
}

/** S8: Highland Road Avoidance — major roads: fraction of cells below 60th %ile */
function checkS8(region) {
  const { roads, heightmap } = region;
  if (!roads || roads.length === 0) return { score: 1, threshold: 0.75, details: 'No roads' };

  const majorRoads = roads.filter(r => r.hierarchy === 'major');
  if (majorRoads.length === 0) return { score: 1, threshold: 0.75, details: 'No major roads' };

  const p60 = computeElevationPercentile(heightmap, 0.6);
  let lowCells = 0;
  let totalCells = 0;

  for (const road of majorRoads) {
    if (!road.path) continue;
    for (const cell of road.path) {
      const elev = heightmap.get(cell.gx, cell.gz);
      totalCells++;
      if (elev <= p60) lowCells++;
    }
  }

  if (totalCells === 0) return { score: 1, threshold: 0.75, details: 'No major road cells' };
  const score = lowCells / totalCells;
  return { score, threshold: 0.75, details: `${(score * 100).toFixed(1)}% of major road cells in lowlands` };
}

/** S9: River Sinuosity — segments ≥5 cells, sinuosity in range by slope */
function checkS9(region) {
  const { drainage, heightmap } = region;
  if (!drainage.streams || drainage.streams.length === 0) return { score: 1, threshold: 0.80, details: 'No streams' };

  const cs = heightmap._cellSize;
  const segments = collectSegments(drainage.streams);
  const qualifying = segments.filter(s => s.cells.length >= 5);
  if (qualifying.length === 0) return { score: 1, threshold: 0.80, details: 'No qualifying segments' };

  let inRange = 0;
  for (const seg of qualifying) {
    const cells = seg.cells;
    const pathLen = gridPathLength(cells, cs);
    const first = cells[0];
    const last = cells[cells.length - 1];
    const straightDx = (last.gx - first.gx) * cs;
    const straightDz = (last.gz - first.gz) * cs;
    const straightLen = Math.sqrt(straightDx * straightDx + straightDz * straightDz);
    if (straightLen < 0.01) { inRange++; continue; } // nearly zero length, skip

    const sinuosity = pathLen / straightLen;

    // Compute average slope along segment
    const elevDiff = Math.abs(first.elevation - last.elevation);
    const avgGradient = elevDiff / pathLen;

    // Classify terrain and get expected sinuosity range
    let minSin, maxSin;
    if (avgGradient > 0.05) {
      // Steep
      minSin = 1.0; maxSin = 1.5;
    } else if (avgGradient > 0.01) {
      // Moderate
      minSin = 1.1; maxSin = 1.8;
    } else {
      // Gentle
      minSin = 1.2; maxSin = 3.0;
    }

    // Allow small tolerance outside range
    if (sinuosity >= minSin * 0.9 && sinuosity <= maxSin * 1.1) inRange++;
  }

  const score = inRange / qualifying.length;
  return { score, threshold: 0.80, details: `${inRange}/${qualifying.length} segments in sinuosity range` };
}

// ── Tier 3: Quality ─────────────────────────────────────────────────────────

/** Q2: Road Hierarchy Ratio — length by tier vs targets */
function checkQ2(region) {
  const { roads, heightmap } = region;
  if (!roads || roads.length === 0) return { score: 0.5, details: 'No roads' };

  const cs = heightmap._cellSize;
  const lengths = { major: 0, secondary: 0, minor: 0 };

  for (const road of roads) {
    if (!road.path || road.path.length < 2) continue;
    const len = gridPathLength(road.path, cs);
    const tier = road.hierarchy || 'minor';
    lengths[tier] = (lengths[tier] || 0) + len;
  }

  const total = lengths.major + lengths.secondary + lengths.minor;
  if (total === 0) return { score: 0.5, details: 'No measurable road length' };

  const ratios = {
    major: lengths.major / total,
    secondary: lengths.secondary / total,
    minor: lengths.minor / total,
  };

  const targets = { major: 0.15, secondary: 0.35, minor: 0.50 };
  const sigmas = { major: 0.15, secondary: 0.20, minor: 0.20 };

  let sumScore = 0;
  for (const tier of ['major', 'secondary', 'minor']) {
    sumScore += gaussianScore(ratios[tier], targets[tier], sigmas[tier]);
  }

  const score = sumScore / 3;
  return {
    score,
    details: `major=${(ratios.major * 100).toFixed(1)}% sec=${(ratios.secondary * 100).toFixed(1)}% minor=${(ratios.minor * 100).toFixed(1)}%`,
  };
}

/** Q5: Road Directness — detour index per road, proportion in expected range */
function checkQ5(region) {
  const { roads, heightmap } = region;
  if (!roads || roads.length === 0) return { score: 0.5, details: 'No roads' };

  const cs = heightmap._cellSize;
  let inRange = 0;
  let total = 0;

  for (const road of roads) {
    if (!road.path || road.path.length < 2) continue;
    const pathLen = gridPathLength(road.path, cs);
    const first = road.path[0];
    const last = road.path[road.path.length - 1];
    const dx = (last.gx - first.gx) * cs;
    const dz = (last.gz - first.gz) * cs;
    const straightLen = Math.sqrt(dx * dx + dz * dz);
    if (straightLen < 0.01) continue;

    total++;
    const detour = pathLen / straightLen;

    // Estimate terrain difficulty from average gradient along path
    const elevDiff = Math.abs(
      heightmap.get(first.gx, first.gz) - heightmap.get(last.gx, last.gz)
    );
    const avgGradient = elevDiff / pathLen;

    let minDetour, maxDetour;
    if (avgGradient > 0.03) {
      minDetour = 1.3; maxDetour = 3.0;
    } else if (avgGradient > 0.01) {
      minDetour = 1.1; maxDetour = 2.0;
    } else {
      minDetour = 1.0; maxDetour = 1.5;
    }

    if (detour >= minDetour && detour <= maxDetour) inRange++;
  }

  if (total === 0) return { score: 0.5, details: 'No measurable roads' };
  const score = inRange / total;
  return { score, details: `${inRange}/${total} roads in detour range` };
}

/** Q8: Settlement Clustering — proportion within 5 grid cells of road/water/coast */
function checkQ8(region) {
  const { settlements, roads, drainage, heightmap } = region;
  if (!settlements || settlements.length === 0) return { score: 0.5, details: 'No settlements' };

  const W = heightmap.width;
  const H = heightmap.height;
  const threshold = 5; // grid cells

  // Build set of road cells for fast lookup — only major/secondary roads
  // count as "corridors" (minor spur roads to villages don't define corridors)
  const roadCells = new Set();
  if (roads) {
    for (const road of roads) {
      if (!road.path) continue;
      if (road.hierarchy === 'minor') continue;
      for (const cell of road.path) {
        roadCells.add(cell.gz * W + cell.gx);
      }
    }
  }

  let onCorridor = 0;
  for (const s of settlements) {
    let nearFeature = false;
    for (let dz = -threshold; dz <= threshold && !nearFeature; dz++) {
      for (let dx = -threshold; dx <= threshold && !nearFeature; dx++) {
        const nx = s.gx + dx;
        const nz = s.gz + dz;
        if (nx < 0 || nx >= W || nz < 0 || nz >= H) continue;
        const idx = nz * W + nx;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist > threshold) continue;
        if (drainage.waterCells.has(idx) || roadCells.has(idx)) {
          nearFeature = true;
        }
      }
    }
    if (nearFeature) onCorridor++;
  }

  const proportion = onCorridor / settlements.length;
  // Use wider sigma — on smaller maps, all settlements near corridors is normal
  const score = gaussianScore(proportion, 0.8, 0.15);
  return { score, details: `${onCorridor}/${settlements.length} near corridor (${(proportion * 100).toFixed(0)}%)` };
}

/** Q9: Terrain Transitions — per-cell max neighbor gradient, proportion in natural range */
function checkQ9(region) {
  const { heightmap } = region;
  const W = heightmap.width;
  const H = heightmap.height;
  const cs = heightmap._cellSize;

  let inRange = 0;
  let total = 0;
  // Sample every 4th cell for performance
  const step = Math.max(1, Math.floor(Math.min(W, H) / 64));

  for (let gz = 1; gz < H - 1; gz += step) {
    for (let gx = 1; gx < W - 1; gx += step) {
      const c = heightmap.get(gx, gz);
      let maxGrad = 0;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const n = heightmap.get(gx + dx, gz + dz);
          const dist = Math.sqrt(dx * dx + dz * dz) * cs;
          const grad = Math.abs(n - c) / dist;
          if (grad > maxGrad) maxGrad = grad;
        }
      }
      total++;
      if (maxGrad >= 0.0005 && maxGrad <= 0.5) inRange++;
    }
  }

  if (total === 0) return { score: 0.5, details: 'No terrain cells sampled' };
  const score = inRange / total;
  return { score, details: `${inRange}/${total} cells in natural gradient range` };
}

/** Q10: River-Settlement Relationship — towns/cities within 10 cells of water, villages within 15 */
function checkQ10(region) {
  const { settlements, drainage, heightmap } = region;
  if (!settlements || settlements.length === 0) return { score: 0.5, details: 'No settlements' };

  const W = heightmap.width;
  const H = heightmap.height;
  let passing = 0;

  for (const s of settlements) {
    const maxDist = s.rank === 'village' ? 15 : 10;
    let nearWater = false;

    for (let dz = -maxDist; dz <= maxDist && !nearWater; dz++) {
      for (let dx = -maxDist; dx <= maxDist && !nearWater; dx++) {
        const nx = s.gx + dx;
        const nz = s.gz + dz;
        if (nx < 0 || nx >= W || nz < 0 || nz >= H) continue;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist > maxDist) continue;
        if (drainage.waterCells.has(nz * W + nx)) {
          nearWater = true;
        }
      }
    }

    if (nearWater) passing++;
  }

  const score = passing / settlements.length;
  return { score, details: `${passing}/${settlements.length} settlements near water` };
}

// ── Composite ───────────────────────────────────────────────────────────────

const S_WEIGHTS = { S1: 0.20, S3: 0.20, S4: 0.25, S8: 0.15, S9: 0.20 };
const Q_WEIGHTS = { Q2: 0.15, Q5: 0.25, Q8: 0.20, Q9: 0.15, Q10: 0.25 };

// ── Main ────────────────────────────────────────────────────────────────────

export function scoreRegion(regionData) {
  const validity = {
    V1: checkV1(regionData),
    V2: checkV2(regionData),
    V3: checkV3(regionData),
    V4: checkV4(regionData),
    V5: checkV5(regionData),
    V6: checkV6(regionData),
    V9: checkV9(regionData),
  };

  const valid = Object.values(validity).every(v => v.pass);

  const structural = {
    S1: checkS1(regionData),
    S3: checkS3(regionData),
    S4: checkS4(regionData),
    S8: checkS8(regionData),
    S9: checkS9(regionData),
  };

  const quality = {
    Q2: checkQ2(regionData),
    Q5: checkQ5(regionData),
    Q8: checkQ8(regionData),
    Q9: checkQ9(regionData),
    Q10: checkQ10(regionData),
  };

  const structuralScore = weightedMean(structural, S_WEIGHTS);
  const qualityScore = weightedMean(quality, Q_WEIGHTS);
  const overallScore = structuralScore * 0.6 + qualityScore * 0.4;

  return {
    valid,
    validity,
    structural,
    quality,
    structuralScore,
    qualityScore,
    overallScore,
  };
}
