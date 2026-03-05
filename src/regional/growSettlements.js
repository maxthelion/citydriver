/**
 * A6d. Settlement growth pass.
 * Count road traffic through each settlement and promote busy ones.
 * Creates a feedback loop: geography → settlement → road → growth.
 */

import { distance2D } from '../core/math.js';

/**
 * @param {Array} settlements - All settlements
 * @param {Array} roads - All roads from generateRoads()
 * @returns {Array} settlements with updated tiers (mutates in place)
 */
export function growSettlements(settlements, roads) {
  // For each settlement, count how many roads pass within a few cells,
  // weighted by road hierarchy
  const hierarchyWeight = { arterial: 3, collector: 2, local: 1 };

  for (const s of settlements) {
    let traffic = 0;

    for (const road of roads) {
      const weight = hierarchyWeight[road.hierarchy] ?? 1;
      const path = road.rawPath || road.path;

      // Check if road passes near this settlement
      let minDist = Infinity;
      for (const p of path) {
        const d = distance2D(s.gx, s.gz, p.gx, p.gz);
        if (d < minDist) minDist = d;
        if (d < 2) break; // Close enough, no need to check more
      }

      if (minDist < 3) {
        traffic += weight;
      }
    }

    s.traffic = traffic;
  }

  // Promote settlements based on traffic
  for (const s of settlements) {
    if (s.tier === 4 && s.traffic >= 6) {
      // Hamlet with significant traffic → village
      s.tier = 3;
      if (s.type === 'farm') s.type = 'roadside';
    } else if (s.tier === 3 && s.traffic >= 20) {
      // Village at major crossroads → town
      s.tier = 2;
      if (s.type === 'market' || s.type === 'roadside') s.type = 'crossroads';
    }
  }

  return settlements;
}
