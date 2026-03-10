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
  suburbanDetached, generateRow, hashPosition,
  sample, ROAD_HALF_WIDTH, SIDEWALK_WIDTH, SETBACK,
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
