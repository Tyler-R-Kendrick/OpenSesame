/**
 * Identity plane session.
 *
 * The access token lives in memory for the tab session only — never OPFS,
 * never localStorage. The control-plane also sets an HttpOnly cookie, so
 * requests carry credentials as well as the bearer header.
 */

import { useCallback, useEffect, useState } from "react";
import { loadSettings } from "./settings.js";

export type Principal = {
  id: string;
  state: string;
  assurance: string;
  createdAt: string;
  updatedAt: string;
  verifiedAt?: string;
  version: number;
  identities: Array<{
    id: string;
    kind: string;
    issuer: string;
    displayHint?: string;
    assurance: string;
  }>;
};

export type IdentitySession = {
  principalId: string;
  accessToken: string;
  expiresAt: string;
};

export class IdentityError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "IdentityError";
    this.status = status;
  }
}

let session: IdentitySession | null = null;
type HostSession = {
  accessToken: string;
  expiresAt: number;
  hostApi: string;
  identityAccessToken: string;
};
let hostSession: HostSession | null = null;
let pendingHostSession: Promise<HostSession> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function currentSession(): IdentitySession | null {
  if (session && Date.parse(session.expiresAt) <= Date.now()) {
    session = null;
    clearHostSession();
  }
  return session;
}

export function clearSession(): void {
  session = null;
  clearHostSession();
  emit();
}

export function identityBase(): string {
  return loadSettings().identityApi.replace(/\/$/, "");
}

export function hostBase(): string {
  return loadSettings().hostApi.replace(/\/$/, "");
}

export function clearHostSession(): void {
  hostSession = null;
  pendingHostSession = null;
}

function currentHostSession(): HostSession | null {
  const identity = currentSession();
  if (
    !hostSession ||
    !identity ||
    hostSession.hostApi !== hostBase() ||
    hostSession.identityAccessToken !== identity.accessToken ||
    hostSession.expiresAt <= Date.now()
  ) {
    hostSession = null;
  }
  return hostSession;
}

async function hostSessionFailure(
  response: Response,
  fallback: string,
): Promise<Error> {
  try {
    const payload = (await response.json()) as {
      error?: unknown;
      hint?: unknown;
      body?: { error?: unknown; hint?: unknown };
    };
    const detail =
      payload.body?.hint ??
      payload.body?.error ??
      payload.hint ??
      payload.error;
    if (typeof detail === "string") return new Error(`${fallback}: ${detail}`);
  } catch {
    // The status still gives the user an actionable failure for non-JSON errors.
  }
  return new Error(`${fallback} (${response.status}).`);
}

async function mintHostSession(
  identity: IdentitySession,
): Promise<HostSession> {
  const unchanged = () =>
    currentSession()?.accessToken === identity.accessToken;
  const hostApi = hostBase();
  const authorize = await fetch(`${hostApi}/api/v1/device/authorize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "omit",
    body: JSON.stringify({
      client_id: "opensesame-pages",
      scope: "opensesame.session",
    }),
  });
  if (!authorize.ok) {
    throw await hostSessionFailure(authorize, "Host session request failed");
  }
  const grant = (await authorize.json()) as {
    device_code?: unknown;
    user_code?: unknown;
  };
  if (
    typeof grant.device_code !== "string" ||
    typeof grant.user_code !== "string"
  ) {
    throw new Error("Host returned an invalid device grant.");
  }
  if (!unchanged()) throw new Error("Identity changed during Host sign-in.");

  const approve = await identityFetch("/v1/device/approve", {
    method: "POST",
    body: JSON.stringify({ user_code: grant.user_code }),
  });
  if (!approve.ok) {
    throw await hostSessionFailure(approve, "Host session approval failed");
  }
  if (!unchanged()) throw new Error("Identity changed during Host sign-in.");

  const token = await fetch(`${hostApi}/api/v1/device/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "omit",
    body: JSON.stringify({
      device_code: grant.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  if (!token.ok) {
    throw await hostSessionFailure(token, "Host session exchange failed");
  }
  const issued = (await token.json()) as {
    access_token?: unknown;
    expires_in?: unknown;
  };
  if (
    typeof issued.access_token !== "string" ||
    !issued.access_token.startsWith("opaque-session:") ||
    typeof issued.expires_in !== "number" ||
    issued.expires_in <= 0
  ) {
    throw new Error("Host returned an invalid session.");
  }
  if (!unchanged()) throw new Error("Identity changed during Host sign-in.");
  return {
    accessToken: issued.access_token,
    expiresAt: Date.now() + issued.expires_in * 1000,
    hostApi,
    identityAccessToken: identity.accessToken,
  };
}

async function ensureHostSession(): Promise<HostSession> {
  const existing = currentHostSession();
  if (existing) return existing;
  const identity = currentSession();
  if (!identity) {
    throw new Error("Connect to Identity before using the Host.");
  }
  if (!pendingHostSession) {
    pendingHostSession = mintHostSession(identity).then((issued) => {
      hostSession = issued;
      return issued;
    });
  }
  const pending = pendingHostSession;
  try {
    return await pending;
  } finally {
    if (pendingHostSession === pending) pendingHostSession = null;
  }
}

/** Fetch against the Host as the connected principal, never as deployment operator. */
export async function hostFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const active = await ensureHostSession();
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${active.accessToken}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${hostBase()}${path}`, {
    ...init,
    headers,
    credentials: "omit",
  });
  if (response.status === 401) clearHostSession();
  return response;
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; error?: string };
    return body.message ?? body.error ?? `Request failed (${res.status}).`;
  } catch {
    return `Request failed (${res.status}).`;
  }
}

/** Fetch against the Identity API, attaching the session when we have one. */
export async function identityFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  const active = currentSession();
  if (active) headers.set("authorization", `Bearer ${active.accessToken}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return fetch(`${identityBase()}${path}`, {
    ...init,
    headers,
    credentials: "include",
  });
}

export async function identityJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await identityFetch(path, init);
  if (!res.ok) throw new IdentityError(await readError(res), res.status);
  return (await res.json()) as T;
}

/** Start a provisional session. This is the anonymous on-ramp the API exposes. */
export async function connectProvisional(): Promise<IdentitySession> {
  const res = await fetch(`${identityBase()}/v1/principals/provisional`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: "{}",
  });
  if (!res.ok) throw new IdentityError(await readError(res), res.status);
  const body = (await res.json()) as {
    principalId: string;
    accessToken: string;
    expiresAt: string;
  };
  session = {
    principalId: body.principalId,
    accessToken: body.accessToken,
    expiresAt: body.expiresAt,
  };
  emit();
  return session;
}

/** Adopt a token the operator already holds (CLI `opensesame-id`, tests). */
export function adoptToken(accessToken: string, principalId = "unknown"): void {
  session = {
    principalId,
    accessToken: accessToken.trim(),
    // The API is authoritative; assume a short horizon and let 401s correct us.
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  emit();
}

export async function fetchPrincipal(): Promise<Principal> {
  return identityJson<Principal>("/v1/principals/me");
}

export type HealthState = "unknown" | "reachable" | "unreachable";

export async function probeIdentity(): Promise<HealthState> {
  try {
    const res = await fetch(`${identityBase()}/v1/health/live`, {
      credentials: "omit",
    });
    return res.ok ? "reachable" : "unreachable";
  } catch {
    return "unreachable";
  }
}

export async function probeHost(): Promise<HealthState> {
  try {
    const res = await fetch(`${hostBase()}/api/v1/health`, {
      credentials: "omit",
    });
    return res.ok ? "reachable" : "unreachable";
  } catch {
    return "unreachable";
  }
}

export function useIdentitySession(): IdentitySession | null {
  const [value, setValue] = useState(currentSession);
  useEffect(() => {
    const listener = () => setValue(currentSession());
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return value;
}

/** Connect-on-demand helper shared by every section that needs a principal. */
export function useConnect(): {
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
} {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      await connectProvisional();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not reach the Identity API.",
      );
    } finally {
      setConnecting(false);
    }
  }, []);
  return { connecting, error, connect };
}
