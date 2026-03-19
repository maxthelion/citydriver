/**
 * Road — an immutable-polyline road entity with parametric bridge support.
 *
 * Coordinate convention: (x, z) — y is up.
 */

let _nextId = 0;

export function _resetRoadIds() {
  _nextId = 0;
}

export class Road {
  #id;
  #polyline;
  #bridges;

  /**
   * @param {Array<{x: number, z: number}>} polyline
   * @param {object} [options]
   * @param {number} [options.width=6]
   * @param {string} [options.hierarchy='local']
   * @param {number} [options.importance=0.45]
   * @param {*}      [options.source]
   */
  constructor(polyline, options = {}) {
    this.#id = _nextId++;
    this.#polyline = _copyPolyline(polyline);
    this.#bridges = [];

    const { width = 6, hierarchy = 'local', importance = 0.45, source } = options;
    this.width = width;
    this.hierarchy = hierarchy;
    this.importance = importance;
    this.source = source;
  }

  // ── Getters ─────────────────────────────────────────────────────────────────

  get id() { return this.#id; }

  /** Returns a snapshot of the polyline (defensive copy). */
  get polyline() { return _copyPolyline(this.#polyline); }

  get start() { return { ...this.#polyline[0] }; }

  get end() { return { ...this.#polyline[this.#polyline.length - 1] }; }

  /** Returns a snapshot of the bridges array. */
  get bridges() { return this.#bridges.map(_copyBridge); }

  // ── Mutation helpers ─────────────────────────────────────────────────────────

  /**
   * Package-private: replace the internal polyline.
   * Needed by RoadNetwork.updatePolyline().
   */
  _replacePolyline(newPolyline) {
    this.#polyline = _copyPolyline(newPolyline);
  }

  /**
   * Add a parametric bridge to this road.
   * @param {Array<{x,z}>} bankA - Points along one side of the bridge
   * @param {Array<{x,z}>} bankB - Points along the other side
   * @param {number} entryT - Fractional arc-length (0..1) where bridge begins
   * @param {number} exitT  - Fractional arc-length (0..1) where bridge ends
   */
  addBridge(bankA, bankB, entryT, exitT) {
    this.#bridges.push({
      bankA: _copyPolyline(bankA),
      bankB: _copyPolyline(bankB),
      entryT,
      exitT,
    });
  }

  // ── Geometry ─────────────────────────────────────────────────────────────────

  /**
   * Returns the polyline with any bridges spliced in at their parametric positions.
   * When no bridges exist, returns a copy of the base polyline.
   *
   * Algorithm:
   *   1. Compute cumulative arc lengths along the base polyline.
   *   2. Sort bridges by entryT.
   *   3. For each bridge: emit base points up to entryT (interpolating the entry
   *      point), then bankA, then bankB, then the interpolated exit point.
   *   4. After all bridges, emit the remaining base points.
   *
   * @returns {Array<{x: number, z: number}>}
   */
  resolvedPolyline() {
    if (this.#bridges.length === 0) {
      return _copyPolyline(this.#polyline);
    }

    const poly = this.#polyline;
    const n = poly.length;

    // 1. Cumulative arc lengths
    const cumLen = new Array(n);
    cumLen[0] = 0;
    for (let i = 1; i < n; i++) {
      const dx = poly[i].x - poly[i - 1].x;
      const dz = poly[i].z - poly[i - 1].z;
      cumLen[i] = cumLen[i - 1] + Math.sqrt(dx * dx + dz * dz);
    }
    const totalLen = cumLen[n - 1];

    /**
     * Interpolate a point at fractional arc length t.
     * Returns {x, z} and the index of the segment it falls on.
     */
    const interpolateAt = (t) => {
      const targetLen = t * totalLen;
      // Find the segment
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
            localT,
          };
        }
      }
      // t >= 1 — clamp to last point
      return { point: { ...poly[n - 1] }, segIndex: n - 2, localT: 1 };
    };

    // 2. Sort bridges by entryT
    const sorted = [...this.#bridges].sort((a, b) => a.entryT - b.entryT);

    // 3. Walk the base polyline, splicing in bridges
    const result = [];
    let baseIdx = 0; // next base polyline index to emit

    for (const bridge of sorted) {
      const entry = interpolateAt(bridge.entryT);
      const exit  = interpolateAt(bridge.exitT);

      // Emit base points strictly before the entry segment index
      while (baseIdx <= entry.segIndex) {
        result.push({ ...poly[baseIdx] });
        baseIdx++;
      }

      // Interpolated entry point (splice onto the segment)
      result.push(entry.point);

      // bankA then bankB
      for (const p of bridge.bankA) result.push({ ...p });
      for (const p of bridge.bankB) result.push({ ...p });

      // Interpolated exit point
      result.push(exit.point);

      // Advance baseIdx to the first base vertex strictly after the exit arc position.
      // That means the first index i where cumLen[i] > exitT * totalLen.
      const exitArcLen = bridge.exitT * totalLen;
      while (baseIdx < n && cumLen[baseIdx] <= exitArcLen + 1e-10) {
        baseIdx++;
      }
    }

    // 4. Emit remaining base points
    while (baseIdx < n) {
      result.push({ ...poly[baseIdx] });
      baseIdx++;
    }

    return result;
  }

  // ── Serialisation ─────────────────────────────────────────────────────────────

  toJSON() {
    return {
      id: this.#id,
      polyline: _copyPolyline(this.#polyline),
      width: this.width,
      hierarchy: this.hierarchy,
      importance: this.importance,
      source: this.source,
      bridges: this.#bridges.map(_copyBridge),
    };
  }

  static fromJSON(data) {
    const road = new Road(data.polyline, {
      width: data.width,
      hierarchy: data.hierarchy,
      importance: data.importance,
      source: data.source,
    });
    // Override the auto-assigned ID to match the serialised one
    road.#id = data.id;
    for (const b of data.bridges) {
      road.addBridge(b.bankA, b.bankB, b.entryT, b.exitT);
    }
    return road;
  }
}

// ── Private helpers ────────────────────────────────────────────────────────────

function _copyPolyline(pts) {
  return pts.map(p => ({ ...p }));
}

function _copyBridge(b) {
  return {
    bankA: _copyPolyline(b.bankA),
    bankB: _copyPolyline(b.bankB),
    entryT: b.entryT,
    exitT: b.exitT,
  };
}
