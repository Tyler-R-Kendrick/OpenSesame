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

export async function hostFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetchImpl(`${hostApiBase()}${path}`, init);
}

export async function daemonFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetchImpl(`${daemonBase()}${path}`, init);
}
