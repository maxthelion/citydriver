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

/**
 * Generate a row of terraced houses from an archetype.
 * @param {object} archetype - Archetype with parameter ranges
 * @param {number} count - Number of houses
 * @param {number} seed - Master seed for deterministic generation
 * @returns {THREE.Group} Group containing all houses positioned side by side
 */
export function generateRow(archetype, count, seed) {
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
  const groundHeight = sample(rowRng, s.groundHeight);
  const bayFloors = Math.round(sample(rowRng, s.bay.floors));
  const bayDepth = sample(rowRng, s.bay.depth);

  let xOffset = 0;

  for (let i = 0; i < count; i++) {
    // Per-house values from position-based seed
    const houseSeed = hashPosition(seed, xOffset, 0);
    const rng = new SeededRandom(houseSeed);

    const width = sample(rng, p.plotWidth);
    const wallColor = nudgeColor(p.wallColor, p.colorVariation, rng);

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
    house._groundHeight = groundHeight;
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
    if (groundHeight > 0) {
      addGroundLevel(house, groundHeight);
    }

    // Position in row
    house.group.position.x = xOffset;
    group.add(house.group);
    xOffset += width;
  }

  return group;
}
