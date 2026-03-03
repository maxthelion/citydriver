import { PerlinNoise } from './noise.js';
import { CITY_SIZE, BLOCK_SIZE, ROAD_WIDTH, CELL_SIZE, GRID_COUNT } from './heightmap.js';

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

        const parkNoise = this.perlin.noise(gx * 0.3 + 100, gz * 0.3 + 100);
        const isPark = parkNoise > 0.3 && this.seededRandom() > 0.5;

        if (isPark) {
          parks.push({ x: cx, z: cz, size: BLOCK_SIZE });
        } else {
          const density = Math.max(0.2, 1 - distFromCenter * 0.8);
          const maxHeight = Math.max(8, (1 - distFromCenter) * 80 + 10);
          this.generateBlock(cx, cz, BLOCK_SIZE, density, maxHeight, buildings);
        }

        blocks.push({ x: cx, z: cz, isPark, gx, gz });
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

  generateBlock(cx, cz, size, density, maxHeight, buildings) {
    const numBuildings = Math.floor(density * (3 + this.seededRandom() * 4));
    const margin = 4;
    const halfBlock = size / 2 - margin;

    for (let i = 0; i < numBuildings; i++) {
      const bw = 6 + this.seededRandom() * 14;
      const bd = 6 + this.seededRandom() * 14;
      const bh = 5 + this.seededRandom() * maxHeight;
      const bx = cx + (this.seededRandom() - 0.5) * (halfBlock * 2 - bw);
      const bz = cz + (this.seededRandom() - 0.5) * (halfBlock * 2 - bd);

      let overlaps = false;
      for (const b of buildings) {
        if (Math.abs(b.x - bx) < (b.w + bw) / 2 + 1 &&
            Math.abs(b.z - bz) < (b.d + bd) / 2 + 1) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;

      const type = this.seededRandom();
      const colorIdx = Math.floor(this.seededRandom() * 5);
      buildings.push({
        x: bx, z: bz,
        w: bw, h: bh, d: bd,
        type: type < 0.3 ? 'residential' : type < 0.7 ? 'commercial' : 'skyscraper',
        colorIdx
      });
    }
  }
}
