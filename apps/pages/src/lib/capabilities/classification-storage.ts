/**
 * `src/lib/encrypted-db/**`: searchable encryption over IndexedDB (ADR 0173).
 */

import { core, optional } from "./classification-rule.js";

const L = "src/lib/";
const SHELL = "shell.navigation";

export const STORAGE_LIB_RULES = [
  optional(
    `${L}encrypted-db/`,
    "storage.encrypted-search",
    "searchable encryption over IndexedDB: onion layers, blind indexes, the encrypted history and password stores (ADR 0173)",
  ),
  core(
    `${L}encrypted-db/names`,
    SHELL,
    "the hashed database names Reset this browser deletes by; the core reset reads them whether or not the capability is on (ADR 0173)",
  ),
] as const;
