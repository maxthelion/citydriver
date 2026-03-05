/**
 * Union-Find (disjoint set) with path compression and union by rank.
 */
export class UnionFind {
  constructor(n) {
    this.parent = new Int32Array(n);
    this.rank = new Uint8Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }

  find(x) {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]]; // path halving
      x = this.parent[x];
    }
    return x;
  }

  union(x, y) {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx === ry) return false;
    if (this.rank[rx] < this.rank[ry]) {
      this.parent[rx] = ry;
    } else if (this.rank[rx] > this.rank[ry]) {
      this.parent[ry] = rx;
    } else {
      this.parent[ry] = rx;
      this.rank[rx]++;
    }
    return true;
  }

  connected(x, y) {
    return this.find(x) === this.find(y);
  }

  /**
   * Returns a Map from root index to array of member indices.
   */
  components() {
    const map = new Map();
    for (let i = 0; i < this.parent.length; i++) {
      const root = this.find(i);
      if (!map.has(root)) map.set(root, []);
      map.get(root).push(i);
    }
    return map;
  }

  componentCount() {
    const roots = new Set();
    for (let i = 0; i < this.parent.length; i++) roots.add(this.find(i));
    return roots.size;
  }
}
