import { assertNotDecoySession } from "@opensesame/app-core/lib/decoy-session.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
/** Recheck before presenting an asynchronous secret-bearing owner result. */
export function assertSecurityOwner(tomb: string): void {
  assertNotDecoySession();
  const state = vaultStore.getSnapshot();
  if (
    state.tomb !== tomb ||
    state.status !== "unlocked" ||
    state.guest ||
    state.decoy ||
    state.awaitingSecondStep
  )
    throw new Error("The owner session changed. Authenticate again.");
}

/** Capture before the first await; a fresh successor session does not inherit intent. */
export function pinSecurityOwner(
  tomb: string,
  requireOwner = assertSecurityOwner,
): () => void {
  const realm = assertNotDecoySession();
  requireOwner(tomb);
  return () => {
    assertNotDecoySession(realm);
    requireOwner(tomb);
  };
}
