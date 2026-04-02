import { RoadNode } from './RoadNode.js';

let _nextRoadWayId = 0;

export function _resetRoadWayIds() {
  _nextRoadWayId = 0;
}

export class RoadWay {
  #bridges;

  /**
   * @param {RoadNode[]} nodes
   * @param {object} [options]
   * @param {number} [options.width=6]
   * @param {string} [options.hierarchy='local']
   * @param {number} [options.importance=0.45]
   * @param {*}      [options.source]
   */
  constructor(nodes, options = {}) {
    this.id = _nextRoadWayId++;
    this.nodes = [...nodes];
    this.#bridges = [];

    const { width = 6, hierarchy = 'local', importance = 0.45, source } = options;
    this.width = width;
    this.hierarchy = hierarchy;
    this.importance = importance;
    this.source = source;
  }

  /**
   * @param {Array<{x: number, z: number}>} polyline
   * @param {object} [options]
   * @param {(x: number, z: number) => RoadNode} [createNode]
   * @returns {RoadWay}
   */
  static fromPolyline(polyline, options = {}, createNode = (x, z) => new RoadNode(x, z)) {
    const nodes = polyline.map(p => createNode(p.x, p.z));
    return new RoadWay(nodes, options);
  }

  get polyline() {
    return this.nodes.map(node => ({ x: node.x, z: node.z }));
  }

  get start() {
    const node = this.nodes[0];
    return node ? { x: node.x, z: node.z } : null;
  }

  get end() {
    const node = this.nodes[this.nodes.length - 1];
    return node ? { x: node.x, z: node.z } : null;
  }

  get bridges() {
    return this.#bridges.map(b => ({
      bankA: { x: b.bankA.x, z: b.bankA.z },
      bankB: { x: b.bankB.x, z: b.bankB.z },
      entryT: b.entryT,
      exitT: b.exitT,
    }));
  }

  addBridge(bankA, bankB, entryT, exitT) {
    this.#bridges.push({
      bankA: { x: bankA.x, z: bankA.z },
      bankB: { x: bankB.x, z: bankB.z },
      entryT,
      exitT,
    });
  }

  replaceNodes(nodes) {
    this.nodes = [...nodes];
  }

  resolvedPolyline() {
    const poly = this.polyline;
    if (this.#bridges.length === 0) {
      return poly;
    }

    const n = poly.length;
    const cumLen = new Array(n);
    cumLen[0] = 0;
    for (let i = 1; i < n; i++) {
      const dx = poly[i].x - poly[i - 1].x;
      const dz = poly[i].z - poly[i - 1].z;
      cumLen[i] = cumLen[i - 1] + Math.sqrt(dx * dx + dz * dz);
    }
    const totalLen = cumLen[n - 1];

    const interpolateAt = (t) => {
      const targetLen = t * totalLen;
      for (let i = 1; i < n; i++) {
        if (cumLen[i] >= targetLen - 1e-10) {
          const segLen = cumLen[i] - cumLen[i - 1];
          const localT = segLen === 0 ? 0 : (targetLen - cumLen[i - 1]) / segLen;
          return {
            point: {
              x: poly[i - 1].x + localT * (poly[i].x - poly[i - 1].x),
              z: poly[i - 1].z + localT * (poly[i].z - poly[i - 1].z),
            },
            segIndex: i - 1,
          };
        }
      }
      return { point: { ...poly[n - 1] }, segIndex: n - 2 };
    };

    const sorted = [...this.#bridges].sort((a, b) => a.entryT - b.entryT);
    const result = [];
    let baseIdx = 0;

    for (const bridge of sorted) {
      const entry = interpolateAt(bridge.entryT);
      const exit = interpolateAt(bridge.exitT);

      while (baseIdx <= entry.segIndex) {
        result.push({ ...poly[baseIdx] });
        baseIdx++;
      }

      result.push(entry.point);
      result.push({ x: bridge.bankA.x, z: bridge.bankA.z });
      result.push({ x: bridge.bankB.x, z: bridge.bankB.z });
      result.push(exit.point);

      const exitArcLen = bridge.exitT * totalLen;
      while (baseIdx < n && cumLen[baseIdx] <= exitArcLen + 1e-10) {
        baseIdx++;
      }
    }

    while (baseIdx < n) {
      result.push({ ...poly[baseIdx] });
      baseIdx++;
    }

    return result;
  }

  toJSON() {
    return {
      id: this.id,
      nodes: this.nodes.map(node => node.toJSON()),
      width: this.width,
      hierarchy: this.hierarchy,
      importance: this.importance,
      source: this.source,
      bridges: this.bridges,
    };
  }

  static fromJSON(data) {
    const nodes = (data.nodes || []).map(node => RoadNode.fromJSON(node));
    const way = new RoadWay(nodes, {
      width: data.width,
      hierarchy: data.hierarchy,
      importance: data.importance,
      source: data.source,
    });
    way.id = data.id;
    if (typeof data.id === 'number' && data.id >= _nextRoadWayId) {
      _nextRoadWayId = data.id + 1;
    }
    for (const bridge of data.bridges || []) {
      way.addBridge(bridge.bankA, bridge.bankB, bridge.entryT, bridge.exitT);
    }
    return way;
  }
}
