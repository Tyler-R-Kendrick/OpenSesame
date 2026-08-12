/**
 * Host API base URL — OPENSESAME_SERVER preferred, OPENSESAME_HOST_API fallback.
 */
export function hostApiBase(): string {
  const base =
    process.env.OPENSESAME_SERVER ??
    process.env.OPENSESAME_HOST_API ??
    "http://127.0.0.1:8787";
  return base.replace(/\/$/, "");
}

export function daemonBase(): string {
  return (process.env.OPENSESAME_DAEMON_URL ?? "http://127.0.0.1:18790").replace(/\/$/, "");
}

export type FetchFn = typeof fetch;

let fetchImpl: FetchFn = globalThis.fetch.bind(globalThis);

export function setFetchForTests(fn: FetchFn): void {
  fetchImpl = fn;
}

export function resetFetchForTests(): void {
  fetchImpl = globalThis.fetch.bind(globalThis);
}

/** Operator or opaque-session bearer for Host API mutations (never a SecretRef). */
export function hostAuthHeaders(): Record<string, string> {
  const operator = process.env.OPENSESAME_OPERATOR_TOKEN?.trim();
  if (operator) {
    return { authorization: `Bearer operator:${operator}` };
  }
  const session = process.env.OPENSESAME_ACCESS_TOKEN?.trim();
  if (session) {
    const token = session.startsWith("opaque-session:")
      ? session
      : `opaque-session:${session}`;
    return { authorization: `Bearer ${token}` };
  }
  return {};
}

export async function hostFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  for (const [k, v] of Object.entries(hostAuthHeaders())) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return fetchImpl(`${hostApiBase()}${path}`, { ...init, headers });
}

/**
 * The daemon gates every mutation on the operator token, and its status probe
 * too. Without it these tools answer 401 and read as a broken daemon rather
 * than a missing credential, so pass it when the environment has one.
 */
export async function daemonFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  const operator = process.env.OPENSESAME_OPERATOR_TOKEN?.trim();
  if (operator && !headers.has("x-opensesame-operator")) {
    headers.set("x-opensesame-operator", operator);
  }
  return fetchImpl(`${daemonBase()}${path}`, { ...init, headers });
}
