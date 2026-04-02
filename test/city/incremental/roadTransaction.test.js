import { describe, expect, it, vi } from 'vitest';
import { FeatureMap } from '../../../src/core/FeatureMap.js';
import { Grid2D } from '../../../src/core/Grid2D.js';
import { tryAddRoad } from '../../../src/city/incremental/roadTransaction.js';

function makeMap() {
  const map = new FeatureMap(80, 80, 5);
  const elevation = new Grid2D(80, 80, { cellSize: 5, fill: 100 });
  const waterMask = map.waterMask;
  map.elevation = elevation;
  map.setLayer('elevation', elevation);
  map.setLayer('waterMask', waterMask);
  return map;
}

describe('tryAddRoad', () => {
  it('allows a short through-road continuation that shares an endpoint node', () => {
    const map = makeMap();
    const existing = map.roadNetwork.add(
      [{ x: 90, z: 50 }, { x: 100, z: 50 }],
      { hierarchy: 'residential', source: 'cross-street' },
    );

    const result = tryAddRoad(
      map,
      [{ x: 100, z: 50 }, { x: 104, z: 50 }],
      { hierarchy: 'residential', source: 'cross-street' },
    );

    expect(result.accepted).toBe(true);
    expect(result.way).not.toBeNull();
    const next = map.roadNetwork.getWay(result.way.id);
    expect(next.nodes[0].id).toBe(existing.nodes[existing.nodes.length - 1].id);
  });

  it('still rejects a same-direction duplicate that starts from the same endpoint', () => {
    const map = makeMap();
    map.roadNetwork.add(
      [{ x: 100, z: 50 }, { x: 110, z: 50 }],
      { hierarchy: 'residential', source: 'cross-street' },
    );

    const result = tryAddRoad(
      map,
      [{ x: 100, z: 50 }, { x: 104, z: 50 }],
      { hierarchy: 'residential', source: 'cross-street' },
    );

    expect(result.accepted).toBe(false);
    expect(result.violations.some(msg => msg.includes('parallel to existing road'))).toBe(true);
  });

  it('does not rebuild derived state for a rejected tentative road', () => {
    const map = makeMap();
    map.roadNetwork.add(
      [{ x: 100, z: 50 }, { x: 110, z: 50 }],
      { hierarchy: 'residential', source: 'cross-street' },
    );
    const spy = vi.spyOn(map.roadNetwork, 'rebuildDerived');

    const result = tryAddRoad(
      map,
      [{ x: 100, z: 50 }, { x: 104, z: 50 }],
      { hierarchy: 'residential', source: 'cross-street' },
    );

    expect(result.accepted).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect(map.roadNetwork.wayCount).toBe(1);
  });

  it('rebuilds derived state once for an accepted road', () => {
    const map = makeMap();
    const spy = vi.spyOn(map.roadNetwork, 'rebuildDerived');

    const result = tryAddRoad(
      map,
      [{ x: 60, z: 60 }, { x: 90, z: 60 }],
      { hierarchy: 'residential', source: 'cross-street' },
    );

    expect(result.accepted).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(map.roadNetwork.wayCount).toBe(1);
  });
});
