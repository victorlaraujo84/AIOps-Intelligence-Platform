export interface EdgePair {
  source_asset_id: string;
  target_asset_id: string;
}

export interface ServiceDepPair {
  service_id: string;
  upstream_service_id: string | null;
}

/**
 * Verifica se a inserção de uma aresta direcionada (source -> target)
 * introduz um ciclo no grafo topológico de ativos do tenant.
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
 * Verifica se vincular `service_id` -> `upstream_service_id` cria ciclo entre serviços.
 */
export function wouldCreateServiceCycle(
  existingDeps: ServiceDepPair[],
  serviceId: string,
  upstreamServiceId: string,
): boolean {
  if (serviceId === upstreamServiceId) {
    return true;
  }

  // Aresta direcionada: serviceId depende de upstreamServiceId (serviceId -> upstreamServiceId)
  const adjacency = new Map<string, string[]>();
  for (const dep of existingDeps) {
    if (!dep.upstream_service_id) continue;
    const list = adjacency.get(dep.service_id) ?? [];
    list.push(dep.upstream_service_id);
    adjacency.set(dep.service_id, list);
  }

  // Verifica se upstreamServiceId já depende (direta ou transitivamente) de serviceId
  const visited = new Set<string>();
  const queue: string[] = [upstreamServiceId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === serviceId) {
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
 * Coleta todos os ativos upstream e downstream conectados a um ativo inicial.
 */
export function collectConnectedAssets(
  edges: EdgePair[],
  startAssetId: string,
): { upstream: string[]; downstream: string[] } {
  const forward = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();

  for (const e of edges) {
    const f = forward.get(e.source_asset_id) ?? [];
    f.push(e.target_asset_id);
    forward.set(e.source_asset_id, f);

    const r = reverse.get(e.target_asset_id) ?? [];
    r.push(e.source_asset_id);
    reverse.set(e.target_asset_id, r);
  }

  const walk = (adj: Map<string, string[]>, seed: string): string[] => {
    const visited = new Set<string>();
    const queue = [...(adj.get(seed) ?? [])];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur === seed || visited.has(cur)) continue;
      visited.add(cur);
      for (const nxt of adj.get(cur) ?? []) {
        if (!visited.has(nxt)) queue.push(nxt);
      }
    }
    return [...visited];
  };

  return {
    upstream: walk(reverse, startAssetId),
    downstream: walk(forward, startAssetId),
  };
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
