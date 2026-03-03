import * as THREE from 'three';
import { materials, sharedGeo } from './materials.js';

const EXTRA_DEPTH = 2;

// ============================================================
// GEOMETRY HELPERS
// ============================================================

/** Build a quad from 4 explicit vertices. Returns a DoubleSide mesh. */
function quad(verts, indices, mat) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(verts), 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const m = mat.clone();
  m.side = THREE.DoubleSide;
  return new THREE.Mesh(geo, m);
}

/** Build a triangle from 3 explicit vertices. Returns a DoubleSide mesh. */
function tri(verts, indices, mat) {
  return quad(verts, indices, mat); // same implementation, different semantic name
}

/** Pitched roof: two slope quads + two gable triangles. */
export function makePitchedRoof(width, depth, peakHeight, roofColorIdx) {
  const group = new THREE.Group();
  const mat = materials.roof[roofColorIdx % materials.roof.length];
  const hw = width / 2, hd = depth / 2;

  for (const side of [-1, 1]) {
    group.add(quad(
      [side * hw, 0, -hd, side * hw, 0, hd, 0, peakHeight, -hd, 0, peakHeight, hd],
      side === -1 ? [0, 2, 1, 1, 2, 3] : [0, 1, 2, 1, 3, 2], mat
    )).castShadow = true;
  }
  for (const side of [-1, 1]) {
    group.add(tri(
      [-hw, 0, side * hd, hw, 0, side * hd, 0, peakHeight, side * hd],
      side === 1 ? [0, 1, 2] : [0, 2, 1], mat
    )).castShadow = true;
  }
  return group;
}

/** Awning: sloped quad extending outward from a wall along +Z. */
function awningZ(x0, x1, yTop, drop, zWall, depth, mat) {
  return quad(
    [x0, yTop, zWall, x1, yTop, zWall, x0, yTop - drop, zWall + depth, x1, yTop - drop, zWall + depth],
    [0, 2, 1, 1, 2, 3], mat
  );
}

/** Awning: sloped quad extending outward from a wall along +X. */
function awningX(z0, z1, yTop, drop, xWall, depth, mat) {
  return quad(
    [xWall, yTop, z0, xWall, yTop, z1, xWall + depth, yTop - drop, z0, xWall + depth, yTop - drop, z1],
    [0, 2, 1, 1, 2, 3], mat
  );
}

/** Rooftop accessory (antenna, AC, water tower, smokestack). */
function rooftopAccessory(type, bw, bd, bh) {
  const g = new THREE.Group();
  if (type === 'antenna') {
    const m = new THREE.Mesh(sharedGeo.antenna, materials.antenna);
    m.position.set(0, bh + 4, 0);
    g.add(m);
  } else if (type === 'ac') {
    const m = new THREE.Mesh(sharedGeo.ac, materials.ac);
    m.position.set(bw * 0.2, bh + 1, bd * 0.2);
    g.add(m);
  } else if (type === 'water_tower') {
    const tank = new THREE.Mesh(sharedGeo.waterTower, materials.ac);
    tank.position.set(bw * 0.25, bh + 4, bd * 0.25);
    g.add(tank);
    for (const ox of [-0.6, 0.6])
      for (const oz of [-0.6, 0.6]) {
        const leg = new THREE.Mesh(sharedGeo.waterTowerLegs, materials.pole);
        leg.position.set(bw * 0.25 + ox, bh + 1.5, bd * 0.25 + oz);
        g.add(leg);
      }
  } else if (type === 'smokestack') {
    const m = new THREE.Mesh(sharedGeo.smokestack, materials.pole);
    m.position.set(bw * 0.3, bh + 6, bd * 0.3);
    g.add(m);
  }
  return g;
}

// ============================================================
// BASE TEMPLATE CLASS
// ============================================================

class BuildingTemplate {
  /** @param {string} districtKey — key into materials.district */
  constructor(districtKey) {
    this.districtKey = districtKey;
  }

  palette() { return materials.district[this.districtKey]; }
  mat(b) { return this.palette()[b.colorIdx % this.palette().length]; }

  /** Create body box embedded into ground. Returns the mesh. */
  body(group, b, w, h, d, mat, x = 0, z = 0) {
    const geo = new THREE.BoxGeometry(w, h + EXTRA_DEPTH, d);
    const mesh = new THREE.Mesh(geo, mat || this.mat(b));
    mesh.position.set(x, (h + EXTRA_DEPTH) / 2 - EXTRA_DEPTH, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  }

  /** Add windows on front+back (±Z faces). */
  windows(group, b, width, floors, floorHeight, depthHalf, startFloor = 0, yOffset = 0) {
    const count = Math.max(1, Math.floor(width / 5));
    for (let f = startFloor; f < floors; f++) {
      for (let w = 0; w < count; w++) {
        const wy = f * floorHeight + floorHeight * 0.65 + yOffset;
        const wx = (w - (count - 1) / 2) * (width / (count + 0.5));
        for (const sign of [1, -1]) {
          const win = new THREE.Mesh(sharedGeo.windowPane, materials.window);
          win.position.set(wx, wy, sign * (depthHalf + 0.05));
          if (sign === -1) win.rotation.y = Math.PI;
          group.add(win);
        }
      }
    }
  }

  /** Add a door. */
  door(group, b) {
    const doorMat = materials.door[b.seed % materials.door.length];
    const door = new THREE.Mesh(sharedGeo.door, doorMat);
    const y = 1.1;
    const faces = [
      [0, y, b.d / 2 + 0.06, 0],
      [0, y, -(b.d / 2 + 0.06), Math.PI],
      [b.w / 2 + 0.06, y, 0, -Math.PI / 2],
      [-(b.w / 2 + 0.06), y, 0, Math.PI / 2],
    ];
    const [dx, dy, dz, ry] = faces[b.doorFace] || faces[0];
    door.position.set(dx, dy, dz);
    door.rotation.y = ry;
    group.add(door);
  }

  /** Override in subclass to add features. Return the group. */
  build(b) {
    const group = new THREE.Group();
    this.body(group, b, b.w, b.h, b.d);
    this.decorate(group, b);
    this.door(group, b);
    return group;
  }

  decorate(group, b) {} // override
}

// For export compatibility with builders.js
export function addDoor(group, b) {
  const t = new BuildingTemplate('downtown_office');
  t.door(group, b);
}

// ============================================================
// DOWNTOWN OFFICE
// ============================================================

class GlassTower extends BuildingTemplate {
  constructor() { super('downtown_office'); }

  build(b) {
    const group = new THREE.Group();
    this.body(group, b, b.w, b.h, b.d);

    // Lobby overlay
    const lobbyH = b.floorHeight * 1.5;
    const lobbyGeo = new THREE.BoxGeometry(b.w + 0.1, lobbyH, b.d + 0.1);
    const lobby = new THREE.Mesh(lobbyGeo, materials.lobby);
    lobby.position.set(0, lobbyH / 2, 0);
    group.add(lobby);

    // Windows (skip lobby floor)
    this.windows(group, b, b.w, b.floors, b.floorHeight, b.d / 2, 1, lobbyH);

    if (b.h > 30) group.add(rooftopAccessory('antenna', b.w, b.d, b.h));
    this.door(group, b);
    return group;
  }
}

class SteppedTower extends BuildingTemplate {
  constructor() { super('downtown_office'); }

  build(b) {
    const group = new THREE.Group();
    const setbackFloor = Math.floor(b.floors * 0.65);
    const lowerH = setbackFloor * b.floorHeight;
    const upperW = b.w * 0.65, upperD = b.d * 0.65;
    const upperH = (b.floors - setbackFloor) * b.floorHeight;

    this.body(group, b, b.w, lowerH, b.d);
    const accentMat = this.palette()[(b.colorIdx + 1) % this.palette().length];
    this.body(group, b, upperW, upperH, upperD, accentMat).position.set(0, lowerH + upperH / 2, 0);

    this.windows(group, b, b.w, setbackFloor, b.floorHeight, b.d / 2);
    this.windows(group, b, upperW, b.floors - setbackFloor, b.floorHeight, upperD / 2, 0, lowerH);

    if (b.h > 25) group.add(rooftopAccessory('antenna', upperW, upperD, b.h));
    this.door(group, b);
    return group;
  }
}

// ============================================================
// HIGHRISE RESIDENTIAL
// ============================================================

class ApartmentBlock extends BuildingTemplate {
  constructor() { super('highrise_residential'); }

  decorate(group, b) {
    this.windows(group, b, b.w, b.floors, b.floorHeight, b.d / 2);

    // Balconies every other floor
    const bpf = Math.max(1, Math.floor(b.w / 6));
    for (let f = 1; f < b.floors; f += 2)
      for (let i = 0; i < bpf; i++) {
        const bx = (i - (bpf - 1) / 2) * (b.w / (bpf + 0.5));
        const bal = new THREE.Mesh(sharedGeo.balcony, materials.pole);
        bal.position.set(bx, f * b.floorHeight, b.d / 2 + 0.5);
        group.add(bal);
      }

    // Roof railing
    const railGeo = new THREE.BoxGeometry(b.w + 0.2, 0.6, 0.15);
    for (const s of [1, -1]) {
      const rail = new THREE.Mesh(railGeo, materials.pole);
      rail.position.set(0, b.h + 0.3, s * b.d / 2);
      group.add(rail);
    }

    if (b.seed % 3 === 0) group.add(rooftopAccessory('water_tower', b.w, b.d, b.h));
    else if (b.seed % 3 === 1) group.add(rooftopAccessory('ac', b.w, b.d, b.h));
  }
}

class LShapeBlock extends BuildingTemplate {
  constructor() { super('highrise_residential'); }

  build(b) {
    const group = new THREE.Group();
    const mainD = b.d * 0.5;
    const sideW = b.w * 0.5, sideD = b.d * 0.55;

    this.body(group, b, b.w, b.h, mainD).position.z = -b.d / 2 + mainD / 2;
    this.body(group, b, sideW, b.h, sideD).position.x = -b.w / 2 + sideW / 2;
    group.children[1].position.z = b.d / 2 - sideD / 2;

    // Windows on visible faces
    const count = Math.max(1, Math.floor(b.w / 5));
    for (let f = 0; f < b.floors; f++)
      for (let w = 0; w < count; w++) {
        const wy = f * b.floorHeight + b.floorHeight * 0.65;
        const wx = (w - (count - 1) / 2) * (b.w / (count + 0.5));
        const win = new THREE.Mesh(sharedGeo.windowPane, materials.window);
        win.position.set(wx, wy, -(b.d / 2 - mainD) - 0.05);
        win.rotation.y = Math.PI;
        group.add(win);
      }

    this.door(group, b);
    return group;
  }
}

// ============================================================
// SHOPPING STREET
// ============================================================

class ShopRow extends BuildingTemplate {
  constructor() { super('shopping_street'); }

  decorate(group, b) {
    // Shopfront window
    const shopH = b.floorHeight * 0.7;
    const shopMat = materials.shopfront[b.accentColorIdx % materials.shopfront.length];
    const shop = new THREE.Mesh(new THREE.PlaneGeometry(b.w * 0.7, shopH), shopMat);
    shop.position.set(0, shopH / 2 + 0.3, b.d / 2 + 0.06);
    group.add(shop);

    // Awning
    const aMat = materials.awning[b.accentColorIdx % materials.awning.length];
    const aw = b.w * 0.85;
    group.add(awningZ(-aw / 2, aw / 2, b.floorHeight + 0.2, 0.4, b.d / 2 + 0.02, 1.5, aMat));

    // Upper windows
    if (b.floors > 1)
      this.windows(group, b, b.w, b.floors - 1, b.floorHeight, b.d / 2, 0, b.floorHeight);
  }
}

class CornerShop extends BuildingTemplate {
  constructor() { super('shopping_street'); }

  decorate(group, b) {
    const aMat = materials.awning[b.accentColorIdx % materials.awning.length];
    const aTop = b.floorHeight + 0.2;

    // Awnings on +Z and +X faces
    group.add(awningZ(-b.w * 0.42, b.w * 0.42, aTop, 0.4, b.d / 2 + 0.02, 1.5, aMat));
    group.add(awningX(-b.d * 0.42, b.d * 0.42, aTop, 0.4, b.w / 2 + 0.02, 1.5, aMat));

    // Shopfronts
    const shopMat = materials.shopfront[b.accentColorIdx % materials.shopfront.length];
    const shopH = b.floorHeight * 0.7;
    const front = new THREE.Mesh(new THREE.PlaneGeometry(b.w * 0.7, shopH), shopMat);
    front.position.set(0, shopH / 2 + 0.3, b.d / 2 + 0.06);
    group.add(front);
    const side = new THREE.Mesh(new THREE.PlaneGeometry(b.d * 0.7, shopH), shopMat);
    side.position.set(b.w / 2 + 0.06, shopH / 2 + 0.3, 0);
    side.rotation.y = -Math.PI / 2;
    group.add(side);

    // Upper windows
    if (b.floors > 1)
      this.windows(group, b, b.w, b.floors - 1, b.floorHeight, b.d / 2, 0, b.floorHeight);
  }
}

// ============================================================
// MARKET
// ============================================================

class MarketStall extends BuildingTemplate {
  constructor() { super('market'); }

  build(b) {
    const group = new THREE.Group();
    const hw = b.w / 2 - 0.2, hd = b.d / 2 - 0.2;

    // Corner poles
    for (const [px, pz] of [[hw, hd], [-hw, hd], [hw, -hd], [-hw, -hd]]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, b.h, 4), materials.pole);
      pole.position.set(px, b.h / 2, pz);
      group.add(pole);
    }

    // Canopy (nearly horizontal plane — single-axis rotation is safe)
    const cMat = materials.canopy[b.colorIdx % materials.canopy.length];
    const canopy = new THREE.Mesh(new THREE.PlaneGeometry(b.w + 0.5, b.d + 0.5), cMat);
    canopy.position.set(0, b.h + 0.05, 0);
    canopy.rotation.x = -Math.PI / 2 + 0.08;
    group.add(canopy);

    this.door(group, b);
    return group;
  }
}

class MarketHall extends BuildingTemplate {
  constructor() { super('market'); }

  decorate(group, b) {
    // Large door opening (dark recessed plane)
    const doorW = b.w * 0.3, doorH = b.h * 0.6;
    const opening = new THREE.Mesh(new THREE.PlaneGeometry(doorW, doorH), materials.lobby);
    opening.position.set(0, doorH / 2, b.d / 2 + 0.06);
    group.add(opening);
  }
}

// ============================================================
// SUBURBAN HOUSES
// ============================================================

class DetachedHouse extends BuildingTemplate {
  constructor() { super('suburban_houses'); }

  build(b) {
    const group = new THREE.Group();
    const wallH = b.floors * b.floorHeight;
    this.body(group, b, b.w, wallH, b.d);

    // Pitched roof
    const roof = makePitchedRoof(b.w + 0.6, b.d + 0.6, 2.5 + b.seed % 2, b.accentColorIdx);
    roof.position.y = wallH;
    group.add(roof);

    // Small windows
    const winsPerFloor = Math.max(2, Math.floor(b.w / 4));
    for (const sign of [1, -1])
      for (let f = 0; f < b.floors; f++)
        for (let i = 0; i < winsPerFloor; i++) {
          const win = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.4), materials.window);
          const wx = (i - (winsPerFloor - 1) / 2) * (b.w / (winsPerFloor + 1));
          win.position.set(wx, f * b.floorHeight + b.floorHeight * 0.6, sign * (b.d / 2 + 0.05));
          if (sign === -1) win.rotation.y = Math.PI;
          group.add(win);
        }

    this.door(group, b);
    return group;
  }
}

class TerracedRow extends BuildingTemplate {
  constructor() { super('suburban_houses'); }

  build(b) {
    const group = new THREE.Group();
    const numUnits = 3 + (b.seed % 3);
    const unitW = b.w / numUnits;
    const wallH = b.floors * b.floorHeight;

    for (let u = 0; u < numUnits; u++) {
      const unitMat = this.palette()[(b.colorIdx + u) % this.palette().length];
      const unitX = (u - (numUnits - 1) / 2) * unitW;

      // All units same height so the shared roof sits flush
      this.body(group, b, unitW - 0.2, wallH, b.d, unitMat, unitX);

      // Per-unit door
      const doorMat = materials.door[(b.seed + u) % materials.door.length];
      const door = new THREE.Mesh(sharedGeo.door, doorMat);
      door.position.set(unitX, 1.1, b.d / 2 + 0.06);
      group.add(door);

      // Per-unit window
      for (let f = 0; f < b.floors; f++) {
        const win = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.4), materials.window);
        win.position.set(unitX, f * b.floorHeight + b.floorHeight * 0.6, b.d / 2 + 0.05);
        group.add(win);
      }
    }

    // Shared roof flush on top of uniform wall height
    const roof = makePitchedRoof(b.w + 0.4, b.d + 0.4, 2, b.accentColorIdx);
    roof.position.y = wallH;
    group.add(roof);

    return group; // doors already added per unit
  }
}

// ============================================================
// INDUSTRIAL
// ============================================================

class Warehouse extends BuildingTemplate {
  constructor() { super('industrial'); }

  decorate(group, b) {
    // Loading dock
    const dockW = b.w * 0.4, dockH = b.h * 0.5;
    const dock = new THREE.Mesh(new THREE.PlaneGeometry(dockW, dockH), materials.lobby);
    dock.position.set(b.w * 0.15, dockH / 2, b.d / 2 + 0.06);
    group.add(dock);

    group.add(rooftopAccessory('ac', b.w, b.d, b.h));
  }
}

class Factory extends BuildingTemplate {
  constructor() { super('industrial'); }

  decorate(group, b) {
    // Sawtooth roof
    const count = Math.max(2, Math.floor(b.w / 6));
    const tw = b.w / count, th = 2, hd = b.d / 2;
    const mat = this.mat(b);

    for (let i = 0; i < count; i++) {
      const tx = (i - (count - 1) / 2) * tw;
      const x0 = tx - tw / 2, x1 = tx + tw / 2;
      group.add(quad(
        [x0, b.h, -hd, x0, b.h, hd, x0, b.h + th, -hd, x0, b.h + th, hd],
        [0, 2, 1, 1, 2, 3], mat
      )); // vertical face
      group.add(quad(
        [x0, b.h + th, -hd, x0, b.h + th, hd, x1, b.h, -hd, x1, b.h, hd],
        [0, 2, 1, 1, 2, 3], mat
      )); // slope face
      group.add(tri([x0, b.h, -hd, x1, b.h, -hd, x0, b.h + th, -hd], [0, 1, 2], mat)); // back
      group.add(tri([x0, b.h, hd, x1, b.h, hd, x0, b.h + th, hd], [0, 2, 1], mat));     // front
    }

    group.add(rooftopAccessory('smokestack', b.w, b.d, b.h));
  }
}

// ============================================================
// DISPATCH MAP
// ============================================================

const templates = {
  downtown_office:        [new GlassTower(), new SteppedTower()],
  highrise_residential:   [new ApartmentBlock(), new LShapeBlock()],
  shopping_street:        [new ShopRow(), new CornerShop()],
  market:                 [new MarketStall(), new MarketHall()],
  suburban_houses:        [new DetachedHouse(), new TerracedRow()],
  industrial:             [new Warehouse(), new Factory()],
};

export const DISTRICT_TEMPLATES = {};
for (const [district, tmpls] of Object.entries(templates)) {
  DISTRICT_TEMPLATES[district] = tmpls.map(t => (b) => t.build(b));
}
