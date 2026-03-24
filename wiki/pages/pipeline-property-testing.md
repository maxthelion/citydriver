---
title: "Pipeline Property Testing"
category: "testing"
tags: [testing, pipeline, property-testing, generative, invariants]
summary: "Testing strategy for procedural output — three levels of validation from world rules through structural properties to distribution health."
last-modified-by: user
---

## The Problem

The city generator is procedural — given a seed, it produces a city. The output is intentionally different for each seed. This makes testing hard:

- **We can't assert exact outputs.** "Seed 42 produces exactly 53 zones" is brittle — any upstream change breaks it, even if the new output is equally valid.
- **We can say what's wrong.** Roads in water, zones with 0 cells, duplicate edges — these are always bugs regardless of seed.
- **It's harder to say what's right.** "At least 5 zones" is too weak. "Exactly 53 zones" is too strong. The right answer depends on the terrain, which varies per seed.
- **Some bugs only appear on certain seeds.** Seed 884469 produces 2 zones where it should produce 53. Seeds 42 and 12345 work fine. Testing only 3 fixed seeds misses this.

## Current State

### What exists (Level 1: World Rules)

[Pipeline invariant tests](pipeline-invariant-tests) check that the output doesn't violate physics:
- No roads in water
- No zones on water
- No reservations outside zones
- No degenerate roads
- No orphan graph nodes
- No stale edge references

These run after every pipeline step for 3 fixed seeds. They catch "the output is impossible" but not "the output is bad."

**Implementation:** `src/city/invariants/{bitmap,polyline,block}Invariants.js`, tested in `test/integration/pipelineInvariants.test.js`.

### What's missing (Level 2 and 3)

No tests validate that the pipeline produces *reasonable quantities* of things. Seed 884469 went from 53 zones to 2 zones and nothing caught it, because "2 zones with no invariant violations" passes all existing checks.

## Three Levels of Validation

### Level 1: World Rules (Invariants)

**"The output must not violate physics."**

Already implemented. Per-cell and per-feature checks that must hold for every seed after every step. Zero tolerance — any violation is a bug.

See [world-state-invariants](world-state-invariants) for the rules, [bitmap-invariants](bitmap-invariants) and [road-network-invariants](road-network-invariants) for testing mechanisms.

### Level 2: Structural Properties

**"For any seed, the output must have reasonable structure."**

This is the main gap. These are property-based tests that run across many seeds (including randomly generated ones) and assert structural relationships. They don't check exact values — they check that the output is within sane bounds and that pipeline steps have the expected effect on each other.

#### Universal properties (must hold for ALL seeds)

| Property | After step | Assertion |
|----------|-----------|-----------|
| Pipeline completes | completion | No throw, no infinite loop |
| Zones exist | `zones` | zone count > 0 |
| Zones have cells | `zones` | every zone has cells.length > 0 |
| Zone coverage | `zones` | total zone cells > 10% of non-water area |
| Road network connected | `skeleton` | single connected component (or one per nucleus if isolated) |
| No duplicate graph edges | `zone-boundary` | graph has no edge between same node pair twice |
| Graph faces are closed | `zones` | every face from facesWithEdges() has >= 3 nodes |

#### Monotonicity properties (things that should only grow or stay stable)

| Property | Assertion |
|----------|-----------|
| Roads don't disappear | road count after step N+1 >= road count after step N |
| Zones don't collapse | zone count after `zones-refine` >= zone count after `zones` * 0.5 |
| Zone coverage doesn't collapse | total zone cells after refine >= total zone cells before * 0.5 |

#### Relational properties (proportional assertions)

| Property | Assertion |
|----------|-----------|
| Subdivision creates more zones | zone count after `zone-boundary` + `zones-refine` > zone count after `zones` |
| More roads from growth | road count after growth > road count after skeleton |
| Zone count scales with area | zone count roughly proportional to buildable area (within 10x) |

#### How to test these

**Property-based testing with random seeds.** Like QuickCheck/fast-check — generate random seeds, run the pipeline, assert properties hold. Instead of 3 fixed seeds, run 20+ random seeds. Any single failure is a real bug.

```javascript
describe('pipeline structural properties', () => {
  // Use a seeded RNG to generate test seeds — reproducible but broad
  const testRng = new SeededRandom(12345);
  const TEST_SEEDS = Array.from({ length: 20 }, () =>
    Math.floor(testRng.next() * 1000000)
  );

  for (const seed of TEST_SEEDS) {
    it(`seed ${seed}: zones exist after extraction`, () => {
      const map = runPipelineTo(seed, 'zones');
      expect(map.developmentZones.length).toBeGreaterThan(0);
    });

    it(`seed ${seed}: zone coverage > 10% of buildable area`, () => {
      const map = runPipelineTo(seed, 'zones');
      const totalZoneCells = map.developmentZones
        .reduce((sum, z) => sum + z.cells.length, 0);
      const buildableArea = countBuildableCells(map);
      expect(totalZoneCells / buildableArea).toBeGreaterThan(0.1);
    });

    it(`seed ${seed}: zones-refine doesn't collapse zones`, () => {
      const mapBefore = runPipelineTo(seed, 'zones');
      const mapAfter = runPipelineTo(seed, 'zones-refine');
      expect(mapAfter.developmentZones.length)
        .toBeGreaterThanOrEqual(mapBefore.developmentZones.length * 0.5);
    });
  }
});
```

**Why random seeds matter:** Seed 884469 was broken for months. If we'd been testing with 20 random seeds, the probability of hitting a similar bug on at least one seed is much higher. And when a property fails on a random seed, that seed becomes a regression test — add it to the fixed set.

**Performance:** Running the pipeline to `zones` takes ~2-5 seconds per seed. 20 seeds = ~60-100 seconds. Too slow for unit test suite, fine for integration. Could parallelize with vitest forks.

#### Metamorphic properties (relationship between runs)

These don't need exact values — they assert that changes to the pipeline have predictable directional effects:

| Property | Assertion |
|----------|-----------|
| Determinism | Same seed → same output (zone count, road count) |
| Adding roads creates zones | More zone-boundary roads → more zones after refine |
| Removing a zone-boundary road loses at most 2 zones | Targeted regression test |

### Level 3: Distribution Health

**"Across many seeds, the output distribution hasn't shifted."**

Not per-commit tests. A periodic health check that runs 100+ random seeds and computes statistics:

| Metric | Expected range | Alert if |
|--------|---------------|----------|
| Zone count (median) | 15-60 | Outside range or shifted >30% from last run |
| Zone count (min across seeds) | > 3 | Any seed produces < 3 zones |
| Road count (median) | 50-500 | Outside range |
| Zone coverage % (median) | 20-60% | Below 15% |
| Duplicate edge count | 0 | Any seed has duplicates |
| facesWithEdges failure rate | 0% | Any seed fails graph-face extraction |

This catches slow drift — a refactoring that slightly degrades zone quality across all seeds. No single seed fails a property test, but the distribution shifts.

**Implementation:** Run as a script (like `benchmark-pipeline.js`) that outputs a JSON summary. Compare to previous baseline. Could run nightly or before releases.

## Relationship to Other Testing

| Level | What it catches | When to run | Speed |
|-------|----------------|-------------|-------|
| Unit tests | Function-level bugs | Every commit | < 5s |
| Level 1 (world rules) | Impossible output | Every commit | ~10s (3 seeds) |
| Level 2 (properties) | Unreasonable output | Every commit (integration suite) | ~100s (20 seeds) |
| Level 3 (distribution) | Drift over time | Nightly / pre-release | ~10min (100 seeds) |

## Prior Art

**Property-based testing** (QuickCheck, Hypothesis, fast-check): Generate random inputs, assert properties of outputs. Standard in functional programming. The key insight: properties are universal statements ("for all seeds, zone count > 0") rather than existential statements ("seed 42 produces 53 zones").

**Metamorphic testing** (Chen et al. 2018): When you can't specify expected output, specify expected *relationships* between outputs. Widely used in ML testing and scientific computing. "Rotating the input image shouldn't change the classification" is a metamorphic property.

**Statistical testing for games** (procedural generation QA): Run thousands of seeds, build histograms of output metrics, alert on distribution shift. Used by studios working on roguelikes and procedural worlds. The key metric: "what percentage of seeds produce a playable/valid result?"

**Fuzzing with property assertions**: Similar to property testing but focuses on finding crashes and assertion failures across random inputs. The pipeline's "run to completion without throwing" is the simplest fuzz test.

## Implementation Priority

1. **Add graph integrity checks to Level 1** — duplicate edges, dangling edges, face closure. These are world rules that should be zero-tolerance. Currently missing from the invariant checkers.
2. **Write Level 2 property tests** — universal properties across 20 random seeds. This would have caught the zone regression immediately.
3. **Add failed seeds to fixed regression set** — when a property fails on a random seed, add that seed permanently.
4. **Build Level 3 distribution script** — periodic health check, not blocking.

## Source Files

| File | Role |
|------|------|
| `src/city/invariants/bitmapInvariants.js` | Level 1: bitmap world rules |
| `src/city/invariants/polylineInvariants.js` | Level 1: road network world rules |
| `src/city/invariants/blockInvariants.js` | Level 1: zone structural world rules |
| `test/integration/pipelineInvariants.test.js` | Level 1: integration test (3 fixed seeds) |
| `test/integration/pipelineProperties.test.js` | Level 2: property tests (20+ seeds) — **to be created** |
| `scripts/pipeline-health.js` | Level 3: distribution sampling — **to be created** |
