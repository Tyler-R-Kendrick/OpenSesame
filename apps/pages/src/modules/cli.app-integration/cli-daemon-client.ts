import type { PendingRequest } from "@opensesame/app-core/lib/cli-app-integration/pending-request.js";
import { localNetworkFetch } from "@opensesame/app-core/lib/local-network-fetch.js";
import { loadSettings } from "@opensesame/app-core/lib/settings.js";

export type CliIntegrationDecision = "approve" | "deny";

const LOOPBACK_DEFAULT = "http://127.0.0.1:18790";
const PENDING_PATH = "/v1/cli/app-integration/pending";
const RESPOND_PATH = "/v1/cli/app-integration/respond";

function daemonBase(): string | null {
  const raw = loadSettings().daemonApi.trim() || LOOPBACK_DEFAULT;
  try {
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    return url.origin.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value);
  return text.length > 0 ? text : undefined;
}

function parsePendingList(body: unknown): readonly PendingRequest[] {
  if (!isJsonObject(body)) return [];
  const pending = body.pending;
  if (pending === undefined) return [];
  if (!Array.isArray(pending)) return [];
  const rows: PendingRequest[] = [];
  for (const entry of pending) {
    if (!isJsonObject(entry)) continue;
    const requestId = readNonEmptyString(entry.requestId);
    const terminalSessionId = readNonEmptyString(entry.terminalSessionId);
    const verb = readNonEmptyString(entry.verb);
    if (!requestId || !terminalSessionId || !verb) continue;
    const reference = readNonEmptyString(entry.reference);
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

function parseRespondOk(
  body: unknown,
  decision: CliIntegrationDecision,
): boolean {
  if (!isJsonObject(body)) return false;
  const status = body.status;
  if (status === undefined || status === null) return false;
  const text = String(status);
  return text === decision || text === "approved";
}

export const cliDaemonClientSeams = {
  base: daemonBase,
  fetch: localNetworkFetch,
};

export async function listCliIntegrationPending(): Promise<
  readonly PendingRequest[]
> {
  const base = cliDaemonClientSeams.base();
  if (!base) return [];
  const response = await cliDaemonClientSeams.fetch(`${base}${PENDING_PATH}`, {
    method: "GET",
    credentials: "omit",
    cache: "no-store",
  });
  if (!response.ok) return [];
  const body: unknown = await response.json();
  return parsePendingList(body);
}

export async function respondCliIntegration(
  requestId: string,
  terminalSessionId: string,
  decision: CliIntegrationDecision,
): Promise<boolean> {
  const base = cliDaemonClientSeams.base();
  if (!base) return false;
  const response = await cliDaemonClientSeams.fetch(`${base}${RESPOND_PATH}`, {
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
  const body: unknown = await response.json();
  return parseRespondOk(body, decision);
}
