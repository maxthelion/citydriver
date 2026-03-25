# Experiment 012c: k3 with elevation matching + parallel filter + road clipping

## Previous state
012b restored elevation quartile face segmentation (matching 007k3). But three issues remained:
- Parallel junctions connected by distance index, not elevation — steep diagonal connections
- Adjacent terrain faces generated parallel streets that converged within 5m at boundaries
- k3 streets crossed existing roads without T-junctions

## Changes
1. **Elevation-based junction matching** — connect junctions on adjacent cross streets by closest elevation instead of sequential index. Skip connections steeper than 15% grade.
2. **Cross-face parallel separation filter** — post-process removes parallel streets within 5m of each other.
3. **Road clipping** — truncate k3 streets at existing road cells, creating T-junctions.

## Results

All 18 k3 invariant tests pass (was 2 failures on elevation consistency).

| Seed | Zone | Cross | Parallel | Junctions |
|------|------|-------|----------|-----------|
| 884469 | 0 | 68 | 244 | 273 |
| 884469 | 1 | 25 | 36 | 58 |
| 884469 | 2 | 60 | 219 | 286 |
| 42 | 0 | 28 | 115 | 173 |
| 42 | 1 | 49 | 300 | 406 |
| 42 | 2 | 26 | 123 | 186 |
| 12345 | 0 | 37 | 175 | 204 |
| 12345 | 1 | 61 | 389 | 428 |
| 12345 | 2 | 61 | 202 | 227 |

## Decision
KEEP — k3 quality now matches 007k3 baseline with additional invariant enforcement.
