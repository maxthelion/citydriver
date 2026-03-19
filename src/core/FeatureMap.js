/**
 * FeatureMap: central class for city-scale spatial data.
 *
 * A layer bag + feature arrays + road network + metadata.
 * Pipeline steps read/write named layers via setLayer/getLayer.
 * No addFeature side effects — each step owns its own mutations.
 */

import { Grid2D } from './Grid2D.js';
import { RoadNetwork } from './RoadNetwork.js';
import { riverHalfWidth, channelProfile } from './riverGeometry.js';
import { RIVER_STAMP_FRACTION, STAMP_STEP_FRACTION } from '../city/constants.js';

// Land value constants
const LV_FLATNESS_WEIGHT = 0.6;
const LV_FLATNESS_RADIUS_M = 15;
const LV_FLATNESS_MAX_SLOPE = 0.4;
const LV_PROXIMITY_FALLOFF_M = 200;
const LV_WATER_BONUS_MAX = 0.15;
const LV_WATER_BONUS_RANGE_M = 50;
const LV_BUILDABLE_FLOOR = 0.2;

export class FeatureMap {
  /**
   * @param {number} width
   * @param {number} height
   * @param {number} cellSize
   * @param {object} [options]
   * @param {number} [options.originX=0]
   * @param {number} [options.originZ=0]
   */
  constructor(width, height, cellSize, options = {}) {
    const { originX = 0, originZ = 0 } = options;

    this.width = width;
    this.height = height;
    this.cellSize = cellSize;
    this.originX = originX;
    this.originZ = originZ;

    // Feature arrays
    this.rivers = [];
    this.plots = [];
    this.buildings = [];

    // Road network — single source of truth for roads, graph, roadGrid, bridgeGrid
    this.roadNetwork = new RoadNetwork(width, height, cellSize, originX, originZ);

    // Terrain grids (set by setup.js)
    this.elevation = null;
    this.slope = null;

    // Water grids (set by setup.js / classifyWater / computeWaterDepth)
    this.waterMask = new Grid2D(width, height, { type: 'uint8', cellSize, originX, originZ });
    this.waterType = null;
    this.waterDepth = null;
    this.waterDist = null;

    // Railway grid (stamped by setup.js)
    this.railwayGrid = new Grid2D(width, height, { type: 'uint8', cellSize, originX, originZ });

    // Land value (set by computeLandValue / setup.js)
    this.landValue = new Grid2D(width, height, { type: 'float32', cellSize, originX, originZ });

    // Named layers (Grid2D instances set by pipeline steps)
    this.layers = new Map();

    // Nucleus data
    this.nuclei = [];
  }

  // ── Road network delegation ────────────────────────────────────────────────

  get roads() { return this.roadNetwork.roads; }
  get graph() { return this.roadNetwork.graph; }
  get roadGrid() { return this.roadNetwork.roadGrid; }
  get bridgeGrid() { return this.roadNetwork.bridgeGrid; }

  // ── Layer bag ──────────────────────────────────────────────────────────────

  setLayer(name, grid) { this.layers.set(name, grid); }
  getLayer(name) { return this.layers.get(name); }
  hasLayer(name) { return this.layers.has(name); }

  // ── Path cost factory ──────────────────────────────────────────────────────

  /**
   * Create a cost function for A* pathfinding, parameterised by preset.
   * Reads terrainSuitability from the layer bag.
   */
  createPathCost(preset = 'growth') {
    const presets = {
      anchor:    { slopePenalty: 10, unbuildableCost: 15,       reuseDiscount: 0.01 },
      growth:    { slopePenalty: 10, unbuildableCost: Infinity, reuseDiscount: 0.5  },
      nucleus:   { slopePenalty: 5,  unbuildableCost: 12,       reuseDiscount: 0.1  },
      shortcuts: { slopePenalty: 8,  unbuildableCost: 20,       reuseDiscount: 1.0  },
      satellite: { slopePenalty: 10, unbuildableCost: Infinity, reuseDiscount: 0.15 },
      bridge:    { slopePenalty: 3,  unbuildableCost: 8,        reuseDiscount: 0.1  },
      extra:     { slopePenalty: 10, unbuildableCost: 15,       reuseDiscount: 0.01 },
    };

    const p = presets[preset] || presets.growth;
    const { slopePenalty, unbuildableCost, reuseDiscount } = p;

    const elevation = this.elevation;
    const terrainSuitability = this.getLayer('terrainSuitability');
    const roadGrid = this.roadGrid;
    const bridgeGrid = this.bridgeGrid;
    const waterDepth = this.waterDepth;
    const waterType = this.waterType;

    return (fromGx, fromGz, toGx, toGz) => {
      const dx = toGx - fromGx;
      const dz = toGz - fromGz;
      const baseDist = Math.sqrt(dx * dx + dz * dz);

      if (!elevation) return baseDist;

      if (waterType && waterType.get(toGx, toGz) === 1) return Infinity;

      const fromH = elevation.get(fromGx, fromGz);
      const toH = elevation.get(toGx, toGz);
      const slope = Math.abs(toH - fromH) / (baseDist * this.cellSize);

      let cost = baseDist + slope * slopePenalty;

      // Road reuse discount (early return)
      if (roadGrid.get(toGx, toGz) > 0) return baseDist * reuseDiscount;

      // Bridge penalty
      if (bridgeGrid.get(toGx, toGz) > 0) cost *= 8;

      // Terrain suitability check (replaces buildability)
      const b = terrainSuitability ? terrainSuitability.get(toGx, toGz) : 1;
      if (b < 0.01) {
        if (!isFinite(unbuildableCost)) return Infinity;
        if (waterDepth) {
          const depth = waterDepth.get(toGx, toGz);
          cost += unbuildableCost * depth;
        } else {
          cost += unbuildableCost;
        }
      } else if (b < 0.3) {
        cost *= 1 + 2 * (1 - b / 0.3);
      }

      return cost;
    };
  }

  // ── Water classification ───────────────────────────────────────────────────

  classifyWater(seaLevel) {
    this.waterType = new Grid2D(this.width, this.height, {
      type: 'uint8', cellSize: this.cellSize,
      originX: this.originX, originZ: this.originZ,
    });

    const isWater = new Uint8Array(this.width * this.height);
    for (let gz = 0; gz < this.height; gz++) {
      for (let gx = 0; gx < this.width; gx++) {
        const idx = gz * this.width + gx;
        if (this.waterMask.get(gx, gz) > 0 ||
            (this.elevation && this.elevation.get(gx, gz) < seaLevel)) {
          isWater[idx] = 1;
        }
      }
    }

    // BFS from boundary → sea (type 1)
    const queue = [];
    for (let gx = 0; gx < this.width; gx++) {
      if (isWater[gx]) { this.waterType.set(gx, 0, 1); queue.push(gx | (0 << 16)); }
      const bz = this.height - 1;
      if (isWater[bz * this.width + gx]) { this.waterType.set(gx, bz, 1); queue.push(gx | (bz << 16)); }
    }
    for (let gz = 0; gz < this.height; gz++) {
      if (isWater[gz * this.width]) { this.waterType.set(0, gz, 1); queue.push(0 | (gz << 16)); }
      const bx = this.width - 1;
      if (isWater[gz * this.width + bx]) { this.waterType.set(bx, gz, 1); queue.push(bx | (gz << 16)); }
    }

    const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
    let head = 0;
    while (head < queue.length) {
      const packed = queue[head++];
      const cx = packed & 0xFFFF, cz = packed >> 16;
      for (const [ddx, ddz] of dirs) {
        const nx = cx + ddx, nz = cz + ddz;
        if (nx < 0 || nx >= this.width || nz < 0 || nz >= this.height) continue;
        const nIdx = nz * this.width + nx;
        if (isWater[nIdx] && this.waterType.get(nx, nz) === 0) {
          this.waterType.set(nx, nz, 1);
          queue.push(nx | (nz << 16));
        }
      }
    }

    // Paint river paths as river (type 3)
    for (const river of this.rivers) {
      const polyline = river.polyline;
      if (!polyline || polyline.length < 2) continue;
      for (let i = 0; i < polyline.length - 1; i++) {
        const a = polyline[i], b = polyline[i + 1];
        const dx = b.x - a.x, dz = b.z - a.z;
        const segLen = Math.sqrt(dx * dx + dz * dz);
        if (segLen < 0.01) continue;
        const steps = Math.ceil(segLen / (this.cellSize * STAMP_STEP_FRACTION));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const px = a.x + dx * t, pz = a.z + dz * t;
          const aWidth = a.width || riverHalfWidth(a.accumulation || 1) * 2;
          const bWidth = b.width || riverHalfWidth(b.accumulation || 1) * 2;
          const halfW = (aWidth * (1 - t) + bWidth * t) / 2;
          const effectiveRadius = Math.max(halfW, this.cellSize * RIVER_STAMP_FRACTION);
          const cellRadius = Math.ceil(effectiveRadius / this.cellSize);
          const cgx = Math.round((px - this.originX) / this.cellSize);
          const cgz = Math.round((pz - this.originZ) / this.cellSize);
          for (let ddz = -cellRadius; ddz <= cellRadius; ddz++) {
            for (let ddx = -cellRadius; ddx <= cellRadius; ddx++) {
              const gx = cgx + ddx, gz = cgz + ddz;
              if (gx < 0 || gx >= this.width || gz < 0 || gz >= this.height) continue;
              if (this.waterType.get(gx, gz) === 1) continue;
              const cellX = this.originX + gx * this.cellSize;
              const cellZ = this.originZ + gz * this.cellSize;
              if ((cellX - px) ** 2 + (cellZ - pz) ** 2 <= effectiveRadius * effectiveRadius) {
                this.waterType.set(gx, gz, 3);
              }
            }
          }
        }
      }
    }

    // Remaining water → lake (type 2)
    for (let gz = 0; gz < this.height; gz++) {
      for (let gx = 0; gx < this.width; gx++) {
        if (isWater[gz * this.width + gx] && this.waterType.get(gx, gz) === 0) {
          this.waterType.set(gx, gz, 2);
        }
      }
    }
  }

  // ── Channel carving ────────────────────────────────────────────────────────

  carveChannels() {
    if (!this.elevation) return;

    // Phase 1: enforce monotonic downhill
    for (const river of this.rivers) {
      const polyline = river.polyline;
      if (!polyline || polyline.length < 2) continue;
      const elevations = polyline.map(p => {
        const gx = (p.x - this.originX) / this.cellSize;
        const gz = (p.z - this.originZ) / this.cellSize;
        return this.elevation.sample(gx, gz);
      });
      const flowsForward = elevations[0] >= elevations[elevations.length - 1];
      if (!flowsForward) elevations.reverse();
      for (let i = 1; i < elevations.length; i++) {
        if (elevations[i] > elevations[i - 1]) elevations[i] = elevations[i - 1];
      }
      if (!flowsForward) elevations.reverse();
      for (let i = 0; i < polyline.length; i++) polyline[i]._targetY = elevations[i];
    }

    // Phase 2: carve channels
    const seaLevel = this.seaLevel != null ? this.seaLevel : -Infinity;
    const seaFloor = seaLevel !== -Infinity ? seaLevel - 0.5 : -Infinity;
    for (const river of this.rivers) {
      const polyline = river.polyline;
      if (!polyline || polyline.length < 2) continue;
      for (let i = 0; i < polyline.length - 1; i++) {
        const a = polyline[i], b = polyline[i + 1];
        const dx = b.x - a.x, dz = b.z - a.z;
        const segLen = Math.sqrt(dx * dx + dz * dz);
        if (segLen < 0.01) continue;
        const steps = Math.ceil(segLen / (this.cellSize * STAMP_STEP_FRACTION));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const px = a.x + dx * t, pz = a.z + dz * t;
          const accum = (a.accumulation || 1) * (1 - t) + (b.accumulation || 1) * t;
          const halfW = riverHalfWidth(accum);
          const maxDepth = Math.min(4, 1.5 + halfW / 15);
          const targetY = (a._targetY != null && b._targetY != null)
            ? a._targetY * (1 - t) + b._targetY * t - maxDepth : null;
          const radius = halfW + 3 * this.cellSize;
          const cellRadius = Math.ceil(radius / this.cellSize);
          const cgx = Math.round((px - this.originX) / this.cellSize);
          const cgz = Math.round((pz - this.originZ) / this.cellSize);
          for (let ddz = -cellRadius; ddz <= cellRadius; ddz++) {
            for (let ddx = -cellRadius; ddx <= cellRadius; ddx++) {
              const gx = cgx + ddx, gz = cgz + ddz;
              if (gx < 0 || gx >= this.width || gz < 0 || gz >= this.height) continue;
              const cellX = this.originX + gx * this.cellSize;
              const cellZ = this.originZ + gz * this.cellSize;
              const dist = Math.sqrt((cellX - px) ** 2 + (cellZ - pz) ** 2);
              const nd = dist / Math.max(halfW, 0.1);
              const profile = channelProfile(nd);
              if (profile < 0.01) continue;
              const current = this.elevation.get(gx, gz);
              let newElev;
              if (targetY != null) {
                newElev = Math.min(current, targetY + maxDepth * (1 - profile));
              } else {
                newElev = current - profile * maxDepth;
              }
              if (targetY != null && targetY < seaLevel) newElev = Math.max(newElev, seaFloor);
              if (newElev < current) this.elevation.set(gx, gz, newElev);
            }
          }
        }
      }
      for (const p of polyline) delete p._targetY;
    }

    // Phase 3: recompute slope after carving (no buildability recompute — that's gone)
    if (this.slope) {
      const w = this.width, h = this.height, cs = this.cellSize;
      for (let gz = 1; gz < h - 1; gz++) {
        for (let gx = 1; gx < w - 1; gx++) {
          const dex = this.elevation.get(gx + 1, gz) - this.elevation.get(gx - 1, gz);
          const dez = this.elevation.get(gx, gz + 1) - this.elevation.get(gx, gz - 1);
          this.slope.set(gx, gz, Math.sqrt(dex * dex + dez * dez) / (2 * cs));
        }
      }
      for (let gx = 0; gx < w; gx++) {
        this.slope.set(gx, 0, this.slope.get(gx, 1));
        this.slope.set(gx, h - 1, this.slope.get(gx, h - 2));
      }
      for (let gz = 0; gz < h; gz++) {
        this.slope.set(0, gz, this.slope.get(1, gz));
        this.slope.set(w - 1, gz, this.slope.get(w - 2, gz));
      }
    }
  }

  // ── Water depth ────────────────────────────────────────────────────────────

  computeWaterDepth() {
    const cutoff = 20;
    this.waterDepth = new Grid2D(this.width, this.height, {
      type: 'float32', cellSize: this.cellSize, fill: cutoff + 1,
    });
    const queue = [];
    for (let gz = 0; gz < this.height; gz++) {
      for (let gx = 0; gx < this.width; gx++) {
        if (this.waterMask.get(gx, gz) === 0) {
          this.waterDepth.set(gx, gz, 0);
          queue.push(gx | (gz << 16));
        }
      }
    }
    const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
    let head = 0;
    while (head < queue.length) {
      const packed = queue[head++];
      const cx = packed & 0xFFFF, cz = packed >> 16;
      const cd = this.waterDepth.get(cx, cz);
      if (cd >= cutoff) continue;
      for (const [dx, dz] of dirs) {
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nx >= this.width || nz < 0 || nz >= this.height) continue;
        if (this.waterDepth.get(nx, nz) > cd + 1) {
          this.waterDepth.set(nx, nz, cd + 1);
          queue.push(nx | (nz << 16));
        }
      }
    }
  }

  // ── Land value ─────────────────────────────────────────────────────────────

  computeLandValue() {
    const w = this.width, h = this.height, cs = this.cellSize;
    const slope = this.getLayer('slope') || this.slope;
    const waterDist = this.getLayer('waterDist') || this.waterDist;
    const terrainSuitability = this.getLayer('terrainSuitability');

    const flatnessR = Math.max(1, Math.round(LV_FLATNESS_RADIUS_M / cs));
    const flatness = new Float32Array(w * h);
    if (slope) {
      for (let gz = 0; gz < h; gz++) {
        for (let gx = 0; gx < w; gx++) {
          let sum = 0, count = 0;
          const gxMin = Math.max(0, gx - flatnessR), gxMax = Math.min(w - 1, gx + flatnessR);
          const gzMin = Math.max(0, gz - flatnessR), gzMax = Math.min(h - 1, gz + flatnessR);
          for (let nz = gzMin; nz <= gzMax; nz++) {
            for (let nx = gxMin; nx <= gxMax; nx++) {
              sum += slope.get(nx, nz); count++;
            }
          }
          flatness[gz * w + gx] = 1.0 - Math.min(1, (sum / count) / LV_FLATNESS_MAX_SLOPE);
        }
      }
    }

    const waterBonusRange = Math.round(LV_WATER_BONUS_RANGE_M / cs);
    const nucleiWorld = (this.nuclei && this.nuclei.length > 0)
      ? this.nuclei.map(n => ({ wx: this.originX + n.gx * cs, wz: this.originZ + n.gz * cs }))
      : this.settlement
        ? [{ wx: this.settlement.gx * (this.regionalLayers?.getData('params')?.cellSize || 50),
             wz: this.settlement.gz * (this.regionalLayers?.getData('params')?.cellSize || 50) }]
        : [];

    for (let gz = 0; gz < h; gz++) {
      for (let gx = 0; gx < w; gx++) {
        if (this.waterMask.get(gx, gz) > 0) { this.landValue.set(gx, gz, 0); continue; }

        const localFlatness = flatness[gz * w + gx];
        const wx = this.originX + gx * cs, wz = this.originZ + gz * cs;
        let minDist = Infinity;
        for (const nc of nucleiWorld) {
          const d = Math.sqrt((wx - nc.wx) ** 2 + (wz - nc.wz) ** 2);
          if (d < minDist) minDist = d;
        }
        const proximity = 1.0 / (1.0 + minDist / LV_PROXIMITY_FALLOFF_M);
        const adjFlatnessW = LV_FLATNESS_WEIGHT * (1 - proximity * 0.3);
        let base = localFlatness * adjFlatnessW + proximity * (1 - adjFlatnessW);

        let waterBonus = 0;
        if (waterDist) {
          const wd = waterDist.get(gx, gz);
          if (wd > 0 && wd <= waterBonusRange) waterBonus = LV_WATER_BONUS_MAX * (1 - wd / waterBonusRange);
        }

        let v = base + waterBonus;
        if (terrainSuitability && terrainSuitability.get(gx, gz) > LV_BUILDABLE_FLOOR) {
          v = Math.max(v, LV_BUILDABLE_FLOOR);
        }
        this.landValue.set(gx, gz, v);
      }
    }
  }

  // ── Face extraction (city blocks from grid) ────────────────────────────────

  extractFaces(options = {}) {
    const w = this.width, h = this.height, cs = this.cellSize;
    const { minArea = 2000, maxArea = w * h * cs * cs * 0.5, simplifyEpsilon = 1.5 } = options;
    const minCells = Math.ceil(minArea / (cs * cs));
    const maxCells = Math.floor(maxArea / (cs * cs));

    const terrainSuitability = this.getLayer('terrainSuitability');

    const boundary = new Uint8Array(w * h);
    for (let gz = 0; gz < h; gz++) {
      for (let gx = 0; gx < w; gx++) {
        const idx = gz * w + gx;
        if (gx === 0 || gx === w - 1 || gz === 0 || gz === h - 1 ||
            this.roadGrid.get(gx, gz) > 0 ||
            this.waterMask.get(gx, gz) > 0 ||
            (terrainSuitability && terrainSuitability.get(gx, gz) < 0.1)) {
          boundary[idx] = 1;
        }
      }
    }

    const label = new Int32Array(w * h);
    let nextLabel = 1;
    const regionSizes = new Map();

    for (let gz = 1; gz < h - 1; gz++) {
      for (let gx = 1; gx < w - 1; gx++) {
        const idx = gz * w + gx;
        if (boundary[idx] || label[idx]) continue;
        const lbl = nextLabel++;
        const queue = [idx];
        label[idx] = lbl;
        let count = 0;
        while (queue.length > 0) {
          const ci = queue.pop(); count++;
          const cx = ci % w, cz = (ci - cx) / w;
          for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
            const nx = cx + dx, nz = cz + dz;
            if (nx < 0 || nx >= w || nz < 0 || nz >= h) continue;
            const ni = nz * w + nx;
            if (boundary[ni] || label[ni]) continue;
            label[ni] = lbl; queue.push(ni);
          }
        }
        regionSizes.set(lbl, count);
      }
    }

    const faces = [];
    for (const [lbl, size] of regionSizes) {
      if (size < minCells || size > maxCells) continue;
      const contour = this._traceContour(label, lbl, w, h);
      if (contour.length < 3) continue;
      const simplified = this._simplifyContour(contour, simplifyEpsilon);
      if (simplified.length < 3) continue;
      const polygon = simplified.map(p => ({ x: this.originX + p.gx * cs, z: this.originZ + p.gz * cs }));
      const area = size * cs * cs;
      let cx = 0, cz = 0;
      for (const p of polygon) { cx += p.x; cz += p.z; }
      faces.push({ polygon, area, centroid: { x: cx / polygon.length, z: cz / polygon.length } });
    }
    return faces;
  }

  // ── Clone ──────────────────────────────────────────────────────────────────

  clone() {
    const t0 = performance.now();
    const copy = new FeatureMap(this.width, this.height, this.cellSize, {
      originX: this.originX, originZ: this.originZ,
    });

    // Terrain
    if (this.elevation) copy.elevation = this.elevation.clone();
    if (this.slope) copy.slope = this.slope.clone();

    // Water
    copy.waterMask = this.waterMask.clone();
    if (this.waterType) copy.waterType = this.waterType.clone();
    if (this.waterDist) copy.waterDist = this.waterDist.clone();
    if (this.waterDepth) copy.waterDepth = this.waterDepth.clone();

    // Other grids
    copy.railwayGrid = this.railwayGrid.clone();
    copy.landValue = this.landValue.clone();

    // Road network
    for (const road of this.roadNetwork.roads) {
      const r = copy.roadNetwork.add(road.polyline, {
        width: road.width, hierarchy: road.hierarchy,
        importance: road.importance, source: road.source,
      });
      for (const b of road.bridges) {
        copy.roadNetwork.addBridge(r.id, b.bankA, b.bankB, b.entryT, b.exitT);
      }
    }

    // Rivers, plots, buildings (deep copy)
    copy.rivers = this.rivers.map(f => JSON.parse(JSON.stringify(f)));
    copy.plots = this.plots.map(f => JSON.parse(JSON.stringify(f)));
    copy.buildings = this.buildings.map(f => JSON.parse(JSON.stringify(f)));

    // Nuclei
    copy.nuclei = this.nuclei.map(n => ({ ...n }));

    // Named layers
    for (const [name, grid] of this.layers) {
      copy.layers.set(name, grid.clone ? grid.clone() : grid);
    }

    // Pipeline state
    if (this.developmentZones) {
      copy.developmentZones = this.developmentZones.map(z => ({
        ...z,
        cells: z.cells.map(c => ({ ...c })),
        boundary: z.boundary ? z.boundary.map(p => ({ ...p })) : undefined,
      }));
    }
    if (this.reservationZones) {
      copy.reservationZones = this.reservationZones.map(r => ({
        ...r, cells: r.cells ? r.cells.map(c => ({ ...c })) : undefined,
      }));
    }
    if (this.growthState) {
      copy.growthState = {
        tick: this.growthState.tick,
        totalZoneCells: this.growthState.totalZoneCells,
        nucleusRadii: new Map(this.growthState.nucleusRadii),
        claimedCounts: new Map(this.growthState.claimedCounts),
        activeSeeds: new Map(
          [...this.growthState.activeSeeds].map(([k, seeds]) => [k, seeds.map(s => ({ ...s }))])
        ),
      };
    }

    // Metadata
    copy.seaLevel = this.seaLevel;
    copy.settlement = this.settlement;
    copy.regionalLayers = this.regionalLayers;
    copy.regionalSettlements = this.regionalSettlements;
    copy.rng = this.rng;

    console.log(`[FeatureMap.clone] ${this.width}×${this.height}, layers=${this.layers.size}, zones=${this.developmentZones?.length || 0}: ${(performance.now() - t0).toFixed(0)}ms`);
    return copy;
  }

  // ── Geometry helpers ───────────────────────────────────────────────────────

  _polygonBounds(polygon) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of polygon) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    }
    return {
      minGx: Math.max(0, Math.floor((minX - this.originX) / this.cellSize)),
      maxGx: Math.min(this.width - 1, Math.ceil((maxX - this.originX) / this.cellSize)),
      minGz: Math.max(0, Math.floor((minZ - this.originZ) / this.cellSize)),
      maxGz: Math.min(this.height - 1, Math.ceil((maxZ - this.originZ) / this.cellSize)),
    };
  }

  _pointInPolygon(x, z, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i].x, zi = polygon[i].z;
      const xj = polygon[j].x, zj = polygon[j].z;
      if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
    }
    return inside;
  }

  _traceContour(label, lbl, w, h) {
    let startIdx = -1;
    for (let gz = 0; gz < h && startIdx < 0; gz++) {
      for (let gx = 0; gx < w && startIdx < 0; gx++) {
        if (label[gz * w + gx] === lbl) startIdx = gz * w + gx;
      }
    }
    if (startIdx < 0) return [];
    const startGx = startIdx % w, startGz = (startIdx - startIdx % w) / w;
    const dx = [1,1,0,-1,-1,-1,0,1], dz = [0,1,1,1,0,-1,-1,-1];
    const contour = [];
    let cx = startGx, cz = startGz, dir = 6;
    const maxSteps = w * h;
    for (let step = 0; step < maxSteps; step++) {
      contour.push({ gx: cx, gz: cz });
      let searchDir = (dir + 5) % 8, found = false;
      for (let i = 0; i < 8; i++) {
        const nx = cx + dx[searchDir], nz = cz + dz[searchDir];
        if (nx >= 0 && nx < w && nz >= 0 && nz < h && label[nz * w + nx] === lbl) {
          dir = searchDir; cx = nx; cz = nz; found = true; break;
        }
        searchDir = (searchDir + 1) % 8;
      }
      if (!found) break;
      if (cx === startGx && cz === startGz) break;
    }
    return contour;
  }

  _simplifyContour(contour, epsilon) {
    if (contour.length <= 3) return contour;
    let maxDist = 0, maxIdx = 0;
    const first = contour[0], last = contour[contour.length - 1];
    for (let i = 1; i < contour.length - 1; i++) {
      const d = _pointLineDistSq(contour[i].gx, contour[i].gz, first.gx, first.gz, last.gx, last.gz);
      if (d > maxDist) { maxDist = d; maxIdx = i; }
    }
    if (Math.sqrt(maxDist) > epsilon) {
      const left = this._simplifyContour(contour.slice(0, maxIdx + 1), epsilon);
      const right = this._simplifyContour(contour.slice(maxIdx), epsilon);
      return left.slice(0, -1).concat(right);
    }
    return [first, last];
  }
}

function _pointLineDistSq(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq === 0) return (px - ax) ** 2 + (pz - az) ** 2;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lenSq));
  return (px - ax - t * dx) ** 2 + (pz - az - t * dz) ** 2;
}
