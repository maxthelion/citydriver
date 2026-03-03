// Constants
export const CITY_SIZE = 800;
export const BLOCK_SIZE = 60;
export const ROAD_WIDTH = 12;
export const CELL_SIZE = BLOCK_SIZE + ROAD_WIDTH;
export const GRID_COUNT = Math.floor(CITY_SIZE / CELL_SIZE);
export const TERRAIN_SIZE = CITY_SIZE + 400;
export const TERRAIN_SEGMENTS = 256;

// The discrete heightmap — single source of truth
let heightmapData = null;
let hmSegments = 0;
let hmSize = 0;
let hmHalf = 0;
let hmCellSize = 0;

// Analytical elevation (used only to populate the heightmap)
function analyticalElevation(perlin, x, z) {
  return perlin.fbm(x * 0.0015, z * 0.0015, 3) * 40 +
         perlin.fbm(x * 0.005, z * 0.005, 3) * 12 +
         perlin.fbm(x * 0.02, z * 0.02, 2) * 3;
}

// Generate the heightmap array from a PerlinNoise instance
export function generateHeightmap(perlin) {
  hmSegments = TERRAIN_SEGMENTS;
  hmSize = TERRAIN_SIZE;
  hmHalf = hmSize / 2;
  hmCellSize = hmSize / hmSegments;

  const count = (hmSegments + 1) * (hmSegments + 1);
  heightmapData = new Float32Array(count);

  for (let j = 0; j <= hmSegments; j++) {
    for (let i = 0; i <= hmSegments; i++) {
      const x = -hmHalf + i * hmCellSize;
      const z = -hmHalf + j * hmCellSize;
      heightmapData[j * (hmSegments + 1) + i] = analyticalElevation(perlin, x, z);
    }
  }

  return heightmapData;
}

// Bilinear interpolation of the heightmap — matches GPU's PlaneGeometry interpolation
export function sampleHeightmap(worldX, worldZ) {
  if (!heightmapData) return 0;

  // Convert world coords to grid coords
  const gx = (worldX + hmHalf) / hmCellSize;
  const gz = (worldZ + hmHalf) / hmCellSize;

  // Clamp to grid bounds
  const ix = Math.max(0, Math.min(hmSegments - 1, Math.floor(gx)));
  const iz = Math.max(0, Math.min(hmSegments - 1, Math.floor(gz)));

  const fx = gx - ix; // fractional x [0,1]
  const fz = gz - iz; // fractional z [0,1]

  const stride = hmSegments + 1;
  const h00 = heightmapData[iz * stride + ix];
  const h10 = heightmapData[iz * stride + ix + 1];
  const h01 = heightmapData[(iz + 1) * stride + ix];
  const h11 = heightmapData[(iz + 1) * stride + ix + 1];

  // Bilinear interpolation
  const h0 = h00 + (h10 - h00) * fx;
  const h1 = h01 + (h11 - h01) * fx;
  return h0 + (h1 - h0) * fz;
}

// Expose for testing
export function getHeightmapData() {
  return { data: heightmapData, segments: hmSegments, size: hmSize };
}
