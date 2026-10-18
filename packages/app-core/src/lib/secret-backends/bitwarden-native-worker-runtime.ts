import type { BoundaryValue } from "@opensesame/os-domain";
import type { BitwardenKdfResourceLimits } from "./bitwarden-native-kdf.js";
import {
  NativeWorkerReply,
  NativeWorkerRequest,
  type NativeWorkerSettings,
  NativeWorkerValue,
} from "./bitwarden-native-worker-protocol.js";
import {
  type BitwardenNativeConfiguration,
  createBitwardenNativeBackend,
} from "./bitwarden-native.js";
import {
  type SecretBackendTransport,
  guardSecretBackendTransport,
} from "./transport.js";
import {
  type SecretBackend,
  SecretBackendError,
  type SecretBackendSession,
} from "./types.js";

export type BitwardenNativeWorkerPort = {
  send(value: NativeWorkerReply): void;
  close(): void;
};
function configuration(
  settings: NativeWorkerSettings,
): BitwardenNativeConfiguration {
  return {
    ...settings,
    mode: "bitwarden-api",
    token: "",
    projectId: "",
    organizationId: "",
    environment: "",
    secretPath: "",
    passwordListId: "",
    fileFormat: "",
  };
}
function stale(): SecretBackendError {
  return new SecretBackendError(
    "stale",
    "The native Bitwarden worker session ended. Connect again.",
  );
}
function failure(id: number, error: BoundaryValue): NativeWorkerReply {
  return error instanceof SecretBackendError
    ? { id, ok: false, code: error.code, message: error.message }
    : {
        id,
        ok: false,
        code: "response",
        message:
          "The native Bitwarden worker could not complete this operation.",
      };
}
function success(id: number, value: BoundaryValue): NativeWorkerReply {
  const result = NativeWorkerValue.parse(value);
  if (
    new TextEncoder().encode(JSON.stringify(result)).length >
    64 * 1024 * 1024
  )
    throw stale();
  return NativeWorkerReply.parse({ id, ok: true, value: result });
}
async function invoke(
  backend: SecretBackend,
  session: SecretBackendSession,
  request: Exclude<
    NativeWorkerRequest,
    { type: "initialize" } | { type: "dispose" }
  >,
) {
  switch (request.type) {
    case "list":
      return backend.listItems(session);
    case "get":
      return backend.getItem(request.selector, session);
    case "notes":
      return backend.getNotes(request.selector, session);
    case "create":
      if (!backend.createItem) throw stale();
      return backend.createItem(request.item, session);
    case "update":
      if (!backend.updateItem) throw stale();
      return backend.updateItem(request.itemId, request.item, session);
    case "delete":
      if (!backend.deleteItem) throw stale();
      await backend.deleteItem(request.itemId, session);
      return null;
  }
}
/** Install inside a disposable worker. The host passes a captured fetch port, never ambient fetch. */
export function createBitwardenNativeWorkerRuntime(
  port: BitwardenNativeWorkerPort,
  transport: SecretBackendTransport,
  limits: BitwardenKdfResourceLimits,
) {
  const owner = new AbortController();
  const captured = guardSecretBackendTransport(
    transport,
    undefined,
    owner.signal,
  );
  let backend: SecretBackend | undefined;
  let session: SecretBackendSession | undefined;
  let ended = false;
  let initialized = false;
  let active = 0;
  let queue = Promise.resolve();
  let lastId = 0;
  const check = () => {
    if (ended) throw stale();
    captured.assertCurrent();
  };
  const dispose = async () => {
    if (ended) return;
    ended = true;
    owner.abort();
    transport.signal.removeEventListener("abort", close);
    const prior = backend;
    const handle = session;
    backend = undefined;
    session = undefined;
    try {
      if (prior && handle) await prior.disconnect(handle);
    } finally {
      port.close();
    }
  };
  const close = () => {
    void dispose().catch(() => undefined);
  };
  transport.signal.addEventListener("abort", close, { once: true });
  const execute = async (request: NativeWorkerRequest) => {
    check();
    if (request.type === "initialize") {
      if (initialized) throw stale();
      initialized = true;
      backend = createBitwardenNativeBackend(captured, limits);
      try {
        session = await backend.authenticate(configuration(request.settings));
      } finally {
        request.settings.masterPassword = "";
        request.settings.clientSecret = "";
      }
      check();
      return null;
    }
    if (!backend || !session || session.signal?.aborted) throw stale();
    if (request.type === "dispose") return null;
    return invoke(backend, session, request);
  };
  return {
    dispose,
    receive(value: BoundaryValue): void {
      if (ended) return;
      const parsed = NativeWorkerRequest.safeParse(value);
      if (!parsed.success || parsed.data.id <= lastId || active >= 4) {
        close();
        return;
      }
      const request = parsed.data;
      lastId = request.id;
      if (request.type === "dispose") {
        close();
        return;
      }
      active++;
      queue = queue
        .then(async () => {
          try {
            const result = await execute(request);
            check();
            port.send(success(request.id, result));
          } catch (error) {
            if (!ended)
              port.send(
                failure(request.id, error instanceof Error ? error : undefined),
              );
            if (request.type === "initialize" || session?.signal?.aborted)
              close();
          } finally {
            active--;
          }
        })
        .catch(close);
    },
  };
}
