/**
 * Loopback daemon client for CLI app-integration (ADR 0186).
 */

import { localNetworkFetch } from "../local-network-fetch.js";
import { cliAppDaemonPaths } from "./daemon-paths.js";

export type CliAppPendingRow = Readonly<{
  requestId: string;
  terminalSessionId: string;
  verb: string;
  respondNonce: string;
}>;

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
  daemonOrigin: string,
  headers: Record<string, string>,
): Promise<CliAppPendingRow | null> {
  const res = await localNetworkFetch(
    `${daemonOrigin}${cliAppDaemonPaths.pending}`,
    {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      headers,
    },
  );
  if (!res.ok) return null;
  return parseFirstPending(await res.json());
}
