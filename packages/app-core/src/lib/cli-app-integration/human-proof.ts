/**
 * PIN / passkey proof for CLI app-integration approve (ADR 0186, D6 redesign).
 */

import { readCliAppIntegrationBearer } from "./bearer-session.js";
import { approvalChallengeDigest } from "./device-crypto.js";
import { ensureCliAppDeviceSigningKey } from "./device-signing-key.js";
import {
  CLI_APP_HUMAN_PROOF_PREFIX,
  type CliAppHumanProofBinding,
  formatCliAppHumanProofPasskey,
  formatCliAppHumanProofPin,
  isCliAppHumanProofValid,
} from "./human-proof-crypto.js";

export {
  CLI_APP_HUMAN_PROOF_PREFIX,
  type CliAppHumanProofBinding,
  isCliAppHumanProofValid,
};

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
  requirePairingSecret();
  const device = await ensureCliAppDeviceSigningKey();
  if (!device) throw new Error("vault_locked");
  const challenge = approvalChallengeDigest(
    binding.requestId,
    binding.terminalSessionId,
    binding.respondNonce,
    binding.verb,
  );
  const sig = await device.sign(challenge);
  return formatCliAppHumanProofPin(sig);
}

export async function mintCliAppHumanProofFromPasskey(
  probe: import("../vault/passkey-unlock-session.js").PasskeyProbe,
  binding: CliAppHumanProofBinding,
): Promise<string> {
  const fingerprint = new Uint8Array(probe.prfOutput);
  if (fingerprint.byteLength === 0) {
    throw new Error("passkey_probe_empty");
  }
  requirePairingSecret();
  const challenge = approvalChallengeDigest(
    binding.requestId,
    binding.terminalSessionId,
    binding.respondNonce,
    binding.verb,
  );
  let binary = "";
  for (const byte of challenge) {
    binary += String.fromCharCode(byte);
  }
  const challengeB64 = btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: Uint8Array.from(challenge),
      timeout: 60_000,
      userVerification: "required",
    },
  });
  if (!assertion || !(assertion instanceof PublicKeyCredential)) {
    throw new Error("passkey_assertion_cancelled");
  }
  const response = assertion.response;
  if (!(response instanceof AuthenticatorAssertionResponse)) {
    throw new Error("passkey_assertion_invalid");
  }
  const wire = JSON.stringify({
    credentialIdB64: btoa(
      String.fromCharCode(...new Uint8Array(assertion.rawId)),
    )
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, ""),
    authenticatorDataB64: btoa(
      String.fromCharCode(...new Uint8Array(response.authenticatorData)),
    )
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, ""),
    clientDataJsonB64: btoa(
      String.fromCharCode(...new Uint8Array(response.clientDataJSON)),
    )
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, ""),
    signatureB64: btoa(
      String.fromCharCode(...new Uint8Array(response.signature)),
    )
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, ""),
    challengeB64,
  });
  return formatCliAppHumanProofPasskey(wire);
}
