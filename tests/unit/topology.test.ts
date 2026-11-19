import assert from 'node:assert/strict';
import test from 'node:test';
import { findSharedUpstreamDependencies, wouldCreateTopologyCycle } from '../../src/server/topology.ts';

test('detecta auto-ciclo e ciclo multi-salto em topology_edges', () => {
  const edges = [
    { source_asset_id: 'A', target_asset_id: 'B' },
    { source_asset_id: 'B', target_asset_id: 'C' },
  ];

  assert.equal(wouldCreateTopologyCycle(edges, 'A', 'A'), true);
  assert.equal(wouldCreateTopologyCycle(edges, 'C', 'A'), true);
  assert.equal(wouldCreateTopologyCycle(edges, 'B', 'A'), true);
  assert.equal(wouldCreateTopologyCycle(edges, 'C', 'D'), false);
  assert.equal(wouldCreateTopologyCycle(edges, 'A', 'C'), false); // redundância DAG válida
});

test('identifica dependências upstream compartilhadas', () => {
  const edges = [
    { source_asset_id: 'CORE-1', target_asset_id: 'EDGE-1' },
    { source_asset_id: 'CORE-1', target_asset_id: 'EDGE-2' },
    { source_asset_id: 'CORE-2', target_asset_id: 'EDGE-3' },
  ];

  const shared = findSharedUpstreamDependencies(edges);
  assert.equal(shared.length, 1);
  assert.equal(shared[0].upstream_asset_id, 'CORE-1');
  assert.equal(shared[0].downstream_count, 2);
});
