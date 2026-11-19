export interface EdgePair {
  source_asset_id: string;
  target_asset_id: string;
}

/**
 * Verifica se a inserção de uma aresta direcionada (source -> target)
 * introduz um ciclo no grafo topológico do tenant.
 */
export function wouldCreateTopologyCycle(
  existingEdges: EdgePair[],
  newSourceId: string,
  newTargetId: string,
): boolean {
  if (newSourceId === newTargetId) {
    return true;
  }

  const adjacency = new Map<string, string[]>();
  for (const edge of existingEdges) {
    const list = adjacency.get(edge.source_asset_id) ?? [];
    list.push(edge.target_asset_id);
    adjacency.set(edge.source_asset_id, list);
  }

  // Verifica se já existe caminho de newTargetId até newSourceId
  const visited = new Set<string>();
  const queue: string[] = [newTargetId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === newSourceId) {
      return true;
    }
    if (visited.has(current)) continue;
    visited.add(current);

    const neighbors = adjacency.get(current) ?? [];
    for (const next of neighbors) {
      if (!visited.has(next)) {
        queue.push(next);
      }
    }
  }

  return false;
}

/**
 * Identifica ativos upstream que servem múltiplos nós downstream (Single Point of Failure potencial).
 */
export function findSharedUpstreamDependencies(
  edges: EdgePair[],
): Array<{ upstream_asset_id: string; downstream_count: number }> {
  const downstreamByUpstream = new Map<string, Set<string>>();
  for (const edge of edges) {
    const set = downstreamByUpstream.get(edge.source_asset_id) ?? new Set<string>();
    set.add(edge.target_asset_id);
    downstreamByUpstream.set(edge.source_asset_id, set);
  }

  const shared: Array<{ upstream_asset_id: string; downstream_count: number }> = [];
  for (const [upstreamId, downstreams] of downstreamByUpstream.entries()) {
    if (downstreams.size > 1) {
      shared.push({ upstream_asset_id: upstreamId, downstream_count: downstreams.size });
    }
  }

  return shared.sort((a, b) => b.downstream_count - a.downstream_count);
}
