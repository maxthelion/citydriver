import { describe, it, expect } from 'vitest';
import {
  V_noRoadsInWater,
  V_noBuildingsInWater,
  V_noBuildingOverlaps,
  V_roadGraphConnected,
  V_buildingsHaveRoadAccess,
  V_noOverlappingRoads,
  V_plotsNotOnRoads,
  V_plotsNotInWater,
  S_deadEndFraction,
  S_plotFrontageRate,
  S_densityBuildingCorrelation,
  S_hierarchyRatios,
  S_blockCompactness,
  S_populationBudgetMatch,
  Q_frontageContinuity,
  Q_junctionAngles,
  Q_heightGradient,
  Q_amenityCatchment,
  getCityValidators,
  runValidators,
} from '../../src/validators/cityValidators.js';
import { LayerStack } from '../../src/core/LayerStack.js';
import { Grid2D } from '../../src/core/Grid2D.js';
import { PlanarGraph } from '../../src/core/PlanarGraph.js';

// ============================================================
// Helper: build a minimal valid city LayerStack
// ============================================================

/**
 * Creates a simple valid city with:
 * - 4 nodes in a square (0,0), (100,0), (100,100), (0,100) connected in a loop
 * - A few buildings near roads
 * - Elevation above sea level
 * - Density grid
 * - Plots near roads
 */
function makeValidCity(overrides = {}) {
  const cellSize = 10;
  const gridW = 20;
  const gridH = 20;
  const seaLevel = 0;

  const layers = new LayerStack();

  // Params
  layers.setData('params', { width: gridW, height: gridH, cellSize, seaLevel });

  // Elevation grid: all above sea level (value = 10)
  const elevation = new Grid2D(gridW, gridH, { cellSize, fill: 10 });
  layers.setGrid('elevation', elevation);

  // Density grid: values 0-1
  const density = new Grid2D(gridW, gridH, { cellSize, fill: 0.5 });
  // Make top-left denser
  for (let gz = 0; gz < gridH / 2; gz++) {
    for (let gx = 0; gx < gridW / 2; gx++) {
      density.set(gx, gz, 0.8);
    }
  }
  layers.setGrid('density', density);

  // Road graph: square loop with an arterial and local roads
  const graph = new PlanarGraph();
  const n0 = graph.addNode(20, 20);
  const n1 = graph.addNode(80, 20);
  const n2 = graph.addNode(80, 80);
  const n3 = graph.addNode(20, 80);

  graph.addEdge(n0, n1, { hierarchy: 'arterial', width: 12 });
  graph.addEdge(n1, n2, { hierarchy: 'collector', width: 8 });
  graph.addEdge(n2, n3, { hierarchy: 'local', width: 6 });
  graph.addEdge(n3, n0, { hierarchy: 'local', width: 6 });

  layers.setData('roadGraph', overrides.roadGraph ?? graph);

  // Buildings near roads
  const buildings = overrides.buildings ?? [
    {
      footprint: [{ x: 25, z: 25 }, { x: 35, z: 25 }, { x: 35, z: 35 }, { x: 25, z: 35 }],
      height: 10,
      groundHeight: 10,
      centroid: { x: 30, z: 30 },
      type: 'terrace',
      district: 'A',
      material: 'brick',
      floors: 3,
    },
    {
      footprint: [{ x: 60, z: 25 }, { x: 70, z: 25 }, { x: 70, z: 35 }, { x: 60, z: 35 }],
      height: 15,
      groundHeight: 10,
      centroid: { x: 65, z: 30 },
      type: 'commercial',
      district: 'B',
      material: 'concrete',
      floors: 5,
    },
    {
      footprint: [{ x: 60, z: 65 }, { x: 70, z: 65 }, { x: 70, z: 75 }, { x: 60, z: 75 }],
      height: 8,
      groundHeight: 10,
      centroid: { x: 65, z: 70 },
      type: 'detached',
      district: 'C',
      material: 'brick',
      floors: 2,
    },
  ];
  layers.setData('buildings', buildings);

  // Plots near roads
  const plots = overrides.plots ?? [
    { vertices: [{ x: 22, z: 22 }, { x: 38, z: 22 }, { x: 38, z: 38 }, { x: 22, z: 38 }], area: 256, centroid: { x: 30, z: 30 }, density: 0.5, district: 'A' },
    { vertices: [{ x: 58, z: 22 }, { x: 72, z: 22 }, { x: 72, z: 38 }, { x: 58, z: 38 }], area: 256, centroid: { x: 65, z: 30 }, density: 0.5, district: 'B' },
  ];
  layers.setData('plots', plots);

  // Water mask: all dry
  const waterMask = new Grid2D(gridW, gridH, { cellSize, fill: 0 });
  if (overrides.waterMask) {
    // Apply custom water cells
    overrides.waterMask.forEach(([gx, gz]) => waterMask.set(gx, gz, 1));
  }
  layers.setGrid('waterMask', waterMask);

  // Amenities
  const amenities = overrides.amenities ?? [
    { type: 'park', centroid: { x: 50, z: 50 }, x: 50, z: 50 },
  ];
  layers.setData('amenities', amenities);

  return layers;
}

// ============================================================
// Tier 1 Tests
// ============================================================

describe('Tier 1: V_noRoadsInWater', () => {
  it('returns true for a valid city', () => {
    const layers = makeValidCity();
    expect(V_noRoadsInWater.fn(layers)).toBe(true);
  });

  it('returns false when a road node is in water', () => {
    const layers = makeValidCity();
    const elevation = layers.getGrid('elevation');
    // Set the area around node (20,20) to below sea level
    const { gx, gz } = elevation.worldToGrid(20, 20);
    elevation.set(Math.floor(gx), Math.floor(gz), -5);
    elevation.set(Math.ceil(gx), Math.floor(gz), -5);
    elevation.set(Math.floor(gx), Math.ceil(gz), -5);
    elevation.set(Math.ceil(gx), Math.ceil(gz), -5);

    expect(V_noRoadsInWater.fn(layers)).toBe(false);
  });

  it('returns true when data is missing', () => {
    const layers = new LayerStack();
    expect(V_noRoadsInWater.fn(layers)).toBe(true);
  });
});

describe('Tier 1: V_noBuildingsInWater', () => {
  it('returns true for a valid city', () => {
    const layers = makeValidCity();
    expect(V_noBuildingsInWater.fn(layers)).toBe(true);
  });

  it('returns false when a building centroid is in water', () => {
    const layers = makeValidCity();
    const elevation = layers.getGrid('elevation');
    // Set the area around building centroid (30,30) to below sea level
    const { gx, gz } = elevation.worldToGrid(30, 30);
    elevation.set(Math.floor(gx), Math.floor(gz), -5);
    elevation.set(Math.ceil(gx), Math.floor(gz), -5);
    elevation.set(Math.floor(gx), Math.ceil(gz), -5);
    elevation.set(Math.ceil(gx), Math.ceil(gz), -5);

    expect(V_noBuildingsInWater.fn(layers)).toBe(false);
  });

  it('returns true when data is missing', () => {
    const layers = new LayerStack();
    expect(V_noBuildingsInWater.fn(layers)).toBe(true);
  });
});

describe('Tier 1: V_noBuildingOverlaps', () => {
  it('returns true for non-overlapping buildings', () => {
    const layers = makeValidCity();
    expect(V_noBuildingOverlaps.fn(layers)).toBe(true);
  });

  it('returns false for overlapping buildings', () => {
    const buildings = [
      {
        footprint: [{ x: 0, z: 0 }, { x: 20, z: 0 }, { x: 20, z: 20 }, { x: 0, z: 20 }],
        height: 10, groundHeight: 10, centroid: { x: 10, z: 10 }, type: 'residential', district: 'A', material: 'brick', floors: 3,
      },
      {
        footprint: [{ x: 10, z: 10 }, { x: 30, z: 10 }, { x: 30, z: 30 }, { x: 10, z: 30 }],
        height: 10, groundHeight: 10, centroid: { x: 20, z: 20 }, type: 'residential', district: 'A', material: 'brick', floors: 3,
      },
    ];
    const layers = makeValidCity({ buildings });
    expect(V_noBuildingOverlaps.fn(layers)).toBe(false);
  });

  it('returns true when there are fewer than 2 buildings', () => {
    const layers = makeValidCity({ buildings: [] });
    expect(V_noBuildingOverlaps.fn(layers)).toBe(true);
  });

  it('returns true for buildings with non-overlapping bounding boxes', () => {
    const buildings = [
      {
        footprint: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }],
        height: 10, groundHeight: 10, centroid: { x: 5, z: 5 }, type: 'residential', district: 'A', material: 'brick', floors: 3,
      },
      {
        footprint: [{ x: 50, z: 50 }, { x: 60, z: 50 }, { x: 60, z: 60 }, { x: 50, z: 60 }],
        height: 10, groundHeight: 10, centroid: { x: 55, z: 55 }, type: 'residential', district: 'A', material: 'brick', floors: 3,
      },
    ];
    const layers = makeValidCity({ buildings });
    expect(V_noBuildingOverlaps.fn(layers)).toBe(true);
  });
});

describe('Tier 1: V_roadGraphConnected', () => {
  it('returns true for a connected graph', () => {
    const layers = makeValidCity();
    expect(V_roadGraphConnected.fn(layers)).toBe(true);
  });

  it('returns false for a disconnected graph', () => {
    const graph = new PlanarGraph();
    graph.addNode(0, 0);
    graph.addNode(10, 0);
    graph.addNode(50, 50);
    graph.addNode(60, 50);
    graph.addEdge(0, 1);
    graph.addEdge(2, 3);
    // Two disconnected components
    const layers = makeValidCity({ roadGraph: graph });
    expect(V_roadGraphConnected.fn(layers)).toBe(false);
  });

  it('returns true when data is missing', () => {
    const layers = new LayerStack();
    expect(V_roadGraphConnected.fn(layers)).toBe(true);
  });
});

describe('Tier 1: V_buildingsHaveRoadAccess', () => {
  it('returns true when buildings are near roads', () => {
    const layers = makeValidCity();
    expect(V_buildingsHaveRoadAccess.fn(layers)).toBe(true);
  });

  it('returns false when a building is too far from roads', () => {
    const buildings = [
      {
        footprint: [{ x: 0, z: 0 }, { x: 5, z: 0 }, { x: 5, z: 5 }, { x: 0, z: 5 }],
        height: 10, groundHeight: 10, centroid: { x: 500, z: 500 }, type: 'residential', district: 'A', material: 'brick', floors: 3,
      },
    ];
    const layers = makeValidCity({ buildings });
    expect(V_buildingsHaveRoadAccess.fn(layers)).toBe(false);
  });

  it('returns true when data is missing', () => {
    const layers = new LayerStack();
    expect(V_buildingsHaveRoadAccess.fn(layers)).toBe(true);
  });
});

describe('Tier 1: V_noOverlappingRoads', () => {
  it('returns true for non-overlapping roads', () => {
    const layers = makeValidCity();
    expect(V_noOverlappingRoads.fn(layers)).toBe(true);
  });

  it('returns false for parallel overlapping roads', () => {
    const graph = new PlanarGraph();
    // Two parallel edges running the same path, not sharing endpoints
    const a0 = graph.addNode(0, 0);
    const a1 = graph.addNode(100, 0);
    const b0 = graph.addNode(0, 2);  // 2m away — within default width of 9
    const b1 = graph.addNode(100, 2);
    graph.addEdge(a0, a1, { width: 9, hierarchy: 'local' });
    graph.addEdge(b0, b1, { width: 9, hierarchy: 'local' });
    const layers = makeValidCity({ roadGraph: graph });
    expect(V_noOverlappingRoads.fn(layers)).toBe(false);
  });

  it('returns true when edges share endpoints (adjacent)', () => {
    const graph = new PlanarGraph();
    const n0 = graph.addNode(0, 0);
    const n1 = graph.addNode(50, 0);
    const n2 = graph.addNode(100, 0);
    graph.addEdge(n0, n1, { width: 9 });
    graph.addEdge(n1, n2, { width: 9 });
    const layers = makeValidCity({ roadGraph: graph });
    expect(V_noOverlappingRoads.fn(layers)).toBe(true);
  });

  it('returns true when data is missing', () => {
    const layers = new LayerStack();
    expect(V_noOverlappingRoads.fn(layers)).toBe(true);
  });
});

describe('Tier 1: V_plotsNotOnRoads', () => {
  it('returns true when plot centroids are away from roads', () => {
    const layers = makeValidCity();
    expect(V_plotsNotOnRoads.fn(layers)).toBe(true);
  });

  it('returns false when a plot centroid sits on a road', () => {
    // Place a plot centroid exactly on the road edge from (20,20) to (80,20)
    const plots = [
      { vertices: [{ x: 48, z: 18 }, { x: 52, z: 18 }, { x: 52, z: 22 }, { x: 48, z: 22 }],
        area: 16, centroid: { x: 50, z: 20 }, density: 0.5, district: 'A' },
    ];
    const layers = makeValidCity({ plots });
    expect(V_plotsNotOnRoads.fn(layers)).toBe(false);
  });

  it('returns true when data is missing', () => {
    const layers = new LayerStack();
    expect(V_plotsNotOnRoads.fn(layers)).toBe(true);
  });
});

describe('Tier 1: V_plotsNotInWater', () => {
  it('returns true when no plots are in water', () => {
    const layers = makeValidCity();
    expect(V_plotsNotInWater.fn(layers)).toBe(true);
  });

  it('returns false when a plot centroid is on a water cell', () => {
    // Plot centroid at (30,30), which maps to grid cell (3,3) with cellSize=10
    const layers = makeValidCity({ waterMask: [[3, 3]] });
    expect(V_plotsNotInWater.fn(layers)).toBe(false);
  });

  it('returns true when data is missing', () => {
    const layers = new LayerStack();
    expect(V_plotsNotInWater.fn(layers)).toBe(true);
  });
});

// ============================================================
// Tier 2 Tests
// ============================================================

describe('Tier 2: S_deadEndFraction', () => {
  it('returns value in [0,1] for valid city', () => {
    const layers = makeValidCity();
    const score = S_deadEndFraction.fn(layers);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('returns 1.0 when no dead ends exist (loop)', () => {
    const layers = makeValidCity();
    // Default graph is a square loop, all nodes degree 2
    const score = S_deadEndFraction.fn(layers);
    expect(score).toBe(1.0);
  });

  it('returns lower score for many dead ends', () => {
    const graph = new PlanarGraph();
    // A star: central node connected to 5 leaves
    const center = graph.addNode(50, 50);
    for (let i = 0; i < 5; i++) {
      const leaf = graph.addNode(50 + 30 * Math.cos(i), 50 + 30 * Math.sin(i));
      graph.addEdge(center, leaf);
    }
    // 5 dead ends out of 6 nodes = 83% dead ends
    const layers = makeValidCity({ roadGraph: graph });
    const score = S_deadEndFraction.fn(layers);
    expect(score).toBe(0);
  });

  it('returns 0.5 when data is missing', () => {
    const layers = new LayerStack();
    expect(S_deadEndFraction.fn(layers)).toBe(0.5);
  });
});

describe('Tier 2: S_plotFrontageRate', () => {
  it('returns value in [0,1]', () => {
    const layers = makeValidCity();
    const score = S_plotFrontageRate.fn(layers);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('returns high score when all plots are near roads', () => {
    const layers = makeValidCity();
    const score = S_plotFrontageRate.fn(layers);
    expect(score).toBeGreaterThan(0.5);
  });

  it('returns 0.5 when data is missing', () => {
    const layers = new LayerStack();
    expect(S_plotFrontageRate.fn(layers)).toBe(0.5);
  });
});

describe('Tier 2: S_densityBuildingCorrelation', () => {
  it('returns value in [0,1]', () => {
    const layers = makeValidCity();
    const score = S_densityBuildingCorrelation.fn(layers);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('returns 0.5 when data is missing', () => {
    const layers = new LayerStack();
    expect(S_densityBuildingCorrelation.fn(layers)).toBe(0.5);
  });
});

describe('Tier 2: S_hierarchyRatios', () => {
  it('returns value in [0,1]', () => {
    const layers = makeValidCity();
    const score = S_hierarchyRatios.fn(layers);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('scores higher when ratios match targets', () => {
    // Build a graph with roughly 15% arterial, 25% collector, 60% local
    const graph = new PlanarGraph();
    const n0 = graph.addNode(0, 0);
    const n1 = graph.addNode(15, 0);    // arterial = 15
    const n2 = graph.addNode(40, 0);    // collector = 25
    const n3 = graph.addNode(100, 0);   // local = 60
    graph.addEdge(n0, n1, { hierarchy: 'arterial' });
    graph.addEdge(n1, n2, { hierarchy: 'collector' });
    graph.addEdge(n2, n3, { hierarchy: 'local' });

    const layers = makeValidCity({ roadGraph: graph });
    const score = S_hierarchyRatios.fn(layers);
    expect(score).toBeGreaterThan(0.8);
  });

  it('returns 0.5 when data is missing', () => {
    const layers = new LayerStack();
    expect(S_hierarchyRatios.fn(layers)).toBe(0.5);
  });
});

describe('Tier 2: S_blockCompactness', () => {
  it('returns value in [0,1]', () => {
    const layers = makeValidCity();
    const score = S_blockCompactness.fn(layers);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('returns 0.5 when data is missing', () => {
    const layers = new LayerStack();
    expect(S_blockCompactness.fn(layers)).toBe(0.5);
  });
});

describe('Tier 2: S_populationBudgetMatch', () => {
  it('returns 1.0 for perfect match', () => {
    const layers = makeValidCity();
    layers.setData('population', 1000);
    layers.setData('targetPopulation', 1000);
    expect(S_populationBudgetMatch.fn(layers)).toBe(1.0);
  });

  it('returns lower score for mismatch', () => {
    const layers = makeValidCity();
    layers.setData('population', 500);
    layers.setData('targetPopulation', 1000);
    const score = S_populationBudgetMatch.fn(layers);
    expect(score).toBe(0.5);
  });

  it('returns 0.5 when data is missing', () => {
    const layers = new LayerStack();
    expect(S_populationBudgetMatch.fn(layers)).toBe(0.5);
  });

  it('clamps score to [0,1]', () => {
    const layers = makeValidCity();
    layers.setData('population', 3000);
    layers.setData('targetPopulation', 1000);
    const score = S_populationBudgetMatch.fn(layers);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

// ============================================================
// Tier 3 Tests
// ============================================================

describe('Tier 3: Q_frontageContinuity', () => {
  it('returns value in [0,1]', () => {
    const layers = makeValidCity();
    const score = Q_frontageContinuity.fn(layers);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('returns 0.5 when no arterial roads', () => {
    const graph = new PlanarGraph();
    const n0 = graph.addNode(20, 20);
    const n1 = graph.addNode(80, 20);
    graph.addEdge(n0, n1, { hierarchy: 'local' });
    const layers = makeValidCity({ roadGraph: graph });
    const score = Q_frontageContinuity.fn(layers);
    expect(score).toBe(0.5);
  });

  it('returns 0.5 when data is missing', () => {
    const layers = new LayerStack();
    expect(Q_frontageContinuity.fn(layers)).toBe(0.5);
  });
});

describe('Tier 3: Q_junctionAngles', () => {
  it('returns value in [0,1]', () => {
    const layers = makeValidCity();
    const score = Q_junctionAngles.fn(layers);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('returns 1.0 for well-angled junctions', () => {
    const graph = new PlanarGraph();
    // Cross junction at center with 90-degree angles
    const center = graph.addNode(50, 50);
    const n = graph.addNode(50, 0);
    const e = graph.addNode(100, 50);
    const s = graph.addNode(50, 100);
    const w = graph.addNode(0, 50);
    graph.addEdge(center, n);
    graph.addEdge(center, e);
    graph.addEdge(center, s);
    graph.addEdge(center, w);

    const layers = makeValidCity({ roadGraph: graph });
    const score = Q_junctionAngles.fn(layers);
    expect(score).toBe(1.0);
  });

  it('returns low score for tight angles', () => {
    const graph = new PlanarGraph();
    // Junction with two edges very close in angle
    const center = graph.addNode(50, 50);
    const n1 = graph.addNode(50, 0);
    const n2 = graph.addNode(52, 0);  // nearly same direction as n1
    const n3 = graph.addNode(100, 50);
    graph.addEdge(center, n1);
    graph.addEdge(center, n2);
    graph.addEdge(center, n3);

    const layers = makeValidCity({ roadGraph: graph });
    const score = Q_junctionAngles.fn(layers);
    expect(score).toBe(0);
  });

  it('returns 0.5 when data is missing', () => {
    const layers = new LayerStack();
    expect(Q_junctionAngles.fn(layers)).toBe(0.5);
  });
});

describe('Tier 3: Q_heightGradient', () => {
  it('returns value in [0,1]', () => {
    const layers = makeValidCity();
    const score = Q_heightGradient.fn(layers);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('returns 0.5 when data is missing', () => {
    const layers = new LayerStack();
    expect(Q_heightGradient.fn(layers)).toBe(0.5);
  });
});

describe('Tier 3: Q_amenityCatchment', () => {
  it('returns value in [0,1]', () => {
    const layers = makeValidCity();
    const score = Q_amenityCatchment.fn(layers);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('returns 1.0 when all residential buildings are near a park', () => {
    // Park at (50,50), residential buildings within 400m (40*10=400)
    const layers = makeValidCity();
    const score = Q_amenityCatchment.fn(layers);
    // Both residential buildings (30,30) and (65,70) are within 400 of park (50,50)
    expect(score).toBe(1.0);
  });

  it('returns 0.5 when no parks exist', () => {
    const layers = makeValidCity({ amenities: [] });
    const score = Q_amenityCatchment.fn(layers);
    expect(score).toBe(0.5);
  });

  it('returns 0.5 when no residential buildings exist', () => {
    const buildings = [
      {
        footprint: [{ x: 25, z: 25 }, { x: 35, z: 25 }, { x: 35, z: 35 }, { x: 25, z: 35 }],
        height: 10, groundHeight: 10, centroid: { x: 30, z: 30 }, type: 'commercial', district: 'A', material: 'brick', floors: 3,
      },
    ];
    const layers = makeValidCity({ buildings });
    const score = Q_amenityCatchment.fn(layers);
    expect(score).toBe(0.5);
  });

  it('returns 0.5 when data is missing', () => {
    const layers = new LayerStack();
    expect(Q_amenityCatchment.fn(layers)).toBe(0.5);
  });
});

// ============================================================
// getCityValidators and runValidators
// ============================================================

describe('getCityValidators', () => {
  it('returns all 18 validators', () => {
    const validators = getCityValidators();
    expect(validators).toHaveLength(18);
  });

  it('contains all tiers', () => {
    const validators = getCityValidators();
    const tiers = new Set(validators.map(v => v.tier));
    expect(tiers.has(1)).toBe(true);
    expect(tiers.has(2)).toBe(true);
    expect(tiers.has(3)).toBe(true);
  });

  it('has 8 tier 1, 6 tier 2, 4 tier 3', () => {
    const validators = getCityValidators();
    expect(validators.filter(v => v.tier === 1)).toHaveLength(8);
    expect(validators.filter(v => v.tier === 2)).toHaveLength(6);
    expect(validators.filter(v => v.tier === 3)).toHaveLength(4);
  });
});

describe('runValidators', () => {
  it('returns valid=true and positive scores for a valid city', () => {
    const layers = makeValidCity();
    const validators = getCityValidators();
    const results = runValidators(layers, validators);

    expect(results.valid).toBe(true);
    expect(results.tier1).toHaveLength(8);
    expect(results.tier2).toHaveLength(6);
    expect(results.tier3).toHaveLength(4);
    expect(results.structural).toBeGreaterThan(0);
    expect(results.quality).toBeGreaterThan(0);
    expect(results.overall).toBeGreaterThan(0);
  });

  it('returns valid=false when a T1 validator fails', () => {
    const layers = makeValidCity();
    // Make road graph disconnected
    const graph = new PlanarGraph();
    graph.addNode(0, 0);
    graph.addNode(10, 0);
    graph.addNode(50, 50);
    graph.addNode(60, 50);
    graph.addEdge(0, 1);
    graph.addEdge(2, 3);
    layers.setData('roadGraph', graph);

    const validators = getCityValidators();
    const results = runValidators(layers, validators);

    expect(results.valid).toBe(false);
    expect(results.overall).toBe(0);
  });

  it('all T1 results are booleans', () => {
    const layers = makeValidCity();
    const validators = getCityValidators();
    const results = runValidators(layers, validators);

    for (const entry of results.tier1) {
      expect(typeof entry.value).toBe('boolean');
    }
  });

  it('all T2 and T3 results are numbers in [0,1]', () => {
    const layers = makeValidCity();
    const validators = getCityValidators();
    const results = runValidators(layers, validators);

    for (const entry of [...results.tier2, ...results.tier3]) {
      expect(typeof entry.value).toBe('number');
      expect(entry.value).toBeGreaterThanOrEqual(0);
      expect(entry.value).toBeLessThanOrEqual(1);
    }
  });

  it('overall = structural*0.6 + quality*0.4 when valid', () => {
    const layers = makeValidCity();
    const validators = getCityValidators();
    const results = runValidators(layers, validators);

    expect(results.overall).toBeCloseTo(results.structural * 0.6 + results.quality * 0.4, 10);
  });
});
