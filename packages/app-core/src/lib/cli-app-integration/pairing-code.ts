/**
 * CLI app-integration pairing wire parse (no device crypto — safe for static import).
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { b64urlToBytes } from "@opensesame/vault-core";
import { SECRET, isPairableOrigin } from "../tailnet-sync/plugin-pairing.js";
import { isTailnetOrLoopback, normalizeTailnetBase } from "../urls.js";

export const CLI_APP_PAIRING_PREFIX = "opensesame-cli-app:v1:";
export const CLI_APP_PAIRING_EXCHANGE_PATH = "/v1/cli/app-integration/pairing";
export const CLI_APP_PAIRING_CONFIRM_PATH =
  "/v1/cli/app-integration/pairing/confirm";
export const CLI_APP_PAIRING_CHALLENGE_PATH =
  "/v1/cli/app-integration/pairing/challenge";

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

function decodeJson(text: string): BoundaryValue | null {
  try {
    return overlapCast(JSON.parse(new TextDecoder().decode(b64urlToBytes(text))));
  } catch {
    return null;
  }
}

export function parseCliAppPairingCode(raw: string): CliAppPairingCode | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith(CLI_APP_PAIRING_PREFIX)) return null;
  const payload = trimmed.slice(CLI_APP_PAIRING_PREFIX.length);
  const wire = decodeJson(payload);
  if (!wire || !isJsonObject(wire)) return null;
  const code = wire.code;
  const origin = wire.origin;
  const url = wire.url;
  const label = wire.label;
  if (
    !isString(code) ||
    !SECRET.test(code) ||
    !isString(origin) ||
    !isPairableOrigin(origin) ||
    !isString(url) ||
    !daemonBase(url) ||
    !isString(label)
  ) {
    return null;
  }
  return { code, origin, url, label };
}
