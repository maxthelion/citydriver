/**
 * Regional road network generation.
 *
 * Builds a tree-like road network where:
 * 1. Cities are connected by trunk roads (MST + redundancy)
 * 2. Towns branch off the existing network via spurs (T-junctions)
 * 3. Villages branch off via spurs to the nearest road cell
 *
 * This avoids parallel duplicate roads by ensuring each new settlement
 * connects to the nearest point on the existing network rather than
 * routing independently to another settlement.
 */
import { findPath, terrainCostFunction, simplifyPath, smoothPath } from '../core/pathfinding.js';
import { ROCK_PROPERTIES } from './geology.js';

/**
 * Union-Find for Kruskal's MST.
 */
class UnionFind {
  constructor(n) {
    this.parent = new Array(n);
    this._rank = new Array(n);
    for (let i = 0; i < n; i++) {
      this.parent[i] = i;
      this._rank[i] = 0;
    }
  }

  find(x) {
    if (this.parent[x] !== x) {
      this.parent[x] = this.find(this.parent[x]);
    }
    return this.parent[x];
  }

  union(x, y) {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx === ry) return false;
    if (this._rank[rx] < this._rank[ry]) {
      this.parent[rx] = ry;
    } else if (this._rank[rx] > this._rank[ry]) {
      this.parent[ry] = rx;
    } else {
      this.parent[ry] = rx;
      this._rank[rx]++;
    }
    return true;
  }
}

/**
 * Generate the inter-settlement road network.
 *
 * Algorithm:
 *   Phase 1 – Build trunk roads between cities (Kruskal MST + redundancy).
 *   Phase 2 – Each unconnected town spurs to the nearest existing road cell.
 *   Phase 3 – Each unconnected village spurs to the nearest existing road cell.
 *   Phase 4 – Compute road-entry directions per settlement.
 *
 * Settlements are processed closest-to-network first so the network grows
 * outward naturally (Prim-like).  Each spur's `to` field is set to the
 * nearest endpoint of the road it joins, preserving graph connectivity for
 * BFS reachability.
 *
 * @param {Array<object>} settlements - Settlement[] from placeSettlements
 * @param {import('../core/heightmap.js').Heightmap} heightmap
 * @param {object} drainage - From generateDrainage (needs waterCells)
 * @returns {{
 *   roads: Array<object>,
 *   settlements: Array<object>,
 * }}
 */
export function generateRegionalRoads(settlements, heightmap, drainage, geology = null) {
  if (settlements.length < 2) {
    for (const s of settlements) s.roadEntries = [];
    return { roads: [], settlements };
  }

  const W = heightmap.width;
  const H = heightmap.height;
  const cellSize = heightmap._cellSize;
  const { waterCells } = drainage;

  const baseCostFn = terrainCostFunction(heightmap, {
    slopePenalty: 12,
    waterCells,
    waterPenalty: 200,
    edgeMargin: 3,
    edgePenalty: 10,
  });

  // Wrap cost function with geology modifiers
  const costFn = geology
    ? (fromGx, fromGz, toGx, toGz) => {
      let cost = baseCostFn(fromGx, fromGz, toGx, toGz);
      const idx = toGz * W + toGx;
      const rockType = geology.rockTypes[idx];
      const resistance = ROCK_PROPERTIES[rockType].erosionResistance;

      // Hard rock: roads avoid highlands (3x cost increase)
      if (resistance >= 0.7) {
        cost *= 1 + 2 * resistance; // up to ~2.9x for igneous
      }

      // Spring-line cells: natural route along escarpment base (cheaper)
      if (geology.springLine[idx]) {
        cost *= 0.6;
      }

      return cost;
    }
    : baseCostFn;

  // -----------------------------------------------------------------
  // Road-cell bookkeeping
  // -----------------------------------------------------------------
  const roadPresence = new Uint8Array(W * H);
  const roadCellList = [];                        // all road cells
  const cellToRoadIdx = new Int32Array(W * H).fill(-1); // first road through cell
  const cellToSettlementIdx = new Map();           // cell key → settlement index

  function addPathToNetwork(gridPath, roadIndex) {
    for (const pt of gridPath) {
      const key = pt.gz * W + pt.gx;
      if (!roadPresence[key]) {
        roadPresence[key] = 1;
        roadCellList.push({ gx: pt.gx, gz: pt.gz });
        cellToRoadIdx[key] = roadIndex;
      }
    }
  }

  /** Seed a single cell as a road anchor (for lone cities/towns). */
  function seedCell(gx, gz, settlementIdx) {
    const key = gz * W + gx;
    if (!roadPresence[key]) {
      roadPresence[key] = 1;
      roadCellList.push({ gx, gz });
    }
    cellToSettlementIdx.set(key, settlementIdx);
  }

  /** Euclidean nearest road cell (squared-distance comparison). */
  function findNearestRoadCell(gx, gz) {
    let bestDistSq = Infinity;
    let best = null;
    for (const cell of roadCellList) {
      const dx = cell.gx - gx;
      const dz = cell.gz - gz;
      const dsq = dx * dx + dz * dz;
      if (dsq < bestDistSq) {
        bestDistSq = dsq;
        best = cell;
      }
    }
    return best;
  }

  /**
   * Given a spur settlement and the road cell it connects to,
   * determine a settlement to use as the spur road's `to` field
   * so the adjacency graph stays connected.
   */
  function findToSettlement(spurSettlement, nearestCell) {
    const key = nearestCell.gz * W + nearestCell.gx;

    // If target cell IS a settlement, connect directly
    if (cellToSettlementIdx.has(key)) {
      return settlements[cellToSettlementIdx.get(key)];
    }

    // If target cell is on a road, pick the nearest endpoint of that road
    const roadIdx = cellToRoadIdx[key];
    if (roadIdx >= 0 && roads[roadIdx]) {
      const road = roads[roadIdx];
      const candidates = [road.from, road.to].filter(Boolean);
      if (candidates.length === 1) return candidates[0];
      if (candidates.length >= 2) {
        const d0 = (spurSettlement.gx - candidates[0].gx) ** 2 +
                    (spurSettlement.gz - candidates[0].gz) ** 2;
        const d1 = (spurSettlement.gx - candidates[1].gx) ** 2 +
                    (spurSettlement.gz - candidates[1].gz) ** 2;
        return d0 <= d1 ? candidates[0] : candidates[1];
      }
    }

    // Fallback: nearest already-connected settlement
    let best = null;
    let bestDist = Infinity;
    for (const idx of connected) {
      const s = settlements[idx];
      const d = (spurSettlement.gx - s.gx) ** 2 + (spurSettlement.gz - s.gz) ** 2;
      if (d < bestDist) { bestDist = d; best = s; }
    }
    return best;
  }

  // -----------------------------------------------------------------
  // Settlement classification
  // -----------------------------------------------------------------
  const cityIndices = [];
  const townIndices = [];
  const villageIndices = [];
  for (let i = 0; i < settlements.length; i++) {
    const s = settlements[i];
    if (s.rank === 'city') cityIndices.push(i);
    else if (s.rank === 'town') townIndices.push(i);
    else villageIndices.push(i);
  }

  const roads = [];
  const connected = new Set();
  const connectedPairs = new Set();

  function pairKey(a, b) { return a < b ? `${a}-${b}` : `${b}-${a}`; }

  // -----------------------------------------------------------------
  // Route helpers
  // -----------------------------------------------------------------

  /** Route between two settlements and record a trunk road. */
  function connectSettlementPair(fromIdx, toIdx, hierarchy) {
    const pk = pairKey(fromIdx, toIdx);
    if (connectedPairs.has(pk)) return;

    const from = settlements[fromIdx];
    const to = settlements[toIdx];
    const result = findPath(from.gx, from.gz, to.gx, to.gz, W, H, costFn);
    if (!result) return;

    connectedPairs.add(pk);
    const roadIdx = roads.length;

    const simplified = simplifyPath(result.path, 1.5);
    const worldPath = smoothPath(simplified, cellSize, 2);

    roads.push({
      from,
      to,
      path: result.path,
      worldPath,
      hierarchy,
      cost: result.cost,
    });

    addPathToNetwork(result.path, roadIdx);
    connected.add(fromIdx);
    connected.add(toIdx);
    cellToSettlementIdx.set(from.gz * W + from.gx, fromIdx);
    cellToSettlementIdx.set(to.gz * W + to.gx, toIdx);
  }

  /** Route from a settlement to the nearest existing road cell (spur). */
  function connectToNearestRoad(settlementIdx, hierarchy) {
    if (connected.has(settlementIdx)) return;

    const s = settlements[settlementIdx];
    const sKey = s.gz * W + s.gx;

    // If settlement cell is already on a road, record connectivity
    if (roadPresence[sKey]) {
      connected.add(settlementIdx);
      cellToSettlementIdx.set(sKey, settlementIdx);
      const toSettlement = findToSettlement(s, { gx: s.gx, gz: s.gz });
      if (toSettlement && toSettlement !== s) {
        const worldPt = heightmap.gridToWorld(s.gx, s.gz);
        roads.push({
          from: s,
          to: toSettlement,
          path: [{ gx: s.gx, gz: s.gz }],
          worldPath: [{ x: worldPt.x, z: worldPt.z }],
          hierarchy,
          cost: 0,
        });
      }
      return;
    }

    const nearest = findNearestRoadCell(s.gx, s.gz);
    if (!nearest) return;

    const result = findPath(s.gx, s.gz, nearest.gx, nearest.gz, W, H, costFn);
    if (!result) return;

    const toSettlement = findToSettlement(s, nearest);
    const roadIdx = roads.length;

    const simplified = simplifyPath(result.path, 1.5);
    const worldPath = smoothPath(simplified, cellSize, 2);

    roads.push({
      from: s,
      to: toSettlement,
      path: result.path,
      worldPath,
      hierarchy,
      cost: result.cost,
    });

    addPathToNetwork(result.path, roadIdx);
    connected.add(settlementIdx);
    cellToSettlementIdx.set(sKey, settlementIdx);
  }

  // Relaxed cost function: cap water penalty at 20 (vs 200 in normal)
  const relaxedCostFn = terrainCostFunction(heightmap, {
    slopePenalty: 12,
    waterCells,
    waterPenalty: 20,
    edgeMargin: 3,
    edgePenalty: 10,
  });

  /**
   * Connect all unconnected settlements in `indices` to the nearest road
   * cell, processing the closest ones first (Prim-like network growth).
   */
  function connectRemainderAsSpurs(indices, hierarchy) {
    const remaining = new Set(indices.filter(i => !connected.has(i)));

    while (remaining.size > 0) {
      let bestIdx = -1;
      let bestDistSq = Infinity;

      for (const idx of remaining) {
        const s = settlements[idx];
        const nearest = findNearestRoadCell(s.gx, s.gz);
        if (!nearest) continue;
        const dsq = (s.gx - nearest.gx) ** 2 + (s.gz - nearest.gz) ** 2;
        if (dsq < bestDistSq) {
          bestDistSq = dsq;
          bestIdx = idx;
        }
      }

      if (bestIdx < 0) break;
      connectToNearestRoad(bestIdx, hierarchy);
      remaining.delete(bestIdx);
    }

    // Fallback: force-connect any still-unconnected settlements with relaxed cost
    const stillUnconnected = indices.filter(i => !connected.has(i));
    for (const idx of stillUnconnected) {
      const s = settlements[idx];
      const nearest = findNearestRoadCell(s.gx, s.gz);
      if (!nearest) continue;

      const result = findPath(s.gx, s.gz, nearest.gx, nearest.gz, W, H, relaxedCostFn);
      if (!result) continue;

      const toSettlement = findToSettlement(s, nearest);
      const roadIdx = roads.length;

      const simplified = simplifyPath(result.path, 1.5);
      const worldPath = smoothPath(simplified, cellSize, 2);

      roads.push({
        from: s,
        to: toSettlement,
        path: result.path,
        worldPath,
        hierarchy,
        cost: result.cost,
      });

      addPathToNetwork(result.path, roadIdx);
      connected.add(idx);
      cellToSettlementIdx.set(s.gz * W + s.gx, idx);
    }
  }

  // =================================================================
  // Phase 1: Trunk network (highest-rank settlements)
  // =================================================================

  if (cityIndices.length >= 2) {
    // City-city MST → major trunk roads
    const edges = [];
    for (let i = 0; i < cityIndices.length; i++) {
      for (let j = i + 1; j < cityIndices.length; j++) {
        const a = settlements[cityIndices[i]];
        const b = settlements[cityIndices[j]];
        const d = Math.sqrt(
          (a.gx - b.gx) ** 2 + (a.gz - b.gz) ** 2
        );
        edges.push({ i, j, idxA: cityIndices[i], idxB: cityIndices[j], dist: d });
      }
    }
    edges.sort((a, b) => a.dist - b.dist);

    const uf = new UnionFind(cityIndices.length);
    let maxMstDist = 0;
    for (const e of edges) {
      if (uf.union(e.i, e.j)) {
        connectSettlementPair(e.idxA, e.idxB, 'major');
        if (e.dist > maxMstDist) maxMstDist = e.dist;
      }
    }
    // Add redundant edges within 1.5× longest MST edge
    for (const e of edges) {
      if (e.dist <= maxMstDist * 1.5) {
        connectSettlementPair(e.idxA, e.idxB, 'major');
      }
    }
  } else if (cityIndices.length === 1) {
    // Single city — seed the network at its location
    const c = settlements[cityIndices[0]];
    seedCell(c.gx, c.gz, cityIndices[0]);
    connected.add(cityIndices[0]);
  }

  // If no cities exist, build a town-MST backbone
  if (cityIndices.length === 0 && townIndices.length >= 2) {
    const edges = [];
    for (let i = 0; i < townIndices.length; i++) {
      for (let j = i + 1; j < townIndices.length; j++) {
        const a = settlements[townIndices[i]];
        const b = settlements[townIndices[j]];
        const d = Math.sqrt(
          (a.gx - b.gx) ** 2 + (a.gz - b.gz) ** 2
        );
        edges.push({ i, j, idxA: townIndices[i], idxB: townIndices[j], dist: d });
      }
    }
    edges.sort((a, b) => a.dist - b.dist);
    const uf = new UnionFind(townIndices.length);
    for (const e of edges) {
      if (uf.union(e.i, e.j)) {
        connectSettlementPair(e.idxA, e.idxB, 'secondary');
      }
    }
  } else if (cityIndices.length === 0 && townIndices.length === 1) {
    const t = settlements[townIndices[0]];
    seedCell(t.gx, t.gz, townIndices[0]);
    connected.add(townIndices[0]);
  }

  // =================================================================
  // Phase 2: Towns spur to nearest road (closest-first)
  // =================================================================
  connectRemainderAsSpurs(townIndices, 'secondary');

  // =================================================================
  // Phase 3: Villages spur to nearest road
  // =================================================================

  // Edge case: no roads exist at all (no cities, no towns)
  if (roadCellList.length === 0 && villageIndices.length >= 2) {
    // Connect two closest villages to seed the network
    let bestDist = Infinity;
    let bestA = -1;
    let bestB = -1;
    for (let i = 0; i < villageIndices.length; i++) {
      for (let j = i + 1; j < villageIndices.length; j++) {
        const a = settlements[villageIndices[i]];
        const b = settlements[villageIndices[j]];
        const d = (a.gx - b.gx) ** 2 + (a.gz - b.gz) ** 2;
        if (d < bestDist) {
          bestDist = d;
          bestA = villageIndices[i];
          bestB = villageIndices[j];
        }
      }
    }
    if (bestA >= 0) {
      connectSettlementPair(bestA, bestB, 'minor');
    }
  } else if (roadCellList.length === 0 && villageIndices.length === 1) {
    const v = settlements[villageIndices[0]];
    seedCell(v.gx, v.gz, villageIndices[0]);
    connected.add(villageIndices[0]);
  }

  connectRemainderAsSpurs(villageIndices, 'minor');

  // =================================================================
  // Phase 4: Compute road entries for each settlement
  // =================================================================
  const entryRadius = Math.min(20, Math.floor(W / 4));

  for (let si = 0; si < settlements.length; si++) {
    const settlement = settlements[si];
    const entries = [];

    for (const road of roads) {
      let isFrom = false;
      let isTo = false;
      if (road.from === settlement) isFrom = true;
      if (road.to === settlement) isTo = true;
      if (!isFrom && !isTo) continue;

      // Walk the grid path from the settlement end
      const gridPath = road.path;
      const pathOrder = isFrom ? gridPath : [...gridPath].reverse();
      let entryPoint = null;

      for (let p = 1; p < pathOrder.length; p++) {
        const pt = pathOrder[p];
        const dx = pt.gx - settlement.gx;
        const dz = pt.gz - settlement.gz;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d >= entryRadius) {
          const prev = pathOrder[p - 1];
          const prevDx = prev.gx - settlement.gx;
          const prevDz = prev.gz - settlement.gz;
          const prevD = Math.sqrt(prevDx * prevDx + prevDz * prevDz);

          const t = prevD < d ? (entryRadius - prevD) / (d - prevD) : 0.5;
          const interpGx = prev.gx + t * (pt.gx - prev.gx);
          const interpGz = prev.gz + t * (pt.gz - prev.gz);

          const world = heightmap.gridToWorld(interpGx, interpGz);
          entryPoint = { x: world.x, z: world.z };
          break;
        }
      }

      // Path too short for entryRadius — use last point
      if (!entryPoint && pathOrder.length > 1) {
        const last = pathOrder[pathOrder.length - 1];
        const world = heightmap.gridToWorld(last.gx, last.gz);
        entryPoint = { x: world.x, z: world.z };
      }

      if (entryPoint) {
        const dx = entryPoint.x - settlement.x;
        const dz = entryPoint.z - settlement.z;
        let direction = Math.atan2(dz, dx);
        if (direction < 0) direction += 2 * Math.PI;

        let destination;
        if (isFrom && road.to) {
          destination = `${road.to.rank} at (${road.to.gx},${road.to.gz})`;
        } else if (isTo && road.from) {
          destination = `${road.from.rank} at (${road.from.gx},${road.from.gz})`;
        } else {
          destination = 'road network';
        }

        entries.push({
          point: entryPoint,
          direction,
          hierarchy: road.hierarchy,
          destination,
        });
      }
    }

    settlement.roadEntries = entries;
  }

  return { roads, settlements };
}
