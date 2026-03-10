import * as THREE from 'three';
import { SeededRandom } from '../core/rng.js';
import {
  createHouse, setPartyWalls, addFloor,
  addPitchedRoof, addFrontDoor, addBayWindow,
  addWindows, addWindowSills, addGroundLevel,
} from './generate.js';

/**
 * Sample a value from an archetype field.
 * If the field is a two-element array [min, max], returns rng.range(min, max).
 * Otherwise returns the value unchanged.
 */
export function sample(rng, value) {
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'number') {
    return rng.range(value[0], value[1]);
  }
  return value;
}

/**
 * Hash a seed with a world position to produce a deterministic integer seed.
 * The same (seed, x, z) always produces the same result.
 */
export function hashPosition(seed, x, z) {
  const ix = Math.round(x * 100);
  const iz = Math.round(z * 100);
  return ((seed ^ (ix * 73856093) ^ (iz * 19349663)) | 0);
}

/**
 * Shift each RGB component of a hex color by a random amount.
 */
function nudgeColor(hex, amount, rng) {
  const shift = Math.round(amount * 255);
  const r = Math.min(255, Math.max(0, ((hex >> 16) & 0xff) + rng.int(-shift, shift)));
  const g = Math.min(255, Math.max(0, ((hex >> 8) & 0xff) + rng.int(-shift, shift)));
  const b = Math.min(255, Math.max(0, (hex & 0xff) + rng.int(-shift, shift)));
  return (r << 16) | (g << 8) | b;
}

export const victorianTerrace = {
  typology: 'terraced',
  partyWalls: ['left', 'right'],

  // Sampled once, shared across the whole row
  shared: {
    floors: [2, 3],
    floorHeight: [2.8, 3.2],
    roofPitch: [35, 45],
    roofDirection: 'sides',
    roofOverhang: 0.2,
    depth: [8, 10],
    door: 'left',
    bay: { style: 'box', span: 1, floors: [1, 2], depth: [0.6, 0.9] },
    windowSpacing: [2.2, 2.8],
    windowHeight: [1.3, 1.6],
    groundHeight: [0.3, 0.5],
    sills: { protrusion: 0.08 },
    roofColor: 0x6b4e37,
  },

  // Sampled per house from position-based seed
  perHouse: {
    plotWidth: [4.5, 6],
    wallColor: 0xd4c4a8,
    colorVariation: 0.06,
  },
};

// Layout constants
export const ROAD_HALF_WIDTH = 3;
export const SIDEWALK_WIDTH = 1.5;
export const SETBACK = 2;
export const HOUSE_Z = ROAD_HALF_WIDTH + SIDEWALK_WIDTH + SETBACK;

/**
 * Generate a row of terraced houses from an archetype.
 * @param {object} archetype - Archetype with parameter ranges
 * @param {number} count - Number of houses
 * @param {number} seed - Master seed for deterministic generation
 * @param {function} [heightFn] - Terrain height query: (x, z) => y. Defaults to flat.
 * @returns {THREE.Group} Group containing all houses positioned side by side
 */
export function generateRow(archetype, count, seed, heightFn = () => 0) {
  const group = new THREE.Group();
  const s = archetype.shared;
  const p = archetype.perHouse;

  // Sample shared values once at row level
  const rowRng = new SeededRandom(seed);
  const floors = Math.round(sample(rowRng, s.floors));
  const floorHeight = sample(rowRng, s.floorHeight);
  const roofPitch = sample(rowRng, s.roofPitch);
  const depth = sample(rowRng, s.depth);
  const winSpacing = sample(rowRng, s.windowSpacing);
  const winHeight = sample(rowRng, s.windowHeight);
  const baseGroundHeight = sample(rowRng, s.groundHeight);
  const bayFloors = Math.round(sample(rowRng, s.bay.floors));
  const bayDepth = sample(rowRng, s.bay.depth);

  let xOffset = 0;

  for (let i = 0; i < count; i++) {
    // Per-house values from position-based seed
    const houseSeed = hashPosition(seed, xOffset, 0);
    const rng = new SeededRandom(houseSeed);

    const width = sample(rng, p.plotWidth);
    const wallColor = nudgeColor(p.wallColor, p.colorVariation, rng);

    // Terrain heights at house position
    const centerX = xOffset + width / 2;
    const frontZ = HOUSE_Z;
    const backZ = HOUSE_Z + depth;
    const terrainFront = heightFn(centerX, frontZ);
    const roadY = heightFn(centerX, 0);
    const terrainRear = heightFn(centerX, backZ);

    // Ground level = how much to raise house above road
    const groundLevel = Math.max(baseGroundHeight, terrainFront - roadY);

    // Party walls: ends get one side exposed
    const partyWalls = [...archetype.partyWalls];
    if (i === 0) {
      const idx = partyWalls.indexOf('left');
      if (idx !== -1) partyWalls.splice(idx, 1);
    }
    if (i === count - 1) {
      const idx = partyWalls.indexOf('right');
      if (idx !== -1) partyWalls.splice(idx, 1);
    }

    // Build house using composable API
    const house = createHouse(width, depth, floorHeight, wallColor);
    house._winSpacing = winSpacing;
    house._groundHeight = groundLevel;
    house.roofColor = s.roofColor;

    setPartyWalls(house, partyWalls);
    for (let f = 1; f < floors; f++) addFloor(house);
    addPitchedRoof(house, roofPitch, s.roofDirection, s.roofOverhang);
    addFrontDoor(house, s.door);
    addBayWindow(house, {
      style: s.bay.style,
      span: s.bay.span,
      floors: Math.min(bayFloors, floors),
      depth: bayDepth,
    });
    addWindows(house, { spacing: winSpacing, height: winHeight });
    if (s.sills) {
      addWindowSills(house, { protrusion: s.sills.protrusion });
    }
    if (groundLevel > 0.05) {
      addGroundLevel(house, groundLevel);
    }

    // Rear foundation wall: if terrain drops behind the house
    const rearDrop = terrainFront - terrainRear;
    if (rearDrop > 0.05) {
      const rearWall = new THREE.Mesh(
        new THREE.BoxGeometry(width + 0.1, rearDrop, 0.15),
        new THREE.MeshLambertMaterial({ color: house.wallColor }),
      );
      // Position at back of house, extending downward
      rearWall.position.set(width / 2, -rearDrop / 2, depth + 0.05);
      rearWall.name = 'rearFoundation';
      house.group.add(rearWall);
    }

    // Position in row: X along row, Y at terrain height, Z at setback from road
    house.group.position.x = xOffset;
    house.group.position.y += terrainFront;
    house.group.position.z = frontZ;
    group.add(house.group);
    xOffset += width;
  }

  return group;
}
