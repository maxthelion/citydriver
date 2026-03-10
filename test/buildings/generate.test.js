import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  createHouse, addFloor, removeFloor,
  addPitchedRoof, addFrontDoor, addBackDoor, addPorch, addWindows,
  addExtension, addDormer, addBayWindow, addWindowSills, addGroundLevel,
  setPartyWalls,
  generateBuilding,
  getWindowTexture,
} from '../../src/buildings/generate.js';
import { getClimateStyle, buildRecipe, CLIMATES } from '../../src/buildings/styles.js';

function getChild(group, name) {
  let found = null;
  group.traverse(c => { if (c.name === name) found = c; });
  return found;
}

function getBounds(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  return {
    minX: box.min.x, maxX: box.max.x,
    minY: box.min.y, maxY: box.max.y,
    minZ: box.min.z, maxZ: box.max.z,
  };
}

describe('createHouse', () => {
  it('returns a house with a walls mesh', () => {
    const house = createHouse(6, 5, 3);
    expect(house.group).toBeInstanceOf(THREE.Group);
    expect(getChild(house.group, 'walls')).toBeDefined();
  });

  it('walls match specified dimensions', () => {
    const house = createHouse(6, 5, 3);
    const { minX, maxX, minY, maxY, minZ, maxZ } = getBounds(house.group);
    expect(maxX - minX).toBeCloseTo(6, 1);
    expect(maxY - minY).toBeCloseTo(3, 1);
    expect(maxZ - minZ).toBeCloseTo(5, 1);
  });
});

describe('addFloor', () => {
  it('increases wall height by one floor', () => {
    const house = createHouse(6, 5, 3);
    addFloor(house);
    expect(house.floors).toBe(2);
    const { maxY } = getBounds(house.group);
    expect(maxY).toBeCloseTo(6, 1);
  });

  it('can add multiple floors', () => {
    const house = createHouse(4, 4, 2.8);
    addFloor(house);
    addFloor(house);
    expect(house.floors).toBe(3);
    const { maxY } = getBounds(house.group);
    expect(maxY).toBeCloseTo(8.4, 1);
  });
});

describe('removeFloor', () => {
  it('decreases floor count', () => {
    const house = createHouse(6, 5, 3);
    addFloor(house);
    removeFloor(house);
    expect(house.floors).toBe(1);
  });

  it('does not go below 1 floor', () => {
    const house = createHouse(6, 5, 3);
    removeFloor(house);
    expect(house.floors).toBe(1);
  });
});

describe('addPitchedRoof', () => {
  it('adds a roof mesh', () => {
    const house = createHouse(6, 5, 3);
    addPitchedRoof(house, 35, 'sides');
    expect(getChild(house.group, 'roof')).toBeDefined();
  });

  it('roof peak matches pitch calculation', () => {
    const house = createHouse(6, 5, 3);
    addPitchedRoof(house, 45, 'sides');
    const { maxY } = getBounds(house.group);
    // pitch 45 on width 6 → rise = 3, wallH = 3, peak = 6
    expect(maxY).toBeCloseTo(6, 0);
  });

  it('frontback direction uses depth for rise', () => {
    const house = createHouse(6, 5, 3);
    addPitchedRoof(house, 45, 'frontback');
    const { maxY } = getBounds(house.group);
    // pitch 45 on depth 5 → rise = 2.5, wallH = 3, peak = 5.5
    expect(maxY).toBeCloseTo(5.5, 0);
  });

  it('flat roof (pitch 0) stays near wall top', () => {
    const house = createHouse(6, 5, 3);
    addPitchedRoof(house, 0, 'sides');
    const { maxY } = getBounds(house.group);
    expect(maxY).toBeCloseTo(3, 0);
  });

  it('hip roof (all) peak uses shorter span', () => {
    const house = createHouse(8, 5, 3);
    addPitchedRoof(house, 45, 'all');
    const { maxY } = getBounds(house.group);
    // shorter span is depth=5, rise = 2.5, wallH = 3, peak = 5.5
    expect(maxY).toBeCloseTo(5.5, 0);
  });

  it('mansard has steep slopes and flat top above walls', () => {
    const house = createHouse(8, 5, 3);
    addPitchedRoof(house, 35, 'mansard');
    const roof = getChild(house.group, 'roof');
    expect(roof).toBeDefined();
    const { maxY } = getBounds(house.group);
    expect(maxY).toBeGreaterThan(3); // above wall top
  });

  it('hip roof on square building makes a pyramid', () => {
    const house = createHouse(6, 6, 3);
    addPitchedRoof(house, 45, 'all');
    const { maxY } = getBounds(house.group);
    // span=6, rise=3, wallH=3, peak=6
    expect(maxY).toBeCloseTo(6, 0);
  });

  it('roof moves up when floor added', () => {
    const house = createHouse(6, 5, 3);
    addPitchedRoof(house, 35, 'sides');
    const before = getBounds(house.group).maxY;
    addFloor(house);
    const after = getBounds(house.group).maxY;
    expect(after - before).toBeCloseTo(3, 0);
  });
});

describe('addFrontDoor', () => {
  it('adds a door mesh', () => {
    const house = createHouse(6, 5, 3);
    addFrontDoor(house, 'center');
    expect(getChild(house.group, 'door')).toBeDefined();
  });

  it('left door is left of center, right door is right of center', () => {
    const make = (p) => { const h = createHouse(8, 5, 3); h._winSpacing = 2.5; addFrontDoor(h, p); return getChild(h.group, 'door').position.x; };
    const lx = make('left'), cx = make('center'), rx = make('right');
    expect(lx).toBeLessThan(cx);
    expect(rx).toBeGreaterThan(cx);
  });

  it('door aligns to window grid', () => {
    const house = createHouse(8, 5, 3);
    house._winSpacing = 2.5;
    addFrontDoor(house, 'left');
    addWindows(house, { spacing: 2.5 });
    // Door X should match a window grid slot
    const doorX = getChild(house.group, 'door').position.x;
    const nSlots = Math.floor(8 / 2.5);
    const startOffset = (8 - (nSlots - 1) * 2.5) / 2;
    const gridPositions = Array.from({ length: nSlots }, (_, i) => startOffset + i * 2.5);
    const onGrid = gridPositions.some(gx => Math.abs(gx - doorX) < 0.01);
    expect(onGrid).toBe(true);
  });
});

describe('addBackDoor', () => {
  it('adds a back door mesh', () => {
    const house = createHouse(6, 5, 3);
    addBackDoor(house, 'center');
    expect(getChild(house.group, 'backDoor')).toBeDefined();
  });

  it('back door is at z = depth', () => {
    const house = createHouse(6, 5, 3);
    addBackDoor(house, 'center');
    const door = getChild(house.group, 'backDoor');
    expect(door.position.z).toBeCloseTo(5.01, 1);
  });
});

describe('addWindows', () => {
  it('adds a windows group', () => {
    const house = createHouse(6, 5, 3);
    addWindows(house);
    expect(getChild(house.group, 'windows')).toBeDefined();
  });

  it('creates multiple window meshes', () => {
    const house = createHouse(8, 6, 3);
    addFloor(house);
    addWindows(house, { spacing: 2.5 });
    const winGroup = getChild(house.group, 'windows');
    expect(winGroup.children.length).toBeGreaterThan(4);
  });

  it('skips windows on party walls', () => {
    const house = createHouse(6, 8, 3);
    setPartyWalls(house, ['left', 'right']);
    addWindows(house, { spacing: 2.5 });
    const winGroup = getChild(house.group, 'windows');
    // All windows should be on front (z near 0) or back (z near depth)
    for (const win of winGroup.children) {
      const x = win.position.x;
      // Should NOT be on left wall (x near -0.01) or right wall (x near 6.01)
      const onLeft = Math.abs(x - (-0.01)) < 0.1;
      const onRight = Math.abs(x - 6.01) < 0.1;
      expect(onLeft || onRight).toBe(false);
    }
  });

  it('uses window texture when house._windowStyle is set', () => {
    const house = createHouse(6, 5, 3);
    house._windowStyle = 'georgian';
    addWindows(house);
    const winGroup = getChild(house.group, 'windows');
    const firstWin = winGroup.children[0];
    expect(firstWin.material.map).toBeDefined();
    expect(firstWin.material.map).toBe(getWindowTexture('georgian'));
  });

  it('defaults to sash texture when no windowStyle set', () => {
    const house = createHouse(6, 5, 3);
    addWindows(house);
    const winGroup = getChild(house.group, 'windows');
    const firstWin = winGroup.children[0];
    expect(firstWin.material.map).toBeDefined();
    expect(firstWin.material.map).toBe(getWindowTexture('sash'));
  });
});

describe('addPorch', () => {
  it('adds a porch group', () => {
    const house = createHouse(6, 5, 3);
    addPorch(house);
    expect(getChild(house.group, 'porch')).toBeDefined();
  });

  it('porch extends in front of the house (negative Z)', () => {
    const house = createHouse(6, 5, 3);
    addPorch(house);
    const { minZ } = getBounds(getChild(house.group, 'porch'));
    expect(minZ).toBeLessThan(0);
  });

  it('replacing porch removes old one', () => {
    const house = createHouse(6, 5, 3);
    addPorch(house);
    addPorch(house, { porchDepth: 2.5 });
    const porches = house.group.children.filter(c => c.name === 'porch');
    expect(porches.length).toBe(1);
  });
});

describe('addExtension', () => {
  it('adds an extension group behind the house', () => {
    const house = createHouse(6, 5, 3);
    addExtension(house);
    expect(getChild(house.group, 'extension')).toBeDefined();
    const { maxZ } = getBounds(getChild(house.group, 'extension'));
    expect(maxZ).toBeGreaterThan(5); // extends beyond house depth
  });

  it('half-width left extension stays on left half', () => {
    const house = createHouse(8, 5, 3);
    addExtension(house, { widthFrac: 0.5, side: 'left' });
    const { minX, maxX } = getBounds(getChild(house.group, 'extension'));
    expect(minX).toBeCloseTo(0, 0);
    expect(maxX).toBeLessThanOrEqual(5); // roughly half of 8
  });

  it('half-width right extension stays on right half', () => {
    const house = createHouse(8, 5, 3);
    addExtension(house, { widthFrac: 0.5, side: 'right' });
    const { minX } = getBounds(getChild(house.group, 'extension'));
    expect(minX).toBeGreaterThanOrEqual(3); // roughly half of 8
  });

  it('full-width extension spans full house width', () => {
    const house = createHouse(6, 5, 3);
    addExtension(house, { widthFrac: 1 });
    const ext = getChild(house.group, 'extension');
    const { minX, maxX } = getBounds(ext);
    expect(maxX - minX).toBeGreaterThanOrEqual(5.9);
  });

  it('respects floor count', () => {
    const house = createHouse(6, 5, 3);
    addExtension(house, { floors: 2 });
    const ext = getChild(house.group, 'extension');
    const { maxY } = getBounds(ext);
    expect(maxY).toBeGreaterThan(6); // 2 floors * 3m + roof
  });

  it('supports all roof types', () => {
    for (const rt of ['sides', 'frontback', 'all', 'mansard']) {
      const house = createHouse(6, 5, 3);
      addExtension(house, { roofDirection: rt });
      expect(getChild(house.group, 'extension')).toBeDefined();
    }
  });
});

describe('addDormer', () => {
  it('adds a dormer to a house with a roof', () => {
    const house = createHouse(6, 5, 3);
    addPitchedRoof(house, 35, 'sides');
    addDormer(house, { position: 0.5 });
    expect(getChild(house.group, 'dormer0')).toBeDefined();
  });

  it('multiple dormers get unique names', () => {
    const house = createHouse(8, 6, 3);
    addPitchedRoof(house, 35, 'sides');
    addDormer(house, { position: 0.3 });
    addDormer(house, { position: 0.7 });
    expect(getChild(house.group, 'dormer0')).toBeDefined();
    expect(getChild(house.group, 'dormer1')).toBeDefined();
  });

  it('does nothing without a roof', () => {
    const house = createHouse(6, 5, 3);
    const before = house.group.children.length;
    addDormer(house, { position: 0.5 });
    expect(house.group.children.length).toBe(before);
  });

  it('dormer sits above wall height', () => {
    const house = createHouse(6, 5, 3);
    addPitchedRoof(house, 40, 'sides');
    addDormer(house, { position: 0.5, slopeFrac: 0.4 });
    const dormer = getChild(house.group, 'dormer0');
    const { minY } = getBounds(dormer);
    expect(minY).toBeGreaterThanOrEqual(3 * 0.3); // at least partway up the slope
  });
});

describe('addBayWindow', () => {
  it('adds a bay group', () => {
    const house = createHouse(8, 5, 3);
    house._winSpacing = 2.5;
    addBayWindow(house);
    expect(getChild(house.group, 'bay')).toBeDefined();
  });

  it('box bay extends in front of house (negative Z)', () => {
    const house = createHouse(8, 5, 3);
    house._winSpacing = 2.5;
    addBayWindow(house, { style: 'box' });
    const { minZ } = getBounds(getChild(house.group, 'bay'));
    expect(minZ).toBeLessThan(0);
  });

  it('angled bay extends in front of house', () => {
    const house = createHouse(8, 5, 3);
    house._winSpacing = 2.5;
    addBayWindow(house, { style: 'angled' });
    const { minZ } = getBounds(getChild(house.group, 'bay'));
    expect(minZ).toBeLessThan(0);
  });

  it('multi-span bay is wider than single-span', () => {
    const house1 = createHouse(8, 5, 3);
    house1._winSpacing = 2.5;
    addBayWindow(house1, { span: 1 });
    const w1 = getBounds(getChild(house1.group, 'bay'));

    const house2 = createHouse(8, 5, 3);
    house2._winSpacing = 2.5;
    addBayWindow(house2, { span: 2 });
    const w2 = getBounds(getChild(house2.group, 'bay'));

    expect(w2.maxX - w2.minX).toBeGreaterThan(w1.maxX - w1.minX);
  });

  it('multi-storey bay is taller', () => {
    const house = createHouse(8, 5, 3);
    house._winSpacing = 2.5;
    addFloor(house);
    addBayWindow(house, { floors: 2 });
    const { maxY } = getBounds(getChild(house.group, 'bay'));
    expect(maxY).toBeGreaterThan(3); // taller than one floor
  });

  it('replacing bay removes old one', () => {
    const house = createHouse(8, 5, 3);
    house._winSpacing = 2.5;
    addBayWindow(house);
    addBayWindow(house, { span: 2 });
    const bays = house.group.children.filter(c => c.name === 'bay');
    expect(bays.length).toBe(1);
  });
});

describe('addWindowSills', () => {
  it('adds sills below windows', () => {
    const house = createHouse(6, 5, 3);
    addWindows(house);
    addWindowSills(house, { protrusion: 0.1 });
    expect(getChild(house.group, 'sills')).toBeDefined();
    const sills = getChild(house.group, 'sills');
    expect(sills.children.length).toBeGreaterThan(0);
  });

  it('sill count matches window count', () => {
    const house = createHouse(6, 5, 3);
    addWindows(house);
    addWindowSills(house);
    const windows = getChild(house.group, 'windows');
    const sills = getChild(house.group, 'sills');
    expect(sills.children.length).toBe(windows.children.length);
  });
});

describe('addGroundLevel', () => {
  it('raises the house and adds steps', () => {
    const house = createHouse(6, 5, 3);
    addFrontDoor(house, 'center');
    addGroundLevel(house, 0.5);
    expect(getChild(house.group, 'groundLevel')).toBeDefined();
    expect(house.group.position.y).toBeCloseTo(0.5, 1);
  });

  it('does nothing when height is 0', () => {
    const house = createHouse(6, 5, 3);
    addGroundLevel(house, 0);
    expect(getChild(house.group, 'groundLevel')).toBeNull();
  });
});

describe('getWindowTexture', () => {
  it('returns a THREE.CanvasTexture for each style', () => {
    for (const style of ['sash', 'georgian', 'casement', 'single']) {
      const tex = getWindowTexture(style);
      expect(tex).toBeInstanceOf(THREE.CanvasTexture);
    }
  });

  it('caches textures — same style returns same object', () => {
    const a = getWindowTexture('sash');
    const b = getWindowTexture('sash');
    expect(a).toBe(b);
  });

  it('different styles return different objects', () => {
    const a = getWindowTexture('sash');
    const b = getWindowTexture('georgian');
    expect(a).not.toBe(b);
  });

  it('unknown style falls back to sash', () => {
    const tex = getWindowTexture('nonexistent');
    const sash = getWindowTexture('sash');
    expect(tex).toBe(sash);
  });
});

describe('addPorch centering', () => {
  it('door-width porch is narrower than full', () => {
    const house = createHouse(8, 5, 3);
    house._winSpacing = 2.5;
    addFrontDoor(house, 'left');
    addPorch(house, { porchWidth: 2.0, porchCenter: house._doorX });
    const porch = getChild(house.group, 'porch');
    const { minX, maxX } = getBounds(porch);
    expect(maxX - minX).toBeLessThan(4); // narrower than 8m house
  });
});

describe('generateBuilding (legacy)', () => {
  it('returns a Group with walls, roof, windows', () => {
    const style = getClimateStyle('temperate');
    const recipe = buildRecipe(style, 'small', 0, 42);
    const group = generateBuilding(style, recipe);

    expect(group).toBeInstanceOf(THREE.Group);
    expect(getChild(group, 'walls')).toBeDefined();
    expect(getChild(group, 'roof')).toBeDefined();
    expect(getChild(group, 'windows')).toBeDefined();
  });

  it('all 54 climate × size × richness combos work', () => {
    for (const climate of CLIMATES) {
      const style = getClimateStyle(climate);
      for (const size of ['small', 'medium', 'large']) {
        for (const rich of [0, 0.5, 1]) {
          const recipe = buildRecipe(style, size, rich, 42);
          const group = generateBuilding(style, recipe);
          expect(group.children.length).toBeGreaterThan(0);
        }
      }
    }
  });
});
