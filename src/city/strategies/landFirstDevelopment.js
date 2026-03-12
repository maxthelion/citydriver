import { buildSkeletonRoads } from '../skeleton.js';
import { extractDevelopmentZones } from '../zoneExtraction.js';
import {
  computeRibbonOrientation, layoutRibbonStreets, adjustStreetToContour,
  CONTOUR_SLOPE_THRESHOLD,
} from '../ribbonLayout.js';
import { findPath, simplifyPath, gridPathToWorldPolyline } from '../../core/pathfinding.js';

const CONNECTION_MAX_PATH_M = 500;

/**
 * Land-First Development strategy.
 *
 * Tick 1: Skeleton roads (unchanged)
 * Tick 2: Recompute land value with nucleus-aware formula
 * Tick 3: Extract development zones
 * Tick 4: Ribbon layout — place parallel streets within zones
 * Tick 5: Connect zone spines to skeleton network
 */
export class LandFirstDevelopment {
  constructor(map) {
    this.map = map;
    this._tick = 0;
    this._zones = [];
  }

  tick() {
    this._tick++;

    if (this._tick === 1) {
      buildSkeletonRoads(this.map);
      return true;
    }

    if (this._tick === 2) {
      this.map.computeLandValue();
      return true;
    }

    if (this._tick === 3) {
      this._zones = extractDevelopmentZones(this.map);
      this.map.developmentZones = this._zones;
      return true;
    }

    if (this._tick === 4) {
      this._layoutRibbons();
      return true;
    }

    if (this._tick === 5) {
      this._connectToNetwork();
      return true;
    }

    return false;
  }

  _layoutRibbons() {
    const map = this.map;

    for (const zone of this._zones) {
      const nucleus = map.nuclei[zone.nucleusIdx];
      const direction = computeRibbonOrientation(zone, nucleus, map.cellSize);

      const streets = layoutRibbonStreets(
        zone, direction, map.cellSize, map.originX, map.originZ
      );

      // Contour adjustment for sloped zones
      if (zone.avgSlope > CONTOUR_SLOPE_THRESHOLD) {
        for (let i = 0; i < streets.parallel.length; i++) {
          streets.parallel[i] = adjustStreetToContour(
            streets.parallel[i], map.elevation, zone.slopeDir,
            map.cellSize, map.originX, map.originZ
          );
        }
      }

      // Clip ribbon streets against existing roads (skeleton) and water.
      // Split each street where it crosses a blocked cell.
      const clippedParallel = [];
      for (const st of streets.parallel) {
        const segments = _clipStreetToGrid(st, map);
        clippedParallel.push(...segments);
      }
      const clippedCross = [];
      for (const st of streets.cross) {
        const segments = _clipStreetToGrid(st, map);
        clippedCross.push(...segments);
      }

      // Add all streets as roads
      for (const st of clippedParallel) {
        if (st.length < 2) continue;
        this._addRoad(st, 'local', 6);
      }
      for (const st of clippedCross) {
        if (st.length < 2) continue;
        this._addRoad(st, 'local', 6);
      }

      // Store on zone for building placement and connection phase
      zone._spine = streets.spine;
      zone._streets = clippedParallel;
      zone._crossStreets = clippedCross;
      zone._spacing = streets.spacing;
    }
  }

  _connectToNetwork() {
    const map = this.map;
    const graph = map.graph;
    if (!graph) return;

    const costFn = map.createPathCost('growth');

    for (const zone of this._zones) {
      const spine = zone._spine;
      if (!spine || spine.length < 2) continue;

      // Try connecting both ends of the spine
      for (const endpoint of [spine[0], spine[spine.length - 1]]) {
        const egx = Math.round((endpoint.x - map.originX) / map.cellSize);
        const egz = Math.round((endpoint.z - map.originZ) / map.cellSize);
        if (map.roadGrid.get(egx, egz) > 0) continue; // already on road

        const nearest = graph.nearestNode(endpoint.x, endpoint.z);
        if (!nearest) continue;
        if (nearest.dist < map.cellSize * 3) continue; // close enough
        if (nearest.dist > CONNECTION_MAX_PATH_M) continue; // too far

        const nearestNode = graph.getNode(nearest.id);
        if (!nearestNode) continue;
        const toGx = Math.round((nearestNode.x - map.originX) / map.cellSize);
        const toGz = Math.round((nearestNode.z - map.originZ) / map.cellSize);

        if (egx < 1 || egx >= map.width - 1 || egz < 1 || egz >= map.height - 1) continue;
        if (toGx < 1 || toGx >= map.width - 1 || toGz < 1 || toGz >= map.height - 1) continue;

        const result = findPath(egx, egz, toGx, toGz, map.width, map.height, costFn);
        if (!result || result.path.length < 2) continue;

        const simplified = simplifyPath(result.path, 1.0);
        const worldPoly = gridPathToWorldPolyline(simplified, map.cellSize, map.originX, map.originZ);
        if (worldPoly.length < 2) continue;

        // Check path length
        let pathLen = 0;
        for (let i = 1; i < worldPoly.length; i++) {
          const dx = worldPoly[i].x - worldPoly[i - 1].x;
          const dz = worldPoly[i].z - worldPoly[i - 1].z;
          pathLen += Math.sqrt(dx * dx + dz * dz);
        }
        if (pathLen > CONNECTION_MAX_PATH_M) continue;

        this._addRoad(worldPoly, 'collector', 8);
      }
    }
  }

  _addRoad(polyline, hierarchy, width) {
    const map = this.map;
    map.addFeature('road', {
      polyline,
      width,
      hierarchy,
      importance: hierarchy === 'collector' ? 0.5 : 0.2,
      source: 'land-first',
    });

    if (polyline.length >= 2 && map.graph) {
      const snapDist = map.cellSize * 3;
      const startPt = polyline[0];
      const endPt = polyline[polyline.length - 1];
      const startNode = this._findOrCreateNode(startPt.x, startPt.z, snapDist);
      const endNode = this._findOrCreateNode(endPt.x, endPt.z, snapDist);

      if (startNode !== endNode) {
        const points = polyline.slice(1, -1).map(p => ({ x: p.x, z: p.z }));
        map.graph.addEdge(startNode, endNode, { points, width, hierarchy });
      }
    }
  }

  _findOrCreateNode(x, z, snapDist) {
    const graph = this.map.graph;
    const nearest = graph.nearestNode(x, z);
    if (nearest && nearest.dist < snapDist) return nearest.id;
    return graph.addNode(x, z);
  }
}

const MIN_CLIP_SEGMENT = 20; // meters — discard clipped fragments shorter than this
const CLIP_SAMPLE_STEP = 2;  // meters — sampling interval along polyline

/**
 * Clip a street polyline against the map's roadGrid and waterMask.
 * Densifies the line, marks each sample as clear/blocked, and splits
 * into contiguous clear segments. Discards short fragments.
 *
 * @param {Array<{x,z}>} street - Polyline (2+ points)
 * @param {Object} map - FeatureMap with roadGrid, waterMask, cellSize, originX, originZ
 * @returns {Array<Array<{x,z}>>} Array of clipped sub-polylines
 */
function _clipStreetToGrid(street, map) {
  if (street.length < 2) return [];

  const cs = map.cellSize;
  const ox = map.originX, oz = map.originZ;
  const roadHalf = 3; // half-width of a ribbon road in meters — buffer around blocked cells

  // Densify into evenly spaced samples
  const samples = [];
  for (let i = 0; i < street.length - 1; i++) {
    const ax = street[i].x, az = street[i].z;
    const bx = street[i + 1].x, bz = street[i + 1].z;
    const dx = bx - ax, dz = bz - az;
    const segLen = Math.sqrt(dx * dx + dz * dz);
    const steps = Math.max(1, Math.ceil(segLen / CLIP_SAMPLE_STEP));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      samples.push({ x: ax + dx * t, z: az + dz * t });
    }
  }
  samples.push(street[street.length - 1]);

  // Classify each sample as clear or blocked
  const clear = samples.map(p => {
    const gx = Math.round((p.x - ox) / cs);
    const gz = Math.round((p.z - oz) / cs);
    if (gx < 0 || gz < 0 || gx >= map.width || gz >= map.height) return false;
    if (map.waterMask.get(gx, gz) > 0) return false;
    // Check roadGrid in a small radius to account for road width
    const r = Math.ceil(roadHalf / cs);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const nx = gx + dx, nz = gz + dz;
        if (nx < 0 || nz < 0 || nx >= map.width || nz >= map.height) continue;
        if (map.roadGrid.get(nx, nz) > 0) return false;
      }
    }
    return true;
  });

  // Split into contiguous clear segments
  const segments = [];
  let current = null;
  for (let i = 0; i < samples.length; i++) {
    if (clear[i]) {
      if (!current) current = [];
      current.push(samples[i]);
    } else {
      if (current && current.length >= 2) segments.push(current);
      current = null;
    }
  }
  if (current && current.length >= 2) segments.push(current);

  // Discard short fragments
  return segments.filter(seg => {
    let len = 0;
    for (let i = 1; i < seg.length; i++) {
      const dx = seg[i].x - seg[i - 1].x;
      const dz = seg[i].z - seg[i - 1].z;
      len += Math.sqrt(dx * dx + dz * dz);
    }
    return len >= MIN_CLIP_SEGMENT;
  });
}
