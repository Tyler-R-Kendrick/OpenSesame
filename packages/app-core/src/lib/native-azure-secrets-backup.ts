/** The same sealed native Azure record owns this CRUD/backup handle and original route. */
import { canonicalize } from "@opensesame/os-domain";
import { subscribeDeviceRows } from "./device-connector-records.js";
import { azureSecretsKeyFlows } from "./native-azure-secrets.js";
import {
  type NativeConnectorRecord,
  assertNativeConnectorRevision,
} from "./native-connector-store.js";
import {
  type NativeProviderTransport,
  captureNativeProviderAuthority,
} from "./native-connector-transport.js";
import { invalidateNativeKey, requireNativeKey } from "./native-key-state.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";
import type { SecretBackendBackupHandle } from "./secret-backends/backup-transfer.js";
import { SecretBackendHttpError } from "./secret-backends/http.js";
import {
  type VaultSessionPort,
  localVaultSessionGuard,
} from "./secret-backends/local-vault-port.js";
import type { SecretBackendTransport } from "./secret-backends/transport.js";
import {
  type SecretBackend,
  SecretBackendError,
  type SecretBackendSession,
} from "./secret-backends/types.js";

export type NativeAzureSecretsOptions = {
  vault: VaultSessionPort;
  transport?: NativeProviderTransport;
  signal?: AbortSignal;
  assertCurrent?: () => void;
};
const classification = {
  publicParameters: ["vault_url"],
  privateCredentials: ["token"],
};
const spec = {
  family: "Azure Key Vault Secrets",
  accepts: azureSecretsKeyFlows.accepts,
  classification,
};
function stale(): never {
  throw new SecretBackendError(
    "stale",
    "The saved Azure secret authority changed.",
  );
}
function recordBinding(record: NativeConnectorRecord): string {
  return canonicalize({
    connectionId: record.connectionId,
    revision: record.revision,
    configuration: record.configuration,
    runtime: record.runtime,
    privateState: record.privateState,
  });
}
function captureOwner(id: string, options: NativeAzureSecretsOptions) {
  const original =
    options.transport ?? captureNativeProviderAuthority().capture();
  original.assertCurrent();
  const providerSignal = original.signal;
  if (!providerSignal)
    throw new SecretBackendError(
      "configuration",
      "The native provider has no captured lifetime.",
    );
  const action = options.assertCurrent;
  const caller = options.signal;
  providerSignal.throwIfAborted();
  caller?.throwIfAborted();
  action?.();
  const guard = localVaultSessionGuard(options.vault);
  const lifetime = new AbortController();
  const signal = AbortSignal.any([
    providerSignal,
    lifetime.signal,
    ...(caller ? [caller] : []),
  ]);
  let unrows = () => {};
  let unlock = () => {};
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    unrows();
    unlock();
    guard.close();
    signal.removeEventListener("abort", close);
    lifetime.abort();
  };
  try {
    const saved = requireNativeKey(spec, id, true);
    const binding = recordBinding(saved);
    const config = {
      baseUrl: saved.configuration.parameters.vault_url ?? "",
      token: saved.privateState.credentials.token ?? "",
    };
    const check = () => {
      try {
        signal.throwIfAborted();
        original.assertCurrent();
        action?.();
        guard.current();
        if (recordBinding(requireNativeKey(spec, id, true)) !== binding)
          stale();
        signal.throwIfAborted();
      } catch (error) {
        close();
        throw error;
      }
    };
    const transport: SecretBackendTransport = {
      signal,
      assertCurrent: check,
      fetch: (input, init) => {
        check();
        return original.fetch(input, {
          ...init,
          signal: AbortSignal.any([
            signal,
            ...(input instanceof Request ? [input.signal] : []),
            ...(init?.signal ? [init.signal] : []),
          ]),
        });
      },
    };
    unrows = subscribeDeviceRows(() => {
      try {
        check();
      } catch {
        close();
      }
    });
    unlock = options.vault.onLock(close);
    signal.addEventListener("abort", close, { once: true });
    check();
    return {
      saved,
      config,
      transport,
      signal,
      check,
      close,
      async current() {
        check();
        await assertNativeConnectorRevision(id, nativeOAuthGuard(saved));
        check();
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}
type Owner = ReturnType<typeof captureOwner>;
function savedBackend(
  owner: Owner,
  opened: SecretBackendBackupHandle,
): SecretBackend {
  const delegate = opened.backend;
  const session = opened.session;
  let closing: Promise<void> | undefined;
  const disconnect = (presented: SecretBackendSession) => {
    if (presented !== session) stale();
    if (!closing) {
      closing = Promise.resolve().then(() => delegate.disconnect(session));
      owner.close();
    }
    return closing;
  };
  async function run<T>(
    presented: SecretBackendSession,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (presented !== session) stale();
    await owner.current();
    try {
      const result = await operation();
      await owner.current();
      owner.check();
      return result;
    } catch (error) {
      if (
        error instanceof SecretBackendHttpError &&
        (error.status === 401 || error.status === 403)
      ) {
        try {
          await invalidateNativeKey(
            classification,
            owner.saved,
            owner.transport,
          );
        } catch {
          /* Preserve the initiating provider error if this original authority ended. */
        }
        owner.close();
      }
      throw error;
    }
  }
  const create = delegate.createItem;
  const update = delegate.updateItem;
  const remove = delegate.deleteItem;
  if (!create || !update || !remove)
    throw new SecretBackendError(
      "unsupported",
      "The native Azure backend has no mutation surface.",
    );
  return {
    signal: owner.signal,
    id: delegate.id,
    name: owner.saved.configuration.displayName,
    capabilities: delegate.capabilities,
    authenticate: async () => {
      throw new SecretBackendError(
        "unsupported",
        "Open the saved native Azure connection instead of supplying another credential.",
      );
    },
    listItems: (presented) => run(presented, () => delegate.listItems(session)),
    getItem: (id, presented) =>
      run(presented, () => delegate.getItem(id, session)),
    getNotes: (id, presented) =>
      run(presented, () => delegate.getNotes(id, session)),
    createItem: (input, presented) =>
      run(presented, () => create.call(delegate, input, session)),
    updateItem: (id, input, presented) =>
      run(presented, () => update.call(delegate, id, input, session)),
    deleteItem: (id, presented) =>
      run(presented, () => remove.call(delegate, id, session)),
    disconnect,
  };
}
export async function openSavedAzureSecrets(
  id: string,
  options: NativeAzureSecretsOptions,
): Promise<SecretBackendBackupHandle> {
  const owner = captureOwner(id, options);
  let opened: SecretBackendBackupHandle | undefined;
  try {
    await owner.current();
    // The current shared flow checks the saved target/key fingerprint before actual list proof.
    await azureSecretsKeyFlows.invoke(id, "provider.read", {}, owner.transport);
    await owner.current();
    const module = await import("./secret-backends/azure-key-vault.js");
    owner.check();
    opened = await module.openAzureKeyVaultSecretBackend(
      owner.config,
      owner.transport,
    );
    await owner.current();
    owner.check();
    return { backend: savedBackend(owner, opened), session: opened.session };
  } catch (error) {
    owner.close();
    if (opened) await opened.backend.disconnect(opened.session);
    throw error;
  }
}
