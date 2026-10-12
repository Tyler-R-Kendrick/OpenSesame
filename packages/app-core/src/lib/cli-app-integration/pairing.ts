/**
 * Pairing code for CLI app-integration (`spec/conformance/cli-app-integration-pairing.json`).
 */

import { b64urlToBytes } from "@opensesame/vault-core";
import { sessionStore } from "../../ports.js";
import { SECRET, isPairableOrigin } from "../tailnet-sync/plugin-pairing.js";
import { isTailnetOrLoopback, normalizeTailnetBase } from "../urls.js";

export const CLI_APP_PAIRING_PREFIX = "opensesame-cli-app:v1:";
export const CLI_APP_PAIRING_EXCHANGE_PATH = "/v1/cli/app-integration/pairing";

const SESSION_KEY = "opensesame-cli-app-integration-bearer";

export type CliAppPairingCode = Readonly<{
  url: string;
  code: string;
  origin: string;
  label: string;
}>;

function daemonBase(url: string): string | null {
  const base = normalizeTailnetBase(url);
  return base && isTailnetOrLoopback(base) ? base : null;
}

function decodeJson(text: string) {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(text)));
  } catch {
    return null;
  }
}

export function parseCliAppPairingCode(raw: string): CliAppPairingCode | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith(CLI_APP_PAIRING_PREFIX)) return null;
  const payload = trimmed.slice(CLI_APP_PAIRING_PREFIX.length);
  const wire = decodeJson(payload);
  if (!wire || typeof wire !== "object") return null;
  const code = wire.code;
  const origin = wire.origin;
  const url = wire.url;
  const label = wire.label;
  if (
    typeof code !== "string" ||
    !SECRET.test(code) ||
    typeof origin !== "string" ||
    !isPairableOrigin(origin) ||
    typeof url !== "string" ||
    !daemonBase(url) ||
    typeof label !== "string"
  ) {
    return null;
  }
  return { code, origin, url, label };
}

export function readCliAppIntegrationBearer(): string | null {
  try {
    const raw = sessionStore().getItem(SESSION_KEY);
    return raw && SECRET.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function writeCliAppIntegrationBearer(token: string): void {
  if (!SECRET.test(token)) return;
  try {
    sessionStore().setItem(SESSION_KEY, token);
  } catch {
    // session store unavailable
  }
}

export async function exchangeCliAppPairingCode(
  parsed: CliAppPairingCode,
): Promise<boolean> {
  const base = daemonBase(parsed.url);
  if (!base) return false;
  const res = await fetch(`${base}${CLI_APP_PAIRING_EXCHANGE_PATH}`, {
    method: "POST",
    credentials: "omit",
    headers: {
      "content-type": "application/json",
      Origin: parsed.origin,
    },
    body: JSON.stringify({ code: parsed.code }),
  });
  if (res.status !== 201) return false;
  const body: unknown = await res.json();
  if (!body || typeof body !== "object") return false;
  const token = (body as { token?: string }).token;
  if (typeof token !== "string" || !SECRET.test(token)) return false;
  writeCliAppIntegrationBearer(token);
  return true;
}
