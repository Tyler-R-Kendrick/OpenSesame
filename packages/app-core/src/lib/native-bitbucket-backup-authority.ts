/** One verified sealed Bitbucket key, exact saved destination and original native route. */
import { canonicalize } from "@opensesame/os-domain";
import { z } from "zod";
import { subscribeDeviceRows } from "./device-connector-records.js";
import { nativeApiVerificationRequest } from "./native-api-auth.js";
import { nativeApiHeaders } from "./native-api-auth.js";
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
import { nativeOAuthGuard } from "./native-oauth-session.js";
import {
  type VaultSessionPort,
  localVaultSessionGuard,
} from "./secret-backends/local-vault-port.js";
import { SecretBackendError } from "./secret-backends/types.js";
import { zodJitless } from "./zod-jitless.js";
export type NativeBitbucketBackupTarget = Readonly<{
  owner: string;
  repo: string;
  branch: string;
}>;
export function nativeBitbucketTargetPath(target: NativeBitbucketBackupTarget) {
  if (
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(target.owner) ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(target.repo) ||
    target.branch === "@" ||
    target.branch.startsWith("-") ||
    !target.branch ||
    target.branch.length > 255 ||
    /[\s~^:?*\[\\]/.test(target.branch) ||
    Array.from(target.branch).some(
      (char) => char.charCodeAt(0) < 33 || char.charCodeAt(0) === 127,
    ) ||
    target.branch.includes("..") ||
    target.branch.includes("@{") ||
    target.branch
      .split("/")
      .some(
        (part) =>
          !part ||
          part.startsWith(".") ||
          part.endsWith(".") ||
          part.endsWith(".lock"),
      )
  )
    throw new SecretBackendError(
      "configuration",
      "Use a repository owner, name and existing branch for the Bitbucket backup.",
    );
  return `/2.0/repositories/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
}
export function nativeBitbucketBackupTarget(
  parameters: Readonly<Record<string, string>>,
): NativeBitbucketBackupTarget | null {
  if (
    Object.keys(parameters).some(
      (key) => !["backup_owner", "backup_repo", "backup_branch"].includes(key),
    )
  )
    throw new SecretBackendError(
      "configuration",
      "Unknown Bitbucket backup parameter.",
    );
  const target = {
    owner: (parameters.backup_owner ?? "").trim(),
    repo: (parameters.backup_repo ?? "").trim(),
    branch: (parameters.backup_branch ?? "").trim(),
  };
  if (!target.owner && !target.repo && !target.branch) return null;
  nativeBitbucketTargetPath(target);
  return Object.freeze(target);
}

zodJitless();
const repository = z.object({
  full_name: z.string(),
  uuid: z.string().min(1),
  scm: z.literal("git"),
});
const branch = z.object({
  name: z.string(),
  target: z.object({ hash: z.string().regex(/^[a-f0-9]{40}$/) }),
});
export async function verifyNativeBitbucketBackupTarget(
  target: NativeApiTarget,
  credentials: Record<string, string>,
  transport: NativeProviderTransport,
) {
  if (target.providerId !== "bitbucket") return;
  const selected = nativeBitbucketBackupTarget(target.parameters);
  if (!selected) return;
  const base = nativeBitbucketTargetPath(selected);
  const headers = nativeApiHeaders(target, credentials);
  const request = (path: string) =>
    nativeApiHttp(
      {
        url: `https://api.bitbucket.org${path}`,
        method: "GET",
        headers,
        signal: transport.signal,
      },
      transport,
    );
  const repo = repository.safeParse(await request(base));
  const head = branch.safeParse(
    await request(
      `${base}/refs/branches/${encodeURIComponent(selected.branch)}`,
    ),
  );
  if (
    !repo.success ||
    repo.data.full_name !== `${selected.owner}/${selected.repo}` ||
    !head.success ||
    head.data.name !== selected.branch
  )
    throw new SecretBackendError(
      "response",
      "Bitbucket did not prove the selected repository and branch.",
    );
}

export type NativeBitbucketBackupOptions = {
  vault: VaultSessionPort;
  transport?: NativeProviderTransport;
  signal?: AbortSignal;
  assertCurrent?: () => void;
};
function stale(): never {
  throw new SecretBackendError(
    "stale",
    "The saved Bitbucket backup authority changed.",
  );
}
function requireBitbucket(id: string, target: NativeBitbucketBackupTarget) {
  const saved = loadNativeConnectorRecord(id);
  if (
    !saved ||
    saved.configuration.providerId !== "bitbucket" ||
    saved.configuration.method !== "api-key" ||
    canonicalize(
      nativeBitbucketBackupTarget(saved.configuration.parameters),
    ) !== canonicalize(target)
  )
    stale();
  assertNativeApiEditable(saved);
  assertNativeApiAuthority(saved);
  return saved;
}
function lifetime(options: NativeBitbucketBackupOptions) {
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
export async function captureNativeBitbucketBackup(
  id: string,
  target: NativeBitbucketBackupTarget,
  options: NativeBitbucketBackupOptions,
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
    const saved = requireBitbucket(id, target);
    const api = nativeApiTarget("bitbucket", saved.configuration.parameters);
    const binding = canonicalize({
      configuration: saved.configuration,
      privateState: saved.privateState,
      runtime: saved.runtime,
    });
    const check = () => {
      owner.check();
      const latest = requireBitbucket(id, target);
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
      "Bitbucket",
      api.profile.verify,
      response,
      saved.privateState.credentials,
    );
    if (result.label !== saved.runtime.identity?.label) stale();
    await verifyNativeBitbucketBackupTarget(
      api,
      saved.privateState.credentials,
      owner.transport,
    );
    await current();
    return {
      ...owner,
      saved,
      headers: nativeApiHeaders(api, saved.privateState.credentials),
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
