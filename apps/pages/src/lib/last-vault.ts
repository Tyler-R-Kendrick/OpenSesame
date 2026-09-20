/**
 * Last vault this device authorized — plaintext boot pointer for the unlock
 * screen. Guest is not a project id, so it cannot live in `projects.v1`; this
 * key remembers guest beside personal/project so a reload or lock opens the
 * same account's unlock ceremony (ADR 0089 / AGENTS.md §5).
 */

import { isString } from "@opensesame/os-domain";
import { kvGet, kvSet } from "./kv.js";
import { GUEST_TOMB } from "./vfs.js";

export const LAST_VAULT_KEY = "opensesame.last-vault.v1";

export function readLastVaultId(): string | null {
  const raw = kvGet(LAST_VAULT_KEY);
  if (!isString(raw) || raw.trim() === "") return null;
  return raw.trim();
}

export function writeLastVaultId(id: string): void {
  const trimmed = id.trim();
  if (trimmed === "") return;
  kvSet(LAST_VAULT_KEY, trimmed);
}

export function lastVaultIsGuest(): boolean {
  return readLastVaultId() === GUEST_TOMB;
}
