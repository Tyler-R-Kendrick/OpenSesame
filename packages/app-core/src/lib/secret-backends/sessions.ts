import { SecretBackendError, type SecretBackendSession } from "./types.js";

/** Identity-bound opaque handles cannot be reconstructed from a storage dump. */
export function createSecretBackendSessions<T extends object>(
  backendId: string,
) {
  const states = new WeakMap<SecretBackendSession, T>();
  return {
    create(state: T): SecretBackendSession {
      const session = Object.freeze({
        id: crypto.randomUUID(),
        backendId,
        authenticatedAt: new Date().toISOString(),
      });
      states.set(session, state);
      return session;
    },
    read(session: SecretBackendSession): T {
      const state = states.get(session);
      if (state === undefined || session.backendId !== backendId)
        throw new SecretBackendError(
          "authentication",
          "Connect this secret backend again.",
        );
      return state;
    },
    remove(session: SecretBackendSession): void {
      states.delete(session);
    },
  };
}
