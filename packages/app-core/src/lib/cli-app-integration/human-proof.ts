/**
 * PIN / passkey proof for CLI app-integration approve (ADR 0186 round 4).
 * Binds the pending row's ids to a fresh unlock check without sending secrets.
 */

import type { VaultHeader } from "@opensesame/vault-core";
import type { PasskeyProbe } from "../vault/passkey-unlock-session.js";

export const CLI_APP_HUMAN_PROOF_PREFIX = "oschip1:";

export type CliAppHumanProofBinding = Readonly<{
  requestId: string;
  respondNonce: string;
  terminalSessionId: string;
}>;

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return new Uint8Array(digest);
}

async function proofMac(
  binding: CliAppHumanProofBinding,
  kind: "pin" | "passkey",
  material: Uint8Array,
): Promise<string> {
  const seed = new TextEncoder().encode(
    [
      binding.requestId,
      binding.respondNonce,
      binding.terminalSessionId,
      kind,
      bytesToHex(material),
    ].join("\0"),
  );
  const mac = await sha256(seed);
  return bytesToHex(mac);
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

export async function mintCliAppHumanProofFromPin(
  header: VaultHeader,
  pin: string,
  binding: CliAppHumanProofBinding,
  recordFailedUnlock: () => void,
): Promise<string> {
  const { unwrapPin } = await import("../vault/primary-unwrap.js");
  const raw = await unwrapPin(header, pin, recordFailedUnlock);
  const fingerprint = await sha256(raw);
  raw.fill(0);
  const mac = await proofMac(binding, "pin", fingerprint);
  return formatCliAppHumanProof("pin", mac);
}

export async function mintCliAppHumanProofFromPasskey(
  probe: PasskeyProbe,
  binding: CliAppHumanProofBinding,
): Promise<string> {
  const fingerprint = await sha256(new Uint8Array(probe.prfOutput));
  const mac = await proofMac(binding, "passkey", fingerprint);
  return formatCliAppHumanProof("passkey", mac);
}
