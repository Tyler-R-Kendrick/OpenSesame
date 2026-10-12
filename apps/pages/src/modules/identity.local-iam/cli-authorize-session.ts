import { readCliAppIntegrationBearer } from "@opensesame/app-core/lib/cli-app-integration/bearer-session.js";
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
