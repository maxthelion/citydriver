/**
 * Land-First Development strategy.
 * Thin sequencer — each tick calls a pipeline function.
 *
 * Tick 1: Skeleton roads
 * Tick 2: Recompute land value with nucleus-aware formula
 * Tick 3: Extract development zones
 * Tick 4: Compute spatial layers (centrality, waterfrontness, etc.)
 * Tick 5..N: Growth agent ticks (archetype-driven incremental zoning)
 * N+1: Ribbon layout — place parallel streets within zones
 * N+2: Connect zone spines to skeleton network
 */

import { buildSkeletonRoads } from '../pipeline/buildSkeletonRoads.js';
import { computeLandValue } from '../pipeline/computeLandValue.js';
import { extractZones } from '../pipeline/extractZones.js';
import { computeSpatialLayers } from '../pipeline/computeSpatialLayers.js';
import { reserveLandUse } from '../pipeline/reserveLandUse.js';
import { initGrowthState, runGrowthTick } from '../pipeline/growthTick.js';
import { layoutRibbons } from '../pipeline/layoutRibbons.js';
import { connectToNetwork } from '../pipeline/connectToNetwork.js';

export class LandFirstDevelopment {
  constructor(map, options = {}) {
    this.map = map;
    this._tick = 0;
    this.archetype = options.archetype || null;
    this._growthState = null;
    this._growthDone = false;
    this._phase = 'pipeline'; // 'pipeline' | 'growth' | 'finish'
  }

  tick() {
    this._tick++;

    if (this._phase === 'pipeline') {
      switch (this._tick) {
        case 1: this.map = buildSkeletonRoads(this.map); return true;
        case 2: this.map = computeLandValue(this.map); return true;
        case 3: this.map = extractZones(this.map); return true;
        case 4: this.map = computeSpatialLayers(this.map); return true;
        case 5:
          // Start growth phase if archetype has growth config, else fall back to old system
          if (this.archetype && this.archetype.growth) {
            this._phase = 'growth';
            this._growthState = initGrowthState(this.map, this.archetype);
            this._growthDone = runGrowthTick(this.map, this.archetype, this._growthState);
            return true;
          } else {
            this.map = reserveLandUse(this.map, this.archetype);
            this._phase = 'finish';
            this._finishTick = 0;
            return true;
          }
        default:
          return false;
      }
    }

    if (this._phase === 'growth') {
      if (this._growthDone) {
        this._phase = 'finish';
        this._finishTick = 0;
        return this.tick(); // immediately run first finish tick
      }
      this._growthDone = runGrowthTick(this.map, this.archetype, this._growthState);
      return true;
    }

    if (this._phase === 'finish') {
      this._finishTick = (this._finishTick || 0) + 1;
      // When growth config is active, skip layoutRibbons — roads are grown during ticks
      const hasGrowth = this.archetype && this.archetype.growth;
      switch (this._finishTick) {
        case 1:
          if (hasGrowth) {
            // Skip layoutRibbons, go straight to connectToNetwork
            this.map = connectToNetwork(this.map);
            return true;
          }
          this.map = layoutRibbons(this.map);
          return true;
        case 2:
          if (hasGrowth) return false; // already ran connectToNetwork
          this.map = connectToNetwork(this.map);
          return true;
        default: return false;
      }
    }

    return false;
  }
}
