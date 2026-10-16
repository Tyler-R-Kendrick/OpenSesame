import { localVaultSessionGuard } from "../secret-backends/local-vault-port.js";
import { AiConnectionError } from "./types.js";

export async function captureAiVault() {
  const { vaultStore } = await import("../vault/store.js");
  const guard = localVaultSessionGuard(vaultStore);
  const current = guard.current();
  if (current.guest) {
    guard.close();
    throw new AiConnectionError(
      "configuration",
      "Unlock a real vault before configuring an AI connection.",
    );
  }
  const lifetime = new AbortController();
  const unsubscribe = vaultStore.onLock(() => lifetime.abort());
  return {
    tomb: current.tomb,
    signal: lifetime.signal,
    check() {
      guard.current();
      lifetime.signal.throwIfAborted();
    },
    close() {
      lifetime.abort();
      unsubscribe();
      guard.close();
    },
  };
}

export const aiVaultSeams = { capture: captureAiVault };
