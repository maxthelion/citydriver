import { buildSkeletonRoads } from '../skeleton.js';
import { findPath, simplifyPath, gridPathToWorldPolyline } from '../../core/pathfinding.js';
import { Grid2D } from '../../core/Grid2D.js';

// ── Zone extraction constants (meters) ────────────────────────
const ZONE_LAND_VALUE_MIN = 0.3;
const ZONE_BUILDABILITY_MIN = 0.2;
const ZONE_SLOPE_MAX = 0.2;
const ZONE_MORPH_RADIUS = 2;           // cells for dilate/erode (physical ~10m at 5m res)
const ZONE_MIN_CELLS = 30;             // ~750m² at 5m

// ── Ribbon layout constants (meters) ─────────────────────────
const RIBBON_SPACING_DENSE = 30;       // <100m from nucleus
const RIBBON_SPACING_MID = 40;         // 100-300m
const RIBBON_SPACING_SUBURBAN = 50;    // >300m
const CROSS_STREET_INTERVAL = 90;      // meters between cross streets
const CROSS_STREET_MIN_LENGTH = 20;    // minimum cross street length (meters)
const SLOPE_CONTOUR_THRESHOLD = 0.1;   // avg slope above which streets follow contours

// ── Connection constants ─────────────────────────────────────
const MAX_CONNECTION_PATH = 500;       // meters — max A* path to skeleton

// ── Plot constants (meters) ──────────────────────────────────
const PLOT_WIDTH_TERRACED = 5;
const PLOT_WIDTH_SEMI = 7.5;
const PLOT_WIDTH_DETACHED = 11;
const PLOT_DEPTH = 12;

/**
 * Land-First Development strategy.
 *
 * Tick 1: Skeleton roads (unchanged)
 * Tick 2: Recompute land value with nucleus-aware formula, extract development zones
 * Tick 3: Ribbon layout — place parallel streets within zones
 * Tick 4: Connect zone spines to skeleton network
 * Tick 5: Plot subdivision — place parcels between ribbons
 * Tick 6: (reserved)
 */
export class StripDevelopment {
  constructor(map) {
    this.map = map;
    this._tick = 0;
    /** @type {Array<Zone>} */
    this._zones = [];
    this._parcels = [];
    this._nextParcelId = 0;
  }

  tick() {
    this._tick++;
    if (this._tick === 1) {
      buildSkeletonRoads(this.map);
      return true;
    }
    if (this._tick === 2) {
      this._recomputeLandValue();
      this._extractZones();
      return true;
    }
    if (this._tick === 3) {
      this._ribbonLayout();
      return true;
    }
    if (this._tick === 4) {
      this._connectToNetwork();
      return true;
    }
    if (this._tick === 5) {
      this._subdividePlots();
      return true;
    }
    return false;
  }

  // ── Tick 2a: Recompute land value with nuclei ──────────────

  _recomputeLandValue() {
    // Nuclei are now placed — recompute land value so proximity is per-nucleus
    this.map.computeLandValue();
  }

  // ── Tick 2b: Zone extraction ───────────────────────────────

  _extractZones() {
    const map = this.map;
    const w = map.width, h = map.height;
    const cs = map.cellSize;
    const nuclei = map.nuclei;
    if (!nuclei || nuclei.length === 0) return;

    // 1. Voronoi assignment — each cell belongs to nearest nucleus
    const ownership = new Uint16Array(w * h);
    for (let gz = 0; gz < h; gz++) {
      for (let gx = 0; gx < w; gx++) {
        let minD = Infinity, bestN = 0;
        for (let ni = 0; ni < nuclei.length; ni++) {
          const dx = gx - nuclei[ni].gx, dz = gz - nuclei[ni].gz;
          const d = dx * dx + dz * dz;
          if (d < minD) { minD = d; bestN = ni; }
        }
        ownership[gz * w + gx] = bestN;
      }
    }

    // 2. Threshold — candidate cells must meet all criteria
    const candidate = new Uint8Array(w * h);
    for (let gz = 0; gz < h; gz++) {
      for (let gx = 0; gx < w; gx++) {
        if (map.waterMask.get(gx, gz) > 0) continue;
        if (map.landValue.get(gx, gz) < ZONE_LAND_VALUE_MIN) continue;
        if (map.buildability.get(gx, gz) < ZONE_BUILDABILITY_MIN) continue;
        if (map.slope && map.slope.get(gx, gz) >= ZONE_SLOPE_MAX) continue;
        candidate[gz * w + gx] = 1;
      }
    }

    // 3. Morphological close (dilate then erode) to fill small gaps
    const dilated = _morphDilate(candidate, w, h, ZONE_MORPH_RADIUS);
    // Remove dilated cells that fail slope check
    if (map.slope) {
      for (let i = 0; i < w * h; i++) {
        if (dilated[i] && !candidate[i]) {
          const gx = i % w, gz = (i - gx) / w;
          if (map.slope.get(gx, gz) >= ZONE_SLOPE_MAX) dilated[i] = 0;
        }
      }
    }
    const closed = _morphErode(dilated, w, h, ZONE_MORPH_RADIUS);

    // 4. Flood-fill connected components per nucleus territory
    const visited = new Uint8Array(w * h);
    const zones = [];
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];

    for (let gz = 0; gz < h; gz++) {
      for (let gx = 0; gx < w; gx++) {
        const idx = gz * w + gx;
        if (visited[idx] || !closed[idx]) continue;
        const nucleusIdx = ownership[idx];

        // BFS flood-fill
        const cells = [];
        const queue = [idx];
        visited[idx] = 1;
        let totalValue = 0;

        while (queue.length > 0) {
          const ci = queue.pop();
          const cx = ci % w, cz = (ci - cx) / w;
          cells.push({ gx: cx, gz: cz });
          totalValue += map.landValue.get(cx, cz);

          for (const [dx, dz] of dirs) {
            const nx = cx + dx, nz = cz + dz;
            if (nx < 0 || nx >= w || nz < 0 || nz >= h) continue;
            const ni = nz * w + nx;
            if (visited[ni] || !closed[ni]) continue;
            if (ownership[ni] !== nucleusIdx) continue;
            visited[ni] = 1;
            queue.push(ni);
          }
        }

        // 5. Filter by minimum size
        if (cells.length < ZONE_MIN_CELLS) continue;

        // Compute centroid
        let sumGx = 0, sumGz = 0;
        for (const c of cells) { sumGx += c.gx; sumGz += c.gz; }
        const centroidGx = sumGx / cells.length;
        const centroidGz = sumGz / cells.length;

        // Distance from centroid to nucleus
        const n = nuclei[nucleusIdx];
        const distToNucleus = Math.sqrt(
          (centroidGx - n.gx) ** 2 + (centroidGz - n.gz) ** 2
        ) * cs;

        zones.push({
          nucleusIdx,
          cells,
          centroidGx,
          centroidGz,
          totalValue,
          distToNucleus,
          priority: totalValue / Math.max(1, distToNucleus),
        });
      }
    }

    // 6. Sort by priority (high-value zones close to nucleus first)
    zones.sort((a, b) => b.priority - a.priority);

    this._zones = zones;

    // Store on map for debug visualization
    if (!map.devLand) {
      map.devLand = new Grid2D(w, h, { type: 'uint16' });
    }
    for (let i = 0; i < zones.length; i++) {
      for (const c of zones[i].cells) {
        map.devLand.set(c.gx, c.gz, i + 1);
      }
    }

    // Store zone data for debug layers
    map.zones = zones;
  }

  // ── Tick 3: Ribbon layout ──────────────────────────────────

  _ribbonLayout() {
    const map = this.map;
    const cs = map.cellSize;

    for (const zone of this._zones) {
      const n = map.nuclei[zone.nucleusIdx];

      // Compute ribbon spacing based on distance to nucleus
      const dist = zone.distToNucleus;
      let spacing;
      if (dist < 100) spacing = RIBBON_SPACING_DENSE;
      else if (dist < 300) spacing = RIBBON_SPACING_MID;
      else spacing = RIBBON_SPACING_SUBURBAN;

      // Compute average slope direction for orientation
      let gradX = 0, gradZ = 0;
      let avgSlope = 0;
      if (map.slope && map.elevation) {
        for (const c of zone.cells) {
          const { gx, gz } = c;
          if (gx < 1 || gx >= map.width - 1 || gz < 1 || gz >= map.height - 1) continue;
          const dex = map.elevation.get(gx + 1, gz) - map.elevation.get(gx - 1, gz);
          const dez = map.elevation.get(gx, gz + 1) - map.elevation.get(gx, gz - 1);
          gradX += dex;
          gradZ += dez;
          avgSlope += map.slope.get(gx, gz);
        }
        avgSlope /= zone.cells.length;
      }

      // Choose orientation
      let dirX, dirZ;
      if (avgSlope > SLOPE_CONTOUR_THRESHOLD && (gradX !== 0 || gradZ !== 0)) {
        // Contour-following: perpendicular to gradient
        const glen = Math.sqrt(gradX * gradX + gradZ * gradZ) || 1;
        dirX = -gradZ / glen;
        dirZ = gradX / glen;
      } else {
        // Radial: bearing from zone centroid toward nucleus
        const dx = n.gx - zone.centroidGx;
        const dz = n.gz - zone.centroidGz;
        const len = Math.sqrt(dx * dx + dz * dz) || 1;
        dirX = dx / len;
        dirZ = dz / len;
      }

      // Store orientation on zone for debug
      zone.dirX = dirX;
      zone.dirZ = dirZ;
      zone.spacing = spacing;

      // Build zone boundary cell set for fast lookup
      const cellSet = new Set();
      for (const c of zone.cells) cellSet.add(c.gz * map.width + c.gx);

      // Place spine street through centroid
      const centroidWx = map.originX + zone.centroidGx * cs;
      const centroidWz = map.originZ + zone.centroidGz * cs;

      const spineStreet = this._clipStreetToZone(
        centroidWx, centroidWz, dirX, dirZ, cellSet, cs
      );

      if (spineStreet && spineStreet.length >= 2) {
        this._addRoad(spineStreet, 'spine', 8);
        zone.spineStreet = spineStreet;
      }

      // Place parallel streets on both sides
      const perpX = -dirZ, perpZ = dirX;
      const maxOffsets = 20;
      const streets = [];
      if (zone.spineStreet) streets.push(zone.spineStreet);

      for (let side = -1; side <= 1; side += 2) {
        for (let i = 1; i <= maxOffsets; i++) {
          const offsetDist = i * spacing;
          const ox = centroidWx + perpX * offsetDist * side;
          const oz = centroidWz + perpZ * offsetDist * side;

          const street = this._clipStreetToZone(ox, oz, dirX, dirZ, cellSet, cs);
          if (!street || street.length < 2) break;

          // Check the street is long enough to be useful
          const sLen = this._polylineLength(street);
          if (sLen < spacing * 0.5) break;

          this._addRoad(street, 'local', 6);
          streets.push(street);
        }
      }

      // Place cross streets connecting adjacent parallels
      this._placeCrossStreets(streets, perpX, perpZ, spacing, cellSet, cs);

      zone.streets = streets;
    }

    // Build parcels from pairs of adjacent streets
    this._buildParcels();
  }

  /**
   * Clip a street line through (ox, oz) in direction (dx, dz) to zone boundary.
   */
  _clipStreetToZone(ox, oz, dx, dz, cellSet, cs) {
    const map = this.map;
    const stepSize = cs;
    const maxSteps = 200;

    // Walk forward and backward from origin
    const forward = [];
    const backward = [];

    for (let dir = -1; dir <= 1; dir += 2) {
      const pts = dir === 1 ? forward : backward;
      for (let i = 0; i <= maxSteps; i++) {
        const wx = ox + dx * stepSize * i * dir;
        const wz = oz + dz * stepSize * i * dir;
        const gx = Math.round((wx - map.originX) / cs);
        const gz = Math.round((wz - map.originZ) / cs);
        if (gx < 0 || gx >= map.width || gz < 0 || gz >= map.height) break;
        if (!cellSet.has(gz * map.width + gx)) break;
        pts.push({ x: wx, z: wz });
      }
    }

    // Combine: backward reversed + forward (skip duplicate origin)
    backward.reverse();
    if (backward.length > 0 && forward.length > 0) {
      return [...backward, ...forward.slice(1)];
    }
    if (backward.length > 0) return backward;
    if (forward.length > 0) return forward;
    return null;
  }

  /**
   * Place cross streets perpendicular to the main direction.
   */
  _placeCrossStreets(streets, perpX, perpZ, spacing, cellSet, cs) {
    if (streets.length < 2) return;
    const map = this.map;

    // For each street, place cross streets at regular intervals
    for (const street of streets) {
      const sLen = this._polylineLength(street);
      let cumDist = 0;

      for (let i = 1; i < street.length; i++) {
        const dx = street[i].x - street[i - 1].x;
        const dz = street[i].z - street[i - 1].z;
        const segLen = Math.sqrt(dx * dx + dz * dz);
        cumDist += segLen;

        if (cumDist < CROSS_STREET_INTERVAL) continue;
        cumDist -= CROSS_STREET_INTERVAL;

        const mx = street[i].x;
        const mz = street[i].z;

        // Try cross street in both perpendicular directions
        for (const side of [1, -1]) {
          const endX = mx + perpX * spacing * side;
          const endZ = mz + perpZ * spacing * side;

          // Check both endpoints are in zone
          const egx = Math.round((endX - map.originX) / cs);
          const egz = Math.round((endZ - map.originZ) / cs);
          if (egx < 0 || egx >= map.width || egz < 0 || egz >= map.height) continue;
          if (!cellSet.has(egz * map.width + egx)) continue;

          const crossLen = Math.sqrt((endX - mx) ** 2 + (endZ - mz) ** 2);
          if (crossLen < CROSS_STREET_MIN_LENGTH) continue;

          this._addRoad(
            [{ x: mx, z: mz }, { x: endX, z: endZ }],
            'cross-street', 6
          );
        }
      }
    }
  }

  /**
   * Build parcels from zone streets for plot placement.
   */
  _buildParcels() {
    const map = this.map;
    if (!map.devLand) {
      map.devLand = new Grid2D(map.width, map.height, { type: 'uint16' });
    }

    for (const zone of this._zones) {
      if (!zone.streets || zone.streets.length < 2) continue;

      const sorted = [...zone.streets];
      // Sort streets by perpendicular offset to find adjacent pairs
      const perpX = -zone.dirZ, perpZ = zone.dirX;
      sorted.sort((a, b) => {
        const aMid = a[Math.floor(a.length / 2)];
        const bMid = b[Math.floor(b.length / 2)];
        return (aMid.x * perpX + aMid.z * perpZ) - (bMid.x * perpX + bMid.z * perpZ);
      });

      for (let i = 0; i < sorted.length - 1; i++) {
        const streetA = sorted[i];
        const streetB = sorted[i + 1];

        // Create parcel between these two streets
        const polygon = [...streetA, ...streetB.slice().reverse()];
        const parcel = {
          id: this._nextParcelId++,
          roadEdge: streetA,
          offsetEdge: streetB,
          side: 1,
          roadWidth: 6,
          polygon,
          cells: [],
          nucleusIdx: zone.nucleusIdx,
          distToNucleus: zone.distToNucleus,
        };

        this._fillPolygon(parcel);
        if (parcel.cells.length > 0) {
          this._parcels.push(parcel);
        }
      }
    }

    map.parcels = this._parcels;
  }

  // ── Tick 4: Connect zones to skeleton network ──────────────

  _connectToNetwork() {
    const map = this.map;
    const graph = map.graph;
    const costFn = map.createPathCost('growth');
    const cs = map.cellSize;

    for (const zone of this._zones) {
      if (!zone.spineStreet || zone.spineStreet.length < 2) continue;

      // Try connecting both ends of the spine
      for (const endpoint of [zone.spineStreet[0], zone.spineStreet[zone.spineStreet.length - 1]]) {
        // Check if already on or near a skeleton road
        const egx = Math.round((endpoint.x - map.originX) / cs);
        const egz = Math.round((endpoint.z - map.originZ) / cs);
        if (map.roadGrid.get(egx, egz) > 0) continue;

        // Find nearest skeleton road node
        const nearest = graph.nearestNode(endpoint.x, endpoint.z);
        if (!nearest) continue;

        const distToSkeleton = nearest.dist;
        if (distToSkeleton < cs * 3) continue; // already close enough
        if (distToSkeleton > MAX_CONNECTION_PATH) continue; // too far

        // A* from endpoint to nearest skeleton node
        const fromGx = egx;
        const fromGz = egz;
        const toNode = graph.nodes.get(nearest.id);
        if (!toNode) continue;
        const toGx = Math.round((toNode.x - map.originX) / cs);
        const toGz = Math.round((toNode.z - map.originZ) / cs);

        const result = findPath(fromGx, fromGz, toGx, toGz, map.width, map.height, costFn);
        if (!result || result.path.length < 2) continue;

        const simplified = simplifyPath(result.path, 1.0);
        const worldPoly = gridPathToWorldPolyline(simplified, cs, map.originX, map.originZ);
        if (worldPoly.length < 2) continue;

        // Check path length doesn't exceed budget
        const pathLen = this._polylineLength(worldPoly);
        if (pathLen > MAX_CONNECTION_PATH) continue;

        this._addRoad(worldPoly, 'collector', 8);
      }
    }
  }

  // ── Tick 5: Plot subdivision ───────────────────────────────

  _subdividePlots() {
    const map = this.map;
    const cs = map.cellSize;

    for (const parcel of this._parcels) {
      const re = parcel.roadEdge;
      if (!re || re.length < 2) continue;

      // Determine plot width from distance to nucleus
      let plotWidth;
      if (parcel.distToNucleus < 100) plotWidth = PLOT_WIDTH_TERRACED;
      else if (parcel.distToNucleus < 300) plotWidth = PLOT_WIDTH_SEMI;
      else plotWidth = PLOT_WIDTH_DETACHED;

      let edgeLen = 0;
      for (let i = 1; i < re.length; i++) {
        const dx = re[i].x - re[i - 1].x;
        const dz = re[i].z - re[i - 1].z;
        edgeLen += Math.sqrt(dx * dx + dz * dz);
      }
      if (edgeLen < plotWidth * 2) continue;

      const plotCount = Math.floor(edgeLen / plotWidth);
      let segIdx = 0, segStart = 0;

      for (let h = 0; h < plotCount; h++) {
        const targetDist = (h + 0.5) * plotWidth;

        while (segIdx < re.length - 2) {
          const dx = re[segIdx + 1].x - re[segIdx].x;
          const dz = re[segIdx + 1].z - re[segIdx].z;
          const sLen = Math.sqrt(dx * dx + dz * dz);
          if (segStart + sLen >= targetDist) break;
          segStart += sLen;
          segIdx++;
        }
        if (segIdx >= re.length - 1) break;

        const ax = re[segIdx].x, az = re[segIdx].z;
        const bx = re[segIdx + 1].x, bz = re[segIdx + 1].z;
        const sdx = bx - ax, sdz = bz - az;
        const segLen = Math.sqrt(sdx * sdx + sdz * sdz);
        if (segLen < 0.01) continue;

        const t = (targetDist - segStart) / segLen;
        const px = ax + sdx * t;
        const pz = az + sdz * t;
        const perpX = -sdz / segLen * parcel.side;
        const perpZ = sdx / segLen * parcel.side;

        // Check buildability at plot center
        const gx = Math.round((px - map.originX) / cs);
        const gz = Math.round((pz - map.originZ) / cs);
        if (gx < 1 || gx >= map.width - 1 || gz < 1 || gz >= map.height - 1) continue;
        if (map.buildability.get(gx, gz) < 0.1) continue;
        if (map.waterMask.get(gx, gz) > 0) continue;

        // Store plot data for building placement
        map.addFeature('plot', {
          polygon: [
            { x: px, z: pz },
            { x: px + sdx / segLen * plotWidth, z: pz + sdz / segLen * plotWidth },
            { x: px + sdx / segLen * plotWidth + perpX * PLOT_DEPTH, z: pz + sdz / segLen * plotWidth + perpZ * PLOT_DEPTH },
            { x: px + perpX * PLOT_DEPTH, z: pz + perpZ * PLOT_DEPTH },
          ],
          center: { x: px + perpX * PLOT_DEPTH / 2, z: pz + perpZ * PLOT_DEPTH / 2 },
          width: plotWidth,
          depth: PLOT_DEPTH,
          roadEdgePoint: { x: px, z: pz },
          perpX, perpZ,
          tangentX: sdx / segLen,
          tangentZ: sdz / segLen,
        });
      }
    }
  }

  // ── Geometry helpers ───────────────────────────────────────

  /**
   * Rasterize a parcel polygon onto the devLand grid using scanline fill.
   */
  _fillPolygon(parcel) {
    const map = this.map;
    const polygon = parcel.polygon;
    if (polygon.length < 3) return;

    const gridPoly = polygon.map(p => ({
      gx: (p.x - map.originX) / map.cellSize,
      gz: (p.z - map.originZ) / map.cellSize,
    }));

    let minGx = Infinity, maxGx = -Infinity, minGz = Infinity, maxGz = -Infinity;
    for (const p of gridPoly) {
      if (p.gx < minGx) minGx = p.gx;
      if (p.gx > maxGx) maxGx = p.gx;
      if (p.gz < minGz) minGz = p.gz;
      if (p.gz > maxGz) maxGz = p.gz;
    }

    const startGz = Math.max(1, Math.floor(minGz));
    const endGz = Math.min(map.height - 2, Math.ceil(maxGz));
    const startGx = Math.max(1, Math.floor(minGx));
    const endGx = Math.min(map.width - 2, Math.ceil(maxGx));

    for (let gz = startGz; gz <= endGz; gz++) {
      const intersections = [];
      const n = gridPoly.length;
      for (let i = 0; i < n; i++) {
        const a = gridPoly[i];
        const b = gridPoly[(i + 1) % n];
        if ((a.gz <= gz && b.gz > gz) || (b.gz <= gz && a.gz > gz)) {
          const t = (gz - a.gz) / (b.gz - a.gz);
          intersections.push(a.gx + t * (b.gx - a.gx));
        }
      }
      intersections.sort((a, b) => a - b);

      for (let k = 0; k < intersections.length - 1; k += 2) {
        const x0 = Math.max(startGx, Math.ceil(intersections[k]));
        const x1 = Math.min(endGx, Math.floor(intersections[k + 1]));
        for (let gx = x0; gx <= x1; gx++) {
          if (map.waterMask.get(gx, gz) > 0) continue;
          if (map.buildability.get(gx, gz) < 0.1) continue;
          map.devLand.set(gx, gz, parcel.id + 1);
          parcel.cells.push({ gx, gz });
        }
      }
    }
  }

  _polylineLength(polyline) {
    let len = 0;
    for (let i = 1; i < polyline.length; i++) {
      const dx = polyline[i].x - polyline[i - 1].x;
      const dz = polyline[i].z - polyline[i - 1].z;
      len += Math.sqrt(dx * dx + dz * dz);
    }
    return len;
  }

  _addRoad(polyline, source, width = 6) {
    const map = this.map;
    const hierarchy = source === 'collector' ? 'collector' : 'local';
    map.addFeature('road', {
      polyline,
      width,
      hierarchy,
      importance: hierarchy === 'collector' ? 0.5 : 0.2,
      source,
    });

    if (polyline.length >= 2) {
      const graph = map.graph;
      const snapDist = map.cellSize * 3;
      const startPt = polyline[0];
      const endPt = polyline[polyline.length - 1];
      const startNodeId = this._findOrCreateNode(graph, startPt.x, startPt.z, snapDist);
      const endNodeId = this._findOrCreateNode(graph, endPt.x, endPt.z, snapDist);

      if (startNodeId !== endNodeId) {
        const points = polyline.slice(1, -1).map(p => ({ x: p.x, z: p.z }));
        graph.addEdge(startNodeId, endNodeId, { points, width, hierarchy });
      }
    }
  }

  _findOrCreateNode(graph, x, z, snapDist) {
    const nearest = graph.nearestNode(x, z);
    if (nearest && nearest.dist < snapDist) return nearest.id;
    return graph.addNode(x, z);
  }
}

// ── Morphological operations ────────────────────────────────

function _morphDilate(mask, w, h, radius) {
  const out = new Uint8Array(w * h);
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (mask[gz * w + gx]) { out[gz * w + gx] = 1; continue; }
      let found = false;
      for (let dz = -radius; dz <= radius && !found; dz++) {
        for (let dx = -radius; dx <= radius && !found; dx++) {
          const nx = gx + dx, nz = gz + dz;
          if (nx >= 0 && nx < w && nz >= 0 && nz < h && mask[nz * w + nx]) {
            found = true;
          }
        }
      }
      if (found) out[gz * w + gx] = 1;
    }
  }
  return out;
}

function _morphErode(mask, w, h, radius) {
  const out = new Uint8Array(w * h);
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (!mask[gz * w + gx]) continue;
      let allSet = true;
      for (let dz = -radius; dz <= radius && allSet; dz++) {
        for (let dx = -radius; dx <= radius && allSet; dx++) {
          const nx = gx + dx, nz = gz + dz;
          if (nx < 0 || nx >= w || nz < 0 || nz >= h || !mask[nz * w + nx]) {
            allSet = false;
          }
        }
      }
      if (allSet) out[gz * w + gx] = 1;
    }
  }
  return out;
}
