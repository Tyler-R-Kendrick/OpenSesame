/**
 * PIN / passkey proof for CLI app-integration approve (ADR 0186).
 * HMAC-SHA256 over the pending row, keyed by the paired bearer (per-pairing secret).
 */

import { readCliAppIntegrationBearer } from "./bearer-session.js";

export const CLI_APP_HUMAN_PROOF_PREFIX = "oschip1:";

export type CliAppHumanProofBinding = Readonly<{
  requestId: string;
  respondNonce: string;
  terminalSessionId: string;
  verb: string;
}>;

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function humanProofMessage(binding: CliAppHumanProofBinding): string {
  return [
    binding.requestId,
    binding.terminalSessionId,
    binding.respondNonce,
    binding.verb,
  ].join("\0");
}

async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const keyBytes = new TextEncoder().encode(key);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(message),
  );
  return bytesToHex(new Uint8Array(sig));
}

async function proofMac(
  pairingSecret: string,
  binding: CliAppHumanProofBinding,
): Promise<string> {
  return hmacSha256Hex(pairingSecret, humanProofMessage(binding));
}

export function formatCliAppHumanProof(
  kind: "pin" | "passkey",
  mac: string,
): string {
  return `${CLI_APP_HUMAN_PROOF_PREFIX}${kind}:${mac}`;
}

const PROOF_RE = /^oschip1:(pin|passkey):([0-9a-f]{64})$/;

export function isCliAppHumanProofValid(proof: string): boolean {
  return PROOF_RE.test(proof.trim());
}

function requirePairingSecret(): string {
  const secret = readCliAppIntegrationBearer();
  if (!secret) {
    throw new Error("cli_app_pairing_required");
  }
  return secret;
}

export async function mintCliAppHumanProofFromPin(
  header: import("@opensesame/vault-core").VaultHeader,
  pin: string,
  binding: CliAppHumanProofBinding,
  recordFailedUnlock: () => void,
): Promise<string> {
  const { unwrapPin } = await import("../vault/primary-unwrap.js");
  const raw = await unwrapPin(header, pin, recordFailedUnlock);
  raw.fill(0);
  const pairingSecret = requirePairingSecret();
  const mac = await proofMac(pairingSecret, binding);
  return formatCliAppHumanProof("pin", mac);
}

export async function mintCliAppHumanProofFromPasskey(
  probe: import("../vault/passkey-unlock-session.js").PasskeyProbe,
  binding: CliAppHumanProofBinding,
): Promise<string> {
  const fingerprint = new Uint8Array(probe.prfOutput);
  if (fingerprint.byteLength === 0) {
    throw new Error("passkey_probe_empty");
  }
  const pairingSecret = requirePairingSecret();
  const mac = await proofMac(pairingSecret, binding);
  return formatCliAppHumanProof("passkey", mac);
}

/** Test helper: mint without vault unlock (vectors / unit tests). */
export async function mintCliAppHumanProofForTest(
  pairingSecret: string,
  binding: CliAppHumanProofBinding,
  kind: "pin" | "passkey" = "passkey",
): Promise<string> {
  const mac = await proofMac(pairingSecret, binding);
  return formatCliAppHumanProof(kind, mac);
}
