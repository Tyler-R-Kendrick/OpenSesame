/** Original GitHub backup ownership and per-destination FIFO; no credentials are adopted after waiting. */
import { canonicalize } from "@opensesame/os-domain";
import {
  type LocalBackupTarget,
  readLocalBackupTarget,
  subscribeLocalBackupTarget,
} from "./backup-target-local.js";
import type { GithubDirectTransport } from "./github-app-direct.js";
import {
  pemFromVault,
  readLocalGithubApp,
  subscribeLocalGithubApp,
} from "./github-app-local.js";
import { captureGithubAuthority } from "./github-app-vault-transport.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { vaultStore } from "./vault/store.js";

export type GithubRestoreOwner = {
  signal: AbortSignal;
  assertCurrent: () => void;
};
/** Runtime receipts may change when an earlier queued producer publishes its own result. */
export function backupTargetReceipt(target: LocalBackupTarget | null): string {
  if (!target) return "null";
  const {
    kind,
    providerId,
    connectionId,
    integrationId,
    installationId,
    owner,
    repo,
    branch,
    enabled,
    config,
  } = target;
  return canonicalize({
    kind,
    providerId,
    connectionId,
    integrationId,
    installationId,
    owner,
    repo,
    branch,
    enabled,
    config,
  });
}
export type SavedGithubBackupRequest = {
  appId: string;
  pem: string;
  installationId: string;
  owner: string;
  repo: string;
  branch: string;
  providerId?: string;
};
function stale(): never {
  throw new Error("The GitHub backup owner or target changed.");
}
function boundTarget(saved: SavedGithubBackupRequest) {
  const providerId = saved.providerId ?? "github";
  const target = readLocalBackupTarget(providerId);
  if (
    !target?.enabled ||
    target.kind !== "github_app" ||
    target.installationId !== saved.installationId ||
    target.owner !== saved.owner ||
    target.repo !== saved.repo ||
    target.branch !== saved.branch ||
    !/^[1-9]\d*$/.test(saved.installationId) ||
    !Number.isSafeInteger(Number(saved.installationId))
  )
    stale();
  return {
    providerId,
    receipt: backupTargetReceipt(target),
    pendingEvents: target.pendingEvents,
  };
}
function originalGithubTransport(
  operation: ReturnType<typeof captureGithubAuthority>,
  lifetime: AbortController,
  native?: NativeProviderTransport,
  caller?: GithubRestoreOwner,
): GithubDirectTransport {
  const fetch = native?.fetch ?? globalThis.fetch;
  const assertNative = native?.assertCurrent;
  const nativeSignal = native?.signal;
  const signal = AbortSignal.any([
    operation.transport.signal,
    lifetime.signal,
    ...(caller ? [caller.signal] : []),
    ...(nativeSignal ? [nativeSignal] : []),
  ]);
  const check = () => {
    signal.throwIfAborted();
    caller?.assertCurrent();
    operation.transport.assertCurrent();
    if (native) {
      if (
        !nativeSignal ||
        native.fetch !== fetch ||
        native.assertCurrent !== assertNative ||
        native.signal !== nativeSignal
      )
        stale();
      assertNative?.call(native);
      operation.transport.assertCurrent();
    }
    caller?.assertCurrent();
  };
  const transport: GithubDirectTransport = {
    signal,
    assertCurrent: check,
    fetch: (input, init) => {
      check();
      return fetch.call(native ?? globalThis, input, init);
    },
  };
  return transport;
}
export function captureSavedGithubBackup(
  input: SavedGithubBackupRequest,
  native?: NativeProviderTransport,
  caller?: GithubRestoreOwner,
) {
  const saved = { ...input };
  const { providerId, receipt, pendingEvents } = boundTarget(saved);
  const appReceipt = canonicalize(readLocalGithubApp());
  const lifetime = new AbortController();
  const stops: (() => void)[] = [];
  const operation = captureGithubAuthority({
    binding: () => {
      const app = readLocalGithubApp();
      return (
        backupTargetReceipt(readLocalBackupTarget(providerId)) === receipt &&
        canonicalize(app) === appReceipt &&
        app?.id === saved.appId &&
        pemFromVault(app) === saved.pem
      );
    },
  });
  try {
    const transport = originalGithubTransport(
      operation,
      lifetime,
      native,
      caller,
    );
    const check = transport.assertCurrent;
    const invalidate = () => {
      try {
        check();
      } catch {
        lifetime.abort();
      }
    };
    stops.push(
      subscribeLocalBackupTarget(invalidate),
      subscribeLocalGithubApp(invalidate),
      vaultStore.subscribe(invalidate),
    );
    check();
    return {
      pendingEvents,
      pendingOwner: canonicalize({ providerId, receipt }),
      transport,
      target: {
        owner: saved.owner,
        repo: saved.repo,
        branch: saved.branch,
        installationId: Number(saved.installationId),
      },
      credentials: { appId: saved.appId, privateKey: saved.pem },
      close: () => {
        lifetime.abort();
        for (const stop of stops) stop();
        operation.close();
      },
    };
  } catch (error) {
    lifetime.abort();
    for (const stop of stops) stop();
    operation.close();
    throw error;
  }
}
export function savedGithubBackupRequest(
  providerId: string,
): SavedGithubBackupRequest {
  const target = readLocalBackupTarget(providerId);
  const app = readLocalGithubApp();
  const pem = app ? pemFromVault(app) : null;
  if (!target || !app?.id || !pem) stale();
  return {
    providerId,
    appId: app.id,
    pem,
    installationId: target.installationId,
    owner: target.owner,
    repo: target.repo,
    branch: target.branch,
  };
}

type CapturedGithubBackup = ReturnType<typeof captureSavedGithubBackup>;
type WriteQueue = {
  tail: Promise<void>;
  pending: number;
  acknowledged: Map<string, number>;
};
const writes = new Map<string, WriteQueue>();
function predecessorReady(
  previous: Promise<void>,
  operation: CapturedGithubBackup,
) {
  const { signal } = operation.transport;
  let ended = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    ended = () =>
      reject(signal.reason ?? new Error("The original backup owner ended."));
    signal.addEventListener("abort", ended, { once: true });
    if (signal.aborted) ended();
  });
  return Promise.race([previous, cancelled])
    .then(() => operation.transport.assertCurrent())
    .finally(() => signal.removeEventListener("abort", ended));
}
/** A reservation is retained through the caller's confirmed metadata publication and finally-close. */
export function reserveGithubBackupWrite(operation: CapturedGithubBackup) {
  operation.transport.assertCurrent();
  const key = canonicalize([
    operation.target.owner.toLowerCase(),
    operation.target.repo.toLowerCase(),
    operation.target.branch,
  ]);
  const queue = writes.get(key) ?? {
    tail: Promise.resolve(),
    pending: 0,
    acknowledged: new Map<string, number>(),
  };
  if (queue.pending >= 32)
    throw new Error("Too many pending GitHub backup requests.");
  const acknowledged = () =>
    queue.acknowledged.get(operation.pendingOwner) ?? 0;
  const workThrough = acknowledged() + operation.pendingEvents;
  const previous = queue.tail;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => held);
  queue.tail = tail;
  queue.pending += 1;
  writes.set(key, queue);
  void tail.then(() => {
    queue.pending -= 1;
    if (queue.pending === 0 && writes.get(key) === queue) writes.delete(key);
  });
  return {
    wait: predecessorReady(previous, operation),
    release,
    pendingAfter: (pending: number) => {
      operation.transport.assertCurrent();
      return Math.max(0, pending - Math.max(0, workThrough - acknowledged()));
    },
    publish: (commit: () => void) => {
      operation.transport.assertCurrent();
      const previousAcknowledged = acknowledged();
      queue.acknowledged.set(
        operation.pendingOwner,
        Math.max(previousAcknowledged, workThrough),
      );
      try {
        commit();
      } catch (error) {
        queue.acknowledged.set(operation.pendingOwner, previousAcknowledged);
        throw error;
      }
    },
  };
}
