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
    this.waterType = null; // set by classifyWater

    // Nucleus data
    this.nuclei = [];
  }

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

    // Water distance BFS (cutoff 15 cells)
    const waterDist = this._computeWaterDistance(15);

    for (let gz = 0; gz < this.height; gz++) {
      for (let gx = 0; gx < this.width; gx++) {
        // Edge margin
        const edgeDist = Math.min(gx, gz, this.width - 1 - gx, this.height - 1 - gz);
        if (edgeDist < 3) {
          this.buildability.set(gx, gz, 0);
          continue;
        }

        // Water cells are unbuildable
        if (this.waterMask.get(gx, gz) > 0) {
          this.buildability.set(gx, gz, 0);
          continue;
        }

        let score = slopeScore(this.slope.get(gx, gz));

        // Edge taper (3-8 cells)
        if (edgeDist < 8) {
          score *= edgeDist / 8;
        }

        // Waterfront bonus
        const wd = waterDist.get(gx, gz);
        if (wd > 0 && wd < 10) {
          score = Math.min(1, score + 0.3 * (1 - wd / 10));
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

      const stepSize = this.cellSize * 0.5;
      const steps = Math.ceil(segLen / stepSize);

      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const px = ax + dx * t;
        const pz = az + dz * t;

        const effectiveRadius = Math.max(halfWidth, this.cellSize * 0.75);
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

              // Bridge detection: road crossing water
              if (this.waterMask.get(gx, gz) > 0) {
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

      const stepSize = this.cellSize * 0.5;
      const steps = Math.ceil(segLen / stepSize);

      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const px = a.x + dx * t;
        const pz = a.z + dz * t;

        // Interpolate width
        const aWidth = a.width || riverHalfWidth(a.accumulation || 1) * 2;
        const bWidth = b.width || riverHalfWidth(b.accumulation || 1) * 2;
        const halfW = (aWidth * (1 - t) + bWidth * t) / 2;

        // Stamp circle for waterMask
        const effectiveRadius = Math.max(halfW, this.cellSize * 0.75);
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
      anchor:    { slopePenalty: 10, unbuildableCost: Infinity, reuseDiscount: 0.15, plotPenalty: 5.0 },
      growth:    { slopePenalty: 10, unbuildableCost: Infinity, reuseDiscount: 0.5,  plotPenalty: 5.0 },
      nucleus:   { slopePenalty: 5,  unbuildableCost: 12,       reuseDiscount: 0.1,  plotPenalty: 3.0 },
      shortcuts: { slopePenalty: 8,  unbuildableCost: 20,       reuseDiscount: 1.0,  plotPenalty: 3.0 },
      satellite: { slopePenalty: 10, unbuildableCost: Infinity, reuseDiscount: 0.15, plotPenalty: 5.0 },
      bridge:    { slopePenalty: 3,  unbuildableCost: 8,        reuseDiscount: 0.1,  plotPenalty: 5.0 },
    };

    const p = presets[preset] || presets.growth;
    const { slopePenalty, unbuildableCost, reuseDiscount, plotPenalty } = p;

    const elevation = this.elevation;
    const buildability = this.buildability;
    const roadGrid = this.roadGrid;
    const bridgeGrid = this.bridgeGrid;

    return (fromGx, fromGz, toGx, toGz) => {
      const dx = toGx - fromGx;
      const dz = toGz - fromGz;
      const baseDist = Math.sqrt(dx * dx + dz * dz);

      if (!elevation) return baseDist;

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
        cost += unbuildableCost;
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

        const steps = Math.ceil(segLen / (this.cellSize * 0.5));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const px = a.x + dx * t;
          const pz = a.z + dz * t;
          const aWidth = a.width || riverHalfWidth(a.accumulation || 1) * 2;
          const bWidth = b.width || riverHalfWidth(b.accumulation || 1) * 2;
          const halfW = (aWidth * (1 - t) + bWidth * t) / 2;
          const effectiveRadius = Math.max(halfW, this.cellSize * 0.75);
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
   * Carve river channels into elevation grid.
   */
  carveChannels() {
    if (!this.elevation) return;

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

        const steps = Math.ceil(segLen / (this.cellSize * 0.5));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const px = a.x + dx * t;
          const pz = a.z + dz * t;

          const accum = (a.accumulation || 1) * (1 - t) + (b.accumulation || 1) * t;
          const halfW = riverHalfWidth(accum);
          const maxDepth = Math.min(4, 1.5 + halfW / 15);

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

              const carve = channelProfile(nd) * maxDepth;
              if (carve > 0.05) {
                const current = this.elevation.get(gx, gz);
                this.elevation.set(gx, gz, current - carve);
              }
            }
          }
        }
      }
    }
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
