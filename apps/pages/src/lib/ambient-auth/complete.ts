/**
 * Ambient callback completion. Correlates state before consume.
 */

import { type CompletedSignIn, FederationError } from "../federation.js";
import { admitAmbientSession, vaultStateFromStore } from "./admission.js";
import { parseAuthCallback } from "../federation-callback.js";
import { currentAuthGeneration, matchesAuthGeneration } from "./generation.js";
import { exchangeAmbientCode } from "./oidc.js";
import {
  cancelTransaction,
  claimTransaction,
  consumeTransaction,
  lookupTransaction,
  withTransactionLock,
} from "./transactions.js";
import type { AuthenticationIntent } from "./types.js";
import { isAmbientIntent } from "./types.js";

export type AmbientCompleteResult = {
  completed: CompletedSignIn;
  intent: Extract<AuthenticationIntent, { kind: "ambient" }>;
};

const OWNER = "pages-complete";

export async function completeAmbientIfPresent(
  search: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AmbientCompleteResult | null> {
  const parsed = parseAuthCallback(search);
  if (parsed.kind === "none") return null;
  if (parsed.kind === "malformed") {
    throw new FederationError(
      parsed.reason,
      "This sign-in response was not usable.",
    );
  }
  const state = parsed.state;
  if (!state) return null;
  const record = lookupTransaction(state);
  if (!record || !isAmbientIntent(record.intent)) return null;

  return await withTransactionLock(`ambient-tx:${state}`, async () => {
    const claimed = claimTransaction(state, OWNER);
    if (!claimed || !isAmbientIntent(claimed.intent)) {
      throw new FederationError(
        "uncorrelated",
        "This sign-in was already finished.",
      );
    }
    if (!matchesAuthGeneration(claimed.generation)) {
      cancelTransaction(state);
      throw new FederationError(
        "stale_generation",
        "That sign-in is no longer valid.",
      );
    }
    if (parsed.kind === "error") {
      consumeTransaction(state, OWNER);
      throw new FederationError(
        parsed.error,
        parsed.description ?? `The broker refused: ${parsed.error}.`,
      );
    }
    if (
      parsed.issuer &&
      parsed.issuer.replace(/\/+$/, "") !== claimed.issuer.replace(/\/+$/, "")
    ) {
      cancelTransaction(state);
      throw new FederationError(
        "mixup",
        "This sign-in came from a different issuer.",
      );
    }
    const { identity, claims } = await exchangeAmbientCode(
      claimed,
      parsed.code,
      fetchImpl,
    );
    consumeTransaction(state, OWNER);
    return {
      intent: claimed.intent,
      completed: {
        identity,
        intent: claimed.intent,
        transactionId: claimed.transactionId,
        generation: claimed.generation,
        policyRevision: claimed.policyRevision,
        claims,
      },
    };
  });
}

export { currentAuthGeneration, vaultStateFromStore, admitAmbientSession };
