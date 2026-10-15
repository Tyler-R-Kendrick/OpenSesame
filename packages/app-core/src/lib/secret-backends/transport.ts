import {
  type SecretBackend,
  SecretBackendError,
  type SecretBackendFetch,
} from "./types.js";

/** A single approved activation; capturing it never borrows a later lease. */
export type SecretBackendTransport = Readonly<{
  fetch: SecretBackendFetch;
  assertCurrent(): void;
  signal: AbortSignal;
}>;
type BackendLifetime = Pick<
  SecretBackendTransport,
  "assertCurrent" | "signal"
> &
  Partial<Pick<SecretBackendTransport, "fetch">>;

function stale(): SecretBackendError {
  return new SecretBackendError(
    "stale",
    "External connectors changed or were disabled. Reconnect this secret backend.",
  );
}

const inactive: SecretBackendTransport = {
  fetch: async () => {
    throw stale();
  },
  assertCurrent: () => {
    throw stale();
  },
  signal: AbortSignal.abort(),
};
let active: SecretBackendTransport = inactive;

export function bindSecretBackendTransport(
  transport: SecretBackendTransport,
): () => void {
  active = transport;
  return () => {
    if (active === transport) active = inactive;
  };
}

/** Only HTTP modes need the optional capability; local ports do not call this. */
export function secretBackendTransport(): SecretBackendTransport {
  active.assertCurrent();
  if (active.signal.aborted) throw stale();
  return active;
}

/** Operation owners may add vault and saved-configuration checks to the approved network port. */
export function guardSecretBackendTransport(
  transport: SecretBackendTransport,
  guard?: () => void,
  ownerSignal?: AbortSignal,
): SecretBackendTransport {
  const fetcher = transport.fetch.bind(transport);
  const capturedCheck = transport.assertCurrent.bind(transport);
  const signal = ownerSignal
    ? AbortSignal.any([transport.signal, ownerSignal])
    : transport.signal;
  const assertCurrent = () => {
    capturedCheck();
    if (signal.aborted) throw stale();
    guard?.();
    if (signal.aborted) throw stale();
  };
  return {
    signal,
    assertCurrent,
    fetch: async (input, init) => {
      assertCurrent();
      const signals = [signal];
      if (input instanceof Request) signals.push(input.signal);
      if (init?.signal) signals.push(init.signal);
      const response = await fetcher(input, {
        ...init,
        signal: AbortSignal.any(signals),
      });
      assertCurrent();
      return response;
    },
  };
}

async function duringLease<T>(
  transport: BackendLifetime,
  operation: () => Promise<T>,
  discard?: (result: T) => Promise<void>,
): Promise<T> {
  transport.assertCurrent();
  if (transport.signal.aborted) return Promise.reject(stale());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(stale());
    transport.signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        transport.assertCurrent();
        if (transport.signal.aborted) throw stale();
        return operation();
      })
      .then(
        async (result) => {
          transport.signal.removeEventListener("abort", abort);
          try {
            transport.assertCurrent();
            if (transport.signal.aborted) throw stale();
            resolve(result);
          } catch (error) {
            // The caller never receives this result. Release opaque sessions
            // even when the lease's abort already rejected the outer promise.
            try {
              await discard?.(result);
            } catch {
              // Preserve the owning lease/vault error if cleanup also fails.
            }
            reject(error);
          }
        },
        (error) => {
          transport.signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
  });
}

/** HTTP and SDK results have the same activation fence as the requests that made them. */
export function fenceSecretBackend(
  backend: SecretBackend,
  transport: BackendLifetime,
): SecretBackend {
  const fenced: SecretBackend = {
    id: backend.id,
    name: backend.name,
    capabilities: backend.capabilities,
    authenticate: (config) =>
      duringLease(
        transport,
        () => backend.authenticate(config),
        (session) => backend.disconnect(session),
      ),
    listItems: (session) =>
      duringLease(transport, () => backend.listItems(session)),
    getItem: (name, session) =>
      duringLease(transport, () => backend.getItem(name, session)),
    getNotes: (name, session) =>
      duringLease(transport, () => backend.getNotes(name, session)),
    disconnect: (session) => backend.disconnect(session),
  };
  const create = backend.createItem;
  const update = backend.updateItem;
  const remove = backend.deleteItem;
  const importToLocal = backend.importToLocal;
  if (create)
    fenced.createItem = (item, session) =>
      duringLease(transport, () => create.call(backend, item, session));
  if (update)
    fenced.updateItem = (id, item, session) =>
      duringLease(transport, () => update.call(backend, id, item, session));
  if (remove)
    fenced.deleteItem = (id, session) =>
      duringLease(transport, () => remove.call(backend, id, session));
  if (importToLocal)
    fenced.importToLocal = (session) =>
      duringLease(transport, () => importToLocal.call(backend, session));
  return fenced;
}
