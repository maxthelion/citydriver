---
title: "Pipeline Invariant Tests"
category: "testing"
tags: [testing, pipeline, invariants, integration, bitmaps]
summary: "Integration test strategy that steps through both regional and city pipelines checking bitmap invariants after each step."
last-modified-by: user
---

## Overview

Pipeline invariant tests step through the full generation pipeline — both regional and city — checking [[bitmap-invariants]] after each step. This catches bugs at the point they're introduced, not when they cause downstream rendering glitches.

These are integration tests, not unit tests. They use real pipeline steps with real terrain data and verify the grid-level relationships between layers.

## Test Structure

### Regional Pipeline Test

Steps through `generateRegion` phases, checking invariants after each:

```javascript
describe('regional pipeline invariants', () => {
  for (const seed of [42, 99, 751119, 456]) {
    describe(`seed ${seed}`, () => {
      // Generate full region
      const layers = generateRegion(params, new SeededRandom(seed));

      it('elevation is finite and bounded', () => { ... });
      it('water cells have valid elevation', () => { ... });
      it('settlements are on buildable land', () => { ... });
      it('road cells do not overlap water', () => { ... });
      it('railway cells do not overlap water', () => { ... });
      it('off-map cities are on inland edges', () => { ... });
      it('land cover values are valid', () => { ... });
    });
  }
});
```

### City Pipeline Test

Steps through `setupCity` + `LandFirstDevelopment` ticks, checking invariants at checkpoints:

```javascript
describe('city pipeline invariants', () => {
  for (const seed of [42, 99, 751119]) {
    describe(`seed ${seed}`, () => {
      const layers = generateRegion(params, new SeededRandom(seed));
      const settlement = pickSettlement(layers);
      const map = setupCity(layers, settlement, new SeededRandom(seed));

      // After setup (tick 0)
      it('water ∩ road = ∅ after setup', () => { ... });
      it('water ∩ railway = ∅ after setup', () => { ... });
      it('station on dry land', () => { ... });
      it('railway elevation is smooth', () => { ... });
      it('nuclei on buildable land', () => { ... });

      // Run ticks and check after each
      const strategy = new LandFirstDevelopment(map, { archetype });

      it('road ∩ water = ∅ after skeleton roads', () => {
        strategy.tick(); // tick 1
        // check invariants
      });

      it('zones on buildable land after extraction', () => {
        strategy.tick(); // tick 2
        strategy.tick(); // tick 3
        // check invariants
      });

      // After buildings
      it('buildings ∩ water = ∅', () => { ... });
      it('buildings ∩ railway = ∅', () => { ... });
      it('buildings ∩ road = ∅', () => { ... });
    });
  }
});
```

## Helper Functions

Reusable invariant checkers that work on any Grid2D pair:

```javascript
/**
 * Assert no cell has both gridA > 0 and gridB > 0.
 * Returns count of violations for reporting.
 */
function assertNoOverlap(gridA, gridB, nameA, nameB) {
  let violations = 0;
  for (let gz = 0; gz < gridA.height; gz++) {
    for (let gx = 0; gx < gridA.width; gx++) {
      if (gridA.get(gx, gz) > 0 && gridB.get(gx, gz) > 0) violations++;
    }
  }
  return violations;
}

/**
 * Assert all cells in gridA with value > 0 also have gridB value matching predicate.
 */
function assertImplies(gridA, gridB, predicate, nameA, nameB) {
  let violations = 0;
  for (let gz = 0; gz < gridA.height; gz++) {
    for (let gx = 0; gx < gridA.width; gx++) {
      if (gridA.get(gx, gz) > 0 && !predicate(gridB.get(gx, gz))) violations++;
    }
  }
  return violations;
}
```

## Multi-Seed Testing

Tests run across multiple seeds to catch geometry-dependent bugs:

- **Seed 42** — general case
- **Seed 99** — different terrain/settlement layout
- **Seed 751119** — river city (railways near water, station placement challenge)
- **Seed 456** — coastal region (off-map cities on inland edges)

Each seed exercises different terrain configurations. A bug that only manifests with specific river/mountain layouts will be caught by at least one seed.

## Performance Strategy

Full city grids are 1200×1200 = 1.44M cells. Checking all bitmap pairs at every pipeline step for 4 seeds:

- **Per-check cost:** ~1.44M comparisons × 5 invariant pairs = 7.2M ops
- **Per-seed cost:** ~7 pipeline steps × 7.2M = 50M ops
- **Total:** 4 seeds × 50M = 200M ops

At ~1 billion ops/sec in JS, this is ~200ms — acceptable for integration tests.

If it grows beyond 1 second:

1. **Sample 10% of cells** — reduces to ~20ms, still catches most violations
2. **Skip intermediate ticks** — only check after setup and after completion
3. **GPU compute** — WebGPU kernel for overlap detection. Each invariant becomes a single dispatch:
   ```wgsl
   @compute @workgroup_size(256)
   fn checkOverlap(@builtin(global_invocation_id) id: vec3<u32>) {
     let i = id.x;
     if (gridA[i] > 0u && gridB[i] > 0u) {
       atomicAdd(&violations, 1u);
     }
   }
   ```
   Full grid check in <1ms regardless of size.

## Integration with CI

Pipeline invariant tests should run in CI on every commit. They catch regressions that unit tests miss — a change to river carving that accidentally puts water cells on existing road cells, for example.

Recommended test configuration:
- **Fast suite** (unit tests): `vitest run test/core/ test/city/*.test.js` — <2s
- **Integration suite** (invariants): `vitest run test/integration/` — <10s
- **Full suite** (everything): `vitest run` — <30s

## Source Files

| File | Role |
|------|------|
| `test/integration/pipelineInvariants.test.js` | Multi-seed pipeline invariant tests (planned) |
| `test/city/routeCityRailways.test.js` | Railway-specific bitmap invariants |
| See [[bitmap-invariants]] | Full list of invariant rules |
