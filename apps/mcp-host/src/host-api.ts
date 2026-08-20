/**
 * Host API and daemon endpoints for the MCP host, plus the fences on where its
 * credentials may travel. Both base URLs come from the environment, and an MCP
 * server's environment is frequently supplied by whatever project the agent has
 * open — so an unchecked base URL is a way to aim the local operator secret at a
 * remote listener.
 */

const LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "0:0:0:0:0:0:0:1",
]);

/** True for a URL that can only reach this machine. */
export function isLoopbackBase(base: string): boolean {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return false;
  }
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (LOOPBACK_HOSTS.has(host) || host.endsWith(".localhost")) return true;
  // 127.0.0.0/8 is all loopback, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Normalize a configured base URL, or throw. Plaintext HTTP is confined to
 * loopback: sending a bearer over cleartext to another host hands it to the
 * network.
 */
export function normalizeBase(raw: string, envName: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`${envName} is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${envName} must be http or https`);
  }
  if (url.username || url.password) {
    throw new Error(`${envName} must not embed credentials`);
  }
  const base = `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  if (url.protocol === "http:" && !isLoopbackBase(base)) {
    throw new Error(`${envName} must use https off loopback`);
  }
  return base;
}

/**
 * Host API base URL — OPENSESAME_SERVER preferred, OPENSESAME_HOST_API fallback.
 */
export function hostApiBase(): string {
  const base =
    process.env.OPENSESAME_SERVER ??
    process.env.OPENSESAME_HOST_API ??
    "http://127.0.0.1:8787";
  return normalizeBase(base, "OPENSESAME_SERVER");
}

/** The daemon is a process on this machine; nothing else may answer for it. */
export function daemonBase(): string {
  const base = process.env.OPENSESAME_DAEMON_URL ?? "http://127.0.0.1:18790";
  const normalized = normalizeBase(base, "OPENSESAME_DAEMON_URL");
  if (!isLoopbackBase(normalized)) {
    throw new Error("OPENSESAME_DAEMON_URL must be a loopback address");
  }
  return normalized;
}

export type FetchFn = typeof fetch;

let fetchImpl: FetchFn = globalThis.fetch.bind(globalThis);

export function setFetchForTests(fn: FetchFn): void {
  fetchImpl = fn;
}

export function resetFetchForTests(): void {
  fetchImpl = globalThis.fetch.bind(globalThis);
}

/**
 * Operator or opaque-session bearer for Host API mutations (never a SecretRef).
 *
 * The operator token is a local shared secret, so it is only offered to a
 * loopback target: a remote Host API must be reached with a session token.
 */
export function hostAuthHeaders(base = hostApiBase()) {
  const operator = process.env.OPENSESAME_OPERATOR_TOKEN?.trim();
  if (operator && isLoopbackBase(base)) {
    return { authorization: `Bearer operator:${operator}` };
  }
  const session = process.env.OPENSESAME_ACCESS_TOKEN?.trim();
  if (session) {
    if (!isLoopbackBase(base) && new URL(base).protocol !== "https:") {
      throw new Error("OPENSESAME_ACCESS_TOKEN requires https off loopback");
    }
    const allowed = process.env.OPENSESAME_HOST_AUDIENCE?.trim();
    if (allowed && new URL(base).origin !== new URL(allowed).origin) {
      throw new Error(
        "OPENSESAME_SERVER does not match OPENSESAME_HOST_AUDIENCE",
      );
    }
    const token = session.startsWith("opaque-session:")
      ? session
      : `opaque-session:${session}`;
    return { authorization: `Bearer ${token}` };
  }
  return {};
}

export async function hostFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const base = hostApiBase();
  const headers = new Headers(init?.headers);
  for (const [k, v] of Object.entries(hostAuthHeaders(base))) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return fetchImpl(`${base}${path}`, { ...init, headers });
}

export async function daemonFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const base = daemonBase();
  const headers = new Headers(init?.headers);
  // Every daemon /v1/* route requires the operator bearer; without it these calls
  // could only ever answer 401.
  const operator = process.env.OPENSESAME_OPERATOR_TOKEN?.trim();
  if (operator && !headers.has("authorization")) {
    headers.set("authorization", `Bearer operator:${operator}`);
  }
  return fetchImpl(`${base}${path}`, { ...init, headers });
}
