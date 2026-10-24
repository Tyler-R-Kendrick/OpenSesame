/** One sealed GitHub token, approved provider activation and original vault session. */
import { canonicalize } from "@opensesame/os-domain";
import { subscribeDeviceRows } from "./device-connector-records.js";
import { assertNativeConnectorRevision } from "./native-connector-store.js";
import {
  type NativeProviderTransport,
  nativeProviderTransport,
} from "./native-connector-transport.js";
import {
  nativeGithubPersonalFingerprint,
  requireNativeGithubPersonal,
} from "./native-github-personal-state.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";
import {
  type VaultSessionPort,
  localVaultSessionGuard,
} from "./secret-backends/local-vault-port.js";
import { SecretBackendError } from "./secret-backends/types.js";

export type NativeGithubBackupOptions = {
  vault: VaultSessionPort;
  transport?: NativeProviderTransport;
  signal?: AbortSignal;
  assertCurrent?: () => void;
};
function stale(): never {
  throw new SecretBackendError(
    "stale",
    "The saved GitHub backup authority changed.",
  );
}
export async function captureNativeGithubBackup(
  id: string,
  options: NativeGithubBackupOptions,
) {
  const transport = options.transport ?? nativeProviderTransport();
  transport.assertCurrent();
  if (!transport.signal)
    throw new SecretBackendError(
      "configuration",
      "The native provider has no captured lifetime.",
    );
  const saved = requireNativeGithubPersonal(id, true);
  const guard = localVaultSessionGuard(options.vault);
  const lifetime = new AbortController();
  const signal = AbortSignal.any([
    transport.signal,
    lifetime.signal,
    ...(options.signal ? [options.signal] : []),
  ]);
  const binding = canonicalize({
    configuration: saved.configuration,
    privateState: saved.privateState,
  });
  const check = () => {
    signal.throwIfAborted();
    transport.assertCurrent();
    options.assertCurrent?.();
    guard.current();
    const current = requireNativeGithubPersonal(id, true);
    if (
      current.revision !== saved.revision ||
      canonicalize({
        configuration: current.configuration,
        privateState: current.privateState,
      }) !== binding
    )
      stale();
  };
  let unsubscribeRows = () => {};
  let unsubscribeLock = () => {};
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    lifetime.abort();
    guard.close();
    unsubscribeRows();
    unsubscribeLock();
    signal.removeEventListener("abort", close);
  };
  unsubscribeRows = subscribeDeviceRows(() => {
    try {
      check();
    } catch {
      close();
    }
  });
  unsubscribeLock = options.vault.onLock(close);
  signal.addEventListener("abort", close, { once: true });
  const current = async () => {
    check();
    await assertNativeConnectorRevision(id, nativeOAuthGuard(saved));
    check();
  };
  try {
    await current();
    if (
      saved.configuration.fingerprint !==
      (await nativeGithubPersonalFingerprint())
    )
      stale();
    check();
    return { saved, transport, signal, check, current, close };
  } catch (error) {
    close();
    throw error;
  }
}
