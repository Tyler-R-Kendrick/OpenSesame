/**
 * CLI authorize humanProof minting for the Pages lazy leaf (ADR 0186).
 */

import { readCliAppIntegrationBearer } from "@opensesame/app-core/lib/cli-app-integration/bearer-session.js";
import type { VaultHeader } from "@opensesame/vault-core";
import { WrongPasswordError } from "@opensesame/vault-core";

export type CliAuthorizeRow = readonly [
  requestId: string,
  terminalSessionId: string,
  verb: string,
  respondNonce: string,
];

function bindingFromRow(row: CliAuthorizeRow) {
  return {
    requestId: row[0],
    terminalSessionId: row[1],
    respondNonce: row[3],
    verb: row[2],
  };
}

function requirePairingSecret(): string {
  const secret = readCliAppIntegrationBearer();
  if (!secret) {
    throw new Error("cli_app_pairing_required");
  }
  return secret;
}

export async function mintCliAuthorizePasskeyProof(
  row: CliAuthorizeRow,
): Promise<string> {
  requirePairingSecret();
  const binding = bindingFromRow(row);
  const {
    approvalChallengeDigest,
    formatCliAppHumanProofPasskey,
  } = await import("@opensesame/app-core/lib/cli-app-integration/device-crypto.js");
  const challenge = approvalChallengeDigest(
    binding.requestId,
    binding.terminalSessionId,
    binding.respondNonce,
    binding.verb,
  );
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      timeout: 60_000,
      userVerification: "required",
    },
  });
  if (!assertion || !(assertion instanceof PublicKeyCredential)) {
    throw new WrongPasswordError("Passkey confirmation was cancelled.");
  }
  const response = assertion.response;
  if (!(response instanceof AuthenticatorAssertionResponse)) {
    throw new WrongPasswordError("Passkey confirmation was cancelled.");
  }
  const b64url = (bytes: ArrayBuffer) =>
    btoa(String.fromCharCode(...new Uint8Array(bytes)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
  const wire = JSON.stringify({
    credentialIdB64: b64url(assertion.rawId),
    authenticatorDataB64: b64url(response.authenticatorData),
    clientDataJsonB64: b64url(response.clientDataJSON),
    signatureB64: b64url(response.signature),
  });
  return formatCliAppHumanProofPasskey(wire);
}

export async function mintCliAuthorizePinProof(
  row: CliAuthorizeRow,
  pin: string,
  header: VaultHeader,
): Promise<string> {
  const binding = bindingFromRow(row);
  const { onCompleteUnlockCodeSubmission } = await import(
    "@opensesame/app-core/sections/settings/security/duress-unlock-bridge.js"
  );
  const duressOutcome = await onCompleteUnlockCodeSubmission(pin, {
    requireDurable: false,
  });
  if (duressOutcome.kind === "duress") {
    throw new WrongPasswordError("That PIN did not work.");
  }
  const [
    { scopedKey },
    { ATTEMPTS_KEY },
    { recordFailedUnlock },
    { unwrapPin },
  ] = await Promise.all([
    import("@opensesame/app-core/lib/projects.js"),
    import("@opensesame/app-core/lib/vault/store-scope.js"),
    import("@opensesame/app-core/lib/vault/unlock-attempts.js"),
    import("@opensesame/app-core/lib/vault/primary-unwrap.js"),
  ]);
  const attemptsKey = scopedKey(ATTEMPTS_KEY);
  const raw = await unwrapPin(header, pin, () =>
    recordFailedUnlock(attemptsKey),
  );
  raw.fill(0);
  requirePairingSecret();
  const [
    { approvalChallengeDigest, formatCliAppHumanProofPin },
    { ensureCliAppDeviceSigningKey },
  ] = await Promise.all([
    import("@opensesame/app-core/lib/cli-app-integration/device-crypto.js"),
    import("@opensesame/app-core/lib/cli-app-integration/device-signing-key.js"),
  ]);
  const device = await ensureCliAppDeviceSigningKey();
  if (!device) throw new WrongPasswordError("That PIN did not work.");
  const challenge = approvalChallengeDigest(
    binding.requestId,
    binding.terminalSessionId,
    binding.respondNonce,
    binding.verb,
  );
  const sig = await device.sign(challenge);
  return formatCliAppHumanProofPin(sig);
}
