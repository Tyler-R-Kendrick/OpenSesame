/**
 * `src/lib/encrypted-db/**`: searchable encryption over IndexedDB (ADR 0175).
 * `src/lib/secret-fs/**`: the vault as real files (ADR 0182).
 */

import { core, each, optional } from "./classification-rule.js";

const L = "src/lib/";
const SHELL = "shell.navigation";
const GIT = "backup.git-remote";

export const STORAGE_LIB_RULES = [
  // Core, and in no Pages entry: a host installs it (the CLI today) and the
  // build's graph never reaches it until the hosted-store wiring lands.
  core(
    `${L}secret-fs/`,
    null,
    "the vault kept as files: the SecretFiles contract, its backends and the VFS adapter (ADR 0182); installed by a host, never by the Pages bootstrap",
  ),
  // The history store's records and its device-sealed implementation, split
  // from `history-backup-idb` behind the store seam.
  ...each(L, ["history-backup-legacy", "history-backup-types"], (p) =>
    optional(p, GIT, "history backup store: the seam and its sealed database"),
  ),
  optional(
    `${L}encrypted-db/`,
    "storage.encrypted-search",
    "searchable encryption over IndexedDB: onion layers, blind indexes, the encrypted history and password stores (ADR 0175)",
  ),
  core(
    `${L}encrypted-db/names`,
    SHELL,
    "the hashed database names Reset this browser deletes by; the core reset reads them whether or not the capability is on (ADR 0175)",
  ),
] as const;
