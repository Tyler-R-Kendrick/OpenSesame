/** Vault identity is stable across legitimate protector and root rotation. */
import type { VaultHeader } from "@opensesame/vault-core";
export function vaultIdentity(header: VaultHeader | null): string | null {
  if (!header) return null;
  return header.protection
    ? `manifest:${header.protection.vaultId}`
    : `legacy:${header.createdAt}`;
}
