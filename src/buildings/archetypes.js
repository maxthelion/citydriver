import * as THREE from 'three';
import { SeededRandom } from '../core/rng.js';
import {
  createHouse, setPartyWalls, addFloor,
  addPitchedRoof, addFrontDoor, addBayWindow,
  addWindows, addWindowSills, addGroundLevel,
  addPorch, addBalcony, addDormer, addExtension,
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
    windowStyle: 'sash',
    roofTileStyle: 'slate',
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

export const parisianHaussmann = {
  typology: 'terraced',
  partyWalls: ['left', 'right'],

  shared: {
    floors: [5, 6],
    floorHeight: [3.0, 3.4],
    roofPitch: [60, 70],
    roofDirection: 'mansard',
    roofOverhang: 0.15,
    depth: [10, 12],
    door: 'center',
    bay: null,
    balcony: { style: 'full', floors: [2, 3] },
    dormers: { style: 'window', count: [2, 3] },
    porch: null,
    extension: null,
    windowSpacing: [2.4, 2.8],
    windowHeight: [2.0, 2.4],
    windowStyle: 'georgian',
    roofTileStyle: 'clay',
    groundHeight: [0.5, 0.8],
    sills: { protrusion: 0.08 },
    roofColor: 0x4a4a4a,
  },

  perHouse: {
    plotWidth: [5, 7],
    wallColor: 0xe8dcc8,
    colorVariation: 0.04,
  },
};

export const germanTownhouse = {
  typology: 'terraced',
  partyWalls: ['left', 'right'],

  shared: {
    floors: [3, 4],
    floorHeight: [2.8, 3.2],
    roofPitch: [45, 55],
    roofDirection: 'sides',
    roofOverhang: 0.3,
    depth: [9, 11],
    door: 'center',
    bay: null,
    balcony: null,
    dormers: { style: 'window', count: [1, 2] },
    porch: { face: 'front', porchDepth: 1.5, roofStyle: 'gable' },
    extension: null,
    windowSpacing: [2.2, 2.6],
    windowHeight: [1.4, 1.8],
    windowStyle: 'georgian',
    roofTileStyle: 'slate',
    groundHeight: [0.3, 0.5],
    sills: { protrusion: 0.08 },
    roofColor: 0x8b4513,
  },

  perHouse: {
    plotWidth: [5, 6.5],
    wallColor: 0xc0b8a8,
    colorVariation: 0.05,
  },
};

export const suburbanDetached = {
  typology: 'detached',
  partyWalls: [],

  shared: {
    floors: 2,
    floorHeight: [2.6, 2.8],
    roofPitch: [25, 30],
    roofDirection: 'all',
    roofOverhang: 0.4,
    depth: [8, 10],
    door: 'center',
    bay: null,
    balcony: null,
    dormers: null,
    porch: { face: 'front', porchDepth: 1.8, roofStyle: 'slope' },
    extension: { widthFrac: 0.5, extDepth: 3, floors: 1, side: 'left' },
    windowSpacing: [2.0, 2.4],
    windowHeight: [1.3, 1.5],
    windowStyle: 'single',
    roofTileStyle: 'shingle',
    groundHeight: [0.2, 0.3],
    sills: null,
    roofColor: 0x6b4e37,
  },

  perHouse: {
    plotWidth: [8, 12],
    wallColor: 0xd8d0c0,
    colorVariation: 0.08,
    sideGap: [1, 2],
  },
};

export const lowRiseApartments = {
  typology: 'terraced',
  partyWalls: ['left', 'right'],

  shared: {
    floors: [4, 5],
    floorHeight: [2.8, 3.0],
    roofPitch: 0,
    roofDirection: 'sides',
    roofOverhang: 0.1,
    depth: [12, 15],
    door: 'center',
    bay: null,
    balcony: { style: 'full', floors: [1, 5] },
    dormers: null,
    porch: null,
    extension: null,
    windowSpacing: [2.2, 2.6],
    windowHeight: [1.5, 1.8],
    windowStyle: 'casement',
    roofTileStyle: 'shingle',
    groundHeight: [0.3, 0.5],
    sills: null,
    roofColor: 0x888888,
  },

  perHouse: {
    plotWidth: [6, 8],
    wallColor: 0xe0ddd8,
    colorVariation: 0.03,
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

  // Optional shared features — sample only if defined
  const bayFloors = s.bay ? Math.round(sample(rowRng, s.bay.floors)) : 0;
  const bayDepth = s.bay ? sample(rowRng, s.bay.depth) : 0;
  const dormerCount = s.dormers ? Math.round(sample(rowRng, s.dormers.count)) : 0;

  let xOffset = 0;

  for (let i = 0; i < count; i++) {
    // Per-house values from position-based seed
    const houseSeed = hashPosition(seed, xOffset, 0);
    const rng = new SeededRandom(houseSeed);

    const plotWidth = sample(rng, p.plotWidth);
    const sideGap = p.sideGap ? sample(rng, p.sideGap) : 0;
    const houseWidth = plotWidth - sideGap * 2;
    const wallColor = nudgeColor(p.wallColor, p.colorVariation, rng);

    // Terrain heights at house position
    const centerX = xOffset + plotWidth / 2;
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
    const house = createHouse(houseWidth, depth, floorHeight, wallColor);
    house._winSpacing = winSpacing;
    house._groundHeight = groundLevel;
    house.roofColor = s.roofColor;

    setPartyWalls(house, partyWalls);
    for (let f = 1; f < floors; f++) addFloor(house);
    house._roofTileStyle = s.roofTileStyle || 'slate';
    addPitchedRoof(house, roofPitch, s.roofDirection, s.roofOverhang);
    addFrontDoor(house, s.door);

    if (s.bay) {
      addBayWindow(house, {
        style: s.bay.style,
        span: s.bay.span,
        floors: Math.min(bayFloors, floors),
        depth: bayDepth,
      });
    }

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

    house._windowStyle = s.windowStyle || 'sash';
    addWindows(house, { spacing: winSpacing, height: winHeight });

    if (s.balcony) {
      const balcStart = Array.isArray(s.balcony.floors) ? s.balcony.floors[0] : 1;
      const balcEnd = Array.isArray(s.balcony.floors) ? s.balcony.floors[1] : floors;
      for (let bf = balcStart; bf <= Math.min(balcEnd, floors - 1); bf++) {
        addBalcony(house, bf, s.balcony.style);
      }
    }

    if (s.sills) {
      addWindowSills(house, { protrusion: s.sills.protrusion });
    }

    if (s.dormers) {
      for (let d = 0; d < dormerCount; d++) {
        const pos = (d + 0.5) / dormerCount;
        addDormer(house, { position: pos, style: s.dormers.style });
      }
    }

    if (groundLevel > 0.05) {
      addGroundLevel(house, groundLevel);
    }

    // Rear foundation wall: if terrain drops behind the house
    const rearDrop = terrainFront - terrainRear;
    if (rearDrop > 0.05) {
      const rearWall = new THREE.Mesh(
        new THREE.BoxGeometry(houseWidth + 0.1, rearDrop, 0.15),
        new THREE.MeshLambertMaterial({ color: house.wallColor }),
      );
      rearWall.position.set(houseWidth / 2, -rearDrop / 2, depth + 0.05);
      rearWall.name = 'rearFoundation';
      house.group.add(rearWall);
    }

    // Position in row: X along plot, Y at terrain height, Z at setback
    house.group.position.x = xOffset + sideGap;
    house.group.position.y += terrainFront;
    house.group.position.z = frontZ;
    group.add(house.group);
    xOffset += plotWidth;
  }

  return group;
}
