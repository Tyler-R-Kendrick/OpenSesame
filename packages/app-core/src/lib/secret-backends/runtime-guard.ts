import { localVaultSessionGuard } from "./local-vault-port.js";
import {
  type SecretBackend,
  SecretBackendError,
  type SecretBackendSession,
} from "./types.js";

export async function secretBackendVaultGuard() {
  const { vaultStore } = await import("../vault/store.js");
  const guard = localVaultSessionGuard(vaultStore);
  const snapshot = guard.current();
  const lifetime = new AbortController();
  let invalidated: (() => void) | undefined;
  const unsubscribe = vaultStore.onLock(() => {
    lifetime.abort();
    invalidated?.();
  });
  const current = () => {
    try {
      if (lifetime.signal.aborted) return false;
      guard.current();
      return true;
    } catch {
      return false;
    }
  };
  return {
    current,
    signal: lifetime.signal,
    tomb: snapshot.tomb,
    guest: snapshot.guest,
    close() {
      lifetime.abort();
      unsubscribe();
      guard.close();
    },
    onInvalidated(callback: () => void) {
      invalidated = callback;
      if (!current()) callback();
    },
  };
}

/** Cancellation withdraws the result owner without waiting for cleanup to settle. */
export function awaitSecretBackendOwner<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  discard?: (result: T) => Promise<void>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new SecretBackendError("stale", "The backend operation ended."));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    operation.then(
      (result) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) {
          if (discard)
            void Promise.resolve()
              .then(() => discard(result))
              .catch(() => undefined);
          abort();
        } else resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) abort();
        else reject(error);
      },
    );
  });
}

export function guardedSecretBackend(
  backend: SecretBackend,
  session: SecretBackendSession,
  check: () => void,
  close: (session: SecretBackendSession) => Promise<void>,
): SecretBackend {
  const checked = () => {
    try {
      check();
    } catch (error) {
      void close(session).catch(() => undefined);
      throw error;
    }
  };
  const call =
    <Args extends unknown[], Result>(fn: (...args: Args) => Promise<Result>) =>
    async (...args: Args): Promise<Result> => {
      checked();
      if (args.at(-1) !== session)
        throw new SecretBackendError(
          "authentication",
          "This session belongs to a different backend.",
        );
      const result = await fn(...args);
      checked();
      return result;
    };
  const guarded: SecretBackend = {
    id: backend.id,
    name: backend.name,
    capabilities: backend.capabilities,
    authenticate: async () => {
      throw new SecretBackendError(
        "configuration",
        "Disconnect before changing this backend's configuration.",
      );
    },
    getNotes: call(backend.getNotes.bind(backend)),
    getItem: call(backend.getItem.bind(backend)),
    listItems: call(backend.listItems.bind(backend)),
    disconnect: close,
  };
  if (backend.createItem)
    guarded.createItem = call(backend.createItem.bind(backend));
  if (backend.updateItem)
    guarded.updateItem = call(backend.updateItem.bind(backend));
  if (backend.deleteItem)
    guarded.deleteItem = call(backend.deleteItem.bind(backend));
  if (backend.importToLocal)
    guarded.importToLocal = call(backend.importToLocal.bind(backend));
  return guarded;
}
