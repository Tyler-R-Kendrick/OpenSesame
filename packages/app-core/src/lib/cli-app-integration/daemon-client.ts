import { isJsonObject, isString, overlapCast } from "@opensesame/os-domain";
import { localNetworkFetch } from "../local-network-fetch.js";
import { loadSettings } from "../settings.js";
import { cliAppIntegrationPolicy } from "./policy.js";
import type { PendingRequest } from "./session.js";

export type CliIntegrationDecision = "approve" | "deny";

function daemonBase(): string | null {
  const fromSettings = loadSettings().daemonApi.trim();
  const raw = fromSettings || "http://127.0.0.1:18790";
  try {
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    return url.origin.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function parsePending(body: unknown): readonly PendingRequest[] {
  if (!isJsonObject(body) || !Array.isArray(body.pending)) return [];
  const rows: PendingRequest[] = [];
  for (const entry of body.pending) {
    if (!isJsonObject(entry)) continue;
    const requestId = isString(entry.requestId) ? entry.requestId : "";
    const terminalSessionId = isString(entry.terminalSessionId)
      ? entry.terminalSessionId
      : "";
    const verb = isString(entry.verb) ? entry.verb : "";
    if (!requestId || !terminalSessionId || !verb) continue;
    const reference = isString(entry.reference) ? entry.reference : undefined;
    rows.push({
      requestId,
      terminalSessionId,
      verb,
      reference,
      createdAtMs: 0,
    });
  }
  return rows;
}

export const cliAppIntegrationDaemonSeams = {
  base: daemonBase,
  fetch: localNetworkFetch,
};

export async function listCliIntegrationPending(): Promise<
  readonly PendingRequest[]
> {
  const base = cliAppIntegrationDaemonSeams.base();
  if (!base) return [];
  const path = cliAppIntegrationPolicy.daemonPaths.pending;
  const response = await cliAppIntegrationDaemonSeams.fetch(`${base}${path}`, {
    method: "GET",
    credentials: "omit",
    cache: "no-store",
  });
  if (!response.ok) return [];
  const body = overlapCast(await response.json());
  return parsePending(body);
}

export async function respondCliIntegration(
  requestId: string,
  terminalSessionId: string,
  decision: CliIntegrationDecision,
): Promise<boolean> {
  const base = cliAppIntegrationDaemonSeams.base();
  if (!base) return false;
  const path = cliAppIntegrationPolicy.daemonPaths.respond;
  const response = await cliAppIntegrationDaemonSeams.fetch(`${base}${path}`, {
    method: "POST",
    credentials: "omit",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      requestId,
      terminalSessionId,
      decision,
    }),
  });
  if (!response.ok) return false;
  const body = overlapCast(await response.json());
  if (!isJsonObject(body) || !isString(body.status)) return false;
  return body.status === decision || body.status === "approved";
}
