/** A saved native bucket and its original vault/provider/action lifetime. */
import { subscribeDeviceRows } from "./device-connector-records.js";
import { assertNativeConnectorRevision } from "./native-connector-store.js";
import {
  type NativeProviderTransport,
  nativeProviderTransport,
} from "./native-connector-transport.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";
import { nativeS3Fingerprint } from "./native-s3-input.js";
import {
  nativeS3CredentialBinding,
  requireNativeS3,
} from "./native-s3-state.js";
import {
  type VaultSessionPort,
  localVaultSessionGuard,
} from "./secret-backends/local-vault-port.js";
import { SecretBackendError } from "./secret-backends/types.js";

export type NativeS3BackupOptions = {
  transport?: NativeProviderTransport;
  vault: VaultSessionPort;
  signal?: AbortSignal;
  assertCurrent?: () => void;
};
function stale(): never {
  throw new SecretBackendError(
    "stale",
    "The saved S3 backup authority changed.",
  );
}

type Action = Pick<NativeS3BackupOptions, "signal" | "assertCurrent">;
function bindBackupAuthority(
  id: string,
  transport: NativeProviderTransport,
  captured: AbortSignal,
  vault: VaultSessionPort,
  action: Action,
) {
  const saved = requireNativeS3(id, true);
  const guard = localVaultSessionGuard(vault);
  const lifetime = new AbortController();
  const signal = AbortSignal.any([
    captured,
    lifetime.signal,
    ...(action.signal ? [action.signal] : []),
  ]);
  const binding = nativeS3CredentialBinding(saved.privateState.credentials);
  const check = () => {
    signal.throwIfAborted();
    transport.assertCurrent();
    action.assertCurrent?.();
    guard.current();
    const current = requireNativeS3(id, true);
    if (
      current.revision !== saved.revision ||
      current.configuration.fingerprint !== saved.configuration.fingerprint ||
      nativeS3CredentialBinding(current.privateState.credentials) !== binding
    )
      stale();
    signal.throwIfAborted();
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
  unsubscribeLock = vault.onLock(close);
  signal.addEventListener("abort", close, { once: true });
  try {
    check();
  } catch (error) {
    close();
    throw error;
  }
  return {
    saved,
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
}

export async function captureNativeS3Backup(
  id: string,
  options: NativeS3BackupOptions,
) {
  const transport = options.transport ?? nativeProviderTransport();
  const action: Action = {
    signal: options.signal,
    assertCurrent: options.assertCurrent,
  };
  const vault = options.vault;
  transport.assertCurrent();
  const captured = transport.signal;
  if (!captured)
    throw new SecretBackendError(
      "configuration",
      "The native provider has no captured lifetime.",
    );
  captured.throwIfAborted();
  action.signal?.throwIfAborted();
  action.assertCurrent?.();
  const owner = bindBackupAuthority(id, transport, captured, vault, action);
  try {
    await owner.current();
    const fingerprint = await nativeS3Fingerprint(
      owner.saved.configuration.parameters,
    );
    owner.check();
    if (fingerprint !== owner.saved.configuration.fingerprint) stale();
    return owner;
  } catch (error) {
    owner.close();
    throw error;
  }
}
