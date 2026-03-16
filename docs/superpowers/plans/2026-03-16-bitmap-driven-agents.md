# Bitmap-Driven Growth Agents Refactor

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove hardcoded pixel-distance checks and fudge factors from growth agents. Make all agent behaviour emerge from scoring against the existing bitmap spatial layers.

**Architecture:** Add a `developmentProximity` layer (blur of existing claims) recomputed each tick. Simplify `spreadFromSeed` to score purely via `scoreCell(affinity, layers)` with no behaviour-specific branching. Simplify seed strategies to score-and-pick with spacing. Shape variation comes from affinity weights, not code paths.

**Tech Stack:** Existing Grid2D, spatial layer infrastructure, box blur.

---

## What Changes

### Current problems

- `spreadFromSeed` has behaviour-specific branches (`linear` does a 3-cell road search, `cluster` counts same-type neighbours, `organic` adds random noise) — these are fudge factors
- `findSeeds` / `scoreCellForStrategy` has per-strategy special cases (roadFrontage does a 2-cell search, arterial counts free neighbours, desirable does a 20-cell industrial scan)
- Frontier eligibility uses a BFS distance grid — this should be a smooth layer
- All of this duplicates logic that the spatial layers already encode

### Target state

- `spreadFromSeed` scores every candidate cell via `scoreCell(gx, gz, affinity, layers)` — no other logic. The only spread variant is whether to add noise (organic).
- `findSeeds` scores all eligible cells via `scoreCell`, sorts, picks top N with spacing. No per-strategy branches.
- A new `developmentProximity` layer (recomputed each tick) encodes "how close to existing development" as a smooth gradient. Agents that should grow near existing development weight this layer.
- Commercial sticks to roads because its `roadFrontage` affinity is very high — no hardcoded road search needed.
- Industrial clusters at edges because `edgeness` + `downwindness` affinity is high.
- Quality residential avoids industrial because it can weight a new `industrialDistance` layer (blur of inverse industrial claims).

### New layers (computed per growth tick)

| Layer | How computed | Purpose |
|-------|-------------|---------|
| `developmentProximity` | Box blur of (reservationGrid > 0 && != AGRICULTURE), radius ~radiusStepCells | Frontier eligibility + growth preference |
| `industrialDistance` | Box blur of inverse industrial mask, normalised | Lets residential quality avoid industrial |

### Simplified spread behaviours

Only two real modes needed:
- **`scored`** (default): BFS picking highest-scoring neighbour. Shape emerges from affinity weights.
- **`organic`**: Same as scored, but adds `Math.random() * noiseWeight` to each score for irregularity.

`dot` stays as-is (claim seed only). `blob`, `linear`, `cluster` all collapse into `scored` — the affinity weights produce the right shapes.

### Simplified seed strategies

All strategies become: score eligible cells via `scoreCell`, pick top N with `minSpacing`. No per-strategy branches. The strategy name is removed from the agent config — it's just affinity weights + seedsPerTick + minSpacing.

---

## File Structure

| File | Changes |
|------|---------|
| `src/city/pipeline/growthAgents.js` | Strip all behaviour branches from `spreadFromSeed`. Remove `findSeeds` strategy switch. Remove `scoreCellForStrategy`. |
| `src/city/pipeline/growthTick.js` | Compute `developmentProximity` and `industrialDistance` layers each tick. Use `developmentProximity > threshold` for eligibility instead of BFS distance grid. |
| `src/city/archetypes.js` | Update marketTown agent configs: remove `seedStrategy`/`spreadBehaviour`, add `developmentProximity` and `industrialDistance` to affinities, add `minSpacing` and `noiseWeight` fields. |
| `test/city/pipeline/growthAgents.test.js` | Simplify tests to match new interface. |
| `test/city/pipeline/growthTick.test.js` | Update for new layer computation. |

---

### Task 1: Compute per-tick spatial layers

**Files:**
- Modify: `src/city/pipeline/growthTick.js`

- [ ] **Step 1: Add developmentProximity layer computation**

At the start of `runGrowthTick`, after loading spatial layers, compute `developmentProximity`:

```js
// Build binary mask of existing development (not NONE, not AGRICULTURE)
const devMask = new Float32Array(w * h);
for (let i = 0; i < w * h; i++) {
  const v = resGrid.data[i];  // direct array access for speed
  devMask[i] = (v !== RESERVATION.NONE && v !== RESERVATION.AGRICULTURE) ? 1.0 : 0.0;
}
// On first tick, also seed from nuclei
if (state.tick === 1) {
  for (const n of map.nuclei) {
    devMask[n.gz * w + n.gx] = 1.0;
  }
}
// Box blur to create smooth proximity gradient
const devProximity = boxBlur(devMask, w, h, radiusStepCells);
layers.developmentProximity = { get: (x, z) => devProximity[z * w + x] };

// Build industrial distance layer (inverse of industrial proximity)
const indMask = new Float32Array(w * h);
for (let i = 0; i < w * h; i++) {
  indMask[i] = resGrid.data[i] === RESERVATION.INDUSTRIAL ? 1.0 : 0.0;
}
const indProximity = boxBlur(indMask, w, h, 40); // ~200m at 5m cells
// Invert: high value = far from industrial
const maxInd = Math.max(...indProximity) || 1;
const indDistance = new Float32Array(w * h);
for (let i = 0; i < w * h; i++) {
  indDistance[i] = 1.0 - indProximity[i] / maxInd;
}
layers.industrialDistance = { get: (x, z) => indDistance[z * w + x] };
```

- [ ] **Step 2: Add boxBlur utility**

```js
function boxBlur(src, w, h, radius) {
  const dst = new Float32Array(w * h);
  const tmp = new Float32Array(w * h);
  // Horizontal pass
  for (let z = 0; z < h; z++) {
    let sum = 0;
    for (let x = 0; x < Math.min(radius, w); x++) sum += src[z * w + x];
    for (let x = 0; x < w; x++) {
      const add = x + radius < w ? src[z * w + x + radius] : 0;
      const sub = x - radius - 1 >= 0 ? src[z * w + x - radius - 1] : 0;
      sum += add - sub;
      tmp[z * w + x] = sum;
    }
  }
  // Vertical pass
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let z = 0; z < Math.min(radius, h); z++) sum += tmp[z * w + x];
    for (let z = 0; z < h; z++) {
      const add = z + radius < h ? tmp[(z + radius) * w + x] : 0;
      const sub = z - radius - 1 >= 0 ? tmp[(z - radius - 1) * w + x] : 0;
      sum += add - sub;
      dst[z * w + x] = sum;
    }
  }
  // Normalise to 0-1
  let max = 0;
  for (let i = 0; i < w * h; i++) if (dst[i] > max) max = dst[i];
  if (max > 0) for (let i = 0; i < w * h; i++) dst[i] /= max;
  return dst;
}
```

- [ ] **Step 3: Replace BFS eligibility with developmentProximity threshold**

Replace the BFS distance grid and eligibility collection with:

```js
const DEV_PROXIMITY_THRESHOLD = 0.01; // any nonzero blur value = near development
const eligible = [];
for (let gz = 0; gz < h; gz++) {
  for (let gx = 0; gx < w; gx++) {
    if (zoneGrid.get(gx, gz) === 0) continue;
    if (resGrid.get(gx, gz) !== RESERVATION.NONE) continue;
    if (devProximity[gz * w + gx] < DEV_PROXIMITY_THRESHOLD) continue;
    eligible.push({ gx, gz });
  }
}
```

- [ ] **Step 4: Update agriculture fill to use developmentProximity**

```js
if (agriConfig) {
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      if (zoneGrid.get(gx, gz) === 0) continue;
      if (resGrid.get(gx, gz) !== RESERVATION.NONE) continue;
      // Agriculture fills cells that are beyond the development frontier
      // but within a band (nonzero blur from being near the frontier edge)
      const dp = devProximity[gz * w + gx];
      if (dp < DEV_PROXIMITY_THRESHOLD && dp > 0.001) {
        resGrid.set(gx, gz, RESERVATION.AGRICULTURE);
      }
    }
  }
}
```

- [ ] **Step 5: Run tests and commit**

Run: `npx vitest run test/city/pipeline/growthTick.test.js`

```bash
git add src/city/pipeline/growthTick.js
git commit -m "feat: compute developmentProximity and industrialDistance layers per tick"
```

---

### Task 2: Simplify spreadFromSeed to pure scoring

**Files:**
- Modify: `src/city/pipeline/growthAgents.js`
- Modify: `test/city/pipeline/growthAgents.test.js`

- [ ] **Step 1: Strip behaviour branches from spreadFromSeed**

Replace the `tryAdd` function's behaviour-specific scoring with pure `scoreCell`:

```js
const tryAdd = (gx, gz) => {
  const k = key(gx, gz);
  if (visited.has(k)) return;
  if (gx < 0 || gx >= w || gz < 0 || gz >= h) return;
  if (zoneGrid.get(gx, gz) === 0) return;
  if (resGrid.get(gx, gz) !== RESERVATION.NONE) return;
  visited.add(k);

  let score = scoreCell(gx, gz, affinity, layers);

  // Only variation: organic adds noise for irregular shapes
  if (behaviour === 'organic') {
    score += Math.random() * 0.3;
  }

  frontier.push({ gx, gz, score });
};
```

- [ ] **Step 2: Update the spreadBehaviour values in archetypes**

In the marketTown config, replace:
- `'linear'` → `'scored'` (commercial — road-hugging emerges from high roadFrontage affinity)
- `'blob'` → `'scored'` (industrial, openSpace, residentialEstate — shape from affinities)
- `'cluster'` → `'scored'` (residentialQuality — clustering from developmentProximity affinity)
- `'organic'` stays as `'organic'` (residentialFine)
- `'dot'` stays as `'dot'` (civic, if we want discrete plots — or switch to `'scored'` with small footprint)

- [ ] **Step 3: Update tests**

Remove tests that relied on behaviour-specific logic. Keep the core tests: blob grows to budget, dot claims seed only, doesn't overwrite, doesn't leave zone.

- [ ] **Step 4: Run tests and commit**

```bash
git add src/city/pipeline/growthAgents.js test/city/pipeline/growthAgents.test.js
git commit -m "feat: simplify spreadFromSeed to pure bitmap scoring"
```

---

### Task 3: Simplify seed strategies to pure scoring

**Files:**
- Modify: `src/city/pipeline/growthAgents.js`

- [ ] **Step 1: Replace findSeeds strategy switch with pure scoring**

```js
export function findSeeds(eligible, count, minSpacing, affinity, layers, w, h) {
  if (eligible.length === 0 || count === 0) return [];

  const scored = eligible.map(c => ({
    gx: c.gx, gz: c.gz,
    score: scoreCell(c.gx, c.gz, affinity, layers),
  }));
  scored.sort((a, b) => b.score - a.score);

  const seeds = [];
  for (const candidate of scored) {
    if (seeds.length >= count) break;
    if (minSpacing > 0) {
      let tooClose = false;
      for (const s of seeds) {
        const dx = candidate.gx - s.gx, dz = candidate.gz - s.gz;
        if (dx * dx + dz * dz < minSpacing * minSpacing) { tooClose = true; break; }
      }
      if (tooClose) continue;
    }
    seeds.push({ gx: candidate.gx, gz: candidate.gz });
  }
  return seeds;
}
```

- [ ] **Step 2: Update agent config in archetypes**

Replace `seedStrategy` with `minSpacing` (in cells). Remove `seedStrategy` field entirely.

```js
commercial: {
  share: 0.12, spreadBehaviour: 'scored',
  footprint: [100, 2000], minSpacing: 20,
  affinity: { centrality: 0.6, roadFrontage: 2.0, developmentProximity: 0.5 },
  seedsPerTick: 10,
},
```

Key affinity changes:
- **commercial**: `roadFrontage: 2.0` (very high — this makes it hug roads without hardcoded checks)
- **industrial**: `edgeness: 0.5, downwindness: 0.6, developmentProximity: 0.3`
- **civic**: `centrality: 0.7, roadFrontage: 0.3, developmentProximity: 0.5`
- **residentialQuality**: `waterfrontness: 0.4, industrialDistance: 0.6, developmentProximity: 0.5`
- **residentialEstate**: `edgeness: 0.5, developmentProximity: 0.3`
- **residentialFine**: `centrality: 0.3, roadFrontage: 0.3, developmentProximity: 0.8` (strongly prefers near existing dev)

- [ ] **Step 3: Update callers in growthTick.js**

Update `findSeeds` call to use new signature:

```js
const seeds = findSeeds(
  agentEligible, agentConfig.seedsPerTick,
  agentConfig.minSpacing || 0, agentConfig.affinity, layers, w, h
);
```

- [ ] **Step 4: Update tests and commit**

```bash
git add src/city/pipeline/growthAgents.js src/city/pipeline/growthTick.js src/city/archetypes.js test/city/pipeline/growthAgents.test.js
git commit -m "feat: simplify seed strategies to pure bitmap scoring with minSpacing"
```

---

### Task 4: Render and verify

- [ ] **Step 1: Run all fast tests**

Run: `npx vitest run --exclude 'test/rendering/prepareCityScene.test.js' --exclude 'test/city/strategies/landFirstDevelopment.test.js'`

- [ ] **Step 2: Render image**

Run: `bun scripts/render-reservations.js 884469 27 95 50`

Convert and inspect. Verify:
- No circular features
- Commercial follows road corridors (thin strips, not blobs)
- Industrial at edges
- Residential quality avoids industrial areas
- No hardcoded distance checks in the code
- Agriculture ring beyond frontier

- [ ] **Step 3: Commit any fixups**
