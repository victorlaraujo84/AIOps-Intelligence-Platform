import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectConnectedAssets,
  findSharedUpstreamDependencies,
  wouldCreateServiceCycle,
  wouldCreateTopologyCycle,
} from '../../src/server/topology.ts';

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

test('detecta ciclo em dependências de serviços (service_dependencies)', () => {
  const deps = [
    { service_id: 'SVC-APP', upstream_service_id: 'SVC-DB' },
    { service_id: 'SVC-DB', upstream_service_id: 'SVC-AUTH' },
  ];

  assert.equal(wouldCreateServiceCycle(deps, 'SVC-APP', 'SVC-APP'), true);
  assert.equal(wouldCreateServiceCycle(deps, 'SVC-AUTH', 'SVC-APP'), true);
  assert.equal(wouldCreateServiceCycle(deps, 'SVC-PORTAL', 'SVC-APP'), false);
});

test('coleta ativos upstream e downstream conectados', () => {
  const edges = [
    { source_asset_id: 'CORE', target_asset_id: 'DIST' },
    { source_asset_id: 'DIST', target_asset_id: 'APP' },
  ];
  const connected = collectConnectedAssets(edges, 'DIST');
  assert.deepEqual(connected.upstream, ['CORE']);
  assert.deepEqual(connected.downstream, ['APP']);
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
