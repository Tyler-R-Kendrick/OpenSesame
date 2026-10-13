/**
 * Loopback daemon client for CLI app-integration (ADR 0186).
 */

import gate from "../../../../../spec/conformance/cli-app-integration.json" with {
  type: "json",
};
import { localNetworkFetch } from "../local-network-fetch.js";
import { loadSettings } from "../settings.js";
import { readCliAppIntegrationBearer } from "./bearer-session.js";

export type CliAppPendingRow = Readonly<{
  requestId: string;
  terminalSessionId: string;
  verb: string;
  respondNonce: string;
}>;

export function readDaemonOrigin(): string | null {
  const raw = loadSettings().daemonApi.trim() || "http://127.0.0.1:18790";
  try {
    return new URL(raw.includes("://") ? raw : `http://${raw}`).origin.replace(
      /\/$/,
      "",
    );
  } catch {
    return null;
  }
}

export function readCliAppAuthHeaders(
  pageOrigin: string | null,
): Record<string, string> | null {
  const token = readCliAppIntegrationBearer();
  if (!token || !pageOrigin) return null;
  return {
    authorization: `Bearer ${token}`,
    Origin: pageOrigin,
  };
}

function parseFirstPending(body: unknown): CliAppPendingRow | null {
  if (!body || typeof body !== "object") return null;
  const pending = (body as { pending?: unknown }).pending;
  if (!Array.isArray(pending) || pending.length === 0) return null;
  const entry = pending[0];
  if (!entry || typeof entry !== "object") return null;
  const requestId = (entry as { requestId?: unknown }).requestId;
  const terminalSessionId = (
    entry as {
      terminalSessionId?: unknown;
    }
  ).terminalSessionId;
  const verb = (entry as { verb?: unknown }).verb;
  const respondNonce = (entry as { respondNonce?: unknown }).respondNonce;
  if (
    typeof requestId !== "string" ||
    typeof terminalSessionId !== "string" ||
    typeof verb !== "string" ||
    typeof respondNonce !== "string"
  ) {
    return null;
  }
  return { requestId, terminalSessionId, verb, respondNonce };
}

export async function fetchFirstCliAppPending(
  pageOrigin: string | null,
): Promise<CliAppPendingRow | null> {
  const origin = readDaemonOrigin();
  const headers = readCliAppAuthHeaders(pageOrigin);
  if (!origin || !headers) return null;
  const res = await localNetworkFetch(`${origin}${gate.daemonPaths.pending}`, {
    method: "GET",
    credentials: "omit",
    cache: "no-store",
    headers,
  });
  if (!res.ok) return null;
  return parseFirstPending(await res.json());
}

export const CLI_AUTHORIZE_ROUTE = "/identity/authorize?cli=1";
