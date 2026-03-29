/**
 * Street index bitmap — separate from the boolean roadGrid.
 *
 * Stores which generated street indices touch each map cell so guide marches
 * can raycast against street identity, not just road occupancy.
 */

export function buildStreetIndexBitmap(streets, map, opts = {}) {
  const W = map.width;
  const H = map.height;
  const cs = map.cellSize;
  const ox = map.originX;
  const oz = map.originZ;
  const radiusMeters = opts.radiusMeters ?? cs;
  const cellRadius = Math.max(0, Math.ceil(radiusMeters / cs));
  const stepSize = opts.stepSize ?? cs * 0.5;

  const cells = new Int32Array(W * H);
  cells.fill(-1);
  const overlaps = new Map();

  for (let streetIdx = 0; streetIdx < streets.length; streetIdx++) {
    const street = streets[streetIdx];
    const points = street.points || street;
    if (!points || points.length < 2) continue;

    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (len < 1e-6) continue;

      const steps = Math.max(1, Math.ceil(len / stepSize));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const px = a.x + dx * t;
        const pz = a.z + dz * t;
        const cgx = Math.round((px - ox) / cs);
        const cgz = Math.round((pz - oz) / cs);

        for (let ddz = -cellRadius; ddz <= cellRadius; ddz++) {
          for (let ddx = -cellRadius; ddx <= cellRadius; ddx++) {
            const gx = cgx + ddx;
            const gz = cgz + ddz;
            if (gx < 0 || gx >= W || gz < 0 || gz >= H) continue;

            const cellX = ox + gx * cs;
            const cellZ = oz + gz * cs;
            const distSq = (cellX - px) * (cellX - px) + (cellZ - pz) * (cellZ - pz);
            if (distSq > radiusMeters * radiusMeters) continue;

            stampStreetCell(cells, overlaps, gz * W + gx, streetIdx);
          }
        }
      }
    }
  }

  return { width: W, height: H, cells, overlaps };
}

export function lookupStreetIds(bitmap, gx, gz) {
  if (!bitmap) return [];
  if (gx < 0 || gx >= bitmap.width || gz < 0 || gz >= bitmap.height) return [];

  const idx = gz * bitmap.width + gx;
  const value = bitmap.cells[idx];
  if (value === -1) return [];
  if (value >= 0) return [value];
  return bitmap.overlaps.get(idx) || [];
}

function stampStreetCell(cells, overlaps, idx, streetIdx) {
  const current = cells[idx];
  if (current === -1) {
    cells[idx] = streetIdx;
    return;
  }
  if (current === streetIdx) return;
  if (current >= 0) {
    cells[idx] = -2;
    overlaps.set(idx, current === streetIdx ? [current] : [current, streetIdx]);
    return;
  }

  const bucket = overlaps.get(idx) || [];
  if (!bucket.includes(streetIdx)) bucket.push(streetIdx);
  overlaps.set(idx, bucket);
}
