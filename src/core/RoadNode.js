let _nextRoadNodeId = 0;

export function _resetRoadNodeIds() {
  _nextRoadNodeId = 0;
}

export class RoadNode {
  /**
   * @param {number} x
   * @param {number} z
   * @param {object} [attrs]
   */
  constructor(x, z, attrs = {}) {
    this.id = _nextRoadNodeId++;
    this.x = x;
    this.z = z;
    this.attrs = { ...attrs };
  }

  clone() {
    const node = new RoadNode(this.x, this.z, this.attrs);
    node.id = this.id;
    return node;
  }

  toJSON() {
    return {
      id: this.id,
      x: this.x,
      z: this.z,
      attrs: { ...this.attrs },
    };
  }

  static fromJSON(data) {
    const node = new RoadNode(data.x, data.z, data.attrs || {});
    node.id = data.id;
    if (typeof data.id === 'number' && data.id >= _nextRoadNodeId) {
      _nextRoadNodeId = data.id + 1;
    }
    return node;
  }
}
