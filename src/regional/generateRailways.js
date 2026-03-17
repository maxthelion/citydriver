/**
 * Generate regional railway network.
 * Routes railways between settlements and off-map cities using
 * terrain-weighted A* with railway-specific cost function.
 *
 * Built in 4 historical phases:
 *   Phase 1: Main line (tier-1 settlement → capital off-map city)
 *   Phase 2: Secondary trunks (tier-1 → other off-map cities, tier-2 → trunk)
 *   Phase 3: Branch lines (tier-3 → nearest existing line junction)
 *   Phase 4: Cross-country (off-map → off-map through region)
 */

import { railwayCostFunction } from '../core/railwayCost.js';
import { findPath, simplifyPath } from '../core/pathfinding.js';
import { distance2D } from '../core/math.js';
import { Grid2D } from '../core/Grid2D.js';

/**
 * @param {object} params - { width, height, cellSize }
 * @param {Array} settlements - [{ gx, gz, tier }]
 * @param {Array} offMapCities - [{ gx, gz, importance, role }]
 * @param {import('../core/Grid2D.js').Grid2D} elevation
 * @param {import('../core/Grid2D.js').Grid2D|null} slope
 * @param {import('../core/Grid2D.js').Grid2D} waterMask
 * @returns {{ railways: Array, railGrid: Grid2D }}
 *
 * Deferred features (see wiki/pages/railway-network.md):
 * - Per-phase gradient constraints (trunk 1.5%, branch 3%)
 * - Curvature penalty in cost function
 * - Tunnel detection and routing
 * - Terminus fan-shape station geometry
 * - City inheritance of railway alignments
 */
export function generateRailways(params, settlements, offMapCities, elevation, slope, waterMask) {
  const { width, height, cellSize = 50 } = params;

  if (!settlements || settlements.length === 0 || !offMapCities || offMapCities.length === 0) {
    return { railways: [], railGrid: new Grid2D(width, height, { type: 'uint8' }) };
  }

  const railGrid = new Grid2D(width, height, { type: 'uint8' });

  const costFn = railwayCostFunction(elevation, {
    slopePenalty: 150,
    waterGrid: waterMask,
    waterPenalty: 200,
    edgeMargin: 0,
    edgePenalty: 0,
  });

  // Rail-aware cost: existing rail cells get discount (shared corridor)
  const railAwareCost = (fromGx, fromGz, toGx, toGz) => {
    const base = costFn(fromGx, fromGz, toGx, toGz);
    if (!isFinite(base)) return base;
    if (railGrid.get(toGx, toGz) > 0) {
      const dx = toGx - fromGx, dz = toGz - fromGz;
      return Math.sqrt(dx * dx + dz * dz) * 0.05; // very strong preference for existing track
    }
    return base;
  };

  // Find the main city (tier 1, or lowest tier)
  const mainCity = settlements.reduce((a, b) => a.tier <= b.tier ? a : b);
  const capital = offMapCities.find(c => c.role === 'capital') || offMapCities[0];

  const connections = [];

  // Phase 1: Main line — main city to capital
  connections.push({
    from: { gx: mainCity.gx, gz: mainCity.gz },
    to: { gx: capital.gx, gz: capital.gz },
    hierarchy: 'trunk',
    phase: 1,
  });

  // Phase 2: Secondary trunks — main city to other off-map cities + tier-2 to trunk
  for (const omc of offMapCities) {
    if (omc === capital) continue;
    connections.push({
      from: { gx: mainCity.gx, gz: mainCity.gz },
      to: { gx: omc.gx, gz: omc.gz },
      hierarchy: 'main',
      phase: 2,
    });
  }

  const tier2 = settlements.filter(s => s.tier === 2);
  for (const s of tier2) {
    const nearest = _nearestPoint(s, [mainCity, ...offMapCities]);
    if (nearest) {
      connections.push({
        from: { gx: s.gx, gz: s.gz },
        to: { gx: nearest.gx, gz: nearest.gz },
        hierarchy: 'main',
        phase: 2,
      });
    }
  }

  // Phase 3: Branch lines — tier-3 connect to nearest tier-1 or tier-2
  const tier3 = settlements.filter(s => s.tier === 3);
  const branchTargets = settlements.filter(s => s.tier <= 2);
  for (const s of tier3) {
    const nearest = _nearestPoint(s, branchTargets);
    if (nearest) {
      connections.push({
        from: { gx: s.gx, gz: s.gz },
        to: { gx: nearest.gx, gz: nearest.gz },
        hierarchy: 'branch',
        phase: 3,
      });
    }
  }

  // Phase 4: Cross-country — at most one route connecting two off-map cities
  // through a tier-2 settlement that isn't already well-connected.
  // Only add if the tier-2 is genuinely between them (within 25% of midpoint).
  if (offMapCities.length >= 2 && tier2.length > 0) {
    let bestRoute = null;
    let bestScore = Infinity;
    for (let i = 0; i < offMapCities.length; i++) {
      for (let j = i + 1; j < offMapCities.length; j++) {
        const midGx = (offMapCities[i].gx + offMapCities[j].gx) / 2;
        const midGz = (offMapCities[i].gz + offMapCities[j].gz) / 2;
        const routeDist = distance2D(offMapCities[i].gx, offMapCities[i].gz, offMapCities[j].gx, offMapCities[j].gz);
        const nearMid = tier2.find(s =>
          distance2D(s.gx, s.gz, midGx, midGz) < routeDist * 0.25
        );
        if (nearMid) {
          const score = distance2D(nearMid.gx, nearMid.gz, midGx, midGz);
          if (score < bestScore) {
            bestScore = score;
            bestRoute = { i, j };
          }
        }
      }
    }
    if (bestRoute) {
      connections.push({
        from: { gx: offMapCities[bestRoute.i].gx, gz: offMapCities[bestRoute.i].gz },
        to: { gx: offMapCities[bestRoute.j].gx, gz: offMapCities[bestRoute.j].gz },
        hierarchy: 'main',
        phase: 4,
      });
    }
  }

  // Deduplicate connections (same endpoints)
  const seen = new Set();
  const deduped = connections.filter(conn => {
    const key = [
      `${conn.from.gx},${conn.from.gz}`,
      `${conn.to.gx},${conn.to.gz}`,
    ].sort().join('-');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  deduped.sort((a, b) => a.phase - b.phase);

  // Pathfind each connection individually. Unlike roads, railways don't need
  // segment merging — we want one clean simplified line per connection.
  // Stamp railGrid after each so later paths prefer existing corridors.
  const railways = [];

  for (const conn of deduped) {
    const result = findPath(
      conn.from.gx, conn.from.gz,
      conn.to.gx, conn.to.gz,
      width, height, railAwareCost,
    );
    if (!result) continue;

    // Stamp grid so later paths share this corridor
    for (const p of result.path) {
      railGrid.set(p.gx, p.gz, 1);
    }

    // Aggressively simplify — railways should be a handful of sweeping segments
    const simplified = simplifyPath(result.path, 8);

    railways.push({
      path: simplified,
      hierarchy: conn.hierarchy,
      phase: conn.phase,
      from: conn.from,
      to: conn.to,
    });
  }

  return { railways, railGrid };
}

function _nearestPoint(from, targets) {
  let best = null;
  let bestDist = Infinity;
  for (const t of targets) {
    if (t.gx === from.gx && t.gz === from.gz) continue;
    const d = distance2D(from.gx, from.gz, t.gx, t.gz);
    if (d < bestDist) { bestDist = d; best = t; }
  }
  return best;
}
