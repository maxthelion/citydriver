/**
 * Land-First Development strategy.
 * Thin sequencer — each tick calls a pipeline function.
 *
 * Tick 1: Skeleton roads
 * Tick 2: Recompute land value with nucleus-aware formula
 * Tick 3: Extract development zones
 * Tick 4: Reserve land for non-residential uses (archetype-driven)
 * Tick 5: Ribbon layout — place parallel streets within zones
 * Tick 6: Connect zone spines to skeleton network
 */

import { buildSkeletonRoads } from '../pipeline/buildSkeletonRoads.js';
import { computeLandValue } from '../pipeline/computeLandValue.js';
import { extractZones } from '../pipeline/extractZones.js';
import { reserveLandUse } from '../pipeline/reserveLandUse.js';
import { layoutRibbons } from '../pipeline/layoutRibbons.js';
import { connectToNetwork } from '../pipeline/connectToNetwork.js';

export class LandFirstDevelopment {
  constructor(map, options = {}) {
    this.map = map;
    this._tick = 0;
    this.archetype = options.archetype || null;
  }

  tick() {
    this._tick++;
    switch (this._tick) {
      case 1: this.map = buildSkeletonRoads(this.map); return true;
      case 2: this.map = computeLandValue(this.map); return true;
      case 3: this.map = extractZones(this.map); return true;
      case 4: this.map = reserveLandUse(this.map, this.archetype); return true;
      case 5: this.map = layoutRibbons(this.map); return true;
      case 6: this.map = connectToNetwork(this.map); return true;
      default: return false;
    }
  }
}
