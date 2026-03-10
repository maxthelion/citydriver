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
  floors: [2, 3],
  floorHeight: [2.8, 3.2],
  roofPitch: [35, 45],
  roofDirection: 'sides',
  roofOverhang: 0.2,
  plotWidth: [4.5, 6],
  depth: [8, 10],
  door: 'left',
  bay: { style: 'box', span: 1, floors: [1, 2], depth: [0.6, 0.9] },
  groundHeight: [0.3, 0.5],
  wallColor: 0xd4c4a8,
  roofColor: 0x6b4e37,
  colorVariation: 0.06,
  windowSpacing: [2.2, 2.8],
  windowHeight: [1.3, 1.6],
  sills: { protrusion: 0.08 },
};
