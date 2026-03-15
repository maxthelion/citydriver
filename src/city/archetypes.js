/**
 * City archetype definitions.
 *
 * Each archetype defines land budget shares, reservation order,
 * placement preferences (weights against spatial layers), and
 * growth modes for each use type.
 *
 * See specs/v5/city-archetypes.md for background.
 */

export const ARCHETYPES = {
  marketTown: {
    id: 'marketTown',
    name: 'Organic Market Town',
    shares: { commercial: 0.12, industrial: 0.08, civic: 0.05, openSpace: 0.08 },
    reservationOrder: ['civic', 'openSpace', 'industrial', 'commercial'],
    placement: {
      commercial: { centrality: 0.8, roadFrontage: 0.6 },
      industrial: { downwindness: 0.7, edgeness: 0.5 },
      civic:      { centrality: 1.0 },
      openSpace:  { centrality: 0.7 },
    },
    growthMode: {
      commercial: 'directional',
      industrial: 'directional',
      civic:      'radial',
      openSpace:  'radial',
    },
  },

  portCity: {
    id: 'portCity',
    name: 'Port and Waterfront City',
    shares: { commercial: 0.15, industrial: 0.14, civic: 0.05, openSpace: 0.06 },
    reservationOrder: ['industrial', 'commercial', 'openSpace', 'civic'],
    placement: {
      commercial: { waterfrontness: 0.7, roadFrontage: 0.4 },
      industrial: { waterfrontness: 0.6, downwindness: 0.4, edgeness: 0.3 },
      civic:      { centrality: 0.8, waterfrontness: 0.3 },
      openSpace:  { waterfrontness: 0.9 },
    },
    growthMode: {
      commercial: 'directional',
      industrial: 'directional',
      civic:      'radial',
      openSpace:  'directional',
    },
  },

  gridTown: {
    id: 'gridTown',
    name: 'Planned Grid Town',
    shares: { commercial: 0.14, industrial: 0.12, civic: 0.06, openSpace: 0.08 },
    reservationOrder: ['civic', 'commercial', 'industrial', 'openSpace'],
    placement: {
      commercial: { centrality: 0.9, roadFrontage: 0.5 },
      industrial: { edgeness: 0.7, downwindness: 0.5 },
      civic:      { centrality: 1.0 },
      openSpace:  { centrality: 0.6 },
    },
    growthMode: {
      commercial: 'directional',
      industrial: 'directional',
      civic:      'radial',
      openSpace:  'radial',
    },
  },

  industrialTown: {
    id: 'industrialTown',
    name: 'Industrial Town',
    shares: { commercial: 0.08, industrial: 0.22, civic: 0.04, openSpace: 0.05 },
    reservationOrder: ['industrial', 'civic', 'commercial', 'openSpace'],
    placement: {
      commercial: { centrality: 0.5, roadFrontage: 0.7 },
      industrial: { waterfrontness: 0.4, downwindness: 0.3, centrality: 0.3 },
      civic:      { centrality: 0.6 },
      openSpace:  { edgeness: 0.8 },
    },
    growthMode: {
      commercial: 'directional',
      industrial: 'radial',
      civic:      'radial',
      openSpace:  'radial',
    },
  },

  civicCentre: {
    id: 'civicCentre',
    name: 'Civic and Administrative Centre',
    shares: { commercial: 0.10, industrial: 0.04, civic: 0.18, openSpace: 0.14 },
    reservationOrder: ['civic', 'openSpace', 'commercial', 'industrial'],
    placement: {
      commercial: { centrality: 0.5, roadFrontage: 0.6 },
      industrial: { downwindness: 0.8, edgeness: 0.5 },
      civic:      { centrality: 1.0 },
      openSpace:  { centrality: 0.6, waterfrontness: 0.3 },
    },
    growthMode: {
      commercial: 'directional',
      industrial: 'directional',
      civic:      'radial',
      openSpace:  'radial',
    },
  },
};

export function getArchetype(id) {
  return ARCHETYPES[id] || null;
}
