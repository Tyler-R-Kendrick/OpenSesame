/** One verified sealed GitLab key, exact saved destination and original native route. */
import { canonicalize } from "@opensesame/os-domain";
import { subscribeDeviceRows } from "./device-connector-records.js";
import { nativeApiVerificationRequest } from "./native-api-auth.js";
import {
  assertNativeApiAuthority,
  assertNativeApiEditable,
} from "./native-api-authority.js";
import { NativeApiError, nativeApiHttp } from "./native-api-http.js";
import { invalidateNativeApiProof } from "./native-api-proof.js";
import {
  type NativeApiTarget,
  nativeApiFingerprint,
  nativeApiTarget,
} from "./native-api-target.js";
import { verifyNativeApiResponse } from "./native-api-verify.js";
import {
  type NativeConnectorRecord,
  assertNativeConnectorRevision,
  loadNativeConnectorRecord,
} from "./native-connector-store.js";
import {
  type NativeProviderTransport,
  captureNativeProviderAuthority,
} from "./native-connector-transport.js";
import {
  type NativeGitlabBackupTarget,
  nativeGitlabBackupTarget,
  verifyNativeGitlabBackupTarget,
} from "./native-gitlab-backup-target.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";
import {
  type VaultSessionPort,
  localVaultSessionGuard,
} from "./secret-backends/local-vault-port.js";
import { SecretBackendError } from "./secret-backends/types.js";
export type NativeGitlabBackupOptions = {
  vault: VaultSessionPort;
  transport?: NativeProviderTransport;
  signal?: AbortSignal;
  assertCurrent?: () => void;
};
function stale(): never {
  throw new SecretBackendError(
    "stale",
    "The saved GitLab backup authority changed.",
  );
}
function requireGitlab(id: string, target: NativeGitlabBackupTarget) {
  const saved = loadNativeConnectorRecord(id);
  if (
    !saved ||
    saved.configuration.providerId !== "gitlab" ||
    saved.configuration.method !== "api-key" ||
    canonicalize(nativeGitlabBackupTarget(saved.configuration.parameters)) !==
      canonicalize(target)
  )
    stale();
  assertNativeApiEditable(saved);
  assertNativeApiAuthority(saved);
  return saved;
}
function lifetime(options: NativeGitlabBackupOptions) {
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
  const unlock = options.vault.onLock(() => controller.abort());
  return {
    transport,
    signal,
    check,
    close: () => {
      controller.abort();
      unlock();
      guard.close();
    },
  };
}
async function accountProbe(
  saved: NativeConnectorRecord,
  api: NativeApiTarget,
  transport: NativeProviderTransport,
) {
  try {
    return await nativeApiHttp(
      nativeApiVerificationRequest(api, saved.privateState.credentials),
      transport,
    );
  } catch (error) {
    if (error instanceof NativeApiError && error.code === "authorization")
      await invalidateNativeApiProof(saved, api, transport);
    throw error;
  }
}
export async function captureNativeGitlabBackup(
  id: string,
  target: NativeGitlabBackupTarget,
  options: NativeGitlabBackupOptions,
) {
  const owner = lifetime(options);
  let unsubscribe = () => {};
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    owner.close();
    unsubscribe();
    owner.signal.removeEventListener("abort", close);
  };
  try {
    owner.check();
    const saved = requireGitlab(id, target);
    const api = nativeApiTarget("gitlab", saved.configuration.parameters);
    const binding = canonicalize({
      configuration: saved.configuration,
      privateState: saved.privateState,
      runtime: saved.runtime,
    });
    const check = () => {
      owner.check();
      const latest = requireGitlab(id, target);
      if (
        latest.revision !== saved.revision ||
        canonicalize({
          configuration: latest.configuration,
          privateState: latest.privateState,
          runtime: latest.runtime,
        }) !== binding
      )
        stale();
    };
    const current = async () => {
      check();
      await assertNativeConnectorRevision(id, nativeOAuthGuard(saved));
      check();
    };
    unsubscribe = subscribeDeviceRows(() => {
      try {
        check();
      } catch {
        close();
      }
    });
    owner.signal.addEventListener("abort", close, { once: true });
    await current();
    if ((await nativeApiFingerprint(api)) !== saved.configuration.fingerprint)
      stale();
    const response = await accountProbe(saved, api, owner.transport);
    if (!api.profile.verify) stale();
    const result = verifyNativeApiResponse(
      "GitLab",
      api.profile.verify,
      response,
      saved.privateState.credentials,
    );
    if (result.label !== saved.runtime.identity?.label) stale();
    await verifyNativeGitlabBackupTarget(
      api,
      saved.privateState.credentials,
      owner.transport,
    );
    await current();
    return {
      ...owner,
      saved,
      check,
      current,
      close,
      invalidate: () => invalidateNativeApiProof(saved, api, owner.transport),
    };
  } catch (error) {
    close();
    throw error;
  }
}
