/**
 * `src/lib/encrypted-db/**`: searchable encryption over IndexedDB (ADR 0175).
 */

import { core, each, optional, shared } from "./classification-rule.js";

const L = "src/lib/";
const SHELL = "shell.navigation";
const GIT = "backup.git-remote";

export const STORAGE_LIB_RULES = [
  shared(
    `${L}legacy-transfer`,
    "sealed legacy-writer handoff shared by core password history and optional encrypted migration",
  ),
  optional(
    `${L}history-backup-lazy.test.ts`,
    GIT,
    "test-only proof of operation-scoped history routing and reset across lazy backend loading",
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
