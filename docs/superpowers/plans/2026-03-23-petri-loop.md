# Petri Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a behaviour-tree-driven autonomous experiment loop that evolves street layout algorithms through Darwinian selection with three-tier evaluation.

**Architecture:** A pure-function behaviour tree evaluates filesystem state each tick and dispatches one of six actions. State lives in `.petri/` on disk. A separate judge agent evaluates mutations visually. The system is invoked repeatedly via `/loop` in a worktree.

**Tech Stack:** JavaScript (ES modules), Vitest, existing `run-experiment.js` and `render-ribbon-overlay-v5.js` infrastructure.

**Spec:** `docs/superpowers/specs/2026-03-23-petri-loop-design.md`

---

## File Structure

```
src/petri/
├── evaluate.js          # Pure behaviour tree evaluation engine
├── tree.js              # Tree definition (6 condition-action pairs)
├── conditions.js        # Condition functions (read world state → boolean)
├── world.js             # Read filesystem + git state into WorldState object
├── metrics.js           # Tier 2 heuristic computation from map/render output
├── actions/
│   ├── fix-regression.js
│   ├── establish-baseline.js
│   ├── hypothesise.js
│   ├── execute-mutation.js
│   ├── spawn-judge.js
│   └── apply-verdict.js

scripts/
└── petri-tick.js        # Entry point: read state → evaluate tree → dispatch action

.petri/
├── rubric.md            # Evaluation criteria for the judge
├── review-guide.md      # Protocol for interactive morning review
└── .gitkeep

test/petri/
├── evaluate.test.js     # Behaviour tree engine tests
├── conditions.test.js   # Condition function tests
├── world.test.js        # World state reading tests
└── metrics.test.js      # Tier 2 heuristic tests
```

---

### Task 1: Behaviour Tree Engine

Port the pure evaluation engine from shoe-makers (TypeScript) to citygenerator (JavaScript ES modules). This is the foundation everything else builds on.

**Files:**
- Create: `src/petri/evaluate.js`
- Test: `test/petri/evaluate.test.js`

**Reference:** `/Users/maxwilliams/dev/shoe-makers/src/tree/evaluate.ts` — port the logic, drop the types.

- [ ] **Step 1: Write failing tests for the tree evaluator**

```javascript
// test/petri/evaluate.test.js
import { describe, it, expect } from 'vitest';
import { evaluate } from '../../src/petri/evaluate.js';

describe('evaluate', () => {
  it('selector returns first successful child', () => {
    const tree = {
      type: 'selector',
      name: 'root',
      children: [
        {
          type: 'sequence',
          name: 'first',
          children: [
            { type: 'condition', name: 'false-cond', check: () => false },
            { type: 'action', name: 'action-a', skill: 'skill-a' },
          ],
        },
        {
          type: 'sequence',
          name: 'second',
          children: [
            { type: 'condition', name: 'true-cond', check: () => true },
            { type: 'action', name: 'action-b', skill: 'skill-b' },
          ],
        },
      ],
    };
    const result = evaluate(tree, {});
    expect(result).toEqual({ status: 'success', skill: 'skill-b' });
  });

  it('selector returns failure when no child succeeds', () => {
    const tree = {
      type: 'selector',
      name: 'root',
      children: [
        {
          type: 'sequence',
          name: 'only',
          children: [
            { type: 'condition', name: 'false', check: () => false },
            { type: 'action', name: 'act', skill: 'x' },
          ],
        },
      ],
    };
    const result = evaluate(tree, {});
    expect(result).toEqual({ status: 'failure', skill: null });
  });

  it('sequence fails on first failing child', () => {
    const tree = {
      type: 'sequence',
      name: 'seq',
      children: [
        { type: 'condition', name: 'pass', check: () => true },
        { type: 'condition', name: 'fail', check: () => false },
        { type: 'action', name: 'act', skill: 'unreachable' },
      ],
    };
    const result = evaluate(tree, {});
    expect(result).toEqual({ status: 'failure', skill: null });
  });

  it('condition receives world state', () => {
    const tree = {
      type: 'condition',
      name: 'check-flag',
      check: (state) => state.flag === true,
    };
    expect(evaluate(tree, { flag: true }).status).toBe('success');
    expect(evaluate(tree, { flag: false }).status).toBe('failure');
  });

  it('action always succeeds and returns skill', () => {
    const tree = { type: 'action', name: 'do-it', skill: 'my-skill' };
    const result = evaluate(tree, {});
    expect(result).toEqual({ status: 'success', skill: 'my-skill' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run test/petri/evaluate.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the evaluator**

```javascript
// src/petri/evaluate.js

/**
 * Evaluate a behaviour tree node against world state.
 * Pure function — no side effects.
 *
 * @param {object} node - Tree node with type, name, and type-specific fields
 * @param {object} state - World state snapshot
 * @returns {{ status: 'success'|'failure', skill: string|null }}
 */
export function evaluate(node, state) {
  switch (node.type) {
    case 'selector': {
      for (const child of node.children) {
        const result = evaluate(child, state);
        if (result.status === 'success') return result;
      }
      return { status: 'failure', skill: null };
    }
    case 'sequence': {
      let lastResult = { status: 'success', skill: null };
      for (const child of node.children) {
        lastResult = evaluate(child, state);
        if (lastResult.status === 'failure') return { status: 'failure', skill: null };
      }
      return lastResult;
    }
    case 'condition': {
      const passed = node.check(state);
      return { status: passed ? 'success' : 'failure', skill: null };
    }
    case 'action': {
      return { status: 'success', skill: node.skill };
    }
    default:
      throw new Error(`Unknown node type: ${node.type}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/petri/evaluate.test.js`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/petri/evaluate.js test/petri/evaluate.test.js
git commit -m "feat(petri): add behaviour tree evaluation engine"
```

---

### Task 2: World State Reader

Reads filesystem and git state into a plain object that conditions check against.

**Files:**
- Create: `src/petri/world.js`
- Test: `test/petri/world.test.js`

- [ ] **Step 1: Write failing tests for world state reading**

```javascript
// test/petri/world.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readWorldState } from '../../src/petri/world.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('readWorldState', () => {
  let root;

  beforeEach(() => {
    root = join(tmpdir(), `petri-test-${Date.now()}`);
    mkdirSync(join(root, '.petri', 'state'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('detects missing baseline', () => {
    const state = readWorldState(root);
    expect(state.hasBaseline).toBe(false);
  });

  it('detects existing baseline', () => {
    mkdirSync(join(root, '.petri', 'baseline'), { recursive: true });
    writeFileSync(join(root, '.petri', 'baseline', 'metrics.json'), '{}');
    const state = readWorldState(root);
    expect(state.hasBaseline).toBe(true);
  });

  it('detects evidence awaiting judge', () => {
    mkdirSync(join(root, '.petri', 'evidence'), { recursive: true });
    writeFileSync(join(root, '.petri', 'evidence', 'metrics.json'), '{}');
    const state = readWorldState(root);
    expect(state.hasEvidence).toBe(true);
    expect(state.hasVerdict).toBe(false);
  });

  it('detects pending verdict', () => {
    writeFileSync(join(root, '.petri', 'state', 'verdict.md'), '# Verdict');
    const state = readWorldState(root);
    expect(state.hasVerdict).toBe(true);
  });

  it('detects work item', () => {
    writeFileSync(join(root, '.petri', 'state', 'work-item.md'), '# Work');
    const state = readWorldState(root);
    expect(state.hasWorkItem).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run test/petri/world.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement world state reader**

```javascript
// src/petri/world.js
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Read the petri loop's world state from the filesystem.
 *
 * @param {string} root - Project root directory
 * @returns {object} World state snapshot
 */
export function readWorldState(root) {
  const petri = join(root, '.petri');

  const hasBaseline = existsSync(join(petri, 'baseline', 'metrics.json'));

  const evidenceDir = join(petri, 'evidence');
  const hasEvidence = existsSync(evidenceDir) &&
    readdirSync(evidenceDir).length > 0;

  const hasVerdict = existsSync(join(petri, 'state', 'verdict.md'));
  const hasWorkItem = existsSync(join(petri, 'state', 'work-item.md'));

  const inboxDir = join(petri, 'inbox');
  const inboxMessages = existsSync(inboxDir)
    ? readdirSync(inboxDir).filter(f => f.endsWith('.md'))
    : [];

  const fitnessLogPath = join(petri, 'fitness-log.md');
  const fitnessLog = existsSync(fitnessLogPath)
    ? readFileSync(fitnessLogPath, 'utf-8')
    : '';

  const judgeDispatched = existsSync(join(petri, 'state', 'judge-dispatched'));

  return {
    hasBaseline,
    hasEvidence,
    hasVerdict,
    hasWorkItem,
    judgeDispatched,
    inboxMessages,
    fitnessLog,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/petri/world.test.js`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/petri/world.js test/petri/world.test.js
git commit -m "feat(petri): add world state reader"
```

---

### Task 3: Conditions and Tree Definition

Wire the conditions to world state and define the tree structure.

**Files:**
- Create: `src/petri/conditions.js`
- Create: `src/petri/tree.js`
- Test: `test/petri/conditions.test.js`

- [ ] **Step 1: Write failing tests for conditions**

```javascript
// test/petri/conditions.test.js
import { describe, it, expect } from 'vitest';
import { conditions } from '../../src/petri/conditions.js';

describe('conditions', () => {
  it('seedsRegressed is true when seedsRegressed flag set', () => {
    expect(conditions.seedsRegressed({ seedsRegressed: true })).toBe(true);
    expect(conditions.seedsRegressed({ seedsRegressed: false })).toBe(false);
  });

  it('noBaseline is true when hasBaseline is false', () => {
    expect(conditions.noBaseline({ hasBaseline: false })).toBe(true);
    expect(conditions.noBaseline({ hasBaseline: true })).toBe(false);
  });

  it('evidenceAwaitingJudge is true when evidence exists but no verdict and no dispatch', () => {
    expect(conditions.evidenceAwaitingJudge({ hasEvidence: true, hasVerdict: false, judgeDispatched: false })).toBe(true);
    expect(conditions.evidenceAwaitingJudge({ hasEvidence: true, hasVerdict: true, judgeDispatched: false })).toBe(false);
    expect(conditions.evidenceAwaitingJudge({ hasEvidence: false, hasVerdict: false, judgeDispatched: false })).toBe(false);
    expect(conditions.evidenceAwaitingJudge({ hasEvidence: true, hasVerdict: false, judgeDispatched: true })).toBe(false);
  });

  it('verdictPending is true when verdict exists', () => {
    expect(conditions.verdictPending({ hasVerdict: true })).toBe(true);
    expect(conditions.verdictPending({ hasVerdict: false })).toBe(false);
  });

  it('workItemExists is true when work item exists', () => {
    expect(conditions.workItemExists({ hasWorkItem: true })).toBe(true);
    expect(conditions.workItemExists({ hasWorkItem: false })).toBe(false);
  });

  it('always returns true', () => {
    expect(conditions.always({})).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run test/petri/conditions.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement conditions**

```javascript
// src/petri/conditions.js

export const conditions = {
  seedsRegressed: (state) => state.seedsRegressed === true,
  noBaseline: (state) => !state.hasBaseline,
  evidenceAwaitingJudge: (state) => state.hasEvidence && !state.hasVerdict && !state.judgeDispatched,
  verdictPending: (state) => state.hasVerdict === true,
  workItemExists: (state) => state.hasWorkItem === true,
  always: () => true,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/petri/conditions.test.js`
Expected: All 6 tests PASS

- [ ] **Step 5: Implement tree definition**

```javascript
// src/petri/tree.js
import { conditions } from './conditions.js';

function conditionAction(name, check, skill) {
  return {
    type: 'sequence',
    name,
    children: [
      { type: 'condition', name: `${name}-check`, check },
      { type: 'action', name: `${name}-action`, skill },
    ],
  };
}

export const petriTree = {
  type: 'selector',
  name: 'petri-root',
  children: [
    conditionAction('seeds-regressed', conditions.seedsRegressed, 'fix-regression'),
    conditionAction('no-baseline', conditions.noBaseline, 'establish-baseline'),
    conditionAction('evidence-awaiting-judge', conditions.evidenceAwaitingJudge, 'spawn-judge'),
    conditionAction('verdict-pending', conditions.verdictPending, 'apply-verdict'),
    conditionAction('work-item-exists', conditions.workItemExists, 'execute-mutation'),
    conditionAction('fallback', conditions.always, 'hypothesise'),
  ],
};
```

- [ ] **Step 6: Commit**

```bash
git add src/petri/conditions.js src/petri/tree.js test/petri/conditions.test.js
git commit -m "feat(petri): add conditions and tree definition"
```

---

### Task 4: Tier 2 Metrics

Compute heuristic scores from rendered map state. These gate the expensive visual evaluation.

The render script (`render-ribbon-overlay-v5.js`) logs k3/s2 line counts to stdout. These are parsed by `parseOverlayOutput`. Additional metrics from the spec (street connectivity ratio, dead-end percentage, block size distribution, plot-to-road adjacency) require access to the map object. To support this, the render script should be modified to write a `metrics.json` sidecar alongside the PNGs. The initial implementation covers what's parseable from stdout; the sidecar will be added as the system matures and we learn which metrics actually discriminate good from bad output.

**Files:**
- Create: `src/petri/metrics.js`
- Test: `test/petri/metrics.test.js`

**Reference:** `src/city/archetypeScoring.js` for how the existing system scores settlements. `scripts/render-ribbon-overlay-v5.js` for what k3/s2 metrics are already computed.

- [ ] **Step 1: Write failing tests for metrics**

```javascript
// test/petri/metrics.test.js
import { describe, it, expect } from 'vitest';
import { computeMetrics, parseOverlayOutput, compareToBaseline } from '../../src/petri/metrics.js';

describe('computeMetrics', () => {
  it('computes zone count from map zones', () => {
    const map = { zones: [{ cells: [1, 2] }, { cells: [3, 4, 5] }] };
    const metrics = computeMetrics(map, {});
    expect(metrics.zoneCount).toBe(2);
  });

  it('includes overlay stats when provided', () => {
    const overlayStats = {
      k3CrossStreets: 62,
      k3ParallelStreets: 176,
      s2SetALines: 7,
      s2SetBLines: 34,
    };
    const metrics = computeMetrics({ zones: [] }, overlayStats);
    expect(metrics.k3CrossStreets).toBe(62);
    expect(metrics.s2SetBLines).toBe(34);
  });

  it('computes connectivity ratio from road grid', () => {
    // Mock map with roadGrid and zones
    const map = {
      zones: [{ cells: [0, 1, 2, 3, 4] }],
      roadGrid: { width: 3, height: 2, data: new Uint8Array([1, 0, 1, 0, 1, 0]) },
    };
    const metrics = computeMetrics(map, {});
    expect(metrics.zoneCount).toBe(1);
  });
});

describe('parseOverlayOutput', () => {
  it('parses k3 and s2 line counts from render script stdout', () => {
    const stdout = [
      'Zone: 42360 cells, avgSlope=0.207',
      '8 terrain faces',
      'k3: 62 cross streets, 176 parallel streets, 250 junction points',
      's2: 2 anchor roads (straightness 0.87 and 0.95), 7 set A lines, 34 set B lines',
    ].join('\n');
    const stats = parseOverlayOutput(stdout);
    expect(stats.k3CrossStreets).toBe(62);
    expect(stats.k3ParallelStreets).toBe(176);
    expect(stats.s2SetALines).toBe(7);
    expect(stats.s2SetBLines).toBe(34);
  });

  it('returns zeros for unparseable output', () => {
    const stats = parseOverlayOutput('no metrics here');
    expect(stats.k3CrossStreets).toBe(0);
    expect(stats.s2SetBLines).toBe(0);
  });
});

describe('compareToBaseline', () => {
  it('passes when all metrics at or above baseline', () => {
    const baseline = { zoneCount: 10, k3CrossStreets: 50 };
    const current = { zoneCount: 12, k3CrossStreets: 55 };
    const result = compareToBaseline(current, baseline, 0.2);
    expect(result.passed).toBe(true);
    expect(result.regressions).toEqual([]);
  });

  it('fails when a metric regresses below threshold', () => {
    const baseline = { zoneCount: 10, k3CrossStreets: 50 };
    const current = { zoneCount: 5, k3CrossStreets: 55 };
    const result = compareToBaseline(current, baseline, 0.2);
    expect(result.passed).toBe(false);
    expect(result.regressions[0].metric).toBe('zoneCount');
  });

  it('allows minor regression within threshold', () => {
    const baseline = { zoneCount: 10, k3CrossStreets: 50 };
    const current = { zoneCount: 9, k3CrossStreets: 45 };
    const result = compareToBaseline(current, baseline, 0.2);
    expect(result.passed).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run test/petri/metrics.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement metrics**

```javascript
// src/petri/metrics.js

/**
 * Parse k3/s2 overlay stats from render-ribbon-overlay-v5.js stdout.
 * The render script logs lines like:
 *   k3: 62 cross streets, 176 parallel streets, 250 junction points
 *   s2: 2 anchor roads (straightness 0.87 and 0.95), 7 set A lines, 34 set B lines
 *
 * @param {string} stdout - Render script stdout
 * @returns {object} Parsed overlay stats
 */
export function parseOverlayOutput(stdout) {
  const k3Match = stdout.match(/k3:\s*(\d+)\s*cross streets,\s*(\d+)\s*parallel streets/);
  const s2Match = stdout.match(/(\d+)\s*set A lines,\s*(\d+)\s*set B lines/);

  return {
    k3CrossStreets: k3Match ? parseInt(k3Match[1], 10) : 0,
    k3ParallelStreets: k3Match ? parseInt(k3Match[2], 10) : 0,
    s2SetALines: s2Match ? parseInt(s2Match[1], 10) : 0,
    s2SetBLines: s2Match ? parseInt(s2Match[2], 10) : 0,
  };
}

/**
 * Compute tier 2 heuristic metrics from a rendered map and overlay stats.
 *
 * @param {object} map - CityMap after pipeline run
 * @param {object} overlayStats - k3/s2 line counts from overlay render
 * @returns {object} Metric scores
 */
export function computeMetrics(map, overlayStats = {}) {
  const zones = map.zones || [];

  return {
    zoneCount: zones.length,
    k3CrossStreets: overlayStats.k3CrossStreets ?? 0,
    k3ParallelStreets: overlayStats.k3ParallelStreets ?? 0,
    s2SetALines: overlayStats.s2SetALines ?? 0,
    s2SetBLines: overlayStats.s2SetBLines ?? 0,
  };
}

/**
 * Compare current metrics to baseline. Fails if any metric regresses
 * below (baseline * (1 - threshold)).
 *
 * @param {object} current - Current metric scores
 * @param {object} baseline - Baseline metric scores
 * @param {number} threshold - Allowed regression fraction (0.2 = 20%)
 * @returns {{ passed: boolean, regressions: Array<{ metric, baseline, current, floor }> }}
 */
export function compareToBaseline(current, baseline, threshold = 0.2) {
  const regressions = [];

  for (const [metric, baseVal] of Object.entries(baseline)) {
    if (typeof baseVal !== 'number') continue;
    const floor = baseVal * (1 - threshold);
    const curVal = current[metric] ?? 0;
    if (curVal < floor) {
      regressions.push({ metric, baseline: baseVal, current: curVal, floor });
    }
  }

  return { passed: regressions.length === 0, regressions };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run test/petri/metrics.test.js`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/petri/metrics.js test/petri/metrics.test.js
git commit -m "feat(petri): add tier 2 heuristic metrics"
```

---

### Task 5: Tick Entry Point

The script that reads state, evaluates the tree, and dispatches the selected action. This is what `/loop` invokes.

**Files:**
- Create: `scripts/petri-tick.js`

**Reference:** `/Users/maxwilliams/dev/shoe-makers/src/setup.ts` for the equivalent entry point pattern.

- [ ] **Step 1: Implement the tick entry point**

```javascript
// scripts/petri-tick.js
import { readWorldState } from '../src/petri/world.js';
import { petriTree } from '../src/petri/tree.js';
import { evaluate } from '../src/petri/evaluate.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

async function tick() {
  console.log('[petri] Reading world state...');
  const state = readWorldState(root);
  console.log('[petri] State:', JSON.stringify(state, null, 2));

  console.log('[petri] Evaluating tree...');
  const result = evaluate(petriTree, state);

  if (result.status === 'failure' || !result.skill) {
    console.log('[petri] No action selected. This should not happen (fallback is always-true).');
    process.exit(1);
  }

  console.log(`[petri] Selected action: ${result.skill}`);

  const actionModule = await import(`../src/petri/actions/${result.skill}.js`);
  await actionModule.run(root, state);

  console.log(`[petri] Action ${result.skill} complete.`);
}

tick().catch((err) => {
  console.error('[petri] Tick failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify the tick script loads without crashing**

Run: `node --check scripts/petri-tick.js`
Expected: No syntax errors (the actual run will fail because actions don't exist yet — that's fine)

- [ ] **Step 3: Commit**

```bash
git add scripts/petri-tick.js
git commit -m "feat(petri): add tick entry point script"
```

---

### Task 6: Scaffold `.petri/` Directory and Static Files

Create the rubric, review guide, and directory structure.

**Files:**
- Create: `.petri/rubric.md`
- Create: `.petri/review-guide.md`
- Create: `.petri/.gitkeep` files for empty dirs
- Modify: `.gitignore`

- [ ] **Step 1: Create rubric**

```markdown
<!-- .petri/rubric.md -->
# Evaluation Rubric

Score each criterion 1-10. A score of 5 means equivalent to baseline.

## Criteria

### Street Block Coherence (weight: 0.25)
Do the streets form recognisable blocks? Are there enclosed areas that could contain buildings?
- 1-3: Chaotic lines with no clear blocks
- 4-6: Some blocks visible but irregular or broken
- 7-10: Clear, coherent block structure throughout

### Grid-Organic Transition (weight: 0.25)
Are streets grid-like near anchor roads and organic deeper in terrain?
- 1-3: No visible transition, one system dominates or they clash
- 4-6: Some transition visible but abrupt or inconsistent
- 7-10: Smooth, natural transition between grid and organic

### Artifact Freedom (weight: 0.2)
Are there overlapping lines, orphaned segments, impossible intersections, or other visual artifacts?
- 1-3: Many obvious artifacts
- 4-6: A few minor artifacts
- 7-10: Clean, no visible artifacts

### Neighbourhood Realism (weight: 0.2)
Does this look like a real neighbourhood you might find in a city?
- 1-3: Does not resemble any real street pattern
- 4-6: Somewhat plausible but clearly artificial
- 7-10: Could pass for a real neighbourhood at this zoom level

### Seed Consistency (weight: 0.1)
Does the character hold across the zone? Is there a coherent "theme" rather than random noise?
- 1-3: Random, incoherent
- 4-6: Mostly consistent with some jarring areas
- 7-10: Coherent character throughout
```

- [ ] **Step 2: Create review guide**

```markdown
<!-- .petri/review-guide.md -->
# Morning Review Protocol

When the user asks to review petri results, follow this flow:

## 1. Summary
Read `.petri/fitness-log.md` and summarise:
- How many ticks ran
- How many hypotheses were tested
- How many were promoted vs rejected
- Net baseline fitness change

## 2. Walk Through Each Attempt
For each attempt in the fitness log, in chronological order:
1. Show what was tried and why (from the log entry)
2. Show the rendered PNGs — baseline vs attempt side by side
3. Show tier 2 metric deltas (table format)
4. Show the judge's verdict and reasoning
5. Ask: "Do you agree with this verdict?"

## 3. Collect Corrections
If the user disagrees:
- Ask them to explain why
- Write their correction into the fitness log entry under **Human correction:**
- If the user thinks a promoted baseline was bad, revert to the previous baseline
- If the user thinks a rejected attempt was good, offer to resurrect it from git history

## 4. Steer Next Run
Ask: "Any direction you want to give for the next run?"
If yes, write their guidance as a markdown file in `.petri/inbox/`.

## 5. Close
Summarise corrections made and any inbox messages written.
```

- [ ] **Step 3: Create directory structure and update .gitignore**

Create `.petri/baseline/.gitkeep`, `.petri/evidence/.gitkeep`, `.petri/state/.gitkeep`, `.petri/inbox/.gitkeep`.

Add to `.gitignore`:
```
# Petri loop ephemeral state
.petri/baseline/
.petri/evidence/
.petri/state/
!.petri/baseline/.gitkeep
!.petri/evidence/.gitkeep
!.petri/state/.gitkeep
```

- [ ] **Step 4: Commit**

```bash
git add .petri/ .gitignore
git commit -m "feat(petri): scaffold .petri directory with rubric and review guide"
```

---

### Task 7: Action — `fix-regression`

The first action the system will execute. Detects and fixes seed regressions.

**Files:**
- Create: `src/petri/actions/fix-regression.js`

**Context needed:** The agent implementing this will need to understand that seed 884469 stopped producing usable zones after the v5 refactor (commit 19a8873). The action should:
1. Try rendering each standard seed
2. Check if zones are produced
3. If not, investigate git log for what changed and make a fix

- [ ] **Step 1: Implement fix-regression action**

```javascript
// src/petri/actions/fix-regression.js
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';

/**
 * Detect and fix seed regressions. Runs standard seeds through the pipeline
 * and checks for failures. If a seed fails, investigates and attempts a fix.
 *
 * This action is a prompt for an agent — it writes a diagnostic report
 * and the agent (Claude) interprets it and makes code changes.
 */
export async function run(root, state) {
  const seeds = [
    { seed: 884469, gx: 27, gz: 95 },
    { seed: 42, gx: 15, gz: 50 },
    { seed: 12345, gx: 20, gz: 60 },
  ];

  const failures = [];

  for (const { seed, gx, gz } of seeds) {
    try {
      const result = execSync(
        `node scripts/render-pipeline.js --seed ${seed} --gx ${gx} --gz ${gz} --layers zones --out .petri/state/regression-check`,
        { cwd: root, timeout: 120000, encoding: 'utf-8', stdio: 'pipe' }
      );
      console.log(`[petri] Seed ${seed}: OK`);
    } catch (err) {
      console.log(`[petri] Seed ${seed}: FAILED`);
      failures.push({ seed, gx, gz, error: err.stderr || err.message });
    }
  }

  if (failures.length === 0) {
    console.log('[petri] No seed regressions detected.');
    // Mark regression check as passed by creating a marker file
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(root, '.petri', 'state', 'seeds-ok'), '');
    return;
  }

  // Log the failures for the agent to investigate
  const report = failures.map(f =>
    `## Seed ${f.seed} (gx=${f.gx}, gz=${f.gz})\n\n\`\`\`\n${f.error}\n\`\`\``
  ).join('\n\n');

  const logEntry = `\n## Regression Fix — ${new Date().toISOString()}\n\n${report}\n`;
  const logPath = join(root, '.petri', 'fitness-log.md');
  mkdirSync(join(root, '.petri'), { recursive: true });
  appendFileSync(logPath, logEntry);

  console.log(`[petri] ${failures.length} seed(s) failed. Dispatching fix subagent...`);

  // Invoke a subagent to investigate and fix the regression
  const { execFileSync } = await import('node:child_process');
  const fixPrompt = [
    'You are fixing a seed regression in the city generator pipeline.',
    'The following seeds failed to produce usable output:',
    '',
    report,
    '',
    'Context:',
    '- Seed 884469 stopped producing usable zones after the v5 refactor (see commit 19a8873)',
    '- Experiment 007s7 was the last known good state for this seed',
    '- Check git log for recent refactoring changes',
    '- Read specs/v5/zones-refine-fix-plan.md for the zones-refine bug investigation',
    '- Read the experiment notes in experiments/007s7-straightness.md and experiments/007s8-straightness-repro.md',
    '',
    'Investigate the root cause and make a targeted fix. Commit your changes.',
    'Focus on making all standard seeds produce usable zones again.',
  ].join('\n');

  try {
    execFileSync('claude', ['-p', '--output-format', 'text'], {
      input: fixPrompt,
      cwd: root,
      timeout: 600000, // 10 min — regression fixes may need investigation
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Verify the fix worked by re-rendering
    let stillBroken = false;
    for (const { seed, gx, gz } of seeds) {
      try {
        execSync(
          `node scripts/render-pipeline.js --seed ${seed} --gx ${gx} --gz ${gz} --layers zones --out .petri/state/regression-check`,
          { cwd: root, timeout: 120000, encoding: 'utf-8', stdio: 'pipe' }
        );
      } catch {
        stillBroken = true;
      }
    }

    if (!stillBroken) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(root, '.petri', 'state', 'seeds-ok'), '');
      console.log('[petri] Regression fixed! All seeds producing output.');
    } else {
      console.log('[petri] Fix attempt did not resolve all seeds. Will retry next tick.');
    }
  } catch (err) {
    console.log('[petri] Fix subagent failed:', err.message);
    console.log('[petri] Will retry next tick.');
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/petri/actions/fix-regression.js
git commit -m "feat(petri): add fix-regression action"
```

---

### Task 8: Action — `establish-baseline`

Renders all standard seeds with the 007s7 overlay, computes metrics, saves as baseline.

**Files:**
- Create: `src/petri/actions/establish-baseline.js`

**Reference:** `scripts/render-ribbon-overlay-v5.js` — this is the script that renders the k3+s2 overlay.

- [ ] **Step 1: Implement establish-baseline action**

```javascript
// src/petri/actions/establish-baseline.js
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { parseOverlayOutput } from '../metrics.js';

const STANDARD_SEEDS = [
  { seed: 884469, gx: 27, gz: 95 },
  { seed: 42, gx: 15, gz: 50 },
  { seed: 12345, gx: 20, gz: 60 },
];

export async function run(root, state) {
  const baselineDir = join(root, '.petri', 'baseline');
  mkdirSync(baselineDir, { recursive: true });

  const tempOut = join(root, '.petri', 'state', 'baseline-render');
  mkdirSync(tempOut, { recursive: true });

  const perSeedMetrics = {};

  for (const { seed, gx, gz } of STANDARD_SEEDS) {
    console.log(`[petri] Rendering baseline for seed ${seed}...`);

    // Run the overlay render script — capture stdout for metric parsing
    const stdout = execSync(
      `node scripts/render-ribbon-overlay-v5.js ${seed} ${gx} ${gz} ${tempOut}`,
      { cwd: root, timeout: 120000, encoding: 'utf-8', stdio: 'pipe' }
    );

    // Parse k3/s2 metrics from stdout
    perSeedMetrics[seed] = parseOverlayOutput(stdout);
    console.log(`[petri] Seed ${seed}: ${JSON.stringify(perSeedMetrics[seed])}`);

    // Copy PNGs to baseline directory
    const pngs = readdirSync(tempOut).filter(f => f.endsWith('.png') && f.includes(`seed${seed}`));
    for (const png of pngs) {
      copyFileSync(join(tempOut, png), join(baselineDir, png));
    }
  }

  // Aggregate metrics across seeds (average)
  const metricKeys = ['k3CrossStreets', 'k3ParallelStreets', 's2SetALines', 's2SetBLines'];
  const aggregated = {};
  for (const key of metricKeys) {
    const values = Object.values(perSeedMetrics).map(m => m[key] || 0);
    aggregated[key] = values.reduce((a, b) => a + b, 0) / values.length;
  }

  // Write baseline metrics (these are what compareToBaseline checks against)
  writeFileSync(
    join(baselineDir, 'metrics.json'),
    JSON.stringify({
      ...aggregated,
      seeds: STANDARD_SEEDS,
      perSeed: perSeedMetrics,
      timestamp: new Date().toISOString(),
    }, null, 2)
  );

  console.log('[petri] Baseline established.');
}
```

- [ ] **Step 2: Commit**

```bash
git add src/petri/actions/establish-baseline.js
git commit -m "feat(petri): add establish-baseline action"
```

---

### Task 9: Action — `hypothesise`

Reads fitness log, experiment history, and inbox. Writes a work-item.md with a mutation plan.

**Files:**
- Create: `src/petri/actions/hypothesise.js`

- [ ] **Step 1: Implement hypothesise action**

This action produces a work-item.md that describes what code change to make. The actual intelligence comes from the agent (Claude) reading context and deciding. The action scaffolds the context and writes the prompt.

```javascript
// src/petri/actions/hypothesise.js
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export async function run(root, state) {
  const petri = join(root, '.petri');

  // Read fitness log for history and corrections
  const fitnessLog = state.fitnessLog || '';

  // Read inbox messages (highest priority)
  const inboxDir = join(petri, 'inbox');
  const inboxMessages = existsSync(inboxDir)
    ? readdirSync(inboxDir)
        .filter(f => f.endsWith('.md'))
        .map(f => readFileSync(join(inboxDir, f), 'utf-8'))
    : [];

  // Read baseline metrics
  const baselineMetrics = existsSync(join(petri, 'baseline', 'metrics.json'))
    ? JSON.parse(readFileSync(join(petri, 'baseline', 'metrics.json'), 'utf-8'))
    : {};

  // Determine if this is an exploration tick (20% chance)
  const isExploration = Math.random() < 0.2;

  // Build the work item prompt
  const workItem = [
    '# Work Item',
    '',
    `**Generated:** ${new Date().toISOString()}`,
    `**Mode:** ${isExploration ? 'EXPLORATION (20% wild)' : 'EXPLOITATION (80% incremental)'}`,
    '',
    '## Context',
    '',
    '### Inbox Messages',
    inboxMessages.length > 0
      ? inboxMessages.join('\n\n---\n\n')
      : '_No inbox messages._',
    '',
    '### Baseline Metrics',
    '```json',
    JSON.stringify(baselineMetrics, null, 2),
    '```',
    '',
    '### Fitness History (recent)',
    fitnessLog.slice(-3000) || '_No history yet._',
    '',
    '## Instructions',
    '',
    isExploration
      ? 'This is an EXPLORATION tick. Try something deliberately different from recent attempts. Consider: a fundamentally different approach, reverting to an earlier strategy, wild parameter swings, or ideas from experiment history that were never pursued.'
      : 'This is an EXPLOITATION tick. Make an incremental improvement to the current best. Focus on the weakest scoring criterion from recent evaluations.',
    '',
    '## Task',
    '',
    'Based on the context above, decide on ONE specific code change to try.',
    'Write your plan below, then implement it.',
    '',
    '### Hypothesis',
    '',
    '_Agent fills this in: what change and why_',
    '',
    '### Files to Modify',
    '',
    '_Agent fills this in: specific file paths and changes_',
  ].join('\n');

  writeFileSync(join(petri, 'state', 'work-item.md'), workItem);
  console.log(`[petri] Work item written (${isExploration ? 'exploration' : 'exploitation'} mode).`);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/petri/actions/hypothesise.js
git commit -m "feat(petri): add hypothesise action"
```

---

### Task 10: Action — `execute-mutation`

Two-phase action. Phase 1: invoke a Claude subagent to read work-item.md and make the code changes described, committing the result. Phase 2: run the programmatic evaluation (tests, renders, tier 2 metrics). If the subagent fails to make changes, the action rejects immediately.

**Files:**
- Create: `src/petri/actions/execute-mutation.js`

- [ ] **Step 1: Implement execute-mutation action**

```javascript
// src/petri/actions/execute-mutation.js
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseOverlayOutput, compareToBaseline } from '../metrics.js';

const STANDARD_SEEDS = [
  { seed: 884469, gx: 27, gz: 95 },
  { seed: 42, gx: 15, gz: 50 },
  { seed: 12345, gx: 20, gz: 60 },
];

export async function run(root, state) {
  const petri = join(root, '.petri');
  const workItem = readFileSync(join(petri, 'state', 'work-item.md'), 'utf-8');

  console.log('[petri] Executing mutation from work item...');

  // Save current HEAD so we can detect if the subagent committed anything
  const headBefore = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf-8', stdio: 'pipe' }).trim();

  // Phase 1: Invoke Claude subagent to make code changes.
  // Prompt piped via stdin to avoid shell escaping issues.
  console.log('[petri] Dispatching mutation subagent...');
  try {
    const { execFileSync } = await import('node:child_process');
    const mutationPrompt = [
      'You are implementing a code mutation for the petri loop experiment system.',
      'Read the work item below and make the EXACT code changes described.',
      'Commit your changes with a descriptive message.',
      'Do NOT run tests or renders — that happens separately.',
      '',
      workItem,
    ].join('\n');
    execFileSync('claude', ['-p', '--output-format', 'text'], {
      input: mutationPrompt,
      cwd: root,
      timeout: 300000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    console.log('[petri] Mutation subagent failed.');
    writeFileSync(join(petri, 'state', 'verdict.md'),
      `# Verdict\n\n**Decision:** REJECT\n**Reason:** Mutation subagent failed to make code changes.\n\n\`\`\`\n${err.message?.slice(0, 2000)}\n\`\`\``
    );
    return;
  }

  // Check that the subagent actually committed something
  const headAfter = execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf-8', stdio: 'pipe' }).trim();
  if (headAfter === headBefore) {
    writeFileSync(join(petri, 'state', 'verdict.md'),
      '# Verdict\n\n**Decision:** REJECT\n**Reason:** Mutation subagent made no code changes.\n'
    );
    return;
  }
  const diff = execSync(`git diff ${headBefore}..HEAD --stat`, { cwd: root, encoding: 'utf-8', stdio: 'pipe' });
  console.log(`[petri] Mutation committed. Changes:\n${diff}`);

  // Phase 2: Evaluate the mutation
  console.log('[petri] Evaluating mutation...');

  // Tier 1: Run tests
  try {
    execSync('bunx vitest run', { cwd: root, timeout: 120000, stdio: 'pipe' });
    console.log('[petri] Tier 1: Tests pass.');
  } catch (err) {
    console.log('[petri] Tier 1 FAIL: Tests failed.');
    writeFileSync(join(petri, 'state', 'verdict.md'),
      `# Verdict\n\n**Decision:** REJECT\n**Reason:** Tier 1 failure — tests did not pass.\n\n\`\`\`\n${err.stderr?.slice(0, 2000) || err.message}\n\`\`\``
    );
    return;
  }

  // Tier 1: Render all seeds, capturing stdout for metric parsing
  const evidenceDir = join(petri, 'evidence');
  mkdirSync(evidenceDir, { recursive: true });

  const perSeedMetrics = {};

  for (const { seed, gx, gz } of STANDARD_SEEDS) {
    try {
      const stdout = execSync(
        `node scripts/render-ribbon-overlay-v5.js ${seed} ${gx} ${gz} ${evidenceDir}`,
        { cwd: root, timeout: 120000, encoding: 'utf-8', stdio: 'pipe' }
      );
      // Parse k3/s2 metrics from render script stdout
      perSeedMetrics[seed] = parseOverlayOutput(stdout);
      console.log(`[petri] Seed ${seed}: rendered. ${JSON.stringify(perSeedMetrics[seed])}`);
    } catch (err) {
      console.log(`[petri] Tier 1 FAIL: Seed ${seed} render failed.`);
      writeFileSync(join(petri, 'state', 'verdict.md'),
        `# Verdict\n\n**Decision:** REJECT\n**Reason:** Tier 1 failure — seed ${seed} failed to render.\n\n\`\`\`\n${err.stderr?.slice(0, 2000) || err.message}\n\`\`\``
      );
      return;
    }
  }

  // Tier 2: Aggregate metrics across seeds and compare to baseline
  const metricKeys = ['k3CrossStreets', 'k3ParallelStreets', 's2SetALines', 's2SetBLines'];
  const currentMetrics = {};
  for (const key of metricKeys) {
    const values = Object.values(perSeedMetrics).map(m => m[key] || 0);
    currentMetrics[key] = values.reduce((a, b) => a + b, 0) / values.length;
  }

  const baselinePath = join(petri, 'baseline', 'metrics.json');
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));

  const comparison = compareToBaseline(currentMetrics, baseline);
  if (!comparison.passed) {
    console.log('[petri] Tier 2 FAIL: Metrics regressed below threshold.');
    writeFileSync(join(petri, 'state', 'verdict.md'),
      `# Verdict\n\n**Decision:** REJECT\n**Reason:** Tier 2 failure — metrics regressed.\n\n` +
      comparison.regressions.map(r =>
        `- ${r.metric}: ${r.current} < floor ${r.floor} (baseline: ${r.baseline})`
      ).join('\n')
    );
    return;
  }

  // Write evidence metrics for the judge
  writeFileSync(join(evidenceDir, 'metrics.json'),
    JSON.stringify({
      metrics: currentMetrics,
      perSeed: perSeedMetrics,
      comparison,
      timestamp: new Date().toISOString(),
    }, null, 2)
  );

  console.log('[petri] Tiers 1+2 passed. Evidence ready for judge.');
}
```

- [ ] **Step 2: Commit**

```bash
git add src/petri/actions/execute-mutation.js
git commit -m "feat(petri): add execute-mutation action"
```

---

### Task 11: Action — `spawn-judge`

Launches a separate agent to evaluate the mutation visually.

**Files:**
- Create: `src/petri/actions/spawn-judge.js`

- [ ] **Step 1: Implement spawn-judge action**

```javascript
// src/petri/actions/spawn-judge.js
import { readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Spawn a judge agent with fresh context. In practice, this writes
 * a judge prompt file that the orchestrating agent (Claude) reads
 * and dispatches as a subagent.
 *
 * The judge receives:
 * - Baseline PNGs (paths)
 * - Evidence PNGs (paths)
 * - Tier 2 metrics comparison
 * - Rubric
 * - Fitness log with human corrections
 *
 * The judge does NOT receive:
 * - The work-item.md (mutation reasoning)
 * - The code diff
 */
export async function run(root, state) {
  const petri = join(root, '.petri');

  const rubric = readFileSync(join(petri, 'rubric.md'), 'utf-8');
  const fitnessLog = readFileSync(join(petri, 'fitness-log.md'), 'utf-8').slice(-5000);
  const evidenceMetrics = readFileSync(join(petri, 'evidence', 'metrics.json'), 'utf-8');

  const baselinePngs = readdirSync(join(petri, 'baseline'))
    .filter(f => f.endsWith('.png'))
    .map(f => join(petri, 'baseline', f));

  const evidencePngs = readdirSync(join(petri, 'evidence'))
    .filter(f => f.endsWith('.png'))
    .map(f => join(petri, 'evidence', f));

  const judgePrompt = [
    '# Judge Evaluation',
    '',
    'You are evaluating a mutation to a city generator\'s street layout algorithm.',
    'You will compare the BASELINE (current best) against the EVIDENCE (new attempt).',
    '',
    '## Rubric',
    rubric,
    '',
    '## Metrics Comparison',
    '```json',
    evidenceMetrics,
    '```',
    '',
    '## Baseline Images',
    ...baselinePngs.map(p => `- ${p}`),
    '',
    '## Evidence Images',
    ...evidencePngs.map(p => `- ${p}`),
    '',
    '## Past Corrections (learn from these)',
    fitnessLog || '_No history yet._',
    '',
    '## Instructions',
    '',
    '1. Read each baseline image and its corresponding evidence image',
    '2. Score each rubric criterion 1-10',
    '3. Compute weighted overall score',
    '4. Compare to baseline (5 = equivalent)',
    '5. Decision: KEEP if overall > 5.5, REJECT otherwise',
    '',
    '## Output Format',
    '',
    'Write your verdict as:',
    '```',
    '# Verdict',
    '',
    '**Decision:** KEEP or REJECT',
    '**Overall Score:** N.N/10',
    '',
    '## Scores',
    '- Street Block Coherence: N/10 — reasoning',
    '- Grid-Organic Transition: N/10 — reasoning',
    '- Artifact Freedom: N/10 — reasoning',
    '- Neighbourhood Realism: N/10 — reasoning',
    '- Seed Consistency: N/10 — reasoning',
    '',
    '## Reasoning',
    'Overall assessment...',
    '```',
  ].join('\n');

  writeFileSync(join(petri, 'state', 'judge-prompt.md'), judgePrompt);

  // Create marker to prevent re-dispatch on next tick
  writeFileSync(join(petri, 'state', 'judge-dispatched'), '');

  // Invoke Claude CLI as a subagent WITH tool access (no --print flag).
  // The subagent needs the Read tool to view PNG images from disk.
  // Prompt is piped via stdin to avoid shell escaping issues.
  console.log('[petri] Dispatching judge subagent...');
  try {
    const { execFileSync } = await import('node:child_process');
    const verdictPath = join(petri, 'state', 'verdict.md');
    // Use -p with stdin pipe. The subagent gets full tool access
    // and can use Read to examine the PNG files listed in the prompt.
    execFileSync('claude', ['-p', '--output-format', 'text'], {
      input: judgePrompt + `\n\nWrite your verdict to: ${verdictPath}`,
      cwd: root,
      timeout: 300000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Clean up dispatch marker now that verdict exists
    rmSync(join(petri, 'state', 'judge-dispatched'), { force: true });
    console.log('[petri] Judge verdict written.');
  } catch (err) {
    console.log('[petri] Judge subagent failed:', err.message);
    rmSync(join(petri, 'state', 'judge-dispatched'), { force: true });
    // Write a default reject verdict so the cycle can continue
    writeFileSync(join(petri, 'state', 'verdict.md'),
      '# Verdict\n\n**Decision:** REJECT\n**Overall Score:** 0/10\n**Reason:** Judge agent failed to produce verdict.\n'
    );
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/petri/actions/spawn-judge.js
git commit -m "feat(petri): add spawn-judge action"
```

---

### Task 12: Action — `apply-verdict`

Reads the judge's verdict and promotes or reverts.

**Files:**
- Create: `src/petri/actions/apply-verdict.js`

- [ ] **Step 1: Implement apply-verdict action**

```javascript
// src/petri/actions/apply-verdict.js
import { readFileSync, writeFileSync, rmSync, cpSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

export async function run(root, state) {
  const petri = join(root, '.petri');
  const verdict = readFileSync(join(petri, 'state', 'verdict.md'), 'utf-8');

  const isKeep = /\*\*Decision:\*\*\s*KEEP/i.test(verdict);
  const scoreMatch = verdict.match(/\*\*Overall Score:\*\*\s*([\d.]+)/);
  const score = scoreMatch ? parseFloat(scoreMatch[1]) : null;

  const workItem = existsSync(join(petri, 'state', 'work-item.md'))
    ? readFileSync(join(petri, 'state', 'work-item.md'), 'utf-8')
    : '_Work item not found_';

  // Extract hypothesis from work item
  const hypothesisMatch = workItem.match(/### Hypothesis\n\n([\s\S]*?)(\n###|$)/);
  const hypothesis = hypothesisMatch ? hypothesisMatch[1].trim() : '_Unknown_';

  if (isKeep) {
    console.log(`[petri] KEEP (${score}/10). Promoting to baseline.`);

    // Promote evidence to baseline
    rmSync(join(petri, 'baseline'), { recursive: true, force: true });
    cpSync(join(petri, 'evidence'), join(petri, 'baseline'), { recursive: true });
  } else {
    console.log(`[petri] REJECT (${score}/10). Reverting.`);

    // Revert the last commit (the mutation)
    try {
      execSync('git revert HEAD --no-edit', { cwd: root, stdio: 'pipe' });
      console.log('[petri] Reverted mutation commit.');
    } catch (err) {
      console.log('[petri] Warning: could not auto-revert. Manual cleanup may be needed.');
    }
  }

  // Append to fitness log
  const logEntry = [
    '',
    `## Attempt — ${new Date().toISOString()}`,
    `**Hypothesis:** ${hypothesis}`,
    `**Judge verdict:** ${isKeep ? 'KEEP' : 'REJECT'} (${score}/10)`,
    `**Baseline updated:** ${isKeep ? 'yes' : 'no'}`,
    '',
    verdict.split('\n').map(l => `> ${l}`).join('\n'),
    '',
    '**Human correction:** _(none yet)_',
    '',
  ].join('\n');

  appendFileSync(join(petri, 'fitness-log.md'), logEntry);

  // Clean up state for next cycle
  rmSync(join(petri, 'evidence'), { recursive: true, force: true });
  rmSync(join(petri, 'state', 'verdict.md'), { force: true });
  rmSync(join(petri, 'state', 'work-item.md'), { force: true });
  rmSync(join(petri, 'state', 'judge-prompt.md'), { force: true });

  console.log('[petri] Verdict applied. Ready for next hypothesis.');
}
```

- [ ] **Step 2: Commit**

```bash
git add src/petri/actions/apply-verdict.js
git commit -m "feat(petri): add apply-verdict action"
```

---

### Task 13: Seed Regression Detection in World State

The `seedsRegressed` condition needs to actually check whether seeds produce usable output. This extends the world state reader.

**Files:**
- Modify: `src/petri/world.js`
- Modify: `test/petri/world.test.js`

- [ ] **Step 1: Add seedsRegressed check to world state**

The regression check is expensive (runs renders), so it should only run once and be cached as a marker file (`.petri/state/seeds-ok`). If the marker doesn't exist, the condition is true (seeds might be regressed). The `fix-regression` action creates the marker when seeds pass.

Add to `readWorldState`:
```javascript
const seedsChecked = existsSync(join(petri, 'state', 'seeds-ok'));
// If seeds haven't been verified yet, assume regressed
return {
  ...existing,
  seedsRegressed: !seedsChecked,
};
```

- [ ] **Step 2: Add test for seedsRegressed**

```javascript
it('seedsRegressed is true when seeds-ok marker missing', () => {
  const state = readWorldState(root);
  expect(state.seedsRegressed).toBe(true);
});

it('seedsRegressed is false when seeds-ok marker exists', () => {
  writeFileSync(join(root, '.petri', 'state', 'seeds-ok'), '');
  const state = readWorldState(root);
  expect(state.seedsRegressed).toBe(false);
});
```

- [ ] **Step 3: Run tests**

Run: `bunx vitest run test/petri/world.test.js`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/petri/world.js test/petri/world.test.js
git commit -m "feat(petri): add seed regression detection to world state"
```

---

### Task 14: Integration Smoke Test

Verify the full tick cycle works end-to-end with a mocked filesystem.

**Files:**
- Create: `test/petri/tick-integration.test.js`

- [ ] **Step 1: Write integration test**

```javascript
// test/petri/tick-integration.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readWorldState } from '../../src/petri/world.js';
import { petriTree } from '../../src/petri/tree.js';
import { evaluate } from '../../src/petri/evaluate.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('petri tick integration', () => {
  let root;

  beforeEach(() => {
    root = join(tmpdir(), `petri-integration-${Date.now()}`);
    mkdirSync(join(root, '.petri', 'state'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('selects fix-regression when seeds not checked', () => {
    const state = readWorldState(root);
    const result = evaluate(petriTree, state);
    expect(result.skill).toBe('fix-regression');
  });

  it('selects establish-baseline after seeds pass', () => {
    writeFileSync(join(root, '.petri', 'state', 'seeds-ok'), '');
    const state = readWorldState(root);
    const result = evaluate(petriTree, state);
    expect(result.skill).toBe('establish-baseline');
  });

  it('selects spawn-judge when evidence exists without verdict', () => {
    writeFileSync(join(root, '.petri', 'state', 'seeds-ok'), '');
    mkdirSync(join(root, '.petri', 'baseline'), { recursive: true });
    writeFileSync(join(root, '.petri', 'baseline', 'metrics.json'), '{}');
    mkdirSync(join(root, '.petri', 'evidence'), { recursive: true });
    writeFileSync(join(root, '.petri', 'evidence', 'metrics.json'), '{}');
    const state = readWorldState(root);
    const result = evaluate(petriTree, state);
    expect(result.skill).toBe('spawn-judge');
  });

  it('selects apply-verdict when verdict exists', () => {
    writeFileSync(join(root, '.petri', 'state', 'seeds-ok'), '');
    mkdirSync(join(root, '.petri', 'baseline'), { recursive: true });
    writeFileSync(join(root, '.petri', 'baseline', 'metrics.json'), '{}');
    writeFileSync(join(root, '.petri', 'state', 'verdict.md'), '# Verdict');
    const state = readWorldState(root);
    const result = evaluate(petriTree, state);
    expect(result.skill).toBe('apply-verdict');
  });

  it('selects execute-mutation when work item exists', () => {
    writeFileSync(join(root, '.petri', 'state', 'seeds-ok'), '');
    mkdirSync(join(root, '.petri', 'baseline'), { recursive: true });
    writeFileSync(join(root, '.petri', 'baseline', 'metrics.json'), '{}');
    writeFileSync(join(root, '.petri', 'state', 'work-item.md'), '# Work');
    const state = readWorldState(root);
    const result = evaluate(petriTree, state);
    expect(result.skill).toBe('execute-mutation');
  });

  it('selects hypothesise as fallback', () => {
    writeFileSync(join(root, '.petri', 'state', 'seeds-ok'), '');
    mkdirSync(join(root, '.petri', 'baseline'), { recursive: true });
    writeFileSync(join(root, '.petri', 'baseline', 'metrics.json'), '{}');
    const state = readWorldState(root);
    const result = evaluate(petriTree, state);
    expect(result.skill).toBe('hypothesise');
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `bunx vitest run test/petri/tick-integration.test.js`
Expected: All 6 tests PASS

- [ ] **Step 3: Commit**

```bash
git add test/petri/tick-integration.test.js
git commit -m "test(petri): add tick integration smoke test"
```

---

### Task 15: Run Full Test Suite

Verify nothing is broken and all petri tests pass together.

- [ ] **Step 1: Run all petri tests**

Run: `bunx vitest run test/petri/`
Expected: All tests pass (evaluate, conditions, world, metrics, tick-integration)

- [ ] **Step 2: Run existing test suite**

Run: `bunx vitest run`
Expected: All existing tests still pass (no regressions)

- [ ] **Step 3: Manual smoke test of petri-tick.js**

Run: `node scripts/petri-tick.js`
Expected: Reads state, evaluates tree, selects `fix-regression` (since `.petri/state/seeds-ok` won't exist), attempts to run seed checks. May fail on the actual render (that's OK — it proves the wiring works).

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix(petri): address issues found in smoke test"
```
