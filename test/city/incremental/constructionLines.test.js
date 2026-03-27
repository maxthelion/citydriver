import { describe, it, expect } from 'vitest';
import { buildConstructionLines, buildGradientField } from '../../../src/city/incremental/constructionLines.js';
import { computeGradient } from '../../../src/city/incremental/index.js';
import { makeRectZone, makeMap } from './helpers.js';

describe('buildConstructionLines', () => {
  const cs = 5;
  const W = 100, H = 100;

  function setup(x0 = 10, z0 = 10, x1 = 50, z1 = 50) {
    const zone = makeRectZone(x0, z0, x1, z1, cs);
    const map = makeMap(W, H, cs);
    const zoneSet = new Set();
    for (const c of zone.cells) zoneSet.add(c.gz * W + c.gx);
    const { gradDir, contourDir } = computeGradient(zone, map, zoneSet);
    const gradField = buildGradientField(zone, map, zoneSet);
    return { zone, map, zoneSet, gradDir, contourDir, gradField };
  }

  it('produces at least one construction line for a large zone', () => {
    const { zone, map, zoneSet, gradDir, contourDir, gradField } = setup();
    const lines = buildConstructionLines(zone, map, gradDir, contourDir, zoneSet, {
      constructionSpacing: 90,
      minStreetLength: 20,
    }, gradField);
    expect(lines.length).toBeGreaterThan(0);
  });

  it('construction lines span the zone (length > half the zone extent)', () => {
    const { zone, map, zoneSet, gradDir, contourDir, gradField } = setup();
    const lines = buildConstructionLines(zone, map, gradDir, contourDir, zoneSet, {
      constructionSpacing: 90,
      minStreetLength: 20,
    }, gradField);
    // Zone extent in gradient direction: ~40 cells * 5m = 200m
    for (const line of lines) {
      expect(line.length).toBeGreaterThan(50);
    }
  });

  it('lines are sorted by contour offset', () => {
    const { zone, map, zoneSet, gradDir, contourDir, gradField } = setup();
    const lines = buildConstructionLines(zone, map, gradDir, contourDir, zoneSet, {
      constructionSpacing: 50,
      minStreetLength: 20,
    }, gradField);
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i].ctOff).toBeGreaterThanOrEqual(lines[i - 1].ctOff);
    }
  });

  it('respects minimum street length', () => {
    const { zone, map, zoneSet, gradDir, contourDir, gradField } = setup();
    const lines = buildConstructionLines(zone, map, gradDir, contourDir, zoneSet, {
      constructionSpacing: 90,
      minStreetLength: 20,
    }, gradField);
    for (const line of lines) {
      expect(line.length).toBeGreaterThanOrEqual(20);
    }
  });

  it('stops at water obstacles', () => {
    const { zone, map, zoneSet, gradDir, contourDir, gradField } = setup();
    // Place water barrier in the gradient direction (x-axis) to split construction lines
    const waterMask = map.getLayer('waterMask');
    for (let gz = 0; gz < H; gz++) {
      waterMask.set(30, gz, 1);
    }
    const lines = buildConstructionLines(zone, map, gradDir, contourDir, zoneSet, {
      constructionSpacing: 90,
      minStreetLength: 20,
    }, gradField);
    // Lines should not span the full zone (split by water at gx=30)
    // Full zone is ~200m, each segment should be ~100m
    for (const line of lines) {
      expect(line.length).toBeLessThan(150);
    }
  });

  it('returns empty for a tiny zone', () => {
    const { zone, map, zoneSet, gradDir, contourDir, gradField } = setup(10, 10, 12, 12);
    const lines = buildConstructionLines(zone, map, gradDir, contourDir, zoneSet, {
      constructionSpacing: 90,
      minStreetLength: 20,
    }, gradField);
    // 3x3 cells = 15m x 15m — may or may not produce a line
    // but definitely won't produce a long one
    for (const line of lines) {
      expect(line.length).toBeLessThan(20);
    }
    // Actually with minStreetLength=20, no lines should pass
    expect(lines.length).toBe(0);
  });

  it('each line has a polyline with multiple points', () => {
    const { zone, map, zoneSet, gradDir, contourDir, gradField } = setup();
    const lines = buildConstructionLines(zone, map, gradDir, contourDir, zoneSet, {
      constructionSpacing: 90,
      minStreetLength: 20,
    }, gradField);
    for (const line of lines) {
      expect(line.points).toBeDefined();
      expect(line.points.length).toBeGreaterThan(1);
      expect(line.length).toBeGreaterThan(0);
    }
  });
});
