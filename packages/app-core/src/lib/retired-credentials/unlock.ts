/** One portable human-password gate for Node, native isolates, extensions and PWAs. */
import { WrongPasswordError } from "@opensesame/vault-core";
import { assertAuthenticationSession } from "../decoy-session.js";
import { probeRetiredCredential } from "./index.js";
import type { RetiredCredentialSessionStore } from "./session-types.js";
import { openRetiredCredentialDecoy } from "./session.js";
export type RetiredPasswordUnlockStore = RetiredCredentialSessionStore &
  Readonly<{
    activeTomb: () => string;
    unlock: (password: string) => Promise<void>;
  }>;
export type RetiredPasswordUnlockResult =
  | "vault_opened"
  | "retired_credential_session";
export async function unlockWithRetiredCredentialGate(
  store: RetiredPasswordUnlockStore,
  password: string,
): Promise<RetiredPasswordUnlockResult> {
  const authorityGeneration = assertAuthenticationSession();
  const tomb = store.activeTomb();
  const trap = await probeRetiredCredential(password, tomb);
  assertAuthenticationSession(authorityGeneration);
  if (store.activeTomb() !== tomb) throw new WrongPasswordError();
  if (trap) {
    if (trap.response === "reject") throw new WrongPasswordError();
    await openRetiredCredentialDecoy(store, trap, tomb);
    return "retired_credential_session";
  }
  await store.unlock(password);
  return "vault_opened";
}
