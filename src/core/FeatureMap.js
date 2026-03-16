/**
 * FeatureMap: central class for city-scale spatial data.
 *
 * Holds typed features (roads, rivers, plots, buildings) and maintains
 * derived layers (buildability, waterMask, bridgeGrid, roadGrid) that
 * update automatically when features are added via addFeature().
 *
 * Spec: specs/v5/feature-map-architecture.md
 * Constants: specs/v5/technical-reference.md
 */

import { Grid2D } from './Grid2D.js';
import { PlanarGraph } from './PlanarGraph.js';
import { riverHalfWidth, channelProfile } from './riverGeometry.js';
import { RIVER_STAMP_FRACTION, STAMP_STEP_FRACTION } from '../city/constants.js';

// Land value constants (land-first formula)
const LV_FLATNESS_WEIGHT = 0.6;
const LV_PROXIMITY_WEIGHT = 0.4;
const LV_FLATNESS_RADIUS_M = 15;       // local averaging radius for flatness
const LV_FLATNESS_MAX_SLOPE = 0.4;     // slope at which flatness = 0
const LV_PROXIMITY_FALLOFF_M = 200;    // distance at which proximity halves
const LV_WATER_BONUS_MAX = 0.15;       // max water proximity bonus
const LV_WATER_BONUS_RANGE_M = 50;     // range for water bonus
const LV_BUILDABLE_FLOOR = 0.2;

// Buildability constants (meters)
const BUILD_EDGE_MARGIN_M = 60;
const BUILD_EDGE_TAPER_M = 160;
const BUILD_WATERFRONT_RANGE_M = 200;
const BUILD_WATERFRONT_BONUS = 0.3;
const WATER_DIST_CUTOFF_M = 300;

// Buildability slope scoring table (from technical-reference.md)
function slopeScore(slope) {
  if (slope < 0.05) return 1.0;
  if (slope < 0.15) return 0.9;
  if (slope < 0.3) return 0.7;
  if (slope < 0.5) return 0.4;
  if (slope < 0.7) return 0.15;
  return 0;
}

export class FeatureMap {
  /**
   * @param {number} width - Grid width in cells
   * @param {number} height - Grid height in cells
   * @param {number} cellSize - World units per cell
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

    // Feature storage
    this.features = []; // all features in add order
    this.roads = [];
    this.rivers = [];
    this.plots = [];
    this.buildings = [];

    // Road topology graph
    this.graph = new PlanarGraph();

    // Terrain grids (set externally after construction)
    this.elevation = null;
    this.slope = null;

    // Derived layers
    const gridOpts = { cellSize, originX, originZ };
    this.buildability = new Grid2D(width, height, { ...gridOpts, type: 'float32' });
    this.waterMask = new Grid2D(width, height, { ...gridOpts, type: 'uint8' });
    this.bridgeGrid = new Grid2D(width, height, { ...gridOpts, type: 'uint8' });
    this.roadGrid = new Grid2D(width, height, { ...gridOpts, type: 'uint8' });
    this.landValue = new Grid2D(width, height, { ...gridOpts, type: 'float32' });
    this.waterType = null; // set by classifyWater

    // Named layers (Grid2D instances, set by pipeline steps)
    this.layers = new Map();

    // Nucleus data
    this.nuclei = [];
  }

  setLayer(name, grid) { this.layers.set(name, grid); }
  getLayer(name) { return this.layers.get(name); }
  hasLayer(name) { return this.layers.has(name); }

  /**
   * Set terrain grids and compute initial buildability from terrain alone.
   */
  setTerrain(elevation, slope) {
    this.elevation = elevation;
    this.slope = slope;
    this._computeInitialBuildability();
  }

  /**
   * Add a feature to the map. Dispatches by type and updates derived layers.
   * @param {string} type - 'road' | 'river' | 'plot' | 'building'
   * @param {object} data - Feature-specific data
   * @returns {object} the stored feature
   */
  addFeature(type, data) {
    const feature = { type, ...data, id: this.features.length };
    this.features.push(feature);

    switch (type) {
      case 'road':
        this.roads.push(feature);
        this._stampRoad(feature);
        this._stampRoadValue(feature);
        break;
      case 'river':
        this.rivers.push(feature);
        this._stampRiver(feature);
        break;
      case 'plot':
        this.plots.push(feature);
        this._stampPlot(feature);
        break;
      case 'building':
        this.buildings.push(feature);
        this._stampBuilding(feature);
        break;
    }

    return feature;
  }

  // --- Terrain-based buildability ---

  _computeInitialBuildability() {
    if (!this.elevation || !this.slope) return;

    const edgeMargin = Math.round(BUILD_EDGE_MARGIN_M / this.cellSize);
    const edgeTaper = Math.round(BUILD_EDGE_TAPER_M / this.cellSize);
    const waterfrontRange = Math.round(BUILD_WATERFRONT_RANGE_M / this.cellSize);
    const cutoffCells = Math.round(WATER_DIST_CUTOFF_M / this.cellSize);
    this.waterDist = this._computeWaterDistance(cutoffCells);
    const waterDist = this.waterDist;

    for (let gz = 0; gz < this.height; gz++) {
      for (let gx = 0; gx < this.width; gx++) {
        // Edge margin
        const edgeDist = Math.min(gx, gz, this.width - 1 - gx, this.height - 1 - gz);
        if (edgeDist < edgeMargin) {
          this.buildability.set(gx, gz, 0);
          continue;
        }

        // Water cells are unbuildable
        if (this.waterMask.get(gx, gz) > 0) {
          this.buildability.set(gx, gz, 0);
          continue;
        }

        let score = slopeScore(this.slope.get(gx, gz));

        // Edge taper
        if (edgeDist < edgeTaper) {
          score *= edgeDist / edgeTaper;
        }

        // Waterfront bonus
        const wd = waterDist.get(gx, gz);
        if (wd > 0 && wd < waterfrontRange) {
          score = Math.min(1, score + BUILD_WATERFRONT_BONUS * (1 - wd / waterfrontRange));
        }

        this.buildability.set(gx, gz, score);
      }
    }
  }

  /**
   * BFS water distance from water cells, 4-connected, with cutoff.
   */
  _computeWaterDistance(cutoff) {
    const dist = new Grid2D(this.width, this.height, {
      type: 'float32',
      cellSize: this.cellSize,
      fill: cutoff + 1,
    });

    const queue = [];
    for (let gz = 0; gz < this.height; gz++) {
      for (let gx = 0; gx < this.width; gx++) {
        if (this.waterMask.get(gx, gz) > 0) {
          dist.set(gx, gz, 0);
          queue.push(gx | (gz << 16));
        }
      }
    }

    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let head = 0;
    while (head < queue.length) {
      const packed = queue[head++];
      const cx = packed & 0xFFFF;
      const cz = packed >> 16;
      const cd = dist.get(cx, cz);
      if (cd >= cutoff) continue;

      for (const [dx, dz] of dirs) {
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nx >= this.width || nz < 0 || nz >= this.height) continue;
        if (dist.get(nx, nz) > cd + 1) {
          dist.set(nx, nz, cd + 1);
          queue.push(nx | (nz << 16));
        }
      }
    }

    return dist;
  }

  /**
   * BFS land distance into water cells, 4-connected.
   * For each water cell, distance to nearest land. Narrow rivers = low values.
   * Stored as this.waterDepth for the path cost function to use.
   */
  computeWaterDepth() {
    const cutoff = 20;
    this.waterDepth = new Grid2D(this.width, this.height, {
      type: 'float32',
      cellSize: this.cellSize,
      fill: cutoff + 1,
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

    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let head = 0;
    while (head < queue.length) {
      const packed = queue[head++];
      const cx = packed & 0xFFFF;
      const cz = packed >> 16;
      const cd = this.waterDepth.get(cx, cz);
      if (cd >= cutoff) continue;

      for (const [dx, dz] of dirs) {
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nx >= this.width || nz < 0 || nz >= this.height) continue;
        if (this.waterDepth.get(nx, nz) > cd + 1) {
          this.waterDepth.set(nx, nz, cd + 1);
          queue.push(nx | (nz << 16));
        }
      }
    }
  }

  // --- Road stamping ---

  _stampRoad(feature) {
    const polyline = feature.polyline;
    if (!polyline || polyline.length < 2) return;

    const halfWidth = (feature.width || 6) / 2;

    // Walk polyline at half-cell steps, stamp roadGrid + zero buildability
    for (let i = 0; i < polyline.length - 1; i++) {
      const ax = polyline[i].x;
      const az = polyline[i].z;
      const bx = polyline[i + 1].x;
      const bz = polyline[i + 1].z;

      const dx = bx - ax;
      const dz = bz - az;
      const segLen = Math.sqrt(dx * dx + dz * dz);
      if (segLen < 0.01) continue;

      const stepSize = this.cellSize * STAMP_STEP_FRACTION;
      const steps = Math.ceil(segLen / stepSize);

      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const px = ax + dx * t;
        const pz = az + dz * t;

        const effectiveRadius = Math.max(halfWidth, this.cellSize * RIVER_STAMP_FRACTION);
        const cellRadius = Math.ceil(effectiveRadius / this.cellSize);
        const cgx = Math.round((px - this.originX) / this.cellSize);
        const cgz = Math.round((pz - this.originZ) / this.cellSize);

        for (let ddz = -cellRadius; ddz <= cellRadius; ddz++) {
          for (let ddx = -cellRadius; ddx <= cellRadius; ddx++) {
            const gx = cgx + ddx;
            const gz = cgz + ddz;
            if (gx < 0 || gx >= this.width || gz < 0 || gz >= this.height) continue;

            const cellCenterX = this.originX + gx * this.cellSize;
            const cellCenterZ = this.originZ + gz * this.cellSize;
            const distSq = (cellCenterX - px) ** 2 + (cellCenterZ - pz) ** 2;
            if (distSq <= effectiveRadius * effectiveRadius) {
              this.roadGrid.set(gx, gz, 1);
              this.buildability.set(gx, gz, 0);

              // Only stamp bridgeGrid for explicit bridge features
              if (feature.bridge && this.waterMask.get(gx, gz) > 0) {
                this.bridgeGrid.set(gx, gz, 1);
              }
            }
          }
        }
      }
    }
  }

  // --- River stamping ---

  _stampRiver(feature) {
    const polyline = feature.polyline;
    if (!polyline || polyline.length < 2) return;

    // Walk polyline, stamp waterMask and apply river edge gradient to buildability
    for (let i = 0; i < polyline.length - 1; i++) {
      const a = polyline[i];
      const b = polyline[i + 1];

      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const segLen = Math.sqrt(dx * dx + dz * dz);
      if (segLen < 0.01) continue;

      const stepSize = this.cellSize * STAMP_STEP_FRACTION;
      const steps = Math.ceil(segLen / stepSize);

      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const px = a.x + dx * t;
        const pz = a.z + dz * t;

        // Interpolate width
        const aWidth = a.width || riverHalfWidth(a.accumulation || 1) * 2;
        const bWidth = b.width || riverHalfWidth(b.accumulation || 1) * 2;
        const halfW = (aWidth * (1 - t) + bWidth * t) / 2;

        // FeatureMap is always city-level — use tight stamp fraction.
        const effectiveRadius = Math.max(halfW, this.cellSize * RIVER_STAMP_FRACTION);
        const cellRadius = Math.ceil(effectiveRadius / this.cellSize);
        const cgx = Math.round((px - this.originX) / this.cellSize);
        const cgz = Math.round((pz - this.originZ) / this.cellSize);

        // Extended radius for buildability gradient
        const gradientRadius = cellRadius + 3;

        for (let ddz = -gradientRadius; ddz <= gradientRadius; ddz++) {
          for (let ddx = -gradientRadius; ddx <= gradientRadius; ddx++) {
            const gx = cgx + ddx;
            const gz = cgz + ddz;
            if (gx < 0 || gx >= this.width || gz < 0 || gz >= this.height) continue;

            const cellCenterX = this.originX + gx * this.cellSize;
            const cellCenterZ = this.originZ + gz * this.cellSize;
            const dist = Math.sqrt((cellCenterX - px) ** 2 + (cellCenterZ - pz) ** 2);
            const nd = dist / Math.max(halfW, 0.1); // normalized distance

            if (dist <= effectiveRadius) {
              this.waterMask.set(gx, gz, 1);
              this.buildability.set(gx, gz, 0);
            } else if (nd < 1.5) {
              // River edge gradient for buildability
              // nd 0.8-1.0: marginal (0.15 max)
              // nd < 0.8: unbuildable
              if (nd < 0.8) {
                this.buildability.set(gx, gz, 0);
              } else if (nd < 1.0) {
                const grad = 0.15 * ((nd - 0.8) / 0.2);
                this.buildability.set(gx, gz, Math.min(this.buildability.get(gx, gz), grad));
              }
            }
          }
        }
      }
    }
  }

  // --- Plot stamping ---

  _stampPlot(feature) {
    const polygon = feature.polygon;
    if (!polygon || polygon.length < 3) return;

    // Rasterize polygon into buildability (zero it)
    const bounds = this._polygonBounds(polygon);
    for (let gz = bounds.minGz; gz <= bounds.maxGz; gz++) {
      for (let gx = bounds.minGx; gx <= bounds.maxGx; gx++) {
        const wx = this.originX + gx * this.cellSize;
        const wz = this.originZ + gz * this.cellSize;
        if (this._pointInPolygon(wx, wz, polygon)) {
          this.buildability.set(gx, gz, 0);
        }
      }
    }
  }

  // --- Building stamping ---

  _stampBuilding(feature) {
    // Same as plot: zero buildability under footprint
    this._stampPlot(feature);
  }

  // --- Path cost factory ---

  /**
   * Create a cost function for A* pathfinding, parameterized by preset.
   * @param {string} preset - 'anchor' | 'growth' | 'nucleus' | 'shortcuts' | 'satellite' | 'bridge'
   * @returns {Function} costFn(fromGx, fromGz, toGx, toGz) => cost
   */
  createPathCost(preset = 'growth') {
    const presets = {
      anchor:    { slopePenalty: 10, unbuildableCost: 15,       reuseDiscount: 0.01, plotPenalty: 5.0 },
      growth:    { slopePenalty: 10, unbuildableCost: Infinity, reuseDiscount: 0.5,  plotPenalty: 5.0 },
      nucleus:   { slopePenalty: 5,  unbuildableCost: 12,       reuseDiscount: 0.1,  plotPenalty: 3.0 },
      shortcuts: { slopePenalty: 8,  unbuildableCost: 20,       reuseDiscount: 1.0,  plotPenalty: 3.0 },
      satellite: { slopePenalty: 10, unbuildableCost: Infinity, reuseDiscount: 0.15, plotPenalty: 5.0 },
      bridge:    { slopePenalty: 3,  unbuildableCost: 8,        reuseDiscount: 0.1,  plotPenalty: 5.0 },
      extra:     { slopePenalty: 10, unbuildableCost: 15,       reuseDiscount: 0.01, plotPenalty: 5.0 },
    };

    const p = presets[preset] || presets.growth;
    const { slopePenalty, unbuildableCost, reuseDiscount, plotPenalty } = p;

    const elevation = this.elevation;
    const buildability = this.buildability;
    const roadGrid = this.roadGrid;
    const bridgeGrid = this.bridgeGrid;
    const waterDepth = this.waterDepth;
    const waterType = this.waterType;

    return (fromGx, fromGz, toGx, toGz) => {
      const dx = toGx - fromGx;
      const dz = toGz - fromGz;
      const baseDist = Math.sqrt(dx * dx + dz * dz);

      if (!elevation) return baseDist;

      // Block sea cells entirely (rivers are allowed with penalty for bridges)
      if (waterType && waterType.get(toGx, toGz) === 1) return Infinity;

      const fromH = elevation.get(fromGx, fromGz);
      const toH = elevation.get(toGx, toGz);
      const slope = Math.abs(toH - fromH) / (baseDist * this.cellSize);

      let cost = baseDist + slope * slopePenalty;

      // Road reuse (early return)
      if (roadGrid.get(toGx, toGz) > 0) {
        return baseDist * reuseDiscount;
      }

      // Bridge check: water cells under bridges
      if (bridgeGrid.get(toGx, toGz) > 0) {
        cost *= 8;
      }

      // Buildability check
      const b = buildability.get(toGx, toGz);
      if (b < 0.01) {
        if (!isFinite(unbuildableCost)) return Infinity;
        // Narrow water crossings: scale cost by depth from land.
        // Depth 1-3 cells (narrow rivers) = moderate cost.
        // Depth 4+ = increasingly expensive, discouraging wide crossings.
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

  // --- Water classification ---

  /**
   * Classify water cells as sea (1), lake (2), or river (3).
   * @param {number} seaLevel
   */
  classifyWater(seaLevel) {
    this.waterType = new Grid2D(this.width, this.height, {
      type: 'uint8',
      cellSize: this.cellSize,
      originX: this.originX,
      originZ: this.originZ,
    });

    // Mark all water cells
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

    // BFS from boundary water → sea
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

    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let head = 0;
    while (head < queue.length) {
      const packed = queue[head++];
      const cx = packed & 0xFFFF;
      const cz = packed >> 16;
      for (const [ddx, ddz] of dirs) {
        const nx = cx + ddx;
        const nz = cz + ddz;
        if (nx < 0 || nx >= this.width || nz < 0 || nz >= this.height) continue;
        const nIdx = nz * this.width + nx;
        if (isWater[nIdx] && this.waterType.get(nx, nz) === 0) {
          this.waterType.set(nx, nz, 1); // sea
          queue.push(nx | (nz << 16));
        }
      }
    }

    // Paint river paths as river (3)
    for (const river of this.rivers) {
      const polyline = river.polyline;
      if (!polyline || polyline.length < 2) continue;
      for (let i = 0; i < polyline.length - 1; i++) {
        const a = polyline[i];
        const b = polyline[i + 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const segLen = Math.sqrt(dx * dx + dz * dz);
        if (segLen < 0.01) continue;

        const steps = Math.ceil(segLen / (this.cellSize * STAMP_STEP_FRACTION));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const px = a.x + dx * t;
          const pz = a.z + dz * t;
          const aWidth = a.width || riverHalfWidth(a.accumulation || 1) * 2;
          const bWidth = b.width || riverHalfWidth(b.accumulation || 1) * 2;
          const halfW = (aWidth * (1 - t) + bWidth * t) / 2;
          const effectiveRadius = Math.max(halfW, this.cellSize * RIVER_STAMP_FRACTION);
          const cellRadius = Math.ceil(effectiveRadius / this.cellSize);
          const cgx = Math.round((px - this.originX) / this.cellSize);
          const cgz = Math.round((pz - this.originZ) / this.cellSize);

          for (let ddz = -cellRadius; ddz <= cellRadius; ddz++) {
            for (let ddx = -cellRadius; ddx <= cellRadius; ddx++) {
              const gx = cgx + ddx;
              const gz = cgz + ddz;
              if (gx < 0 || gx >= this.width || gz < 0 || gz >= this.height) continue;
              if (this.waterType.get(gx, gz) !== 1) { // don't overwrite sea
                const cellCenterX = this.originX + gx * this.cellSize;
                const cellCenterZ = this.originZ + gz * this.cellSize;
                const distSq = (cellCenterX - px) ** 2 + (cellCenterZ - pz) ** 2;
                if (distSq <= effectiveRadius * effectiveRadius) {
                  this.waterType.set(gx, gz, 3); // river
                }
              }
            }
          }
        }
      }
    }

    // Remaining water = lake (2)
    for (let gz = 0; gz < this.height; gz++) {
      for (let gx = 0; gx < this.width; gx++) {
        if (isWater[gz * this.width + gx] && this.waterType.get(gx, gz) === 0) {
          this.waterType.set(gx, gz, 2); // lake
        }
      }
    }
  }

  // --- Channel carving ---

  /**
   * Carve river channels into elevation grid and enforce monotonic downhill flow.
   * After carving, recomputes slope and buildability so pathfinding sees correct terrain.
   */
  carveChannels() {
    if (!this.elevation) return;

    // Phase 1: Enforce monotonic downhill flow on each river polyline.
    // Walk each river in downstream direction and clamp the centerline
    // elevation so it never increases.
    for (const river of this.rivers) {
      const polyline = river.polyline;
      if (!polyline || polyline.length < 2) continue;

      // Sample centerline elevations
      const elevations = polyline.map(p => {
        const gx = (p.x - this.originX) / this.cellSize;
        const gz = (p.z - this.originZ) / this.cellSize;
        return this.elevation.sample(gx, gz);
      });

      // Determine downstream direction from elevation (more reliable than
      // accumulation, which may be interpolated inaccurately at clip boundaries)
      const flowsForward = elevations[0] >= elevations[elevations.length - 1];
      if (!flowsForward) elevations.reverse();

      // Clamp to monotonic decreasing
      for (let i = 1; i < elevations.length; i++) {
        if (elevations[i] > elevations[i - 1]) {
          elevations[i] = elevations[i - 1];
        }
      }

      // Reverse back to match polyline order
      if (!flowsForward) elevations.reverse();

      // Store corrected elevations back as target centerline heights
      // (used by the carving pass below to set absolute channel depth)
      for (let i = 0; i < polyline.length; i++) {
        polyline[i]._targetY = elevations[i];
      }
    }

    // Phase 2: Carve channels using channel profile.
    // Where _targetY is set, use it as the absolute river bed elevation
    // instead of carving relative to current terrain.
    const seaFloor = this.seaLevel != null ? this.seaLevel - 0.5 : -Infinity;
    for (const river of this.rivers) {
      const polyline = river.polyline;
      if (!polyline || polyline.length < 2) continue;

      for (let i = 0; i < polyline.length - 1; i++) {
        const a = polyline[i];
        const b = polyline[i + 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const segLen = Math.sqrt(dx * dx + dz * dz);
        if (segLen < 0.01) continue;

        const steps = Math.ceil(segLen / (this.cellSize * STAMP_STEP_FRACTION));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const px = a.x + dx * t;
          const pz = a.z + dz * t;

          const accum = (a.accumulation || 1) * (1 - t) + (b.accumulation || 1) * t;
          const halfW = riverHalfWidth(accum);
          const maxDepth = Math.min(4, 1.5 + halfW / 15);

          // Target bed elevation (monotonic) if available
          const targetY = (a._targetY != null && b._targetY != null)
            ? a._targetY * (1 - t) + b._targetY * t - maxDepth
            : null;

          const radius = halfW + 3 * this.cellSize;
          const cellRadius = Math.ceil(radius / this.cellSize);
          const cgx = Math.round((px - this.originX) / this.cellSize);
          const cgz = Math.round((pz - this.originZ) / this.cellSize);

          for (let ddz = -cellRadius; ddz <= cellRadius; ddz++) {
            for (let ddx = -cellRadius; ddx <= cellRadius; ddx++) {
              const gx = cgx + ddx;
              const gz = cgz + ddz;
              if (gx < 0 || gx >= this.width || gz < 0 || gz >= this.height) continue;

              const cellCenterX = this.originX + gx * this.cellSize;
              const cellCenterZ = this.originZ + gz * this.cellSize;
              const dist = Math.sqrt((cellCenterX - px) ** 2 + (cellCenterZ - pz) ** 2);
              const nd = dist / Math.max(halfW, 0.1);

              const profile = channelProfile(nd);
              if (profile < 0.01) continue;

              const current = this.elevation.get(gx, gz);
              let newElev;
              if (targetY != null) {
                // Blend between current terrain and target river bed using channel profile
                const bedElev = targetY + maxDepth * (1 - profile);
                newElev = Math.min(current, bedElev);
              } else {
                // Fallback: relative carving
                newElev = current - profile * maxDepth;
              }
              // Never carve below sea level (prevents chasms at river mouths)
              newElev = Math.max(newElev, seaFloor);
              if (newElev < current) {
                this.elevation.set(gx, gz, newElev);
              }
            }
          }
        }
      }

      // Clean up temp properties
      for (const p of polyline) delete p._targetY;
    }

    // Phase 3: Recompute slope and buildability after carving.
    if (this.slope) {
      const w = this.width, h = this.height, cs = this.cellSize;
      for (let gz = 1; gz < h - 1; gz++) {
        for (let gx = 1; gx < w - 1; gx++) {
          const dex = this.elevation.get(gx + 1, gz) - this.elevation.get(gx - 1, gz);
          const dez = this.elevation.get(gx, gz + 1) - this.elevation.get(gx, gz - 1);
          this.slope.set(gx, gz, Math.sqrt(dex * dex + dez * dez) / (2 * cs));
        }
      }
      // Edge slopes from nearest interior
      for (let gx = 0; gx < w; gx++) {
        this.slope.set(gx, 0, this.slope.get(gx, 1));
        this.slope.set(gx, h - 1, this.slope.get(gx, h - 2));
      }
      for (let gz = 0; gz < h; gz++) {
        this.slope.set(0, gz, this.slope.get(1, gz));
        this.slope.set(w - 1, gz, this.slope.get(w - 2, gz));
      }
      this._computeInitialBuildability();
    }
  }

  // --- Land value ---

  /**
   * Compute land value from terrain features and existing infrastructure.
   * Paints high-value source points, then Gaussian blurs to spread value.
   * Call after terrain, water, and initial roads are set up.
   */
  computeLandValue() {
    const w = this.width;
    const h = this.height;
    const cs = this.cellSize;

    // Pre-compute local flatness: average slope in a radius around each cell
    const flatnessR = Math.max(1, Math.round(LV_FLATNESS_RADIUS_M / cs));
    const flatness = new Float32Array(w * h);
    if (this.slope) {
      for (let gz = 0; gz < h; gz++) {
        for (let gx = 0; gx < w; gx++) {
          let sum = 0, count = 0;
          const r = flatnessR;
          const gxMin = Math.max(0, gx - r), gxMax = Math.min(w - 1, gx + r);
          const gzMin = Math.max(0, gz - r), gzMax = Math.min(h - 1, gz + r);
          for (let nz = gzMin; nz <= gzMax; nz++) {
            for (let nx = gxMin; nx <= gxMax; nx++) {
              sum += this.slope.get(nx, nz);
              count++;
            }
          }
          const avgSlope = sum / count;
          flatness[gz * w + gx] = 1.0 - Math.min(1, avgSlope / LV_FLATNESS_MAX_SLOPE);
        }
      }
    }

    // Pre-compute water distance in cells for bonus (reuse existing waterDist if available)
    const waterBonusRange = Math.round(LV_WATER_BONUS_RANGE_M / cs);

    // Nucleus centers for proximity calculation
    const nucleiWorld = [];
    if (this.nuclei && this.nuclei.length > 0) {
      for (const n of this.nuclei) {
        nucleiWorld.push({
          wx: this.originX + n.gx * cs,
          wz: this.originZ + n.gz * cs,
        });
      }
    } else if (this.settlement) {
      // Fallback: use settlement as single center
      const params = this.regionalLayers?.getData('params');
      const rcs = params?.cellSize || 50;
      nucleiWorld.push({
        wx: this.settlement.gx * rcs,
        wz: this.settlement.gz * rcs,
      });
    }

    for (let gz = 0; gz < h; gz++) {
      for (let gx = 0; gx < w; gx++) {
        if (this.waterMask.get(gx, gz) > 0) {
          this.landValue.set(gx, gz, 0);
          continue;
        }

        const localFlatness = flatness[gz * w + gx];

        // Proximity to nearest nucleus
        const wx = this.originX + gx * cs;
        const wz = this.originZ + gz * cs;
        let minDist = Infinity;
        for (const nc of nucleiWorld) {
          const dx = wx - nc.wx, dz = wz - nc.wz;
          const d = Math.sqrt(dx * dx + dz * dz);
          if (d < minDist) minDist = d;
        }
        const proximity = 1.0 / (1.0 + minDist / LV_PROXIMITY_FALLOFF_M);

        // Reduce flatness weight near nucleus — steep land near center is still prime
        const adjustedFlatnessW = LV_FLATNESS_WEIGHT * (1 - proximity * 0.3);
        const adjustedProximityW = 1 - adjustedFlatnessW;
        let base = localFlatness * adjustedFlatnessW + proximity * adjustedProximityW;

        // Water bonus: buildable land near water gets a small additive bonus
        let waterBonus = 0;
        if (this.waterDist) {
          const wd = this.waterDist.get(gx, gz);
          if (wd > 0 && wd <= waterBonusRange) {
            waterBonus = LV_WATER_BONUS_MAX * (1 - wd / waterBonusRange);
          }
        }

        let v = base + waterBonus;

        // Floor for buildable land
        if (this.buildability.get(gx, gz) > LV_BUILDABLE_FLOOR) {
          v = Math.max(v, LV_BUILDABLE_FLOOR);
        }

        this.landValue.set(gx, gz, v);
      }
    }
  }

  /**
   * Incrementally add value from a newly added road and re-blur locally.
   * Lighter than full recompute — just stamps junction value near the new road.
   */
  _stampRoadValue(_feature) {
    // No-op: land value is computed from terrain (flatness + proximity + water),
    // not from road junctions/bridges. The strategy recomputes land value
    // explicitly after skeleton roads are placed.
  }

  // --- Cloning ---

  clone() {
    const copy = new FeatureMap(this.width, this.height, this.cellSize, {
      originX: this.originX,
      originZ: this.originZ,
    });

    // Terrain
    if (this.elevation) copy.elevation = this.elevation.clone();
    if (this.slope) copy.slope = this.slope.clone();

    // Derived grids
    copy.buildability = this.buildability.clone();
    copy.waterMask = this.waterMask.clone();
    copy.bridgeGrid = this.bridgeGrid.clone();
    copy.roadGrid = this.roadGrid.clone();
    copy.landValue = this.landValue.clone();
    if (this.waterType) copy.waterType = this.waterType.clone();
    if (this.waterDist) copy.waterDist = this.waterDist.clone();
    if (this.waterDepth) copy.waterDepth = this.waterDepth.clone();

    // Features (deep copy data, not object references)
    for (const f of this.features) {
      const fCopy = JSON.parse(JSON.stringify(f));
      copy.features.push(fCopy);
      switch (fCopy.type) {
        case 'road': copy.roads.push(fCopy); break;
        case 'river': copy.rivers.push(fCopy); break;
        case 'plot': copy.plots.push(fCopy); break;
        case 'building': copy.buildings.push(fCopy); break;
      }
    }

    // Graph is fresh (strategies build their own)

    // Nuclei (deep copy)
    copy.nuclei = this.nuclei.map(n => ({ ...n }));

    // Named layers
    for (const [name, grid] of this.layers) {
      copy.layers.set(name, grid.clone ? grid.clone() : grid);
    }

    // Pipeline-set dynamic properties
    if (this.developmentZones) {
      copy.developmentZones = this.developmentZones.map(z => ({
        ...z,
        cells: z.cells.map(c => ({ ...c })),
        boundary: z.boundary ? z.boundary.map(p => ({ ...p })) : undefined,
      }));
    }
    if (this.reservationZones) {
      copy.reservationZones = this.reservationZones.map(r => ({
        ...r,
        cells: r.cells ? r.cells.map(c => ({ ...c })) : undefined,
      }));
    }

    // Metadata
    copy.seaLevel = this.seaLevel;
    copy.settlement = this.settlement;
    copy.regionalLayers = this.regionalLayers;
    copy.regionalSettlements = this.regionalSettlements;
    copy.rng = this.rng;

    return copy;
  }

  // --- Geometry helpers ---

  _polygonBounds(polygon) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of polygon) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    return {
      minGx: Math.max(0, Math.floor((minX - this.originX) / this.cellSize)),
      maxGx: Math.min(this.width - 1, Math.ceil((maxX - this.originX) / this.cellSize)),
      minGz: Math.max(0, Math.floor((minZ - this.originZ) / this.cellSize)),
      maxGz: Math.min(this.height - 1, Math.ceil((maxZ - this.originZ) / this.cellSize)),
    };
  }

  // --- Bitmap face extraction ---

  /**
   * Extract enclosed faces (city blocks) from the grid by flood-filling
   * regions bounded by roads, water, and unbuildable terrain.
   *
   * Returns array of { polygon, area, centroid } where polygon is an array
   * of {x, z} world-coord points tracing the face boundary.
   *
   * @param {object} [options]
   * @param {number} [options.minArea=2000] - Min face area in m² to include
   * @param {number} [options.maxArea] - Max face area in m² (default: half map area)
   * @param {number} [options.simplifyEpsilon=1.5] - RDP simplification tolerance in cells
   * @returns {Array<{polygon: Array<{x,z}>, area: number, centroid: {x,z}}>}
   */
  extractFaces(options = {}) {
    const w = this.width;
    const h = this.height;
    const cs = this.cellSize;
    const {
      minArea = 2000,
      maxArea = w * h * cs * cs * 0.5,
      simplifyEpsilon = 1.5,
    } = options;

    const minCells = Math.ceil(minArea / (cs * cs));
    const maxCells = Math.floor(maxArea / (cs * cs));

    // Build boundary mask: 1 = boundary (road, water, unbuildable, edge)
    const boundary = new Uint8Array(w * h);
    for (let gz = 0; gz < h; gz++) {
      for (let gx = 0; gx < w; gx++) {
        const idx = gz * w + gx;
        if (gx === 0 || gx === w - 1 || gz === 0 || gz === h - 1 ||
            this.roadGrid.get(gx, gz) > 0 ||
            this.waterMask.get(gx, gz) > 0 ||
            this.buildability.get(gx, gz) < 0.1) {
          boundary[idx] = 1;
        }
      }
    }

    // Flood-fill to find connected regions
    const label = new Int32Array(w * h); // 0 = unlabeled
    let nextLabel = 1;
    const regionSizes = new Map(); // label -> cell count

    for (let gz = 1; gz < h - 1; gz++) {
      for (let gx = 1; gx < w - 1; gx++) {
        const idx = gz * w + gx;
        if (boundary[idx] || label[idx]) continue;

        // BFS flood fill
        const lbl = nextLabel++;
        const queue = [idx];
        label[idx] = lbl;
        let count = 0;

        while (queue.length > 0) {
          const ci = queue.pop();
          count++;
          const cx = ci % w;
          const cz = (ci - cx) / w;

          // 4-connected neighbors
          for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
            const nx = cx + dx, nz = cz + dz;
            if (nx < 0 || nx >= w || nz < 0 || nz >= h) continue;
            const ni = nz * w + nx;
            if (boundary[ni] || label[ni]) continue;
            label[ni] = lbl;
            queue.push(ni);
          }
        }

        regionSizes.set(lbl, count);
      }
    }

    // Extract contours and build faces for valid regions
    const faces = [];

    for (const [lbl, size] of regionSizes) {
      if (size < minCells || size > maxCells) continue;

      const contour = this._traceContour(label, lbl, w, h);
      if (contour.length < 3) continue;

      // Simplify contour (RDP in grid space)
      const simplified = this._simplifyContour(contour, simplifyEpsilon);
      if (simplified.length < 3) continue;

      // Convert to world coords
      const polygon = simplified.map(p => ({
        x: this.originX + p.gx * cs,
        z: this.originZ + p.gz * cs,
      }));

      // Compute area and centroid
      const area = size * cs * cs;
      let cx = 0, cz = 0;
      for (const p of polygon) { cx += p.x; cz += p.z; }
      cx /= polygon.length;
      cz /= polygon.length;

      faces.push({ polygon, area, centroid: { x: cx, z: cz } });
    }

    return faces;
  }

  /**
   * Trace the contour of a labeled region using Moore neighborhood tracing.
   * Returns array of {gx, gz} grid coords forming a closed boundary.
   */
  _traceContour(label, lbl, w, h) {
    // Find starting pixel: leftmost pixel on the topmost row of the region
    let startIdx = -1;
    for (let gz = 0; gz < h && startIdx < 0; gz++) {
      for (let gx = 0; gx < w && startIdx < 0; gx++) {
        if (label[gz * w + gx] === lbl) startIdx = gz * w + gx;
      }
    }
    if (startIdx < 0) return [];

    const startGx = startIdx % w;
    const startGz = (startIdx - startGx) / w;

    // Moore neighborhood tracing (clockwise)
    // Directions: 0=right, 1=down-right, 2=down, 3=down-left, 4=left, 5=up-left, 6=up, 7=up-right
    const dx = [1, 1, 0, -1, -1, -1, 0, 1];
    const dz = [0, 1, 1, 1, 0, -1, -1, -1];

    const contour = [];
    let cx = startGx, cz = startGz;
    let dir = 6; // start looking up (entered from below since we found topmost)

    const maxSteps = w * h;
    for (let step = 0; step < maxSteps; step++) {
      contour.push({ gx: cx, gz: cz });

      // Search clockwise from (dir + 5) % 8 (backtrack direction + 1)
      let searchDir = (dir + 5) % 8;
      let found = false;

      for (let i = 0; i < 8; i++) {
        const nx = cx + dx[searchDir];
        const nz = cz + dz[searchDir];

        if (nx >= 0 && nx < w && nz >= 0 && nz < h && label[nz * w + nx] === lbl) {
          dir = searchDir;
          cx = nx;
          cz = nz;
          found = true;
          break;
        }
        searchDir = (searchDir + 1) % 8;
      }

      if (!found) break;
      if (cx === startGx && cz === startGz) break;
    }

    return contour;
  }

  /**
   * Simplify a contour using Ramer-Douglas-Peucker algorithm.
   */
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

  _pointInPolygon(x, z, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i].x, zi = polygon[i].z;
      const xj = polygon[j].x, zj = polygon[j].z;
      if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }
}

/** Squared distance from point (px,pz) to line segment (ax,az)-(bx,bz). */
function _pointLineDistSq(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq === 0) return (px - ax) ** 2 + (pz - az) ** 2;
  let t = ((px - ax) * dx + (pz - az) * dz) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return (px - ax - t * dx) ** 2 + (pz - az - t * dz) ** 2;
}
