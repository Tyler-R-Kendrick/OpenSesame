/**
 * CLI app-integration pairing wire + session bearer (ADR 0186).
 * Conformance: `spec/conformance/cli-app-integration-pairing.json`.
 */

import { isTailnetOrLoopback, normalizeTailnetBase } from "../urls.js";
import { writeCliAppIntegrationBearer } from "./bearer-session.js";

/** 32 random bytes, unpadded base64url — same as `plugin-pairing.ts` SECRET. */
export const CLI_APP_PAIRING_SECRET = /^[A-Za-z0-9_-]{43}$/;

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

export type CliAppPairingConfirmOutcome = Readonly<{
  registrationCode: string;
}>;

function wireString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function isPairableOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin || url.username || url.password) return false;
  if (url.protocol === "https:") return !url.hostname.endsWith(".");
  return (
    url.protocol === "http:" && url.hostname === "localhost" && url.port !== ""
  );
}

function daemonBase(url: string): string | null {
  const base = normalizeTailnetBase(url);
  return base && isTailnetOrLoopback(base) ? base : null;
}

function decodePairingPayload(text: string): Record<string, unknown> | null {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  const pad = (4 - (padded.length % 4)) % 4;
  try {
    const binary = atob(padded + "=".repeat(pad));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function parseCliAppPairingCode(raw: string): CliAppPairingCode | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith(CLI_APP_PAIRING_PREFIX)) return null;
  const wire = decodePairingPayload(
    trimmed.slice(CLI_APP_PAIRING_PREFIX.length),
  );
  if (!wire) return null;
  const code = wireString(wire, "code");
  const origin = wireString(wire, "origin");
  const url = wireString(wire, "url");
  const label = wireString(wire, "label");
  if (
    !code ||
    !CLI_APP_PAIRING_SECRET.test(code) ||
    !origin ||
    !isPairableOrigin(origin) ||
    !url ||
    !daemonBase(url) ||
    !label
  ) {
    return null;
  }
  return { code, origin, url, label };
}

type PairingConfirmBody = Readonly<{
  code: string;
  devicePublicKeySpkiB64: string;
  pairingSignatureB64: string;
}>;

type PairingExchangeBody = Readonly<{
  code: string;
}>;

async function postPairing(
  base: string,
  path: string,
  origin: string,
  body: PairingConfirmBody | PairingExchangeBody,
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

export async function fetchCliAppPairingChallenge(
  parsed: CliAppPairingCode,
): Promise<Uint8Array | null> {
  const base = daemonBase(parsed.url);
  if (!base) return null;
  const url = new URL(`${base}${CLI_APP_PAIRING_CHALLENGE_PATH}`);
  url.searchParams.set("code", parsed.code);
  const res = await fetch(url, {
    method: "GET",
    credentials: "omit",
    headers: { Origin: parsed.origin },
  });
  if (!res.ok) return null;
  const body: unknown = await res.json();
  if (!body || typeof body !== "object") return null;
  const challengeB64 = wireString(
    body as Record<string, unknown>,
    "challengeB64",
  );
  if (!challengeB64) return null;
  const { b64urlDecode } = await import("./device-crypto.js");
  const bytes = b64urlDecode(challengeB64);
  return bytes && bytes.byteLength === 32 ? bytes : null;
}

export async function confirmCliAppPairingCode(
  parsed: CliAppPairingCode,
): Promise<CliAppPairingConfirmOutcome | null> {
  const base = daemonBase(parsed.url);
  if (!base) return null;
  const { pairingConfirmMessage, ensureCliAppDeviceSigningKey } = await import(
    "./device-crypto.js"
  );
  const device = await ensureCliAppDeviceSigningKey();
  if (!device) return null;
  const challenge = await fetchCliAppPairingChallenge(parsed);
  if (!challenge) return null;
  const message = pairingConfirmMessage(challenge, parsed.code, parsed.origin);
  const pairingSignatureB64 = await device.sign(message);
  const res = await postPairing(
    base,
    CLI_APP_PAIRING_CONFIRM_PATH,
    parsed.origin,
    {
      code: parsed.code,
      devicePublicKeySpkiB64: device.publicKeySpkiB64,
      pairingSignatureB64,
    },
  );
  if (!res.ok) return null;
  const body: unknown = await res.json();
  if (!body || typeof body !== "object") return null;
  const registrationCode = wireString(
    body as Record<string, unknown>,
    "registrationCode",
  );
  if (!registrationCode || registrationCode.length !== 6) {
    return null;
  }
  return { registrationCode };
}

export async function exchangeCliAppPairingCode(
  parsed: CliAppPairingCode,
): Promise<boolean> {
  const base = daemonBase(parsed.url);
  if (!base) return false;
  const res = await postPairing(
    base,
    CLI_APP_PAIRING_EXCHANGE_PATH,
    parsed.origin,
    {
      code: parsed.code,
    },
  );
  if (res.status !== 201) return false;
  const body: unknown = await res.json();
  if (!body || typeof body !== "object") return false;
  const token = wireString(body as Record<string, unknown>, "token");
  if (!token || !CLI_APP_PAIRING_SECRET.test(token)) return false;
  writeCliAppIntegrationBearer(token);
  return true;
}

/** Confirm in the unlocked PWA, then exchange for the session bearer. */
export async function completeCliAppPairing(
  parsed: CliAppPairingCode,
): Promise<CliAppPairingConfirmOutcome | null> {
  const confirmed = await confirmCliAppPairingCode(parsed);
  if (!confirmed) return null;
  if (!(await exchangeCliAppPairingCode(parsed))) return null;
  return confirmed;
}
