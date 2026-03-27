/**
 * Phase 3: Plot Subdivision
 *
 * Cut plots from each parcel by walking along frontage edges at regular
 * intervals (plot width) and cutting perpendicular to create rectangular lots.
 *
 * Each parcel is split into two rows (back-to-back), each row facing
 * one of the parcel's frontage streets.
 */

export function subdividePlots(parcels, params) {
  const { plotWidth = 10, minFrontage = 5, plotDepth = 10 } = params;
  const plots = [];

  for (const parcel of parcels) {
    const { corners } = parcel;

    // Parcel corners:
    //   [0]---frontage1---[1]
    //    |                 |
    //   [3]---frontage2---[2]
    //
    // Split into two rows at the midline for back-to-back plots.
    const midA = mid(corners[0], corners[3]);
    const midB = mid(corners[1], corners[2]);

    const rows = [
      { front: [corners[0], corners[1]], back: [midA, midB] },
      { front: [corners[3], corners[2]], back: [midA, midB] },
    ];

    for (const row of rows) {
      const fLen = dist(row.front[0], row.front[1]);
      const nPlots = Math.max(1, Math.floor(fLen / plotWidth));

      for (let i = 0; i < nPlots; i++) {
        const t0 = i / nPlots;
        const t1 = (i + 1) / nPlots;

        const p0 = lerp(row.front[0], row.front[1], t0);
        const p1 = lerp(row.front[0], row.front[1], t1);
        const p2 = lerp(row.back[0], row.back[1], t1);
        const p3 = lerp(row.back[0], row.back[1], t0);

        const frontage = dist(p0, p1);
        const depth = (dist(p0, p3) + dist(p1, p2)) / 2;

        if (frontage >= minFrontage && depth >= plotDepth * 0.67) {
          plots.push({ corners: [p0, p1, p2, p3], frontage, depth });
        }
      }
    }
  }

  return plots;
}

function dist(a, b) {
  return Math.sqrt((b.x - a.x) ** 2 + (b.z - a.z) ** 2);
}

function mid(a, b) {
  return { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
}

function lerp(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}
