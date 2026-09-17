import { storeAuthOutcome } from "../auth-outcome.js";
import type { CompletedSignIn } from "../federation.js";
import { displayName, loadSession } from "../federation.js";
import { vaultStore } from "../vault/store.js";
import {
  type VaultNamespaceState,
  admitAmbientSession,
  vaultStateFromStore,
} from "./admission.js";
import type { AuthenticationIntent } from "./types.js";

type AmbientCompleted = CompletedSignIn & {
  intent: Extract<AuthenticationIntent, { kind: "ambient" }>;
};

export const ambientReturnSeams = {
  vault(): VaultNamespaceState {
    const snapshot = vaultStore.getSnapshot();
    return vaultStateFromStore({
      status: snapshot.status,
      guest: snapshot.guest,
      pairwiseSub: loadSession()?.pairwiseSub,
    });
  },
};

function outcomeForAdmission(kind: "mismatch" | "rejected"): {
  kind: "error";
  detail: string;
} {
  if (kind === "mismatch") {
    return {
      kind: "error",
      detail: "That account does not match the open vault.",
    };
  }
  return {
    kind: "error",
    detail: "Sign-in could not finish automatically.",
  };
}

export async function applyAmbientReturn(
  result: AmbientCompleted,
): Promise<{ returnTo?: string }> {
  if (!result.claims) {
    storeAuthOutcome(outcomeForAdmission("rejected"));
    return {};
  }
  const admitted = await admitAmbientSession({
    intent: result.intent,
    identity: result.identity,
    claims: result.claims,
    transactionId: result.transactionId ?? "",
    generation: result.generation ?? 0,
    policyRevision: result.intent.policyRevision,
    expectedPolicyRevision:
      result.policyRevision ?? result.intent.policyRevision,
    vault: ambientReturnSeams.vault(),
    permitJitProvisioning: false,
  });
  if (admitted.kind !== "admitted") {
    storeAuthOutcome(
      outcomeForAdmission(
        admitted.kind === "mismatch" ? "mismatch" : "rejected",
      ),
    );
    return {};
  }
  storeAuthOutcome({
    kind: "authenticated",
    who: displayName(result.identity),
  });
  return result.returnTo !== undefined ? { returnTo: result.returnTo } : {};
}
