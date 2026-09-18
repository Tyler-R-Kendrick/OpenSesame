/**
 * Non-linking ambient admission. Dispatches from saved intent only.
 *
 * Must not call adoptFederatedIdentity, linkGuestAccount,
 * claimProvisionalHistoryAccounts, joinOrgTenant, ensureDefaultAccess, or
 * openVaultAfterSignIn.
 */

import type { VerifiedIdTokenClaims } from "@opensesame/sdk-browser";
import type { UpstreamIdentity } from "../federation.js";
import { clearSession, saveSession } from "../federation.js";
import { matchesAuthGeneration } from "./generation.js";
import type { AuthenticationIntent } from "./types.js";
import type { AmbientReasonCode, PassiveOutcome } from "./types.js";

export type VaultNamespaceState = {
  status: "empty" | "locked" | "unlocked";
  guest: boolean;
  principalLabel?: string;
  pairwiseSub?: string;
};

export type AdmissionContext = {
  intent: AuthenticationIntent;
  identity: UpstreamIdentity;
  claims: VerifiedIdTokenClaims;
  transactionId: string;
  generation: number;
  policyRevision: string;
  expectedPolicyRevision: string;
  vault: VaultNamespaceState;
  permitJitProvisioning: boolean;
};

export type AdmissionSideEffects = {
  saveIdentity: (identity: UpstreamIdentity) => void;
  clearIdentity: () => void;
  bootstrapEmptyWorkspace: () => Promise<void>;
};

export type AdmissionResult =
  | {
      kind: "admitted";
      outcome: Extract<PassiveOutcome, { kind: "authenticated" }>;
      vaultUnchanged: true;
      createdWorkspace: boolean;
    }
  | { kind: "mismatch" }
  | { kind: "rejected"; reason: AmbientReasonCode };

const defaultEffects: AdmissionSideEffects = {
  saveIdentity: saveSession,
  clearIdentity: clearSession,
  bootstrapEmptyWorkspace: async () => {
    /* empty workspace is opt-in via seams */
  },
};

export const ambientAdmissionSeams: AdmissionSideEffects = {
  ...defaultEffects,
};

function staleGeneration(): Extract<AdmissionResult, { kind: "rejected" }> {
  return { kind: "rejected", reason: "stale_generation" };
}

function commitIdentity(
  ctx: AdmissionContext,
  run: AdmissionSideEffects,
): AdmissionResult | null {
  if (!matchesAuthGeneration(ctx.generation)) return staleGeneration();
  run.saveIdentity(ctx.identity);
  if (matchesAuthGeneration(ctx.generation)) return null;
  run.clearIdentity();
  return staleGeneration();
}

export async function admitAmbientSession(
  ctx: AdmissionContext,
  effects: Partial<AdmissionSideEffects> = {},
): Promise<AdmissionResult> {
  const run: AdmissionSideEffects = { ...ambientAdmissionSeams, ...effects };
  if (ctx.intent.kind !== "ambient") {
    return { kind: "rejected", reason: "rejected" };
  }
  if (!matchesAuthGeneration(ctx.generation)) {
    return staleGeneration();
  }
  if (ctx.policyRevision !== ctx.expectedPolicyRevision) {
    return { kind: "rejected", reason: "stale_policy" };
  }
  if (ctx.vault.status === "unlocked" && ctx.vault.guest) {
    return { kind: "rejected", reason: "guest_open" };
  }
  if (
    ctx.vault.status === "unlocked" &&
    ctx.vault.pairwiseSub !== ctx.identity.pairwiseSub
  ) {
    return { kind: "mismatch" };
  }

  const aborted = commitIdentity(ctx, run);
  if (aborted) return aborted;

  let createdWorkspace = false;
  if (ctx.vault.status === "empty" && ctx.permitJitProvisioning) {
    await run.bootstrapEmptyWorkspace();
    if (!matchesAuthGeneration(ctx.generation)) {
      run.clearIdentity();
      return staleGeneration();
    }
    createdWorkspace = true;
  }

  return {
    kind: "admitted",
    outcome: {
      kind: "authenticated",
      verifiedIdentityRef: `${ctx.identity.issuer}|${ctx.identity.pairwiseSub}`,
      transactionId: ctx.transactionId,
    },
    vaultUnchanged: true,
    createdWorkspace,
  };
}

export function vaultStateFromStore(snapshot: {
  status: string;
  guest?: boolean;
  pairwiseSub?: string;
}): VaultNamespaceState {
  const status =
    snapshot.status === "unlocked" || snapshot.status === "locked"
      ? snapshot.status
      : "empty";
  const state: VaultNamespaceState = {
    status,
    guest: snapshot.guest === true,
  };
  if (snapshot.pairwiseSub) {
    state.pairwiseSub = snapshot.pairwiseSub;
  }
  return state;
}
