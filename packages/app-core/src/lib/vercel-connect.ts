/**
 * Vercel Connect session + readiness. CRUD lives in `vercel-connect-ops.ts`.
 * Prefer the Connect relay (no browser token); sealed session auth is fallback.
 * Never call `getToken`: tokens stay in Connect (ADR 0005).
 */

import {
  getConnectorMetadata,
  revokeToken,
  startAuthorization,
} from "@vercel/connect";
import { isVercelConnectable } from "./vercel-connect-catalog.js";
import { connectRelayConfigured } from "./vercel-connect-relay.js";

export { toConnectConnection } from "./vercel-connect-map.js";

export const CONNECT_API = "https://api.vercel.com";

export type VercelConnectAuth = {
  token: string;
  teamId?: string;
  projectId?: string;
};

export class ConnectError extends Error {
  readonly name = "ConnectError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

let sessionAuth: VercelConnectAuth | null = null;
const listeners = new Set<() => void>();
/** Connector ids listed or created on the live Connect transport this session. */
const knownConnectors = new Set<string>();

export function rememberConnector(id: string): void {
  if (id) knownConnectors.add(id);
}

export function vercelConnectAuth(): VercelConnectAuth | null {
  return sessionAuth;
}

/** Live Connect transport: relay (preferred) or a sealed session token. */
export function usesConnect(providerId?: string): boolean {
  if (!vercelConnectConfigured()) return false;
  if (providerId === undefined) return true;
  return isVercelConnectable(providerId);
}

/** True only for connectors this session listed or created via Connect. */
export function isConnectConnector(id: string): boolean {
  return vercelConnectConfigured() && knownConnectors.has(id);
}

export function vercelConnectConfigured(): boolean {
  return connectRelayConfigured() || Boolean(vercelConnectAuth()?.token);
}

export function setVercelConnectAuth(next: VercelConnectAuth | null): void {
  sessionAuth = next;
  if (!next) knownConnectors.clear();
  for (const listener of listeners) listener();
}

export function subscribeVercelConnectAuth(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const vercelConnectSeams = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init),
  auth: vercelConnectAuth,
  startAuthorization,
  getConnectorMetadata,
  revokeToken,
};

export function sdkOptions(auth: VercelConnectAuth) {
  return { vercelToken: auth.token };
}

export function appSubject(scopes?: string[]) {
  if (scopes?.length) {
    return { subject: { type: "app" as const }, scopes };
  }
  return { subject: { type: "app" as const } };
}

export function requireAuth(): VercelConnectAuth {
  const auth = vercelConnectSeams.auth();
  if (!auth?.token) {
    throw new ConnectError(
      0,
      "unconfigured",
      "Vercel Connect is not configured.",
    );
  }
  return auth;
}

export function requireTransport(): "relay" | VercelConnectAuth {
  if (connectRelayConfigured()) return "relay";
  return requireAuth();
}
