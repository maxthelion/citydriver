import { describe, it } from 'vitest';
import { setupCity } from '../src/city/setup.js';
import { generateRegionFromSeed } from '../src/ui/regionHelper.js';
import { SeededRandom } from '../src/core/rng.js';
import { buildSkeletonRoads } from '../src/city/skeleton.js';
import { PlanarGraph } from '../src/core/PlanarGraph.js';

describe('debug faces', () => {
  it('shows face info for seed 139625', () => {
    const { layers, settlement } = generateRegionFromSeed(139625);
    const rng = new SeededRandom(139625);
    const map = setupCity(layers, settlement, rng.fork('city'));
    buildSkeletonRoads(map);

    console.log('Roads:', map.roads.length);
    console.log('Graph nodes:', map.graph.nodes.size);
    console.log('Graph edges:', map.graph.edges.size);
    console.log('Nuclei:', map.nuclei.length);

    const faces = map.graph.faces();
    console.log('Total faces:', faces.length);

    for (const face of faces) {
      const isSimple = new Set(face).size === face.length;
      const nodes = face.map(id => map.graph.getNode(id));
      let area = 0;
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        const b = nodes[(i + 1) % nodes.length];
        area += (a.x * b.z - b.x * a.z);
      }
      area /= 2;
      console.log(`  Face: ${face.length} nodes, simple=${isSimple}, signedArea=${Math.round(area)}`);
    }

    // Check connectivity
    console.log('Is connected:', map.graph.isConnected());
    console.log('Dead ends:', map.graph.deadEnds().length);

    // Check half-edge structure
    const { nextHE, outgoing } = map.graph._buildHalfEdgeNext();
    console.log('Half-edges in nextHE:', nextHE.size);
    console.log('Expected half-edges:', map.graph.edges.size * 2);

    // Check for missing nextHE entries
    let missing = 0;
    for (const [edgeId, edge] of map.graph.edges) {
      const key1 = `${edge.from}-${edge.to}`;
      const key2 = `${edge.to}-${edge.from}`;
      if (!nextHE.has(key1)) missing++;
      if (!nextHE.has(key2)) missing++;
    }
    console.log('Missing nextHE entries:', missing);

    // Check for duplicate edges between same nodes
    const edgePairs = new Map();
    for (const [eid, edge] of map.graph.edges) {
      const key = [Math.min(edge.from, edge.to), Math.max(edge.from, edge.to)].join('-');
      if (!edgePairs.has(key)) edgePairs.set(key, []);
      edgePairs.get(key).push(eid);
    }
    let duplicates = 0;
    for (const [key, eids] of edgePairs) {
      if (eids.length > 1) {
        duplicates++;
        if (duplicates <= 5) console.log(`  Duplicate edges between ${key}: ${eids.join(', ')}`);
      }
    }
    console.log('Duplicate edge pairs:', duplicates);

    // Euler: F = E - V + 2 (for connected planar)
    console.log('Euler expected faces:', map.graph.edges.size - map.graph.nodes.size + 2);

    // Test with a simple known graph to verify faces() works
    const g = new PlanarGraph();
    const n0 = g.addNode(0, 0);
    const n1 = g.addNode(100, 0);
    const n2 = g.addNode(100, 100);
    const n3 = g.addNode(0, 100);
    g.addEdge(n0, n1);
    g.addEdge(n1, n2);
    g.addEdge(n2, n3);
    g.addEdge(n3, n0);
    console.log('\nSimple square faces:', g.faces().length, '(expect 2)');

    // Now test: add a diagonal
    g.addEdge(n0, n2);
    console.log('Square+diagonal faces:', g.faces().length, '(expect 3)');

    // Test with the actual map graph's edge structure — check for self-loops
    let selfLoops = 0;
    for (const [eid, edge] of map.graph.edges) {
      if (edge.from === edge.to) selfLoops++;
    }
    console.log('Self-loops:', selfLoops);

    // Check degree distribution
    const degrees = {};
    for (const [nid] of map.graph.nodes) {
      const d = map.graph.degree(nid);
      degrees[d] = (degrees[d] || 0) + 1;
    }
    console.log('Degree distribution:', degrees);

    // Check: how many connections did skeleton produce?
    console.log('\nRoad sources:');
    const sources = {};
    for (const r of map.roads) {
      sources[r.source || 'unknown'] = (sources[r.source || 'unknown'] || 0) + 1;
    }
    console.log(sources);
  });
});
