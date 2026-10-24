/**
 * CLI authorize humanProof minting for the Pages lazy leaf (ADR 0186).
 */

import { readCliAppIntegrationBearer } from "@opensesame/app-core/lib/cli-app-integration/bearer-session.js";
import type { VaultHeader } from "@opensesame/vault-core";
import { WrongPasswordError } from "@opensesame/vault-core";

export class CliAuthorizeRefusal extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CliAuthorizeRefusal";
    this.code = code;
  }
}

export type CliAuthorizeRow = readonly [
  requestId: string,
  terminalSessionId: string,
  verb: string,
  respondNonce: string,
  daemonIntegrationId: string,
  argvHash: string,
  peerPid: number,
  peerStartTime: number,
];

function bindingFromRow(row: CliAuthorizeRow) {
  return {
    requestId: row[0],
    terminalSessionId: row[1],
    respondNonce: row[3],
    verb: row[2],
    daemonIntegrationId: row[4],
    argvHash: row[5],
    peerPid: row[6],
    peerStartTime: row[7],
  };
}

/**
 * The vault and pairing reads the proofs make. Each loads its module lazily,
 * as this leaf does; a test stands in for them here.
 */
export const cliAuthorizeMintSeams = {
  pairingSecret: (): string | null => readCliAppIntegrationBearer(),
  duressCheck: async (pin: string) => {
    const { onCompleteUnlockCodeSubmission } = await import(
      "@opensesame/app-core/sections/settings/security/duress-unlock-bridge.js"
    );
    return onCompleteUnlockCodeSubmission(pin, { requireDurable: false });
  },
  unwrapPin: async (header: VaultHeader, pin: string): Promise<Uint8Array> => {
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
    return unwrapPin(header, pin, () => recordFailedUnlock(attemptsKey));
  },
};

function requirePairingSecret(): string {
  const secret = cliAuthorizeMintSeams.pairingSecret();
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
  const crypto = await import(
    "@opensesame/app-core/lib/cli-app-integration/device-crypto.js"
  );
  const { approvalChallengeDigestV3 } = crypto;
  const { assertStoredCliAppPasskey } = await import(
    "@opensesame/app-core/lib/cli-app-integration/webauthn-credential.js"
  );
  const challenge = await approvalChallengeDigestV3({
    daemonIntegrationId: binding.daemonIntegrationId,
    requestId: binding.requestId,
    terminalSessionId: binding.terminalSessionId,
    respondNonce: binding.respondNonce,
    verb: binding.verb,
    argvHash: binding.argvHash,
    peerPid: binding.peerPid,
    peerStartTime: binding.peerStartTime,
  });
  const assertion = await assertStoredCliAppPasskey(challenge);
  if (!assertion.ok) {
    throw new CliAuthorizeRefusal(assertion.code, assertion.message);
  }
  return assertion.proof;
}

export async function mintCliAuthorizePinProof(
  row: CliAuthorizeRow,
  pin: string,
  header: VaultHeader,
): Promise<string> {
  const duressOutcome = await cliAuthorizeMintSeams.duressCheck(pin);
  if (duressOutcome.kind === "duress") {
    throw new WrongPasswordError("That PIN did not work.");
  }
  const raw = await cliAuthorizeMintSeams.unwrapPin(header, pin);
  raw.fill(0);
  requirePairingSecret();
  // The daemon rejects `oschip3:pin:` proofs (`human_proof.rs`). A PIN unlock
  // must not be repackaged as a passkey assertion.
  throw new CliAuthorizeRefusal(
    "pin_not_accepted",
    "A PIN cannot approve a CLI request. Use the passkey from pairing.",
  );
}
