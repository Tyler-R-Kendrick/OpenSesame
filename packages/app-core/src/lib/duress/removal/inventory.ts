/**
 * Exact-scope storage inventory for local removal manifests (BACKUP-A).
 * Inventory is the only source of truth for what may be deleted.
 */

export type InventoryEntryKind =
  | "compartment_tomb"
  | "wrapper_record"
  | "cache"
  | "attachment"
  | "index"
  | "grant_handle"
  | "session_cache"
  | "sealed_outbox"
  | "recovery_copy"
  | "other";

export type InventoryEntry = Readonly<{
  ref: string;
  kind: InventoryEntryKind;
  storagePath: string;
  /** When true, removal must retain unless owner expands consent. */
  designatedRecovery: boolean;
  /** Opaque sealed alert material that may survive removal by policy. */
  sealedOutbox: boolean;
}>;

export type StorageInventory = {
  list(vaultRef: string): Promise<readonly InventoryEntry[]>;
  delete(path: string): Promise<boolean>;
  exists(path: string): Promise<boolean>;
};

const OWNED_ROOT =
  /^vaults\/[a-zA-Z0-9_-]+\/(compartments|wrappers|caches|attachments|indexes|grants|sessions)\//;

export function assertOwnedPath(path: string, vaultRef: string): void {
  // Decode once so %2E/%2e/%252e-style encodings cannot bypass ".." checks.
  let decoded = path;
  try {
    decoded = decodeURIComponent(path.replace(/\+/g, " "));
  } catch {
    throw new Error("scope_mismatch: malformed path encoding");
  }
  const lowered = path.toLowerCase();
  if (
    path.includes("..") ||
    decoded.includes("..") ||
    lowered.includes("%2e") ||
    path.includes("\\") ||
    decoded.includes("\\")
  ) {
    throw new Error("scope_mismatch: path traversal");
  }
  if (
    !path.startsWith(`vaults/${vaultRef}/`) &&
    !decoded.startsWith(`vaults/${vaultRef}/`)
  ) {
    throw new Error("scope_mismatch: outside vault root");
  }
  if (!OWNED_ROOT.test(path) && !OWNED_ROOT.test(decoded)) {
    throw new Error("scope_mismatch: unapproved storage class");
  }
}

export type RemovalManifestBuildResult = Readonly<{
  manifest: import("./local-remove.js").RemovalManifest;
  skippedOutsideInventory: string[];
  preservedRecovery: string[];
}>;

/**
 * Build a removal manifest that intersects owner-approved refs with live
 * inventory. Refs not present in inventory are omitted (never invented).
 */
export function buildRemovalManifest(input: {
  incidentId: string;
  vaultRef: string;
  deviceBindingRef: string;
  approvedResourceRefs: readonly string[];
  inventory: readonly InventoryEntry[];
  preserveSealedOutbox: boolean;
  acceptUnrecoverability: boolean;
}): RemovalManifestBuildResult {
  const approved = new Set(input.approvedResourceRefs);
  const resources: {
    ref: string;
    kind: import("./local-remove.js").RemovalResourceKind;
    storagePath: string;
  }[] = [];
  const skippedOutsideInventory: string[] = [];
  const preservedRecovery: string[] = [];
  const seen = new Set<string>();

  for (const ref of approved) {
    const hits = input.inventory.filter((e) => e.ref === ref);
    if (hits.length === 0) {
      skippedOutsideInventory.push(ref);
      continue;
    }
    for (const entry of hits) {
      assertOwnedPath(entry.storagePath, input.vaultRef);
      if (entry.designatedRecovery) {
        preservedRecovery.push(entry.ref);
        continue;
      }
      if (input.preserveSealedOutbox && entry.sealedOutbox) {
        continue;
      }
      if (seen.has(entry.storagePath)) continue;
      seen.add(entry.storagePath);
      resources.push({
        ref: entry.ref,
        kind: toRemovalKind(entry.kind),
        storagePath: entry.storagePath,
      });
    }
  }

  return {
    manifest: {
      version: 1,
      incidentId: input.incidentId,
      vaultRef: input.vaultRef,
      deviceBindingRef: input.deviceBindingRef,
      resources,
      preserveSealedOutbox: input.preserveSealedOutbox,
      acceptUnrecoverability: input.acceptUnrecoverability,
    },
    skippedOutsideInventory,
    preservedRecovery,
  } satisfies RemovalManifestBuildResult;
}

function toRemovalKind(
  kind: InventoryEntryKind,
): import("./local-remove.js").RemovalResourceKind {
  switch (kind) {
    case "compartment_tomb":
    case "wrapper_record":
    case "cache":
    case "attachment":
    case "index":
    case "grant_handle":
    case "session_cache":
      return kind;
    case "sealed_outbox":
      return "grant_handle";
    case "recovery_copy":
    case "other":
      return "cache";
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

/** In-memory inventory for tests and local rehearsal. */
export class MemoryStorageInventory implements StorageInventory {
  #entries: InventoryEntry[];

  constructor(entries: readonly InventoryEntry[] = []) {
    this.#entries = [...entries];
  }

  snapshot(): readonly InventoryEntry[] {
    return this.#entries;
  }

  async list(vaultRef: string): Promise<readonly InventoryEntry[]> {
    return this.#entries.filter((e) =>
      e.storagePath.startsWith(`vaults/${vaultRef}/`),
    );
  }

  async delete(path: string): Promise<boolean> {
    const before = this.#entries.length;
    this.#entries = this.#entries.filter((e) => e.storagePath !== path);
    return this.#entries.length < before;
  }

  async exists(path: string): Promise<boolean> {
    return this.#entries.some((e) => e.storagePath === path);
  }
}
