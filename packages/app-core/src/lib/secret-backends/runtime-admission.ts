import {
  awaitSecretBackendOwner,
  guardedSecretBackend,
} from "./runtime-guard.js";
import { secretBackendSessionClosure } from "./sessions.js";
import { fenceSecretBackend } from "./transport.js";
import {
  type SecretBackend,
  SecretBackendError,
  type SecretBackendSession,
} from "./types.js";

export type SecretBackendHandle = Readonly<{
  backend: SecretBackend;
  session: SecretBackendSession;
  signal?: AbortSignal;
}>;
type BackendLease = {
  signal: AbortSignal;
  current(): boolean;
  check(): void;
  close(): void;
};
export type HeldSecretBackend = SecretBackendHandle & {
  readonly signal: AbortSignal;
  current(): boolean;
  check(): void;
  close(): Promise<void>;
};

function ended(): SecretBackendError {
  return new SecretBackendError(
    "stale",
    "This backend session ended. Connect again.",
  );
}

export function assertSecretBackendSessionOpen(
  session: SecretBackendSession,
): void {
  if (session.signal?.aborted) throw ended();
}

/** Admission can end before adapter disposal; the adapter keeps its own private state. */
export function holdSecretBackend(
  raw: SecretBackendHandle,
  lease: BackendLease,
  onClosed: (held: HeldSecretBackend) => void,
): HeldSecretBackend {
  const backendSignal = raw.backend.signal;
  const lifetime = new AbortController();
  let closed = false;
  let disposal: Promise<void> | undefined;
  const close = (provided: SecretBackendSession): Promise<void> => {
    if (provided !== raw.session)
      return Promise.reject(
        new SecretBackendError(
          "authentication",
          "This session belongs to a different backend.",
        ),
      );
    if (disposal) return disposal;
    closed = true;
    disposal = Promise.resolve().then(() =>
      raw.backend.disconnect(raw.session),
    );
    void disposal.catch(() => undefined);
    lease.signal.removeEventListener("abort", terminate);
    raw.session.signal?.removeEventListener("abort", terminate);
    backendSignal?.removeEventListener("abort", terminate);
    lease.close();
    lifetime.abort();
    onClosed(held);
    return disposal;
  };
  const terminate = () => {
    void close(raw.session).catch(() => undefined);
  };
  const current = () =>
    !closed &&
    lease.current() &&
    !raw.session.signal?.aborted &&
    !backendSignal?.aborted;
  const check = () => {
    lease.check();
    if (!current()) throw ended();
  };
  const held: HeldSecretBackend = {
    backend: fenceSecretBackend(
      guardedSecretBackend(raw.backend, raw.session, check, close),
      {
        signal: lifetime.signal,
        assertCurrent: check,
      },
    ),
    session: raw.session,
    signal: lifetime.signal,
    current,
    check,
    close: () => close(raw.session),
  };
  lease.signal.addEventListener("abort", terminate, { once: true });
  if (!closed)
    raw.session.signal?.addEventListener("abort", terminate, { once: true });
  if (!closed)
    backendSignal?.addEventListener("abort", terminate, { once: true });
  if (
    lease.signal.aborted ||
    raw.session.signal?.aborted ||
    backendSignal?.aborted
  )
    terminate();
  return held;
}

/** Only a registry-confirmed removal initiated by this probe is expected shutdown. */
export async function disposeSecretBackendProbe(
  raw: SecretBackendHandle,
  lease: BackendLease,
): Promise<void> {
  const backendSignal = raw.backend.signal;
  const unexpected = new AbortController();
  let disposing = false;
  const providerEnded = () => {
    if (!disposing || secretBackendSessionClosure(raw.session) !== "removed")
      unexpected.abort();
  };
  raw.session.signal?.addEventListener("abort", providerEnded, { once: true });
  if (raw.session.signal?.aborted) unexpected.abort();
  const cleanup = Promise.resolve().then(() => {
    if (raw.session.signal?.aborted) unexpected.abort();
    disposing = true;
    return raw.backend.disconnect(raw.session);
  });
  try {
    await awaitSecretBackendOwner(
      cleanup,
      AbortSignal.any([
        lease.signal,
        unexpected.signal,
        ...(backendSignal ? [backendSignal] : []),
      ]),
    );
    if (unexpected.signal.aborted) throw ended();
    lease.check();
    if (backendSignal?.aborted) throw ended();
  } finally {
    raw.session.signal?.removeEventListener("abort", providerEnded);
  }
}
