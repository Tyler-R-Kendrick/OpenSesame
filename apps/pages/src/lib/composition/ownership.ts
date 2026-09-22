/**
 * Ownership map: every composition catalog id → owning team/file.
 *
 * One list, one owner per id. unownedIds() fails the suite when a catalog
 * id has no owner, so a capability cannot enter composition without
 * somebody responsible for it.
 */
import { buildCompositionCatalog } from "./catalog.js";

export const OWNERSHIP: Readonly<Record<string, string>> = {
  "vault.items.search": "vault-team:apps/pages/src/sections/VaultSection.tsx",
  "vault.items.read_meta":
    "vault-team:apps/pages/src/sections/VaultSection.tsx",
  "vault.items.reveal":
    "vault-team:apps/pages/src/sections/vault/ItemDetail.tsx",
  "vault.totp.code": "vault-team:apps/pages/src/sections/vault/ItemDetail.tsx",
  "delegations.offers.mint":
    "sharing-team:apps/pages/src/sections/AccessSection.tsx",
  "delegations.claim": "sharing-team:apps/pages/src/sections/AccessSection.tsx",
  "security.findings.read":
    "security-team:apps/pages/src/sections/vault/HealthPanel.tsx",
  "sync.push": "sync-team:apps/pages/src/lib/vault/store.ts",
  "sync.pull": "sync-team:apps/pages/src/lib/vault/store.ts",
  "configs.audit": "security-team:apps/pages/src/sections/SettingsSection.tsx",
};

/** The owner behind an id, or undefined when unowned. */
export function ownerOf(id: string): string | undefined {
  return OWNERSHIP[id];
}

/** Catalog ids with no owner — must always be empty. */
export function unownedIds(): readonly string[] {
  const catalog = buildCompositionCatalog();
  const ids = new Set<string>();
  for (const list of Object.values(catalog)) {
    for (const id of list) ids.add(id);
  }
  return [...ids].filter((id) => ownerOf(id) === undefined).sort();
}
