const ROOT = '/api/postgres-console';

export class ConsoleError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(ROOT + path, { credentials: 'same-origin', ...options });
  if (response.status === 204) return undefined as T;
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new ConsoleError(response.status, data?.error || 'Falha ao consultar o console PostgreSQL.');
  }
  return response.json();
}

export function post<T>(path: string, data: object = {}) {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export function errorMessage(error: unknown) {
  return error instanceof ConsoleError ? error.message : 'Não foi possível acessar o console PostgreSQL.';
}
