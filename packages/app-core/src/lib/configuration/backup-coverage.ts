import { PREFS_SEMANTIC_PATH, PREFS_SOURCE_PATH } from "./prefs-keys.js";

export type CoverageKind =
  | "included"
  | "sidecar_optional"
  | "not_in_vault_export"
  | "not_restorable";

export type CoverageEntry = {
  path: string;
  kind: CoverageKind;
  note: string;
};

/** What each supported backup actually carries. Not a claim of completeness. */
export const BACKUP_COVERAGE: readonly CoverageEntry[] = [
  {
    path: "tomb/<id>/header",
    kind: "included",
    note: "Public wrap parameters in sealed export and offline backup.",
  },
  {
    path: "tomb/<id>/body",
    kind: "included",
    note: "Sealed items, folders, and installed item-type JSON.",
  },
  {
    path: PREFS_SEMANTIC_PATH,
    kind: "sidecar_optional",
    note: "Vault prefs JSON lives in sealed VFS, not the vault body export.",
  },
  {
    path: PREFS_SOURCE_PATH,
    kind: "sidecar_optional",
    note: "Authored YAML comments are a VFS sidecar, omitted from exportSealed.",
  },
  {
    path: "config/identity-applications",
    kind: "sidecar_optional",
    note: "Local application registrations are a separate VFS document.",
  },
  {
    path: "settings/keybindings.yaml",
    kind: "not_in_vault_export",
    note: "Keybinding maps are presentation data, not vault ciphertext.",
  },
  {
    path: "sessions/grants",
    kind: "not_restorable",
    note: "Restoring bytes must not resurrect revoked hosted grants.",
  },
];

export type BackupInventory = {
  format: string;
  included: string[];
  omitted: string[];
  complete: boolean;
};

export type BackupInventoryInput = {
  format: string;
  paths: readonly string[];
};

export function inventoryBackup(input: BackupInventoryInput): BackupInventory {
  const known = BACKUP_COVERAGE.filter(
    (entry) => entry.kind === "included",
  ).map((entry) => entry.path);
  const included = known.filter((path) => input.paths.includes(path));
  const omittedRequired = known.filter((path) => !input.paths.includes(path));
  const omitted = [
    ...omittedRequired,
    ...BACKUP_COVERAGE.filter((entry) => entry.kind !== "included").map(
      (entry) => entry.path,
    ),
  ];
  return {
    format: input.format,
    included,
    omitted,
    complete: omittedRequired.length === 0,
  };
}

export function sealedExportCoverage(): BackupInventory {
  return inventoryBackup({
    format: "opensesame-vault-export",
    paths: ["tomb/<id>/header", "tomb/<id>/body"],
  });
}

export function offlineBackupCoverage(): BackupInventory {
  return inventoryBackup({
    format: "opensesame-offline-backup",
    paths: ["tomb/<id>/header", "tomb/<id>/body"],
  });
}
