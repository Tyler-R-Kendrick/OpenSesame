/**
 * Host API and daemon endpoints for the MCP host, plus the fences on where its
 * credentials may travel. Both base URLs come from the environment, and an MCP
 * server's environment is frequently supplied by whatever project the agent has
 * open — so an unchecked base URL is a way to aim the local operator secret at a
 * remote listener.
 */

import { AgentClient } from "@opensesame/agent-client";

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
let agent = new AgentClient("urn:opensesame:agent:mcp-host", (input, init) =>
  fetchImpl(input, init),
);

export function setFetchForTests(fn: FetchFn): void {
  fetchImpl = fn;
}

export function resetFetchForTests(): void {
  fetchImpl = globalThis.fetch.bind(globalThis);
  agent = new AgentClient("urn:opensesame:agent:mcp-host", (input, init) =>
    fetchImpl(input, init),
  );
}

/** Only an explicitly approved short-lived agent capability can authenticate. */
export function hostAuthHeaders(
  base = hostApiBase(),
): Promise<Record<string, string>> {
  return agent.headers(base);
}

export async function hostFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const base = hostApiBase();
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
    throw new Error("invalid Host request path");
  const headers = new Headers(init?.headers);
  if (headers.has("authorization") || headers.has("x-opensesame-operator"))
    throw new Error("agent authority cannot be overridden");
  if (path !== "/health/live" && path !== "/health/ready") {
    for (const [key, value] of Object.entries(await hostAuthHeaders(base)))
      headers.set(key, value);
  }
  return fetchImpl(`${base}${path}`, {
    ...init,
    headers,
    redirect: "error",
    credentials: "omit",
  });
}

/** The daemon exposes no operator route to model-driven clients. */
export async function daemonFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  if (path !== "/health/live" || (init?.method && init.method !== "GET"))
    throw new Error("daemon operator APIs are not an agent surface");
  return fetchImpl(`${daemonBase()}/health/live`, {
    method: "GET",
    redirect: "error",
    credentials: "omit",
  });
}
