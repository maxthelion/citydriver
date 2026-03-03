import * as THREE from 'three';
import { materials, sharedGeo } from './materials.js';

// ============================================================
// SHARED CONSTRUCTION PRIMITIVES
// ============================================================

const BUILDING_EXTRA_DEPTH = 2;

/**
 * Add a door to a building group.
 * doorFace: 0 = +Z, 1 = -Z, 2 = +X, 3 = -X
 */
export function addDoor(group, b) {
  const doorMat = materials.door[b.seed % materials.door.length];
  const door = new THREE.Mesh(sharedGeo.door, doorMat);
  const doorY = 1.1;
  switch (b.doorFace) {
    case 0:
      door.position.set(0, doorY, b.d / 2 + 0.06);
      break;
    case 1:
      door.position.set(0, doorY, -(b.d / 2 + 0.06));
      door.rotation.y = Math.PI;
      break;
    case 2:
      door.position.set(b.w / 2 + 0.06, doorY, 0);
      door.rotation.y = -Math.PI / 2;
      break;
    case 3:
      door.position.set(-(b.w / 2 + 0.06), doorY, 0);
      door.rotation.y = Math.PI / 2;
      break;
  }
  group.add(door);
}

/**
 * Create window grid on a facade. Returns array of meshes.
 * axis: 'z' for front/back faces, 'x' for left/right faces
 */
export function makeWindowGrid(width, floors, floorHeight, faceSign, axis, offset, startFloor) {
  const meshes = [];
  const windowsPerFloor = Math.max(1, Math.floor(width / 5));
  const start = startFloor || 0;
  for (let f = start; f < floors; f++) {
    for (let w = 0; w < windowsPerFloor; w++) {
      const wy = f * floorHeight + floorHeight * 0.65;
      const wx = (w - (windowsPerFloor - 1) / 2) * (width / (windowsPerFloor + 0.5));
      const win = new THREE.Mesh(sharedGeo.windowPane, materials.window);
      if (axis === 'z') {
        win.position.set(wx, wy, faceSign * offset);
        if (faceSign === -1) win.rotation.y = Math.PI;
      } else {
        win.position.set(faceSign * offset, wy, wx);
        win.rotation.y = faceSign * -Math.PI / 2;
      }
      meshes.push(win);
    }
  }
  return meshes;
}

/**
 * Create a pitched roof (two slope faces + gable ends) using direct vertex geometry.
 */
export function makePitchedRoof(width, depth, peakHeight, roofColorIdx) {
  const group = new THREE.Group();
  const mat = materials.roof[roofColorIdx % materials.roof.length];
  const hw = width / 2;
  const hd = depth / 2;

  // Roof slope faces: two quads from eave to ridge
  // Left slope: (-hw,0,-hd), (-hw,0,hd), (0,peak,-hd), (0,peak,hd)
  // Right slope: (hw,0,-hd), (hw,0,hd), (0,peak,-hd), (0,peak,hd)
  for (const side of [-1, 1]) {
    const verts = new Float32Array([
      side * hw, 0, -hd,
      side * hw, 0,  hd,
      0, peakHeight, -hd,
      0, peakHeight,  hd,
    ]);
    const idx = side === -1
      ? [0, 2, 1, 1, 2, 3]   // left slope faces outward
      : [0, 1, 2, 1, 3, 2];  // right slope faces outward
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    group.add(mesh);
  }

  // Gable ends (triangular faces at front and back)
  for (const side of [-1, 1]) {
    const verts = new Float32Array([
      -hw, 0, side * hd,
       hw, 0, side * hd,
       0, peakHeight, side * hd,
    ]);
    const idx = side === 1 ? [0, 1, 2] : [0, 2, 1]; // face outward
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    group.add(mesh);
  }

  return group;
}

/**
 * Create a rooftop accessory.
 */
export function makeRooftopAccessory(type, bw, bd, bh) {
  const group = new THREE.Group();
  if (type === 'antenna') {
    const antenna = new THREE.Mesh(sharedGeo.antenna, materials.antenna);
    antenna.position.set(0, bh + 4, 0);
    group.add(antenna);
  } else if (type === 'ac') {
    const ac = new THREE.Mesh(sharedGeo.ac, materials.ac);
    ac.position.set(bw * 0.2, bh + 1, bd * 0.2);
    group.add(ac);
  } else if (type === 'water_tower') {
    const tank = new THREE.Mesh(sharedGeo.waterTower, materials.ac);
    tank.position.set(bw * 0.25, bh + 4, bd * 0.25);
    group.add(tank);
    for (const ox of [-0.6, 0.6]) {
      for (const oz of [-0.6, 0.6]) {
        const leg = new THREE.Mesh(sharedGeo.waterTowerLegs, materials.pole);
        leg.position.set(bw * 0.25 + ox, bh + 1.5, bd * 0.25 + oz);
        group.add(leg);
      }
    }
  } else if (type === 'smokestack') {
    const stack = new THREE.Mesh(sharedGeo.smokestack, materials.pole);
    stack.position.set(bw * 0.3, bh + 6, bd * 0.3);
    group.add(stack);
  }
  return group;
}

// ============================================================
// DOWNTOWN OFFICE TEMPLATES
// ============================================================

function downtownGlassTower(b) {
  const group = new THREE.Group();
  const palette = materials.district.downtown_office;
  const mat = palette[b.colorIdx % palette.length];

  // Main body
  const bodyGeo = new THREE.BoxGeometry(b.w, b.h + BUILDING_EXTRA_DEPTH, b.d);
  const body = new THREE.Mesh(bodyGeo, mat);
  body.position.set(0, (b.h + BUILDING_EXTRA_DEPTH) / 2 - BUILDING_EXTRA_DEPTH, 0);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // Lobby: taller ground floor, different material
  const lobbyH = b.floorHeight * 1.5;
  const lobbyGeo = new THREE.BoxGeometry(b.w + 0.1, lobbyH, b.d + 0.1);
  const lobby = new THREE.Mesh(lobbyGeo, materials.lobby);
  lobby.position.set(0, lobbyH / 2, 0);
  group.add(lobby);

  // Windows on front/back (skip lobby floor)
  for (const sign of [1, -1]) {
    makeWindowGrid(b.w, b.floors, b.floorHeight, sign, 'z', b.d / 2 + 0.05, 1)
      .forEach(m => { m.position.y += lobbyH; group.add(m); });
  }

  // Rooftop
  if (b.h > 30) {
    group.add(makeRooftopAccessory('antenna', b.w, b.d, b.h));
  }

  addDoor(group, b);
  return group;
}

function downtownSteppedTower(b) {
  const group = new THREE.Group();
  const palette = materials.district.downtown_office;
  const mat = palette[b.colorIdx % palette.length];

  // Lower section (full width)
  const setbackFloor = Math.floor(b.floors * 0.65);
  const lowerH = setbackFloor * b.floorHeight;
  const lowerGeo = new THREE.BoxGeometry(b.w, lowerH + BUILDING_EXTRA_DEPTH, b.d);
  const lower = new THREE.Mesh(lowerGeo, mat);
  lower.position.set(0, (lowerH + BUILDING_EXTRA_DEPTH) / 2 - BUILDING_EXTRA_DEPTH, 0);
  lower.castShadow = true;
  lower.receiveShadow = true;
  group.add(lower);

  // Upper section (narrower)
  const upperW = b.w * 0.65;
  const upperD = b.d * 0.65;
  const upperH = (b.floors - setbackFloor) * b.floorHeight;
  const upperGeo = new THREE.BoxGeometry(upperW, upperH, upperD);
  const accentMat = palette[(b.colorIdx + 1) % palette.length];
  const upper = new THREE.Mesh(upperGeo, accentMat);
  upper.position.set(0, lowerH + upperH / 2, 0);
  upper.castShadow = true;
  group.add(upper);

  // Windows on lower section
  for (const sign of [1, -1]) {
    makeWindowGrid(b.w, setbackFloor, b.floorHeight, sign, 'z', b.d / 2 + 0.05)
      .forEach(m => group.add(m));
  }
  // Windows on upper section
  for (const sign of [1, -1]) {
    makeWindowGrid(upperW, b.floors - setbackFloor, b.floorHeight, sign, 'z', upperD / 2 + 0.05)
      .forEach(m => { m.position.y += lowerH; group.add(m); });
  }

  if (b.h > 25) {
    group.add(makeRooftopAccessory('antenna', upperW, upperD, b.h));
  }

  addDoor(group, b);
  return group;
}

// ============================================================
// HIGHRISE RESIDENTIAL TEMPLATES
// ============================================================

function highriseApartmentBlock(b) {
  const group = new THREE.Group();
  const palette = materials.district.highrise_residential;
  const mat = palette[b.colorIdx % palette.length];

  const bodyGeo = new THREE.BoxGeometry(b.w, b.h + BUILDING_EXTRA_DEPTH, b.d);
  const body = new THREE.Mesh(bodyGeo, mat);
  body.position.set(0, (b.h + BUILDING_EXTRA_DEPTH) / 2 - BUILDING_EXTRA_DEPTH, 0);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // Windows with balconies on every other floor
  for (const sign of [1, -1]) {
    const windows = makeWindowGrid(b.w, b.floors, b.floorHeight, sign, 'z', b.d / 2 + 0.05);
    windows.forEach(m => group.add(m));
  }

  // Balconies on front face, every other floor
  const balconiesPerFloor = Math.max(1, Math.floor(b.w / 6));
  for (let f = 1; f < b.floors; f += 2) {
    for (let i = 0; i < balconiesPerFloor; i++) {
      const bx = (i - (balconiesPerFloor - 1) / 2) * (b.w / (balconiesPerFloor + 0.5));
      const balcony = new THREE.Mesh(sharedGeo.balcony, materials.pole);
      balcony.position.set(bx, f * b.floorHeight, b.d / 2 + 0.5);
      group.add(balcony);
    }
  }

  // Flat roof railing
  const railGeo = new THREE.BoxGeometry(b.w + 0.2, 0.6, 0.15);
  for (const sign of [1, -1]) {
    const rail = new THREE.Mesh(railGeo, materials.pole);
    rail.position.set(0, b.h + 0.3, sign * b.d / 2);
    group.add(rail);
  }

  // Rooftop accessory
  if (b.seed % 3 === 0) {
    group.add(makeRooftopAccessory('water_tower', b.w, b.d, b.h));
  } else if (b.seed % 3 === 1) {
    group.add(makeRooftopAccessory('ac', b.w, b.d, b.h));
  }

  addDoor(group, b);
  return group;
}

function highriseLShape(b) {
  const group = new THREE.Group();
  const palette = materials.district.highrise_residential;
  const mat = palette[b.colorIdx % palette.length];

  // Main wing
  const mainW = b.w;
  const mainD = b.d * 0.5;
  const bodyGeo = new THREE.BoxGeometry(mainW, b.h + BUILDING_EXTRA_DEPTH, mainD);
  const body = new THREE.Mesh(bodyGeo, mat);
  body.position.set(0, (b.h + BUILDING_EXTRA_DEPTH) / 2 - BUILDING_EXTRA_DEPTH, -b.d / 2 + mainD / 2);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // Side wing
  const sideW = b.w * 0.5;
  const sideD = b.d * 0.55;
  const sideGeo = new THREE.BoxGeometry(sideW, b.h + BUILDING_EXTRA_DEPTH, sideD);
  const side = new THREE.Mesh(sideGeo, mat);
  side.position.set(-b.w / 2 + sideW / 2, (b.h + BUILDING_EXTRA_DEPTH) / 2 - BUILDING_EXTRA_DEPTH, b.d / 2 - sideD / 2);
  side.castShadow = true;
  side.receiveShadow = true;
  group.add(side);

  // Windows on main wing front
  makeWindowGrid(mainW, b.floors, b.floorHeight, -1, 'z', (b.d / 2 - mainD) - 0.05)
    .forEach(m => group.add(m));
  // Windows on side wing front
  makeWindowGrid(sideW, b.floors, b.floorHeight, 1, 'z', b.d / 2 + 0.05)
    .forEach(m => { m.position.x += -b.w / 2 + sideW / 2; group.add(m); });

  addDoor(group, b);
  return group;
}

// ============================================================
// SHOPPING STREET TEMPLATES
// ============================================================

function shopRow(b) {
  const group = new THREE.Group();
  const palette = materials.district.shopping_street;
  const mat = palette[b.colorIdx % palette.length];

  // Main body
  const bodyGeo = new THREE.BoxGeometry(b.w, b.h + BUILDING_EXTRA_DEPTH, b.d);
  const body = new THREE.Mesh(bodyGeo, mat);
  body.position.set(0, (b.h + BUILDING_EXTRA_DEPTH) / 2 - BUILDING_EXTRA_DEPTH, 0);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // Shop front: large bright window on ground floor
  const shopW = b.w * 0.7;
  const shopH = b.floorHeight * 0.7;
  const shopGeo = new THREE.PlaneGeometry(shopW, shopH);
  const shopMat = materials.shopfront[b.accentColorIdx % materials.shopfront.length];
  const shop = new THREE.Mesh(shopGeo, shopMat);
  shop.position.set(0, shopH / 2 + 0.3, b.d / 2 + 0.06);
  group.add(shop);

  // Awning above shopfront
  const awningW = b.w * 0.85;
  const awningGeo = new THREE.PlaneGeometry(awningW, 1.8);
  const awningMat = materials.awning[b.accentColorIdx % materials.awning.length];
  const awning = new THREE.Mesh(awningGeo, awningMat);
  awning.position.set(0, b.floorHeight + 0.2, b.d / 2 + 0.9);
  awning.rotation.x = -0.3;
  group.add(awning);

  // Upper floor windows
  if (b.floors > 1) {
    makeWindowGrid(b.w, b.floors - 1, b.floorHeight, 1, 'z', b.d / 2 + 0.05, 0)
      .forEach(m => { m.position.y += b.floorHeight; group.add(m); });
  }

  addDoor(group, b);
  return group;
}

function cornerShop(b) {
  const group = new THREE.Group();
  const palette = materials.district.shopping_street;
  const mat = palette[b.colorIdx % palette.length];

  // Slightly taller body
  const bodyGeo = new THREE.BoxGeometry(b.w, b.h + BUILDING_EXTRA_DEPTH, b.d);
  const body = new THREE.Mesh(bodyGeo, mat);
  body.position.set(0, (b.h + BUILDING_EXTRA_DEPTH) / 2 - BUILDING_EXTRA_DEPTH, 0);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // Awnings on two faces
  const awningMat = materials.awning[b.accentColorIdx % materials.awning.length];
  for (const [axis, sign, w] of [['z', 1, b.w], ['x', 1, b.d]]) {
    const awningGeo = new THREE.PlaneGeometry(w * 0.85, 1.8);
    const awning = new THREE.Mesh(awningGeo, awningMat);
    if (axis === 'z') {
      awning.position.set(0, b.floorHeight + 0.2, b.d / 2 + 0.9);
      awning.rotation.x = -0.3;
    } else {
      awning.position.set(b.w / 2 + 0.9, b.floorHeight + 0.2, 0);
      awning.rotation.x = -0.3;
      awning.rotation.y = -Math.PI / 2;
    }
    group.add(awning);
  }

  // Shopfronts on two faces
  const shopMat = materials.shopfront[b.accentColorIdx % materials.shopfront.length];
  const shopH = b.floorHeight * 0.7;
  const shopFront = new THREE.Mesh(new THREE.PlaneGeometry(b.w * 0.7, shopH), shopMat);
  shopFront.position.set(0, shopH / 2 + 0.3, b.d / 2 + 0.06);
  group.add(shopFront);
  const shopSide = new THREE.Mesh(new THREE.PlaneGeometry(b.d * 0.7, shopH), shopMat);
  shopSide.position.set(b.w / 2 + 0.06, shopH / 2 + 0.3, 0);
  shopSide.rotation.y = -Math.PI / 2;
  group.add(shopSide);

  // Upper windows
  if (b.floors > 1) {
    for (const sign of [1]) {
      makeWindowGrid(b.w, b.floors - 1, b.floorHeight, sign, 'z', b.d / 2 + 0.05, 0)
        .forEach(m => { m.position.y += b.floorHeight; group.add(m); });
    }
  }

  addDoor(group, b);
  return group;
}

// ============================================================
// MARKET TEMPLATES
// ============================================================

function marketStall(b) {
  const group = new THREE.Group();

  // 4 corner poles
  const halfW = b.w / 2 - 0.2;
  const halfD = b.d / 2 - 0.2;
  const poleH = b.h;
  for (const [px, pz] of [[halfW, halfD], [-halfW, halfD], [halfW, -halfD], [-halfW, -halfD]]) {
    const poleGeo = new THREE.CylinderGeometry(0.08, 0.08, poleH, 4);
    const pole = new THREE.Mesh(poleGeo, materials.pole);
    pole.position.set(px, poleH / 2, pz);
    group.add(pole);
  }

  // Canopy (tilted slightly)
  const canopyMat = materials.canopy[b.colorIdx % materials.canopy.length];
  const canopyGeo = new THREE.PlaneGeometry(b.w + 0.5, b.d + 0.5);
  const canopy = new THREE.Mesh(canopyGeo, canopyMat);
  canopy.position.set(0, poleH + 0.05, 0);
  canopy.rotation.x = -Math.PI / 2 + 0.08;
  group.add(canopy);

  addDoor(group, b);
  return group;
}

function marketHall(b) {
  const group = new THREE.Group();
  const palette = materials.district.market || materials.district.shopping_street;
  const mat = palette[b.colorIdx % palette.length];

  // Main structure
  const bodyGeo = new THREE.BoxGeometry(b.w, b.h + BUILDING_EXTRA_DEPTH, b.d);
  const body = new THREE.Mesh(bodyGeo, mat);
  body.position.set(0, (b.h + BUILDING_EXTRA_DEPTH) / 2 - BUILDING_EXTRA_DEPTH, 0);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // Large door openings (dark recessed planes)
  const doorW = b.w * 0.3;
  const doorH = b.h * 0.6;
  const doorGeo = new THREE.PlaneGeometry(doorW, doorH);
  const darkMat = materials.lobby;
  const opening = new THREE.Mesh(doorGeo, darkMat);
  opening.position.set(0, doorH / 2, b.d / 2 + 0.06);
  group.add(opening);

  addDoor(group, b);
  return group;
}

// ============================================================
// SUBURBAN HOUSE TEMPLATES
// ============================================================

function detachedHouse(b) {
  const group = new THREE.Group();
  const palette = materials.district.suburban_houses;
  const mat = palette[b.colorIdx % palette.length];

  // Main body
  const wallH = b.floors * b.floorHeight;
  const bodyGeo = new THREE.BoxGeometry(b.w, wallH + BUILDING_EXTRA_DEPTH, b.d);
  const body = new THREE.Mesh(bodyGeo, mat);
  body.position.set(0, (wallH + BUILDING_EXTRA_DEPTH) / 2 - BUILDING_EXTRA_DEPTH, 0);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // Pitched roof
  const roofPeak = 2.5 + b.seed % 2;
  const roof = makePitchedRoof(b.w + 0.6, b.d + 0.6, roofPeak, b.accentColorIdx);
  roof.position.set(0, wallH, 0);
  group.add(roof);

  // Windows (small, 2-4 per floor)
  for (const sign of [1, -1]) {
    const winsPerFloor = Math.max(2, Math.floor(b.w / 4));
    for (let f = 0; f < b.floors; f++) {
      for (let i = 0; i < winsPerFloor; i++) {
        const winGeo = new THREE.PlaneGeometry(1.2, 1.4);
        const win = new THREE.Mesh(winGeo, materials.window);
        const wx = (i - (winsPerFloor - 1) / 2) * (b.w / (winsPerFloor + 1));
        win.position.set(wx, f * b.floorHeight + b.floorHeight * 0.6, sign * (b.d / 2 + 0.05));
        if (sign === -1) win.rotation.y = Math.PI;
        group.add(win);
      }
    }
  }

  // h is set to wallH + roofPeak for the building data, but template uses wallH for body
  addDoor(group, b);
  return group;
}

function terracedHouses(b) {
  const group = new THREE.Group();
  const palette = materials.district.suburban_houses;
  const numUnits = 3 + (b.seed % 3); // 3-5 units
  const unitW = b.w / numUnits;

  for (let u = 0; u < numUnits; u++) {
    const unitMat = palette[(b.colorIdx + u) % palette.length];
    const unitX = (u - (numUnits - 1) / 2) * unitW;
    const unitH = b.floors * b.floorHeight + (b.seed + u) % 2; // slight height variation

    // Unit body
    const bodyGeo = new THREE.BoxGeometry(unitW - 0.2, unitH + BUILDING_EXTRA_DEPTH, b.d);
    const body = new THREE.Mesh(bodyGeo, unitMat);
    body.position.set(unitX, (unitH + BUILDING_EXTRA_DEPTH) / 2 - BUILDING_EXTRA_DEPTH, 0);
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    // Per-unit door
    const doorMat = materials.door[(b.seed + u) % materials.door.length];
    const door = new THREE.Mesh(sharedGeo.door, doorMat);
    door.position.set(unitX, 1.1, b.d / 2 + 0.06);
    group.add(door);

    // Per-unit window
    const winGeo = new THREE.PlaneGeometry(1.2, 1.4);
    for (let f = 0; f < b.floors; f++) {
      const win = new THREE.Mesh(winGeo, materials.window);
      win.position.set(unitX, f * b.floorHeight + b.floorHeight * 0.6, b.d / 2 + 0.05);
      group.add(win);
    }
  }

  // Shared pitched roof
  const roofPeak = 2;
  const roof = makePitchedRoof(b.w + 0.4, b.d + 0.4, roofPeak, b.accentColorIdx);
  roof.position.set(0, b.floors * b.floorHeight + 0.5, 0);
  group.add(roof);

  return group; // doors already added per unit, skip addDoor
}

// ============================================================
// INDUSTRIAL TEMPLATES
// ============================================================

function warehouse(b) {
  const group = new THREE.Group();
  const palette = materials.district.industrial;
  const mat = palette[b.colorIdx % palette.length];

  // Main body
  const bodyGeo = new THREE.BoxGeometry(b.w, b.h + BUILDING_EXTRA_DEPTH, b.d);
  const body = new THREE.Mesh(bodyGeo, mat);
  body.position.set(0, (b.h + BUILDING_EXTRA_DEPTH) / 2 - BUILDING_EXTRA_DEPTH, 0);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // Loading dock: recessed dark area on one face
  const dockW = b.w * 0.4;
  const dockH = b.h * 0.5;
  const dockGeo = new THREE.PlaneGeometry(dockW, dockH);
  const dock = new THREE.Mesh(dockGeo, materials.lobby);
  dock.position.set(b.w * 0.15, dockH / 2, b.d / 2 + 0.06);
  group.add(dock);

  // Rooftop AC
  group.add(makeRooftopAccessory('ac', b.w, b.d, b.h));

  addDoor(group, b);
  return group;
}

function factory(b) {
  const group = new THREE.Group();
  const palette = materials.district.industrial;
  const mat = palette[b.colorIdx % palette.length];

  // Main body
  const bodyGeo = new THREE.BoxGeometry(b.w, b.h + BUILDING_EXTRA_DEPTH, b.d);
  const body = new THREE.Mesh(bodyGeo, mat);
  body.position.set(0, (b.h + BUILDING_EXTRA_DEPTH) / 2 - BUILDING_EXTRA_DEPTH, 0);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // Sawtooth roof: repeating triangular prisms using direct vertex geometry
  const sawteethCount = Math.max(2, Math.floor(b.w / 6));
  const toothW = b.w / sawteethCount;
  const toothH = 2;
  const hd = b.d / 2;
  for (let i = 0; i < sawteethCount; i++) {
    const tx = (i - (sawteethCount - 1) / 2) * toothW;
    const x0 = tx - toothW / 2;
    const x1 = tx + toothW / 2;
    // Vertical face (left) + slope face (right) + two triangle ends
    const verts = new Float32Array([
      x0, b.h, -hd,          // 0: bottom-left-back
      x0, b.h, hd,           // 1: bottom-left-front
      x0, b.h + toothH, -hd, // 2: top-left-back
      x0, b.h + toothH, hd,  // 3: top-left-front
      x1, b.h, -hd,          // 4: bottom-right-back
      x1, b.h, hd,           // 5: bottom-right-front
    ]);
    const idx = [
      0, 2, 1, 1, 2, 3, // vertical left face
      2, 4, 3, 3, 4, 5, // slope face
      0, 4, 2,          // back triangle
      1, 3, 5,          // front triangle
    ];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const tooth = new THREE.Mesh(geo, mat);
    group.add(tooth);
  }

  // Smokestack
  group.add(makeRooftopAccessory('smokestack', b.w, b.d, b.h));

  addDoor(group, b);
  return group;
}

// ============================================================
// DISPATCH MAP
// ============================================================

export const DISTRICT_TEMPLATES = {
  downtown_office:        [downtownGlassTower, downtownSteppedTower],
  highrise_residential:   [highriseApartmentBlock, highriseLShape],
  shopping_street:        [shopRow, cornerShop],
  market:                 [marketStall, marketHall],
  suburban_houses:        [detachedHouse, terracedHouses],
  industrial:             [warehouse, factory],
};
