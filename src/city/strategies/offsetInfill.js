import { buildSkeletonRoads } from '../skeleton.js';

export class OffsetInfill {
  constructor(map) {
    this.map = map;
    this._tick = 0;
  }

  tick() {
    this._tick++;
    if (this._tick === 1) {
      buildSkeletonRoads(this.map);
      return true;
    }
    return false;
  }
}
