/**
 * The plaintext keys the core boot hydrates before first paint. Everything
 * an optional module needs — a connector directory endpoint, a model
 * provider record, a first-run marker — hydrates from that module's own
 * `activate` through `ctx.hydrate`, never here (ownership.md §4.3).
 */

import { CAPABILITY_BOOT_KEYS } from "@opensesame/app-core/lib/capabilities/keys.js";
import { LAST_VAULT_KEY } from "@opensesame/app-core/lib/last-vault.js";
import {
  GUEST_ORDINAL_KEY,
  GUEST_PERSON_KEY,
} from "@opensesame/app-core/lib/local-guest.js";
import { PROJECTS_KEY } from "@opensesame/app-core/lib/projects.js";
import { TOMBS_REGISTRY_KEY } from "@opensesame/app-core/lib/vfs.js";
import { THEME_KEY } from "../lib/theme.js";

export const CORE_BOOT_KEYS: readonly string[] = [
  // The boot record and tomb registry first: which tomb is active decides
  // which vault header and consent keys exist.
  PROJECTS_KEY,
  TOMBS_REGISTRY_KEY,
  "settings.v1",
  "setup.v1",
  "outbox.v1",
  // Day/night must survive a locked reload — not a vault secret.
  THEME_KEY,
  // Last authorized vault (guest included). Missing this on a cold load
  // makes unlock default to personal.
  LAST_VAULT_KEY,
  // Guest slug ordinal + durable principal — same cold-load case.
  GUEST_ORDINAL_KEY,
  GUEST_PERSON_KEY,
  // Installation id, selection, receipt, policies, generation counter.
  ...CAPABILITY_BOOT_KEYS,
];
