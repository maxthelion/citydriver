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
    growth: {
      radiusStep: 800,
      maxGrowthTicks: 20,
      agentPriority: ['civic', 'commercial', 'industrial', 'openSpace',
                      'residentialQuality', 'residentialFine', 'residentialEstate',
                      'agriculture'],
      agents: {
        commercial: {
          share: 0.12, seedStrategy: 'roadFrontage', spreadBehaviour: 'linear',
          footprint: [100, 2000], affinity: { centrality: 0.6, roadFrontage: 0.8 }, seedsPerTick: 10,
        },
        industrial: {
          share: 0.08, seedStrategy: 'edge', spreadBehaviour: 'blob',
          footprint: [500, 5000], affinity: { downwindness: 0.6, edgeness: 0.5 }, seedsPerTick: 3,
        },
        civic: {
          share: 0.05, seedStrategy: 'scattered', spreadBehaviour: 'dot',
          footprint: [10, 60], affinity: { centrality: 0.7, roadFrontage: 0.3 }, seedsPerTick: 8,
        },
        openSpace: {
          share: 0.08, seedStrategy: 'terrain', spreadBehaviour: 'blob',
          footprint: [200, 3000], affinity: { waterfrontness: 0.3, edgeness: 0.4 }, seedsPerTick: 3,
        },
        agriculture: {
          share: 0.15, seedStrategy: 'frontier', spreadBehaviour: 'belt',
          footprint: [50, 200], affinity: { edgeness: 1.0 }, seedsPerTick: 0,
        },
        residentialFine: {
          share: 0.30, seedStrategy: 'fill', spreadBehaviour: 'organic',
          footprint: [50, 3000], affinity: { centrality: 0.5, roadFrontage: 0.3 }, seedsPerTick: 20,
        },
        residentialEstate: {
          share: 0.10, seedStrategy: 'edge', spreadBehaviour: 'blob',
          footprint: [300, 5000], affinity: { edgeness: 0.7 }, seedsPerTick: 3,
        },
        residentialQuality: {
          share: 0.12, seedStrategy: 'desirable', spreadBehaviour: 'cluster',
          footprint: [100, 3000], affinity: { waterfrontness: 0.4, centrality: -0.2, edgeness: 0.3 }, seedsPerTick: 5,
        },
      },
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
