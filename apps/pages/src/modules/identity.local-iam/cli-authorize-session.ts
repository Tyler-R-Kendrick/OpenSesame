import { readCliAppIntegrationBearer } from "@opensesame/app-core/lib/cli-app-integration/bearer-session.js";
import { localNetworkFetch } from "@opensesame/app-core/lib/local-network-fetch.js";
import { loadSettings } from "@opensesame/app-core/lib/settings.js";
import {
  type BoundaryValue,
  isJsonObject,
  readString,
} from "@opensesame/os-domain";

export type CliAuthorizeRow = readonly [
  requestId: string,
  terminalSessionId: string,
  verb: string,
  respondNonce: string,
];

export function daemonOrigin(): string | null {
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

export function pageOrigin(): string | null {
  try {
    return window.location.origin;
  } catch {
    return null;
  }
}

export function parseFirstPending(body: BoundaryValue): CliAuthorizeRow | null {
  if (!isJsonObject(body) || !Array.isArray(body.pending)) return null;
  const entry = body.pending[0];
  if (!isJsonObject(entry)) return null;
  const requestId = readString(entry.requestId);
  const terminalSessionId = readString(entry.terminalSessionId);
  const verb = readString(entry.verb);
  const respondNonce = readString(entry.respondNonce);
  if (!requestId || !terminalSessionId || !verb || !respondNonce) return null;
  return [requestId, terminalSessionId, verb, respondNonce];
}

export function cliAuthorizeAuthHeaders(): Record<string, string> | null {
  const token = readCliAppIntegrationBearer();
  const origin = pageOrigin();
  if (!token || !origin) return null;
  return {
    authorization: `Bearer ${token}`,
    Origin: origin,
  };
}

export async function postCliAuthorizeRespond(
  row: CliAuthorizeRow,
  decision: "approve" | "deny",
  humanProof?: string,
): Promise<boolean> {
  const origin = daemonOrigin();
  const headers = cliAuthorizeAuthHeaders();
  if (!origin || !headers) return false;
  const body: Record<string, string> = {
    requestId: row[0],
    terminalSessionId: row[1],
    decision,
    respondNonce: row[3],
  };
  if (decision === "approve" && humanProof) body.humanProof = humanProof;
  const res = await localNetworkFetch(
    `${origin}/v1/cli/app-integration/respond`,
    {
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  return res.ok;
}
