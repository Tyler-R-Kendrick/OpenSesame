import type { VaultStore } from "../vault/store.js";
import { SecretBackendError } from "./types.js";

/** The existing vault owns sealing, second-step checks, and durable writes. */
export type LocalVaultPort = Pick<
  VaultStore,
  | "getSnapshot"
  | "saveItem"
  | "trashItem"
  | "applyImport"
  | "onLock"
  | "isGenuineSession"
>;
export type VaultSessionPort = Pick<
  VaultStore,
  "getSnapshot" | "onLock" | "isGenuineSession"
>;

export async function localVaultPort(
  port?: LocalVaultPort,
): Promise<LocalVaultPort> {
  return port ?? (await import("../vault/store.js")).vaultStore;
}

export function requireUnlockedVault(port: VaultSessionPort) {
  const snapshot = port.getSnapshot();
  if (
    !port.isGenuineSession() ||
    snapshot.guest ||
    snapshot.decoy ||
    snapshot.status !== "unlocked" ||
    snapshot.awaitingSecondStep
  )
    throw new SecretBackendError(
      "locked",
      "Unlock the destination vault first.",
    );
  return snapshot;
}

/** A lock invalidates this handle even when the same tomb is unlocked again later. */
export function localVaultSessionGuard(port: VaultSessionPort) {
  const tomb = requireUnlockedVault(port).tomb;
  let revoked = false;
  const unsubscribe = port.onLock(() => {
    revoked = true;
  });
  return {
    current() {
      if (revoked)
        throw new SecretBackendError(
          "stale",
          "The vault session ended. Connect again.",
        );
      const snapshot = requireUnlockedVault(port);
      if (snapshot.tomb !== tomb)
        throw new SecretBackendError(
          "stale",
          "The active vault changed. Connect again.",
        );
      return snapshot;
    },
    close() {
      revoked = true;
      unsubscribe();
    },
  };
}
