/**
 * Parcel: a contiguous region of cells with the same reservation type within a zone.
 *
 * Each parcel has a boundary polygon, classified edges (road, water, parcel-back,
 * zone-edge, map-edge), and computed metrics (area, frontageLength).
 *
 * Edge types:
 *   'road'        - borders a road cell
 *   'water'       - borders a water cell
 *   'parcel-back' - borders a cell with a different reservation type
 *   'zone-edge'   - borders a cell outside any zone
 *   'map-edge'    - borders the map boundary (out of bounds)
 */

export const EDGE_TYPE = {
  ROAD: 'road',
  WATER: 'water',
  PARCEL_BACK: 'parcel-back',
  ZONE_EDGE: 'zone-edge',
  MAP_EDGE: 'map-edge',
};

export class Parcel {
  /**
   * @param {object} params
   * @param {number} params.id - Unique parcel ID
   * @param {number} params.zoneId - ID of the development zone this parcel belongs to
   * @param {number} params.reservationType - RESERVATION enum value
   * @param {Array<{gx: number, gz: number}>} params.cells - Grid cells in this parcel
   * @param {Array<{x: number, z: number}>} params.polygon - Boundary polygon in world coords
   * @param {Array<{segment: [{x,z},{x,z}], type: string, refId?: number}>} params.edges - Classified boundary edges
   * @param {number} params.area - Area in m²
   * @param {number} params.frontageLength - Total road-edge length in m
   */
  constructor({ id, zoneId, reservationType, cells, polygon, edges, area, frontageLength }) {
    this.id = id;
    this.zoneId = zoneId;
    this.reservationType = reservationType;
    this.cells = cells;
    this.polygon = polygon;
    this.edges = edges;
    this.area = area;
    this.frontageLength = frontageLength;
  }
}
