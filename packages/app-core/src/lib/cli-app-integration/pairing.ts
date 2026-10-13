/**
 * Pairing code for CLI app-integration (`spec/conformance/cli-app-integration-pairing.json`).
 */

import { b64urlToBytes } from "@opensesame/vault-core";
import { SECRET, isPairableOrigin } from "../tailnet-sync/plugin-pairing.js";
import { isTailnetOrLoopback, normalizeTailnetBase } from "../urls.js";
import { writeCliAppIntegrationBearer } from "./bearer-session.js";

export const CLI_APP_PAIRING_PREFIX = "opensesame-cli-app:v1:";
export const CLI_APP_PAIRING_EXCHANGE_PATH = "/v1/cli/app-integration/pairing";
export const CLI_APP_PAIRING_CONFIRM_PATH =
  "/v1/cli/app-integration/pairing/confirm";

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

/** One-time binding secret minted in the unlocked PWA when a person confirms the code. */
export function mintCliAppPairingPageBinding(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) {
    out += String.fromCharCode(byte);
  }
  return btoa(out)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export {
  readCliAppIntegrationBearer,
  writeCliAppIntegrationBearer,
} from "./bearer-session.js";

async function postPairing(
  base: string,
  path: string,
  origin: string,
  body: Record<string, string>,
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    credentials: "omit",
    headers: {
      "content-type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify(body),
  });
}

export async function confirmCliAppPairingCode(
  parsed: CliAppPairingCode,
  pageBinding: string,
): Promise<boolean> {
  const base = daemonBase(parsed.url);
  if (!base || !SECRET.test(pageBinding)) return false;
  const res = await postPairing(base, CLI_APP_PAIRING_CONFIRM_PATH, parsed.origin, {
    code: parsed.code,
    pageBinding,
  });
  return res.status === 204;
}

export async function exchangeCliAppPairingCode(
  parsed: CliAppPairingCode,
  pageBinding: string,
): Promise<boolean> {
  const base = daemonBase(parsed.url);
  if (!base || !SECRET.test(pageBinding)) return false;
  const res = await postPairing(base, CLI_APP_PAIRING_EXCHANGE_PATH, parsed.origin, {
    code: parsed.code,
    pageBinding,
  });
  if (res.status !== 201) return false;
  const body: unknown = await res.json();
  if (!body || typeof body !== "object") return false;
  const token = (body as { token?: string }).token;
  if (typeof token !== "string" || !SECRET.test(token)) return false;
  writeCliAppIntegrationBearer(token);
  return true;
}

/** Confirm in the unlocked PWA, then exchange for the session bearer. */
export async function completeCliAppPairing(
  parsed: CliAppPairingCode,
): Promise<boolean> {
  const pageBinding = mintCliAppPairingPageBinding();
  if (!(await confirmCliAppPairingCode(parsed, pageBinding))) return false;
  return exchangeCliAppPairingCode(parsed, pageBinding);
}
