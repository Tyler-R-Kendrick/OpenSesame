import { localNetworkFetch } from "../local-network-fetch.js";
import { loadSettings } from "../settings.js";
import { cliAppIntegrationPolicy } from "./policy-runtime.js";
import type { PendingRequest } from "./session.js";

export type CliIntegrationDecision = "approve" | "deny";

const verbLabels = cliAppIntegrationPolicy.verbLabels;
const ui = cliAppIntegrationPolicy.ui;

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
  if (!body || typeof body !== "object") return [];
  const pending = Reflect.get(body, "pending");
  if (!Array.isArray(pending)) return [];
  const rows: PendingRequest[] = [];
  for (const entry of pending) {
    if (!entry || typeof entry !== "object") continue;
    const requestId = Reflect.get(entry, "requestId");
    const terminalSessionId = Reflect.get(entry, "terminalSessionId");
    const verb = Reflect.get(entry, "verb");
    if (
      typeof requestId !== "string" ||
      typeof terminalSessionId !== "string" ||
      typeof verb !== "string" ||
      !requestId ||
      !terminalSessionId ||
      !verb
    ) {
      continue;
    }
    const reference = Reflect.get(entry, "reference");
    rows.push({
      requestId,
      terminalSessionId,
      verb,
      reference: typeof reference === "string" ? reference : undefined,
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
  return parsePending(await response.json());
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
  const body = await response.json();
  if (!body || typeof body !== "object") return false;
  const status = Reflect.get(body, "status");
  if (typeof status !== "string") return false;
  return status === decision || status === "approved";
}

export type CliAuthorizeView = Readonly<{
  terminalLabel: string;
  commandLabel: string;
  targetLine: string | null;
}>;

export function cliAuthorizeCopy() {
  return ui;
}

export function presentCliAuthorizeRequest(row: PendingRequest): CliAuthorizeView {
  const id = row.terminalSessionId.trim();
  const terminalLabel =
    id.length <= 12 ? id || "Unknown terminal" : `${id.slice(0, 6)}…${id.slice(-4)}`;
  const commandLabel =
    verbLabels[row.verb as keyof typeof verbLabels] ?? row.verb;
  const reference = row.reference?.trim();
  return {
    terminalLabel,
    commandLabel,
    targetLine: reference || null,
  };
}
