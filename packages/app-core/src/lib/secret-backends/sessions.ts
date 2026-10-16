import { SecretBackendError, type SecretBackendSession } from "./types.js";

type SessionState<T> = {
  state: T;
  lifetime: AbortController;
  nativeLifetime?: AbortSignal;
  detach(): void;
};
type SessionClosure = "removed" | "provider-ended";
const closures = new WeakMap<SecretBackendSession, SessionClosure>();

/** Safe metadata for the exact original handle, never another source of authority. */
export function secretBackendSessionClosure(
  session: SecretBackendSession,
): SessionClosure | null {
  return closures.get(session) ?? null;
}

function disconnected(): SecretBackendError {
  return new SecretBackendError(
    "authentication",
    "Connect this secret backend again.",
  );
}

/** Identity-bound opaque handles cannot be reconstructed from a storage dump. */
export function createSecretBackendSessions<T extends object>(
  backendId: string,
) {
  const states = new WeakMap<SecretBackendSession, SessionState<T>>();
  const retire = (
    session: SecretBackendSession,
    reason: SessionClosure,
  ): void => {
    const held = states.get(session);
    if (!held) return;
    // Reentrant observers must lose both authority and the external subscription first.
    states.delete(session);
    held.detach();
    closures.set(
      session,
      held.nativeLifetime?.aborted ? "provider-ended" : reason,
    );
    held.lifetime.abort();
  };
  const remove = (session: SecretBackendSession): void =>
    retire(session, "removed");
  return {
    create(state: T, nativeLifetime?: AbortSignal): SecretBackendSession {
      if (nativeLifetime?.aborted) throw disconnected();
      const lifetime = new AbortController();
      const session = {
        id: crypto.randomUUID(),
        backendId,
        authenticatedAt: new Date().toISOString(),
      };
      Object.defineProperty(session, "signal", {
        value: lifetime.signal,
        enumerable: false,
        writable: false,
        configurable: false,
      });
      Object.freeze(session);
      const terminate = () => retire(session, "provider-ended");
      const held = {
        state,
        lifetime,
        nativeLifetime,
        detach: () => nativeLifetime?.removeEventListener("abort", terminate),
      };
      states.set(session, held);
      try {
        nativeLifetime?.addEventListener("abort", terminate, { once: true });
        if (
          nativeLifetime?.aborted ||
          lifetime.signal.aborted ||
          states.get(session) !== held
        )
          throw disconnected();
      } catch {
        retire(session, "provider-ended");
        throw disconnected();
      }
      return session;
    },
    read(session: SecretBackendSession): T {
      const held = states.get(session);
      if (held?.nativeLifetime?.aborted) {
        retire(session, "provider-ended");
        throw disconnected();
      }
      if (!held || session.backendId !== backendId) throw disconnected();
      return held.state;
    },
    remove,
  };
}
