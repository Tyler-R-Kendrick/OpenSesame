/**
 * PIN / passkey proof for CLI app-integration approve (ADR 0186 round 4).
 * Binds the pending row's ids to a fresh unlock check without sending secrets.
 */

import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import type { VaultHeader } from "@opensesame/vault-core";
import type { PasskeyProbe } from "../vault/passkey-unlock-session.js";
import { unwrapPin } from "../vault/primary-unwrap.js";

export const CLI_APP_HUMAN_PROOF_PREFIX = "oschip1:";

export type CliAppHumanProofBinding = Readonly<{
  requestId: string;
  respondNonce: string;
  terminalSessionId: string;
}>;

function proofMac(
  binding: CliAppHumanProofBinding,
  kind: "pin" | "passkey",
  material: Uint8Array,
): string {
  const seed = new TextEncoder().encode(
    [
      binding.requestId,
      binding.respondNonce,
      binding.terminalSessionId,
      kind,
      bytesToHex(material),
    ].join("\0"),
  );
  return bytesToHex(sha256(seed));
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
  const raw = await unwrapPin(header, pin, recordFailedUnlock);
  const fingerprint = sha256(raw);
  raw.fill(0);
  const mac = proofMac(binding, "pin", fingerprint);
  return formatCliAppHumanProof("pin", mac);
}

export function mintCliAppHumanProofFromPasskey(
  probe: PasskeyProbe,
  binding: CliAppHumanProofBinding,
): string {
  const fingerprint = sha256(new Uint8Array(probe.prfOutput));
  const mac = proofMac(binding, "passkey", fingerprint);
  return formatCliAppHumanProof("passkey", mac);
}
