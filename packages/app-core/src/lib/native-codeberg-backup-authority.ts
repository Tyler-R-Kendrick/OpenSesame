/** One real sealed public-PKCE grant, original route and vault own a backup handle. */
import { canonicalize } from "@opensesame/os-domain";
import { subscribeDeviceRows } from "./device-connector-records.js";
import { browserOAuthClassification } from "./native-browser-oauth-profile.js";
import { refreshNativeBrowserAuthorization } from "./native-browser-oauth-refresh.js";
import {
  type NativeCodebergBackupTarget,
  nativeCodebergBackupTarget,
} from "./native-codeberg-backup-target.js";
import { verifyNativeCodebergIdentity } from "./native-codeberg-provider.js";
import {
  assertNativeConnectorRevision,
  updateNativeConnector,
} from "./native-connector-store.js";
import { captureNativeProviderAuthority } from "./native-connector-transport.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import {
  nativeOAuthGuard,
  requireNativeOAuthRecord,
} from "./native-oauth-session.js";
import {
  type VaultSessionPort,
  localVaultSessionGuard,
} from "./secret-backends/local-vault-port.js";
import { SecretBackendError } from "./secret-backends/types.js";
export type NativeCodebergBackupOptions = {
  vault: VaultSessionPort;
  transport?: NativeProviderTransport;
  signal?: AbortSignal;
  assertCurrent?: () => void;
};
function stale(): never {
  throw new SecretBackendError(
    "stale",
    "The saved Codeberg backup authority changed.",
  );
}
function lifetime(options: NativeCodebergBackupOptions) {
  const original =
    options.transport ?? captureNativeProviderAuthority().capture();
  original.assertCurrent();
  if (!original.signal)
    throw new SecretBackendError(
      "configuration",
      "The native provider has no captured lifetime.",
    );
  const guard = localVaultSessionGuard(options.vault);
  const controller = new AbortController();
  const signal = AbortSignal.any([
    original.signal,
    controller.signal,
    ...(options.signal ? [options.signal] : []),
  ]);
  const check = () => {
    signal.throwIfAborted();
    original.assertCurrent();
    options.assertCurrent?.();
    guard.current();
  };
  const transport: NativeProviderTransport = {
    ...original,
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
  const unsubscribeLock = options.vault.onLock(() => controller.abort());
  const close = () => {
    controller.abort();
    unsubscribeLock();
    guard.close();
  };
  return { transport, signal, check, close };
}
function requireCodeberg(id: string, target: NativeCodebergBackupTarget) {
  const record = requireNativeOAuthRecord(id);
  if (
    record.configuration.providerId !== "codeberg" ||
    record.configuration.method !== "oauth" ||
    !record.privateState.verification ||
    record.privateState.verification.fingerprint !==
      record.configuration.fingerprint ||
    record.privateState.recovery.length > 0 ||
    Object.keys(record.privateState.pending).length > 0 ||
    canonicalize(
      nativeCodebergBackupTarget(record.configuration.parameters),
    ) !== canonicalize(target)
  )
    stale();
  return record;
}
function requireGrant(saved: ReturnType<typeof requireCodeberg>) {
  const grant = saved.privateState.grants.user;
  if (
    !grant ||
    grant.providerId !== "codeberg" ||
    grant.kind !== "oauth" ||
    grant.actor !== "user" ||
    grant.fingerprint !== saved.configuration.fingerprint ||
    grant.clientId !== saved.configuration.clientId ||
    grant.issuer !== "https://codeberg.org" ||
    grant.endpoint !== "https://codeberg.org/login/oauth/access_token" ||
    !grant.accessToken ||
    Array.from(grant.accessToken).some(
      (char) => char.charCodeAt(0) < 33 || char.charCodeAt(0) === 127,
    ) ||
    (grant.expiresAt !== null && grant.expiresAt <= Date.now())
  )
    stale();
  return grant;
}
async function verified(
  id: string,
  target: NativeCodebergBackupTarget,
  transport: NativeProviderTransport,
) {
  transport.assertCurrent();
  const initial = requireCodeberg(id, target);
  const configuration = canonicalize(initial.configuration);
  const expiresAt = initial.privateState.grants.user?.expiresAt;
  if (expiresAt !== undefined && expiresAt !== null && expiresAt <= Date.now())
    await refreshNativeBrowserAuthorization(initial, transport);
  transport.assertCurrent();
  const saved = requireCodeberg(id, target);
  if (canonicalize(saved.configuration) !== configuration) stale();
  const grant = requireGrant(saved);
  return { saved, grant };
}
async function invalidateCodeberg(
  saved: ReturnType<typeof requireCodeberg>,
  transport: NativeProviderTransport,
  close: () => void,
) {
  try {
    await updateNativeConnector(
      saved.connectionId,
      nativeOAuthGuard(saved),
      browserOAuthClassification(saved.configuration),
      (record) => {
        record.privateState.verification = null;
        record.runtime.verifiedAt = null;
        record.runtime.grants = record.runtime.grants.map((metadata) => ({
          ...metadata,
          needsReauth: true,
        }));
        return record;
      },
      transport.assertCurrent,
    );
  } finally {
    close();
  }
}
function watchPreparing(
  id: string,
  target: NativeCodebergBackupTarget,
  held: ReturnType<typeof lifetime>,
  close: () => void,
) {
  held.check();
  const initial = canonicalize(requireCodeberg(id, target).configuration);
  return subscribeDeviceRows(() => {
    try {
      held.check();
      if (canonicalize(requireNativeOAuthRecord(id).configuration) !== initial)
        stale();
    } catch {
      close();
    }
  });
}
export async function captureNativeCodebergBackup(
  id: string,
  target: NativeCodebergBackupTarget,
  options: NativeCodebergBackupOptions,
) {
  const held = lifetime(options);
  let unsubscribeRows = () => {};
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribeRows();
    held.signal.removeEventListener("abort", close);
    held.close();
  };
  try {
    held.check();
    unsubscribeRows = watchPreparing(id, target, held, close);
    const { saved, grant } = await verified(id, target, held.transport);
    const binding = canonicalize({
      configuration: saved.configuration,
      privateState: saved.privateState,
    });
    const check = () => {
      held.check();
      if (grant.expiresAt !== null && grant.expiresAt <= Date.now()) stale();
      const current = requireCodeberg(id, target);
      if (
        current.revision !== saved.revision ||
        canonicalize({
          configuration: current.configuration,
          privateState: current.privateState,
        }) !== binding
      )
        stale();
    };
    unsubscribeRows();
    unsubscribeRows = subscribeDeviceRows(() => {
      try {
        check();
      } catch {
        close();
      }
    });
    held.signal.addEventListener("abort", close, { once: true });
    const current = async () => {
      check();
      await assertNativeConnectorRevision(id, nativeOAuthGuard(saved));
      check();
    };
    await current();
    const identity = await verifyNativeCodebergIdentity(grant, held.transport);
    check();
    if (identity.id !== saved.runtime.identity?.id) stale();
    const invalidate = () => invalidateCodeberg(saved, held.transport, close);
    return { ...held, saved, grant, check, current, close, invalidate };
  } catch (error) {
    close();
    throw error;
  }
}
