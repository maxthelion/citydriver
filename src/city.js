import { PerlinNoise } from './noise.js';
import { CITY_SIZE, BLOCK_SIZE, ROAD_WIDTH, CELL_SIZE, GRID_COUNT } from './heightmap.js';

const DISTRICT_PARAMS = {
  downtown_office:      { wRange: [8, 16],  dRange: [8, 16],  floorsRange: [8, 25], floorH: [3.5, 4.0] },
  highrise_residential: { wRange: [10, 18], dRange: [10, 18], floorsRange: [5, 15], floorH: [3.0, 3.5] },
  shopping_street:      { wRange: [10, 15], dRange: [8, 12],  floorsRange: [2, 3],  floorH: [3.5, 4.0] },
  market:               { wRange: [4, 8],   dRange: [4, 8],   floorsRange: [1, 1],  floorH: [3.0, 4.0] },
  suburban_houses:      { wRange: [8, 12],  dRange: [8, 12],  floorsRange: [1, 2],  floorH: [3.0, 3.5] },
  industrial:           { wRange: [15, 25], dRange: [15, 25], floorsRange: [1, 2],  floorH: [4.0, 5.0] },
};

const LEGACY_TYPE = {
  downtown_office:      'skyscraper',
  highrise_residential: 'residential',
  shopping_street:      'commercial',
  market:               'commercial',
  suburban_houses:      'residential',
  industrial:           'commercial',
};

const LAYOUT = {
  downtown_office:      'scatter',
  highrise_residential: 'scatter',
  shopping_street:      'edge_fill',
  market:               'grid',
  suburban_houses:      'single_plot',
  industrial:           'scatter',
};

export class CityGenerator {
  constructor(seed) {
    this.seed = seed || Math.random() * 65536;
    this.perlin = new PerlinNoise(this.seed);
  }

  seededRandom() {
    this.seed = (this.seed * 16807 + 0) % 2147483647;
    return (this.seed - 1) / 2147483646;
  }

  generate() {
    const blocks = [];
    const roads = [];
    const parks = [];
    const buildings = [];
    const halfCity = (GRID_COUNT * CELL_SIZE) / 2;

    for (let gx = 0; gx < GRID_COUNT; gx++) {
      for (let gz = 0; gz < GRID_COUNT; gz++) {
        const cx = gx * CELL_SIZE + CELL_SIZE / 2 - halfCity;
        const cz = gz * CELL_SIZE + CELL_SIZE / 2 - halfCity;
        const distFromCenter = Math.sqrt(cx * cx + cz * cz) / halfCity;

        const district = this.classifyDistrict(gx, gz, distFromCenter);

        if (district === 'park') {
          parks.push({ x: cx, z: cz, size: BLOCK_SIZE });
        } else {
          this.generateDistrictBlock(cx, cz, BLOCK_SIZE, distFromCenter, district, buildings);
        }

        blocks.push({ x: cx, z: cz, isPark: district === 'park', district, gx, gz });
      }
    }

    for (let gx = 0; gx <= GRID_COUNT; gx++) {
      const x = gx * CELL_SIZE - halfCity;
      roads.push({ x, z: -halfCity, endX: x, endZ: GRID_COUNT * CELL_SIZE - halfCity, horizontal: false });
    }
    for (let gz = 0; gz <= GRID_COUNT; gz++) {
      const z = gz * CELL_SIZE - halfCity;
      roads.push({ x: -halfCity, z, endX: GRID_COUNT * CELL_SIZE - halfCity, endZ: z, horizontal: true });
    }

    return { blocks, roads, parks, buildings };
  }

  classifyDistrict(gx, gz, distFromCenter) {
    const districtNoise = this.perlin.noise(gx * 0.25 + 50, gz * 0.25 + 50);
    const r = this.seededRandom();

    let weights;
    if (distFromCenter < 0.2) {
      weights = [['downtown_office', 0.8], ['highrise_residential', 0.2]];
    } else if (distFromCenter < 0.5) {
      weights = [['highrise_residential', 0.4], ['shopping_street', 0.3], ['park', 0.3]];
    } else if (distFromCenter < 0.8) {
      // Noise biases between shopping/suburban
      const shopBias = districtNoise > 0 ? 0.1 : -0.1;
      weights = [
        ['shopping_street', 0.25 + shopBias],
        ['suburban_houses', 0.4 - shopBias],
        ['park', 0.2],
        ['market', 0.15],
      ];
    } else {
      weights = [['suburban_houses', 0.5], ['industrial', 0.3], ['park', 0.2]];
    }

    let cumulative = 0;
    for (const [district, weight] of weights) {
      cumulative += weight;
      if (r < cumulative) return district;
    }
    return weights[weights.length - 1][0];
  }

  generateDistrictBlock(cx, cz, size, distFromCenter, district, buildings) {
    const layout = LAYOUT[district];
    switch (layout) {
      case 'scatter':
        this.layoutScatter(cx, cz, size, distFromCenter, district, buildings);
        break;
      case 'edge_fill':
        this.layoutEdgeFill(cx, cz, size, district, buildings);
        break;
      case 'grid':
        this.layoutGrid(cx, cz, size, district, buildings);
        break;
      case 'single_plot':
        this.layoutSinglePlot(cx, cz, size, district, buildings);
        break;
    }
  }

  checkOverlap(bx, bz, bw, bd, buildings) {
    for (const b of buildings) {
      if (Math.abs(b.x - bx) < (b.w + bw) / 2 + 1 &&
          Math.abs(b.z - bz) < (b.d + bd) / 2 + 1) {
        return true;
      }
    }
    return false;
  }

  makeBuildingData(bx, bz, bw, bd, district, floors, floorHeight) {
    const bh = floors * floorHeight;
    const seed = Math.floor(this.seededRandom() * 10000);
    const colorIdx = Math.floor(this.seededRandom() * 5);
    const accentColorIdx = Math.floor(this.seededRandom() * 5);
    const templateId = Math.floor(this.seededRandom() * 2);
    const doorFace = Math.floor(this.seededRandom() * 4);

    return {
      x: bx, z: bz,
      w: bw, h: bh, d: bd,
      type: LEGACY_TYPE[district],
      colorIdx,
      district,
      templateId,
      floors,
      floorHeight,
      accentColorIdx,
      doorFace,
      seed,
    };
  }

  layoutScatter(cx, cz, size, distFromCenter, district, buildings) {
    const params = DISTRICT_PARAMS[district];
    const density = Math.max(0.2, 1 - distFromCenter * 0.8);
    const numBuildings = Math.floor(density * (3 + this.seededRandom() * 4));
    const margin = 4;
    const halfBlock = size / 2 - margin;

    for (let i = 0; i < numBuildings; i++) {
      const bw = params.wRange[0] + this.seededRandom() * (params.wRange[1] - params.wRange[0]);
      const bd = params.dRange[0] + this.seededRandom() * (params.dRange[1] - params.dRange[0]);
      const floors = Math.floor(params.floorsRange[0] + this.seededRandom() * (params.floorsRange[1] - params.floorsRange[0] + 1));
      const floorH = params.floorH[0] + this.seededRandom() * (params.floorH[1] - params.floorH[0]);
      const bx = cx + (this.seededRandom() - 0.5) * (halfBlock * 2 - bw);
      const bz = cz + (this.seededRandom() - 0.5) * (halfBlock * 2 - bd);

      if (this.checkOverlap(bx, bz, bw, bd, buildings)) continue;

      const data = this.makeBuildingData(bx, bz, bw, bd, district, floors, floorH);
      // Door faces nearest block edge
      const dxToEdge = bx - cx;
      const dzToEdge = bz - cz;
      if (Math.abs(dxToEdge) > Math.abs(dzToEdge)) {
        data.doorFace = dxToEdge > 0 ? 2 : 3; // +X or -X
      } else {
        data.doorFace = dzToEdge > 0 ? 0 : 1; // +Z or -Z
      }
      buildings.push(data);
    }
  }

  layoutEdgeFill(cx, cz, size, district, buildings) {
    const params = DISTRICT_PARAMS[district];
    const halfBlock = size / 2;

    // Place buildings along +Z edge (facing road) and -Z edge
    for (const edgeSign of [1, -1]) {
      let cursor = cx - halfBlock + 2;
      const edgeEnd = cx + halfBlock - 2;

      while (cursor < edgeEnd) {
        const bw = params.wRange[0] + this.seededRandom() * (params.wRange[1] - params.wRange[0]);
        const bd = params.dRange[0] + this.seededRandom() * (params.dRange[1] - params.dRange[0]);
        const floors = Math.floor(params.floorsRange[0] + this.seededRandom() * (params.floorsRange[1] - params.floorsRange[0] + 1));
        const floorH = params.floorH[0] + this.seededRandom() * (params.floorH[1] - params.floorH[0]);

        if (cursor + bw > edgeEnd) break;

        const bx = cursor + bw / 2;
        const bz = cz + edgeSign * (halfBlock - bd / 2 - 1);

        if (this.checkOverlap(bx, bz, bw, bd, buildings)) { cursor += 3; continue; }

        const data = this.makeBuildingData(bx, bz, bw, bd, district, floors, floorH);
        data.doorFace = edgeSign > 0 ? 0 : 1; // face the road
        buildings.push(data);
        cursor += bw + 0.5; // small gap between shops
      }
    }
  }

  layoutGrid(cx, cz, size, district, buildings) {
    const params = DISTRICT_PARAMS[district];
    const halfBlock = size / 2;
    const cellSize = 10; // grid cell size for stalls
    const gridCols = Math.floor((size - 4) / cellSize);
    const gridRows = Math.floor((size - 4) / cellSize);

    for (let row = 0; row < gridRows; row++) {
      for (let col = 0; col < gridCols; col++) {
        if (this.seededRandom() < 0.15) continue; // some empty cells

        const bw = params.wRange[0] + this.seededRandom() * (params.wRange[1] - params.wRange[0]);
        const bd = params.dRange[0] + this.seededRandom() * (params.dRange[1] - params.dRange[0]);
        const floors = params.floorsRange[0];
        const floorH = params.floorH[0] + this.seededRandom() * (params.floorH[1] - params.floorH[0]);

        const bx = cx - halfBlock + 2 + (col + 0.5) * cellSize;
        const bz = cz - halfBlock + 2 + (row + 0.5) * cellSize;

        if (this.checkOverlap(bx, bz, bw, bd, buildings)) continue;

        const data = this.makeBuildingData(bx, bz, bw, bd, district, floors, floorH);
        data.doorFace = 0; // all face same direction
        buildings.push(data);
      }
    }
  }

  layoutSinglePlot(cx, cz, size, district, buildings) {
    const params = DISTRICT_PARAMS[district];
    const plotSize = 20;
    const plotsPerSide = Math.floor(size / plotSize);
    const halfBlock = size / 2;

    for (let px = 0; px < plotsPerSide; px++) {
      for (let pz = 0; pz < plotsPerSide; pz++) {
        if (this.seededRandom() < 0.1) continue; // occasional empty lot

        const plotCx = cx - halfBlock + (px + 0.5) * plotSize;
        const plotCz = cz - halfBlock + (pz + 0.5) * plotSize;

        const bw = params.wRange[0] + this.seededRandom() * (params.wRange[1] - params.wRange[0]);
        const bd = params.dRange[0] + this.seededRandom() * (params.dRange[1] - params.dRange[0]);
        const floors = Math.floor(params.floorsRange[0] + this.seededRandom() * (params.floorsRange[1] - params.floorsRange[0] + 1));
        const floorH = params.floorH[0] + this.seededRandom() * (params.floorH[1] - params.floorH[0]);

        if (this.checkOverlap(plotCx, plotCz, bw, bd, buildings)) continue;

        const data = this.makeBuildingData(plotCx, plotCz, bw, bd, district, floors, floorH);
        // Door faces nearest block edge
        const edgeDist = [
          Math.abs(plotCz - (cz - halfBlock)), // -Z edge
          Math.abs(plotCz - (cz + halfBlock)), // +Z edge
          Math.abs(plotCx - (cx - halfBlock)), // -X edge
          Math.abs(plotCx - (cx + halfBlock)), // +X edge
        ];
        const nearest = edgeDist.indexOf(Math.min(...edgeDist));
        data.doorFace = [1, 0, 3, 2][nearest]; // face toward that edge
        buildings.push(data);
      }
    }
  }
}
