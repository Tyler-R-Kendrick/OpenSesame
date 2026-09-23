/**
 * Exact-scope local removal and device retirement (BACKUP).
 * Not forensic erasure; not replicated content tombstones; not origin wipe.
 */

import {
  type InventoryEntry,
  type StorageInventory,
  assertOwnedPath,
} from "./inventory.js";

export type RemovalResourceKind =
  | "compartment_tomb"
  | "wrapper_record"
  | "cache"
  | "attachment"
  | "index"
  | "grant_handle"
  | "session_cache";

export type RemovalManifest = Readonly<{
  version: 1;
  incidentId: string;
  vaultRef: string;
  deviceBindingRef: string;
  resources: readonly {
    ref: string;
    kind: RemovalResourceKind;
    storagePath: string;
  }[];
  preserveSealedOutbox: boolean;
  acceptUnrecoverability: boolean;
}>;

export type RemovalReceipt = Readonly<{
  removed: string[];
  failed: string[];
  retainedByPolicy: string[];
  outsideControl: string[];
  /** Explicit: not cryptographic erase / forensic wipe. */
  assurance: "application_scoped_removal";
  /** True only when caller also requested device retirement. */
  deviceRetired: boolean;
  /** Crash-resume cursor: paths still pending after partial run. */
  pendingPaths: string[];
  completion: "applied_local" | "failed" | "completion_unknown";
}>;

export type StorageBackend = {
  delete(path: string): Promise<boolean>;
  exists(path: string): Promise<boolean>;
};

export type ExecuteLocalRemovalOpts = Readonly<{
  retainOutboxPaths?: readonly string[];
  /** Designated recovery copies that must survive (BACKUP-B). */
  preserveRecoveryPaths?: readonly string[];
  /** When true, mark receipt as device retired (control-plane only). */
  retireDevice?: boolean;
  /**
   * Resume after restart: only delete paths still present in this set
   * (or all remaining manifest paths when omitted) — INV-31.
   */
  resumePendingPaths?: readonly string[];
}>;

const OUTSIDE_CONTROL = [
  "historical_offline_snapshots",
  "browser_clipboard_history",
  "os_screenshots",
  "provider_side_replicas",
] as const;

function noteRetained(retainedByPolicy: string[], ref: string): void {
  if (!retainedByPolicy.includes(ref)) {
    retainedByPolicy.push(ref);
  }
}

function shouldRetainResource(
  res: RemovalManifest["resources"][number],
  manifest: RemovalManifest,
  retainSet: Set<string>,
  retainedByPolicy: string[],
): boolean {
  if (retainSet.has(res.storagePath) || retainSet.has(res.ref)) {
    noteRetained(retainedByPolicy, res.ref);
    return true;
  }
  if (manifest.preserveSealedOutbox && res.kind === "grant_handle") {
    noteRetained(retainedByPolicy, res.ref);
    return true;
  }
  return false;
}

async function deleteRemovalResource(
  res: RemovalManifest["resources"][number],
  vaultRef: string,
  storage: StorageBackend,
): Promise<"removed" | "failed"> {
  try {
    assertOwnedPath(res.storagePath, vaultRef);
    return (await storage.delete(res.storagePath)) ? "removed" : "failed";
  } catch {
    return "failed";
  }
}

function removalCompletion(
  removed: string[],
  failed: string[],
): RemovalReceipt["completion"] {
  if (failed.length === 0) return "applied_local";
  if (removed.length === 0) return "failed";
  return "completion_unknown";
}

/**
 * Execute exact-scope local removal. Never invents paths; never origin-wipes;
 * never emits replicated content tombstones.
 */
export async function executeLocalRemoval(
  manifest: RemovalManifest,
  storage: StorageBackend,
  opts: ExecuteLocalRemovalOpts = {},
): Promise<RemovalReceipt> {
  const removed: string[] = [];
  const failed: string[] = [];
  const retainedByPolicy: string[] = [
    ...(opts.retainOutboxPaths ?? []),
    ...(opts.preserveRecoveryPaths ?? []),
  ];
  const outsideControl: string[] = [...OUTSIDE_CONTROL];
  const retainSet = new Set(retainedByPolicy);
  const resume =
    opts.resumePendingPaths !== undefined
      ? new Set(opts.resumePendingPaths)
      : null;
  const pendingPaths: string[] = [];

  for (const res of manifest.resources) {
    if (resume && !resume.has(res.storagePath)) continue;
    if (shouldRetainResource(res, manifest, retainSet, retainedByPolicy))
      continue;
    const outcome = await deleteRemovalResource(
      res,
      manifest.vaultRef,
      storage,
    );
    if (outcome === "removed") {
      removed.push(res.ref);
      continue;
    }
    failed.push(res.ref);
    pendingPaths.push(res.storagePath);
  }

  return {
    removed,
    failed,
    retainedByPolicy,
    outsideControl,
    assurance: "application_scoped_removal",
    deviceRetired: opts.retireDevice === true,
    pendingPaths,
    completion: removalCompletion(removed, failed),
  };
}

/**
 * Crash-resumable cleanup: re-run against remaining pending paths only.
 */
export async function resumeLocalRemoval(
  manifest: RemovalManifest,
  storage: StorageBackend,
  prior: RemovalReceipt,
  opts: Omit<ExecuteLocalRemovalOpts, "resumePendingPaths"> = {},
): Promise<RemovalReceipt> {
  const pending =
    prior.pendingPaths.length > 0
      ? prior.pendingPaths
      : (
          await Promise.all(
            manifest.resources.map(async (r) =>
              (await storage.exists(r.storagePath)) ? r.storagePath : null,
            ),
          )
        ).filter((p): p is string => p !== null);

  const next = await executeLocalRemoval(manifest, storage, {
    ...opts,
    resumePendingPaths: pending,
    retireDevice: opts.retireDevice ?? prior.deviceRetired,
  });

  return {
    ...next,
    removed: [...new Set([...prior.removed, ...next.removed])],
    retainedByPolicy: [
      ...new Set([...prior.retainedByPolicy, ...next.retainedByPolicy]),
    ],
    outsideControl: [
      ...new Set([...prior.outsideControl, ...next.outsideControl]),
    ],
  };
}

export type DeviceRetirementEvent = Readonly<{
  kind: "device_retirement";
  deviceBindingRef: string;
  vaultRef: string;
  incidentId: string;
  /** Must never serialize as replicated item tombstone. */
  replicationClass: "local_only_control_plane";
  /** Explicit non-claims for peers and backups (BACKUP-B). */
  doesNotMean: readonly [
    "content_deleted_everywhere",
    "replicated_item_tombstone",
    "forensic_disk_wipe",
    "origin_storage_wipe",
  ];
}>;

export function createDeviceRetirementEvent(
  input: Omit<
    DeviceRetirementEvent,
    "kind" | "replicationClass" | "doesNotMean"
  >,
): DeviceRetirementEvent {
  return {
    ...input,
    kind: "device_retirement",
    replicationClass: "local_only_control_plane",
    doesNotMean: [
      "content_deleted_everywhere",
      "replicated_item_tombstone",
      "forensic_disk_wipe",
      "origin_storage_wipe",
    ],
  };
}

/** Peers must not treat retirement as backup purge. */
export function retirementImpliesContentPurge(
  event: DeviceRetirementEvent,
): boolean {
  void event;
  return false;
}

export type UnsupportedDestructiveAction =
  | "device_brick"
  | "origin_wipe"
  | "remote_purge_all"
  | "shell_exec"
  | "whole_disk_wipe"
  | "forensic_erase";

export function isUnsupportedDestructiveAction(
  action: string,
): action is UnsupportedDestructiveAction {
  return (
    action === "device_brick" ||
    action === "origin_wipe" ||
    action === "remote_purge_all" ||
    action === "shell_exec" ||
    action === "whole_disk_wipe" ||
    action === "forensic_erase"
  );
}

export type UnsupportedDestructiveRefusal = Readonly<{
  ok: false;
  code: "unsupported_action";
  action: string;
}>;

export function refuseUnsupportedDestructiveAction(
  action: string,
): UnsupportedDestructiveRefusal {
  if (!isUnsupportedDestructiveAction(action)) {
    throw new Error(`not_an_unsupported_destructive_action:${action}`);
  }
  return {
    ok: false,
    code: "unsupported_action",
    action,
  } satisfies UnsupportedDestructiveRefusal;
}

/**
 * Filter inventory leftovers still in-scope after a partial receipt.
 */
export function leftoverInScope(
  inventory: readonly InventoryEntry[],
  manifest: RemovalManifest,
  receipt: RemovalReceipt,
): InventoryEntry[] {
  const target = new Set(manifest.resources.map((r) => r.storagePath));
  const removedRefs = new Set(receipt.removed);
  const retained = new Set(receipt.retainedByPolicy);
  return inventory.filter(
    (e) =>
      target.has(e.storagePath) &&
      !removedRefs.has(e.ref) &&
      !retained.has(e.ref) &&
      !retained.has(e.storagePath),
  );
}

export { assertOwnedPath } from "./inventory.js";
