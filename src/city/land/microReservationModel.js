import { polygonArea, polylineLength } from './geometryPrimitives.js';

let nextId = 1;

function allocateId(prefix) {
  const id = `${prefix}-${nextId}`;
  nextId += 1;
  return id;
}

export class PlannedRoad {
  constructor({ id = allocateId('planned-road'), kind, centerline, width = 8, meta = {} }) {
    this.id = id;
    this.kind = kind;
    this.centerline = centerline;
    this.width = width;
    this.meta = meta;
  }

  toJSON() {
    return {
      id: this.id,
      kind: this.kind,
      width: this.width,
      pointCount: this.centerline.length,
      length: roundNumber(polylineLength(this.centerline)),
      meta: this.meta,
    };
  }
}

export class FrontageSpan {
  constructor({
    id = allocateId('frontage-span'),
    frontage,
    inward,
    depth,
    serviceRoadId = null,
    gapDistances = [],
    meta = {},
  }) {
    this.id = id;
    this.frontage = frontage;
    this.inward = inward;
    this.depth = depth;
    this.serviceRoadId = serviceRoadId;
    this.gapDistances = gapDistances;
    this.meta = meta;
  }

  toJSON() {
    return {
      id: this.id,
      length: roundNumber(polylineLength(this.frontage)),
      depth: roundNumber(this.depth),
      serviceRoadId: this.serviceRoadId,
      gapCount: this.gapDistances.length,
      meta: this.meta,
    };
  }
}

export class ReservationParcel {
  constructor({
    id = allocateId('parcel'),
    kind,
    polygon,
    frontageSpanId = null,
    meta = {},
  }) {
    this.id = id;
    this.kind = kind;
    this.polygon = polygon;
    this.frontageSpanId = frontageSpanId;
    this.meta = meta;
  }

  toJSON() {
    return {
      id: this.id,
      kind: this.kind,
      vertexCount: this.polygon.length,
      area: roundNumber(polygonArea(this.polygon)),
      frontageSpanId: this.frontageSpanId,
      meta: this.meta,
    };
  }
}

export class ResidualArea {
  constructor({
    id = allocateId('residual-area'),
    polygon,
    meta = {},
  }) {
    this.id = id;
    this.polygon = polygon;
    this.meta = meta;
  }

  toJSON() {
    return {
      id: this.id,
      vertexCount: this.polygon.length,
      area: roundNumber(polygonArea(this.polygon)),
      meta: this.meta,
    };
  }
}

export class ReservationLayout {
  constructor({ id = allocateId('layout'), kind = 'micro-reservation-layout', meta = {} } = {}) {
    this.id = id;
    this.kind = kind;
    this.meta = meta;
    this.frontageSpans = [];
    this.parcels = [];
    this.roads = [];
    this.residualAreas = [];
  }

  addRoad(road) {
    this.roads.push(road);
    return road;
  }

  addFrontageSpan(span) {
    this.frontageSpans.push(span);
    return span;
  }

  addParcel(parcel) {
    this.parcels.push(parcel);
    return parcel;
  }

  addResidualArea(area) {
    this.residualAreas.push(area);
    return area;
  }

  summary() {
    return {
      id: this.id,
      kind: this.kind,
      counts: {
        frontageSpans: this.frontageSpans.length,
        parcels: this.parcels.length,
        roads: this.roads.length,
        residualAreas: this.residualAreas.length,
      },
      totalFrontageLength: roundNumber(this.frontageSpans.reduce((sum, span) => sum + polylineLength(span.frontage), 0)),
      totalParcelArea: roundNumber(this.parcels.reduce((sum, parcel) => sum + polygonArea(parcel.polygon), 0)),
      roadLength: roundNumber(this.roads.reduce((sum, road) => sum + polylineLength(road.centerline), 0)),
      totalResidualArea: roundNumber(this.residualAreas.reduce((sum, area) => sum + polygonArea(area.polygon), 0)),
    };
  }

  toJSON() {
    return {
      id: this.id,
      kind: this.kind,
      meta: this.meta,
      summary: this.summary(),
      frontageSpans: this.frontageSpans.map(span => span.toJSON()),
      parcels: this.parcels.map(parcel => parcel.toJSON()),
      roads: this.roads.map(road => road.toJSON()),
      residualAreas: this.residualAreas.map(area => area.toJSON()),
    };
  }
}

function roundNumber(value) {
  return Math.round(value * 1000) / 1000;
}
