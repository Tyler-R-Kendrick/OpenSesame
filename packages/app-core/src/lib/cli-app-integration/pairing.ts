/**
 * CLI app-integration pairing wire + session bearer (ADR 0186).
 * Conformance: `spec/conformance/cli-app-integration-pairing.json`.
 */

import { z } from "zod";
import { localNetworkFetch } from "../local-network-fetch.js";
import { isTailnetOrLoopback, normalizeTailnetBase } from "../urls.js";
import {
  clearCliAppIntegrationBearer,
  writeCliAppIntegrationBearer,
} from "./bearer-session.js";
import type { CliAppPasskeyRegistration } from "./webauthn-credential.js";

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

export type CliAppPairingFailure = Readonly<{
  ok: false;
  code: string;
  message: string;
}>;

export type CliAppPairingConfirmOutcome = Readonly<{
  ok: true;
  registrationCode: string;
}>;

const PAIRING_REFUSAL_MESSAGES = new Map<string, string>([
  ["origin_required", "This page's origin cannot pair."],
  [
    "root_key_not_enrolled",
    "The root trust key is not enrolled, so pairing cannot finish.",
  ],
  ["pairing_confirm_required", "Confirm the pairing code before finishing."],
  [
    "pairing_registration_required",
    "Type the registration code into the terminal, then finish pairing.",
  ],
  ["pairing_registration_mismatch", "The registration code did not match."],
  [
    "too_many_pairings",
    "Too many pairings are stored. Remove one, then try again.",
  ],
  ["invalid_proof", "The passkey proof was rejected."],
  ["pairing_expired", "That pairing code expired."],
  ["pairing_unknown", "That pairing code is not waiting."],
  ["pairing_wrong_origin", "That pairing code was issued for another origin."],
  ["invalid_origin", "That origin cannot pair."],
  [
    "cli_app_pairing_required",
    "Pairing did not stick. Start again from the code.",
  ],
  [
    "ark_enrollment_required",
    "Approver enrollment is required before pairing can finish.",
  ],
  [
    "client_supplied_spki_rejected",
    "A software key cannot stand in for the passkey.",
  ],
  ["vault_locked", "Unlock the vault before pairing."],
  ["challenge_unavailable", "The pairing challenge could not be read."],
  ["network", "The pairing service could not be reached."],
  ["pairing_unreadable", "The pairing refusal could not be read."],
]);

/** One sentence per daemon or local refusal. Unknown codes keep their code. */
export function cliAppPairingRefusalMessage(code: string): string {
  return PAIRING_REFUSAL_MESSAGES.get(code) ?? `Pairing was refused (${code}).`;
}

function refused(code: string, message?: string): CliAppPairingFailure {
  return {
    ok: false,
    code,
    message: message ?? cliAppPairingRefusalMessage(code),
  };
}

const pairingPayloadSchema = z.object({
  code: z.string(),
  origin: z.string(),
  url: z.string(),
  label: z.string(),
});

const pairingChallengeBodySchema = z.object({
  challengeB64: z.string(),
});

const pairingConfirmBodySchema = z.object({
  registrationCode: z.string().length(6),
});

const pairingExchangeBodySchema = z.object({
  token: z.string(),
});

const CLI_APP_PAIRING_WEBAUTHN_PATH =
  "/v1/cli/app-integration/pairing/webauthn";

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

function decodePairingPayload(
  text: string,
): z.infer<typeof pairingPayloadSchema> | null {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  const pad = (4 - (padded.length % 4)) % 4;
  try {
    const binary = atob(padded + "=".repeat(pad));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const parsed = pairingPayloadSchema.safeParse(
      JSON.parse(new TextDecoder().decode(bytes)),
    );
    return parsed.success ? parsed.data : null;
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
  const { code, origin, url, label } = wire;
  if (
    !CLI_APP_PAIRING_SECRET.test(code) ||
    !isPairableOrigin(origin) ||
    !daemonBase(url)
  ) {
    return null;
  }
  return { code, origin, url, label };
}

type PairingConfirmBody = Readonly<{
  code: string;
  devicePublicKeySpkiB64: string;
  pairingSignatureB64: string;
  vaultSessionRootDigest: string;
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
  return localNetworkFetch(`${base}${path}`, {
    method: "POST",
    credentials: "omit",
    headers: {
      "content-type": "application/json",
      Origin: origin,
    },
    body: JSON.stringify(body),
    timeoutMs: 15_000,
  });
}

async function refusalFromResponse(
  res: Response,
): Promise<CliAppPairingFailure> {
  let code = "pairing_unreadable";
  try {
    const body = z
      .object({ error: z.string().min(1) })
      .safeParse(await res.json());
    if (body.success) code = body.data.error;
  } catch {
    code = "pairing_unreadable";
  }
  return refused(code);
}

export async function fetchCliAppPairingChallenge(
  parsed: CliAppPairingCode,
): Promise<Uint8Array | CliAppPairingFailure> {
  const base = daemonBase(parsed.url);
  if (!base) return refused("invalid_origin");
  const url = new URL(`${base}${CLI_APP_PAIRING_CHALLENGE_PATH}`);
  url.searchParams.set("code", parsed.code);
  const res = await localNetworkFetch(url.href, {
    method: "GET",
    credentials: "omit",
    headers: { Origin: parsed.origin },
    timeoutMs: 15_000,
  });
  if (!res.ok) return refusalFromResponse(res);
  const body = pairingChallengeBodySchema.safeParse(await res.json());
  if (!body.success) return refused("pairing_unreadable");
  const { b64urlDecode } = await import("./device-crypto.js");
  const bytes = b64urlDecode(body.data.challengeB64);
  return bytes && bytes.byteLength === 32
    ? bytes
    : refused("challenge_unavailable");
}

export async function confirmCliAppPairingCode(
  parsed: CliAppPairingCode,
): Promise<CliAppPairingConfirmOutcome | CliAppPairingFailure> {
  const base = daemonBase(parsed.url);
  if (!base) return refused("invalid_origin");
  const {
    pairingConfirmMessage,
    ensureCliAppDeviceSigningKey,
    readVaultSessionRootDigestForCliApp,
  } = await import("./device-crypto.js");
  const device = await ensureCliAppDeviceSigningKey();
  const vaultSessionRootDigest = await readVaultSessionRootDigestForCliApp();
  if (!device || !vaultSessionRootDigest) return refused("vault_locked");
  let challenge: Uint8Array | CliAppPairingFailure;
  try {
    challenge = await fetchCliAppPairingChallenge(parsed);
  } catch {
    return refused("network");
  }
  if (!(challenge instanceof Uint8Array)) return challenge;
  const message = pairingConfirmMessage(challenge, parsed.code, parsed.origin);
  const pairingSignatureB64 = await device.sign(message);
  let res: Response;
  try {
    res = await postPairing(base, CLI_APP_PAIRING_CONFIRM_PATH, parsed.origin, {
      code: parsed.code,
      devicePublicKeySpkiB64: device.publicKeySpkiB64,
      pairingSignatureB64,
      vaultSessionRootDigest,
    });
  } catch {
    return refused("network");
  }
  if (!res.ok) return refusalFromResponse(res);
  const body = pairingConfirmBodySchema.safeParse(await res.json());
  if (!body.success) return refused("pairing_unreadable");
  return { ok: true, registrationCode: body.data.registrationCode };
}

export async function submitCliAppWebAuthnRegistration(
  base: string,
  origin: string,
  token: string,
  vaultSessionRootDigest: string,
  registration: CliAppPasskeyRegistration,
): Promise<true | CliAppPairingFailure> {
  const { cliAppWebAuthnRegisterPayload, saveCliAppWebAuthnCredential } =
    await import("./webauthn-credential.js");
  let res: Response;
  try {
    res = await localNetworkFetch(`${base}${CLI_APP_PAIRING_WEBAUTHN_PATH}`, {
      method: "POST",
      credentials: "omit",
      headers: {
        "content-type": "application/json",
        Origin: origin,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(
        cliAppWebAuthnRegisterPayload(vaultSessionRootDigest, registration),
      ),
      timeoutMs: 15_000,
    });
  } catch {
    return refused("network");
  }
  if (res.status !== 204) return refusalFromResponse(res);
  await saveCliAppWebAuthnCredential({
    credentialIdB64: registration.credentialIdB64,
    coseKeyB64: registration.coseKeyB64,
    publicKeySpkiB64: registration.publicKeySpkiB64,
  });
  return true;
}

async function registerCliAppHumanProofCredential(
  base: string,
  origin: string,
  token: string,
): Promise<true | CliAppPairingFailure> {
  const {
    readVaultSessionRootDigestForCliApp,
    webauthnRegisterChallengeDigest,
  } = await import("./device-crypto.js");
  const { createCliAppPasskeyCredential } = await import(
    "./webauthn-credential.js"
  );
  const vaultSessionRootDigest = await readVaultSessionRootDigestForCliApp();
  if (!vaultSessionRootDigest) return refused("vault_locked");
  const challenge = await webauthnRegisterChallengeDigest(
    token,
    origin,
    vaultSessionRootDigest,
  );
  const registration = await createCliAppPasskeyCredential(challenge);
  if (!registration.ok) return refused(registration.code, registration.message);
  return submitCliAppWebAuthnRegistration(
    base,
    origin,
    token,
    vaultSessionRootDigest,
    registration,
  );
}

export async function exchangeCliAppPairingCode(
  parsed: CliAppPairingCode,
): Promise<true | CliAppPairingFailure> {
  const base = daemonBase(parsed.url);
  if (!base) return refused("invalid_origin");
  let res: Response;
  try {
    res = await postPairing(
      base,
      CLI_APP_PAIRING_EXCHANGE_PATH,
      parsed.origin,
      {
        code: parsed.code,
      },
    );
  } catch {
    return refused("network");
  }
  if (res.status !== 201) return refusalFromResponse(res);
  const body = pairingExchangeBodySchema.safeParse(await res.json());
  if (!body.success || !CLI_APP_PAIRING_SECRET.test(body.data.token)) {
    return refused("pairing_unreadable");
  }
  const token = body.data.token;
  writeCliAppIntegrationBearer(token);
  const registered = await registerCliAppHumanProofCredential(
    base,
    parsed.origin,
    token,
  );
  if (registered !== true) {
    clearCliAppIntegrationBearer();
    return registered;
  }
  return true;
}

/** Confirm in the unlocked PWA, then exchange for the session bearer. */
export async function completeCliAppPairing(
  parsed: CliAppPairingCode,
): Promise<CliAppPairingConfirmOutcome | CliAppPairingFailure> {
  const confirmed = await confirmCliAppPairingCode(parsed);
  if (!confirmed.ok) return confirmed;
  const exchanged = await exchangeCliAppPairingCode(parsed);
  if (exchanged !== true) return exchanged;
  return confirmed;
}
