/**
 * Silent-iframe automatic acquisition. Never escalates to a top-level
 * redirect. Entra uses MSAL `ssoSilent`; other protocols are unsupported.
 */

import { type VaultNamespaceState, admitAmbientSession } from "./admission.js";
import type { Eligibility } from "./controller.js";
import { acquireEntraSilent, newEntraNonce } from "./entra.js";
import { currentAuthGeneration } from "./generation.js";
import type { PassiveOutcome } from "./types.js";

function vaultFromEligibility(eligibility: Eligibility): VaultNamespaceState {
  const status: VaultNamespaceState["status"] =
    eligibility.vaultStatus === "unlocked" ||
    eligibility.vaultStatus === "locked"
      ? eligibility.vaultStatus
      : "empty";
  if (eligibility.openPairwiseSub) {
    return {
      status,
      guest: eligibility.guestOpen,
      pairwiseSub: eligibility.openPairwiseSub,
    };
  }
  return { status, guest: eligibility.guestOpen };
}

export async function runSilentIframeAttempt(
  eligibility: Eligibility,
  redirectUri: string,
  generation: number,
): Promise<PassiveOutcome> {
  const connection = eligibility.connection;
  if (!connection || connection.protocol !== "entra") {
    return { kind: "unsupported", reason: "unsupported" };
  }
  const result = await acquireEntraSilent(
    {
      connection,
      redirectUri,
      generation,
      nonce: newEntraNonce(),
    },
    fetch,
  );
  if (result.kind !== "authenticated") return result;
  if (generation !== currentAuthGeneration()) {
    return { kind: "rejected", reason: "stale_generation" };
  }
  const admitted = await admitAmbientSession({
    intent: {
      kind: "ambient",
      policyRevision: eligibility.policy.policyRevision,
      selectedProviderKey: connection.key,
    },
    identity: result.identity,
    claims: result.claims,
    transactionId: connection.key,
    generation,
    policyRevision: eligibility.policy.policyRevision,
    expectedPolicyRevision: eligibility.policy.policyRevision,
    vault: vaultFromEligibility(eligibility),
    permitJitProvisioning: false,
  });
  if (admitted.kind === "admitted") return admitted.outcome;
  if (admitted.kind === "mismatch") return { kind: "account-mismatch" };
  return { kind: "rejected", reason: admitted.reason };
}
