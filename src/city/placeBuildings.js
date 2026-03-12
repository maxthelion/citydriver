/**
 * Place buildings along roads in the city.
 *
 * Walks each road polyline, placing plots at regular intervals on both sides
 * with a setback from the road edge. Generates houses using the archetype system.
 *
 * Returns a THREE.Group containing all building meshes in local scene coordinates.
 */

import * as THREE from 'three';
import { SeededRandom } from '../core/rng.js';
import {
  suburbanDetached, victorianTerrace, generateRow, hashPosition,
  sample, ROAD_HALF_WIDTH, SIDEWALK_WIDTH, SETBACK, HOUSE_Z,
} from '../buildings/archetypes.js';
import {
  createHouse, setPartyWalls, addFloor, addPitchedRoof,
  addFrontDoor, addPorch, addWindows, addWindowSills,
  addExtension, addGroundLevel,
} from '../buildings/generate.js';

const PLOT_INTERVAL = 20;   // meters between plot centers along road
const ROAD_SETBACK = 14;    // meters from road centerline to house front
const MIN_ROAD_LENGTH = 40; // skip very short road stubs
const MAX_HOUSES = 100;     // cap total houses to avoid performance issues

/**
 * @param {import('../core/FeatureMap.js').FeatureMap} map
 * @param {number} seed
 * @returns {THREE.Group}
 */
export function placeBuildings(map, seed) {
  const group = new THREE.Group();
  const ox = map.originX, oz = map.originZ;
  const cs = map.cellSize;
  const rng = new SeededRandom(seed);

  const archetype = suburbanDetached;
  const s = archetype.shared;
  const p = archetype.perHouse;

  // Sample shared values once
  const rowRng = new SeededRandom(seed);
  const floors = Math.round(sample(rowRng, s.floors));
  const floorHeight = sample(rowRng, s.floorHeight);
  const roofPitch = sample(rowRng, s.roofPitch);
  const depth = sample(rowRng, s.depth);
  const winSpacing = sample(rowRng, s.windowSpacing);
  const winHeight = sample(rowRng, s.windowHeight);
  const baseGroundHeight = sample(rowRng, s.groundHeight);

  let houseCount = 0;

  for (const road of map.roads) {
    if (houseCount >= MAX_HOUSES) break;
    const pts = road.polyline;
    if (!pts || pts.length < 2) continue;

    // Compute total road length
    let totalLen = 0;
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i].x - pts[i - 1].x;
      const dz = pts[i].z - pts[i - 1].z;
      totalLen += Math.sqrt(dx * dx + dz * dz);
    }
    if (totalLen < MIN_ROAD_LENGTH) continue;

    // Walk the polyline at PLOT_INTERVAL steps
    let segIdx = 0;
    let segStart = 0; // distance along polyline where current segment starts
    let segLen = _segLen(pts, 0);

    for (let dist = PLOT_INTERVAL / 2; dist < totalLen - PLOT_INTERVAL / 2; dist += PLOT_INTERVAL) {
      // Advance to the correct segment
      while (segIdx < pts.length - 2 && dist > segStart + segLen) {
        segStart += segLen;
        segIdx++;
        segLen = _segLen(pts, segIdx);
      }

      const t = (dist - segStart) / segLen;
      const a = pts[segIdx];
      const b = pts[segIdx + 1];

      // Interpolated point on road centerline
      const cx = a.x + t * (b.x - a.x);
      const cz = a.z + t * (b.z - a.z);

      // Road direction and perpendicular
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len < 0.01) continue;
      const nx = -dz / len; // perpendicular (left)
      const nz = dx / len;

      // Angle of the road (for house rotation)
      const roadAngle = Math.atan2(dx, dz);

      // Place on both sides
      for (const side of [-1, 1]) {
        const hx = cx + nx * ROAD_SETBACK * side;
        const hz = cz + nz * ROAD_SETBACK * side;

        // Convert to local scene coords
        const lx = hx - ox;
        const lz = hz - oz;

        // Check buildability
        const gx = lx / cs;
        const gz = lz / cs;
        if (gx < 1 || gz < 1 || gx >= map.width - 1 || gz >= map.height - 1) continue;
        if (map.buildability.sample(gx, gz) < 0.3) continue;
        if (map.waterMask.get(Math.floor(gx), Math.floor(gz))) continue;

        // Terrain height
        const terrainY = map.elevation.sample(gx, gz);

        // Per-house randomisation from position
        const houseSeed = hashPosition(seed, Math.round(hx), Math.round(hz));
        const hRng = new SeededRandom(houseSeed);

        const plotWidth = sample(hRng, p.plotWidth);
        const sideGap = p.sideGap ? sample(hRng, p.sideGap) : 0;
        const houseWidth = plotWidth - sideGap * 2;
        const wallColor = _nudgeColor(p.wallColor, p.colorVariation, hRng);

        // Build house
        const house = createHouse(houseWidth, depth, floorHeight, wallColor);
        house.roofColor = s.roofColor;
        house._winSpacing = winSpacing;
        house._groundHeight = baseGroundHeight;
        house._roofTileStyle = s.roofTileStyle || 'shingle';
        house._windowStyle = s.windowStyle || 'single';

        for (let f = 1; f < floors; f++) addFloor(house);
        addPitchedRoof(house, roofPitch, s.roofDirection, s.roofOverhang);
        addFrontDoor(house, s.door);

        if (s.porch) {
          addPorch(house, {
            face: s.porch.face || 'front',
            porchDepth: s.porch.porchDepth || 1.8,
            roofStyle: s.porch.roofStyle || 'slope',
          });
        }

        if (s.extension) {
          addExtension(house, {
            widthFrac: s.extension.widthFrac || 0.5,
            extDepth: s.extension.extDepth || s.extension.depth || 3,
            floors: s.extension.floors || 1,
            side: s.extension.side || 'left',
          });
        }

        addWindows(house, { spacing: winSpacing, height: winHeight });

        if (baseGroundHeight > 0.05) {
          addGroundLevel(house, baseGroundHeight);
        }

        // Position: center the house on the plot, face toward road
        const houseGroup = house.group;
        // House front is at z=0 facing local -Z.
        // Direction from house toward road is (-nx*side, -nz*side).
        // To align local -Z with that direction: rotation.y = atan2(dirX, dirZ)
        // where dir is the facing direction (toward road).
        const faceDirX = nx * side;
        const faceDirZ = nz * side;
        const wrapper = new THREE.Group();
        wrapper.rotation.y = Math.atan2(faceDirX, faceDirZ);
        // Offset the house so front-center is at origin of wrapper
        houseGroup.position.set(-houseWidth / 2, 0, 0);
        wrapper.add(houseGroup);
        wrapper.position.set(lx, terrainY, lz);
        group.add(wrapper);
        houseCount++;
        if (houseCount >= MAX_HOUSES) break;
      }
      if (houseCount >= MAX_HOUSES) break;
    }
  }

  return group;
}

function _segLen(pts, i) {
  const dx = pts[i + 1].x - pts[i].x;
  const dz = pts[i + 1].z - pts[i].z;
  return Math.sqrt(dx * dx + dz * dz);
}

function _nudgeColor(hex, amount, rng) {
  const shift = Math.round(amount * 255);
  const r = Math.min(255, Math.max(0, ((hex >> 16) & 0xff) + rng.int(-shift, shift)));
  const g = Math.min(255, Math.max(0, ((hex >> 8) & 0xff) + rng.int(-shift, shift)));
  const b = Math.min(255, Math.max(0, (hex & 0xff) + rng.int(-shift, shift)));
  return (r << 16) | (g << 8) | b;
}

/**
 * Place simple boxes along development parcels for debugging.
 *
 * Each parcel has a roadEdge (polyline along the road) and an offsetEdge.
 * Places one box per parcel showing its extent.
 *
 * @param {import('../core/FeatureMap.js').FeatureMap} map
 * @param {number} seed
 * @returns {THREE.Group}
 */
const PLOT_WIDTH = 5;      // meters — width of each terraced house plot along road
const HOUSE_DEPTH = 9;     // meters — depth of house (front to back)
const HOUSE_HEIGHT = 8;    // meters — height of box placeholder
const FRONT_GARDEN = 3;    // meters — front garden depth (between fence and house)
const PLOT_TOTAL_DEPTH = 20; // meters — total plot depth (front fence to back fence)
const FENCE_HEIGHT = 1.2;  // meters
const FENCE_THICKNESS = 0.1;

/**
 * Build a single plot template (house + fence) as a merged BufferGeometry.
 * This gets instanced for every plot.
 */
function _buildPlotTemplate() {
  const geos = [];

  // House box (centered at origin, bottom at y=0)
  const houseGeo = new THREE.BoxGeometry(PLOT_WIDTH * 0.9, HOUSE_HEIGHT, HOUSE_DEPTH);
  houseGeo.translate(0, HOUSE_HEIGHT / 2, FRONT_GARDEN + HOUSE_DEPTH / 2);
  geos.push(houseGeo);

  // Front fence
  const frontFence = new THREE.BoxGeometry(PLOT_WIDTH, FENCE_HEIGHT, FENCE_THICKNESS);
  frontFence.translate(0, FENCE_HEIGHT / 2, 0);
  geos.push(frontFence);

  // Back fence
  const backFence = new THREE.BoxGeometry(PLOT_WIDTH, FENCE_HEIGHT, FENCE_THICKNESS);
  backFence.translate(0, FENCE_HEIGHT / 2, PLOT_TOTAL_DEPTH);
  geos.push(backFence);

  // Left side fence
  const leftFence = new THREE.BoxGeometry(FENCE_THICKNESS, FENCE_HEIGHT, PLOT_TOTAL_DEPTH);
  leftFence.translate(-PLOT_WIDTH / 2, FENCE_HEIGHT / 2, PLOT_TOTAL_DEPTH / 2);
  geos.push(leftFence);

  // Right side fence
  const rightFence = new THREE.BoxGeometry(FENCE_THICKNESS, FENCE_HEIGHT, PLOT_TOTAL_DEPTH);
  rightFence.translate(PLOT_WIDTH / 2, FENCE_HEIGHT / 2, PLOT_TOTAL_DEPTH / 2);
  geos.push(rightFence);

  return mergeBufferGeometries(geos);
}

/**
 * Merge an array of BufferGeometries into one.
 */
function mergeBufferGeometries(geometries) {
  let totalVerts = 0;
  let totalIdx = 0;
  for (const g of geometries) {
    totalVerts += g.attributes.position.count;
    totalIdx += g.index ? g.index.count : 0;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const indices = new Uint32Array(totalIdx);

  let vertOffset = 0;
  let idxOffset = 0;

  for (const g of geometries) {
    const pos = g.attributes.position.array;
    const norm = g.attributes.normal.array;
    positions.set(pos, vertOffset * 3);
    normals.set(norm, vertOffset * 3);

    if (g.index) {
      for (let i = 0; i < g.index.count; i++) {
        indices[idxOffset + i] = g.index.array[i] + vertOffset;
      }
      idxOffset += g.index.count;
    }
    vertOffset += g.attributes.position.count;
    g.dispose();
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  return merged;
}

/**
 * Determine plot width based on distance from nucleus.
 */
function plotWidthForDensity(distFromNucleus) {
  if (distFromNucleus < 100) return 5;   // terraced
  if (distFromNucleus < 300) return 8;   // semi-detached
  return 12;                              // detached
}

/**
 * Place instanced house+fence boxes along ribbon streets from development zones.
 *
 * Reads zone._streets (parallel street polylines) from map.developmentZones.
 * Places houses on both sides of each street.
 *
 * @param {import('../core/FeatureMap.js').FeatureMap} map
 * @param {number} _seed
 * @returns {THREE.Group}
 */
/**
 * Get the 4 world-space corners of a plot rectangle.
 * The plot's local frame: front edge at origin, extends plotDepth in the perp direction.
 * Along-road axis = (adx, adz), perp axis = (perpX, perpZ).
 */
function _plotCorners(frontX, frontZ, adx, adz, perpX, perpZ, plotWidth, plotDepth) {
  const hw = plotWidth / 2;
  return [
    { x: frontX - adx * hw,               z: frontZ - adz * hw },
    { x: frontX + adx * hw,               z: frontZ + adz * hw },
    { x: frontX + adx * hw + perpX * plotDepth, z: frontZ + adz * hw + perpZ * plotDepth },
    { x: frontX - adx * hw + perpX * plotDepth, z: frontZ - adz * hw + perpZ * plotDepth },
  ];
}

/**
 * Check whether a rotated rectangle collides with an occupancy grid.
 * Rasterises the rectangle's axis-aligned bounding box and tests each cell
 * inside the rotated rect against the grid.
 * Returns true if ANY cell is occupied.
 */
function _rectCollides(corners, occupancy, cs, ox, oz) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const c of corners) {
    if (c.x < minX) minX = c.x;
    if (c.x > maxX) maxX = c.x;
    if (c.z < minZ) minZ = c.z;
    if (c.z > maxZ) maxZ = c.z;
  }
  const gx0 = Math.max(0, Math.floor((minX - ox) / cs));
  const gx1 = Math.min(occupancy.width - 1, Math.ceil((maxX - ox) / cs));
  const gz0 = Math.max(0, Math.floor((minZ - oz) / cs));
  const gz1 = Math.min(occupancy.height - 1, Math.ceil((maxZ - oz) / cs));

  for (let gz = gz0; gz <= gz1; gz++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const wx = ox + gx * cs;
      const wz = oz + gz * cs;
      if (_pointInQuad(wx, wz, corners) && occupancy.get(gx, gz) > 0) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Stamp a rotated rectangle onto the occupancy grid (mark cells as occupied).
 */
function _stampRect(corners, occupancy, cs, ox, oz) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const c of corners) {
    if (c.x < minX) minX = c.x;
    if (c.x > maxX) maxX = c.x;
    if (c.z < minZ) minZ = c.z;
    if (c.z > maxZ) maxZ = c.z;
  }
  const gx0 = Math.max(0, Math.floor((minX - ox) / cs));
  const gx1 = Math.min(occupancy.width - 1, Math.ceil((maxX - ox) / cs));
  const gz0 = Math.max(0, Math.floor((minZ - oz) / cs));
  const gz1 = Math.min(occupancy.height - 1, Math.ceil((maxZ - oz) / cs));

  for (let gz = gz0; gz <= gz1; gz++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const wx = ox + gx * cs;
      const wz = oz + gz * cs;
      if (_pointInQuad(wx, wz, corners)) {
        occupancy.set(gx, gz, 1);
      }
    }
  }
}

/** Point-in-convex-quad using cross-product winding test. */
function _pointInQuad(px, pz, corners) {
  // Check that point is on the same side of all 4 edges
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const cross = (b.x - a.x) * (pz - a.z) - (b.z - a.z) * (px - a.x);
    if (cross < 0) return false;
  }
  return true;
}

export function placeTerracedRows(map, _seed) {
  const group = new THREE.Group();
  const ox = map.originX, oz = map.originZ;
  const cs = map.cellSize;
  const zones = map.developmentZones;

  if (!zones || zones.length === 0) return group;

  const templateGeo = _buildPlotTemplate();

  // Build occupancy grid: water + unbuildable + skeleton/collector roads = occupied.
  // Ribbon (local land-first) roads are excluded — plots are designed to line them.
  const { Grid2D } = _getGrid2D(map);
  const occupancy = new Grid2D(map.width, map.height, { type: 'uint8' });
  for (let gz = 0; gz < map.height; gz++) {
    for (let gx = 0; gx < map.width; gx++) {
      if (map.waterMask.get(gx, gz) > 0) { occupancy.set(gx, gz, 1); continue; }
      if (map.buildability.get(gx, gz) < 0.15) { occupancy.set(gx, gz, 1); continue; }
    }
  }
  // Stamp non-ribbon roads onto occupancy (skeleton, collector, bridges)
  _stampRoadsOntoOccupancy(map, occupancy);

  // First pass: count max possible plots for InstancedMesh allocation
  let totalPlots = 0;
  for (const zone of zones) {
    if (!zone._streets) continue;
    const plotWidth = plotWidthForDensity(zone.distFromNucleus);
    for (const street of zone._streets) {
      if (street.length < 2) continue;
      let streetLen = 0;
      for (let i = 1; i < street.length; i++) {
        const dx = street[i].x - street[i - 1].x;
        const dz = street[i].z - street[i - 1].z;
        streetLen += Math.sqrt(dx * dx + dz * dz);
      }
      if (streetLen < plotWidth * 2) continue;
      totalPlots += Math.floor(streetLen / plotWidth) * 2;
    }
  }

  if (totalPlots === 0) return group;

  const mat = new THREE.MeshLambertMaterial({ color: 0xd4c4a8 });
  const mesh = new THREE.InstancedMesh(templateGeo, mat, totalPlots);
  const dummy = new THREE.Object3D();
  let instanceIdx = 0;

  for (const zone of zones) {
    if (!zone._streets) continue;
    const plotWidth = plotWidthForDensity(zone.distFromNucleus);
    const spacing = zone._spacing || 30;
    const roadHalfW = 3;
    const plotDepth = Math.min(PLOT_TOTAL_DEPTH, (spacing / 2) - roadHalfW - 1);

    for (const street of zone._streets) {
      if (street.length < 2) continue;

      let streetLen = 0;
      for (let i = 1; i < street.length; i++) {
        const dx = street[i].x - street[i - 1].x;
        const dz = street[i].z - street[i - 1].z;
        streetLen += Math.sqrt(dx * dx + dz * dz);
      }
      if (streetLen < plotWidth * 2) continue;

      const houseCount = Math.floor(streetLen / plotWidth);
      let segIdx = 0, segStart = 0;

      for (let h = 0; h < houseCount; h++) {
        const targetDist = (h + 0.5) * plotWidth;

        while (segIdx < street.length - 2) {
          const dx = street[segIdx + 1].x - street[segIdx].x;
          const dz = street[segIdx + 1].z - street[segIdx].z;
          const sLen = Math.sqrt(dx * dx + dz * dz);
          if (segStart + sLen >= targetDist) break;
          segStart += sLen;
          segIdx++;
        }
        if (segIdx >= street.length - 1) break;

        const ax = street[segIdx].x, az = street[segIdx].z;
        const bx = street[segIdx + 1].x, bz = street[segIdx + 1].z;
        const sdx = bx - ax, sdz = bz - az;
        const segLen = Math.sqrt(sdx * sdx + sdz * sdz);
        if (segLen < 0.01) continue;

        const t = (targetDist - segStart) / segLen;
        const px = ax + sdx * t;
        const pz = az + sdz * t;

        // Along-road unit vector
        const adx = sdx / segLen;
        const adz = sdz / segLen;

        for (const side of [-1, 1]) {
          const perpX = (-sdz / segLen) * side;
          const perpZ = (sdx / segLen) * side;
          const angle = Math.atan2(perpX, perpZ);

          const roadHalfWidth = 3;
          const sidewalk = 1.5;
          const frontSetback = roadHalfWidth + sidewalk;
          const frontX = px + perpX * frontSetback;
          const frontZ = pz + perpZ * frontSetback;

          // Check full plot rectangle against occupancy grid
          const corners = _plotCorners(
            frontX, frontZ, adx, adz, perpX, perpZ, plotWidth, plotDepth
          );
          if (_rectCollides(corners, occupancy, cs, ox, oz)) continue;

          // Plot is clear — stamp it into occupancy and place instance
          _stampRect(corners, occupancy, cs, ox, oz);

          const lx = frontX - ox;
          const lz = frontZ - oz;
          const gx = lx / cs;
          const gz = lz / cs;
          if (gx < 1 || gz < 1 || gx >= map.width - 1 || gz >= map.height - 1) continue;
          const terrainY = map.elevation.sample(gx, gz);

          dummy.position.set(lx, terrainY, lz);
          dummy.rotation.set(0, angle, 0);
          dummy.updateMatrix();
          mesh.setMatrixAt(instanceIdx, dummy.matrix);
          instanceIdx++;
        }
      }
    }
  }

  mesh.count = instanceIdx;
  mesh.instanceMatrix.needsUpdate = true;
  group.add(mesh);
  return group;
}

/** Extract Grid2D constructor from the map's existing grids. */
function _getGrid2D(map) {
  return { Grid2D: map.waterMask.constructor };
}

/**
 * Stamp non-ribbon roads onto the occupancy grid.
 * Includes skeleton roads, collector connections, and bridges — anything
 * that isn't a local land-first ribbon street (source='land-first', hierarchy='local').
 */
function _stampRoadsOntoOccupancy(map, occupancy) {
  const cs = map.cellSize;
  const ox = map.originX, oz = map.originZ;
  const w = map.width, h = map.height;

  for (const road of map.roads) {
    // Skip local ribbon roads — plots are designed to line them
    if (road.source === 'land-first' && road.hierarchy === 'local') continue;

    const polyline = road.polyline;
    if (!polyline || polyline.length < 2) continue;

    const halfWidth = (road.width || 6) / 2 + 2; // +2m buffer

    for (let i = 0; i < polyline.length - 1; i++) {
      const ax = polyline[i].x, az = polyline[i].z;
      const bx = polyline[i + 1].x, bz = polyline[i + 1].z;
      const dx = bx - ax, dz = bz - az;
      const segLen = Math.sqrt(dx * dx + dz * dz);
      if (segLen < 0.01) continue;

      const steps = Math.ceil(segLen / (cs * 0.5));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const px = ax + dx * t, pz = az + dz * t;
        const cellRadius = Math.ceil(halfWidth / cs);
        const cgx = Math.round((px - ox) / cs);
        const cgz = Math.round((pz - oz) / cs);

        for (let ddz = -cellRadius; ddz <= cellRadius; ddz++) {
          for (let ddx = -cellRadius; ddx <= cellRadius; ddx++) {
            const gx = cgx + ddx, gz = cgz + ddz;
            if (gx < 0 || gx >= w || gz < 0 || gz >= h) continue;
            const cellX = ox + gx * cs, cellZ = oz + gz * cs;
            const distSq = (cellX - px) ** 2 + (cellZ - pz) ** 2;
            if (distSq <= halfWidth * halfWidth) {
              occupancy.set(gx, gz, 1);
            }
          }
        }
      }
    }
  }
}
