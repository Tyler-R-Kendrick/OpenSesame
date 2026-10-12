import type { VaultHeader } from "@opensesame/vault-core";
import { WrongPasswordError } from "@opensesame/vault-core";
import type { CliAuthorizeRow } from "./cli-authorize-session.js";

function bindingFromRow(row: CliAuthorizeRow) {
  return {
    requestId: row[0],
    respondNonce: row[3],
    terminalSessionId: row[1],
  };
}

export async function mintCliAuthorizePasskeyProof(
  row: CliAuthorizeRow,
): Promise<string> {
  const [{ vaultStore }, { mintCliAppHumanProofFromPasskey }] =
    await Promise.all([
      import("@opensesame/app-core/lib/vault/store.js"),
      import("@opensesame/app-core/lib/cli-app-integration/human-proof.js"),
    ]);
  const probe = await vaultStore.probePasskeyCeremony();
  return mintCliAppHumanProofFromPasskey(probe, bindingFromRow(row));
}

export async function mintCliAuthorizePinProof(
  row: CliAuthorizeRow,
  pin: string,
  header: VaultHeader,
): Promise<string> {
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
    { mintCliAppHumanProofFromPin },
  ] = await Promise.all([
    import("@opensesame/app-core/lib/projects.js"),
    import("@opensesame/app-core/lib/vault/store-scope.js"),
    import("@opensesame/app-core/lib/vault/unlock-attempts.js"),
    import("@opensesame/app-core/lib/cli-app-integration/human-proof.js"),
  ]);
  const attemptsKey = scopedKey(ATTEMPTS_KEY);
  return mintCliAppHumanProofFromPin(header, pin, bindingFromRow(row), () =>
    recordFailedUnlock(attemptsKey),
  );
}
