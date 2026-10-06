import { currentRealmGeneration } from "../decoy-session.js";
import { assertTombRealmAuthority } from "../vfs-authority.js";
import type { VaultScope } from "./store-scope.js";

type OperationState = {
  scope: VaultScope;
  generation: number;
  vaultKey: CryptoKey | null;
  pendingVaultKey?: CryptoKey | null;
};

/** Queued work belongs to its original store, scope, key, and tab realm. */
export function pinStoreOperation(
  read: () => OperationState,
  allowKeyAdmission = false,
): () => void {
  const original = read();
  if (original.vaultKey)
    assertTombRealmAuthority(original.scope.tomb, original.vaultKey);
  if (original.pendingVaultKey)
    assertTombRealmAuthority(original.scope.tomb, original.pendingVaultKey);
  const realm = currentRealmGeneration();
  return () => {
    const current = read();
    if (current.vaultKey)
      assertTombRealmAuthority(current.scope.tomb, current.vaultKey);
    if (current.pendingVaultKey)
      assertTombRealmAuthority(current.scope.tomb, current.pendingVaultKey);
    if (
      current.scope !== original.scope ||
      current.generation !== original.generation ||
      (!allowKeyAdmission && current.vaultKey !== original.vaultKey) ||
      currentRealmGeneration() !== realm
    )
      throw new Error(
        "The vault session changed. Lock it and authenticate again.",
      );
  };
}
