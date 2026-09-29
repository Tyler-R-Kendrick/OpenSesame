import { isGuestSessionTomb } from "@opensesame/app-core/lib/duress/store/decoy-scratch.js";
import { useVault } from "../lib/vault/hooks.js";
import { AddKeyProtection } from "../sections/settings/VaultKeyProtectionCeremonies.js";

/**
 * The key vault glyph's ceremony: adding a key that protects this vault — the
 * same choices as Settings › Security › Vault key protection, because that is
 * the one place a protector is enrolled. It once offered to bind a connector as
 * a setup preference, which changed nothing about how the vault is protected
 * and sent a cloud choice to a Host for an authorization nothing used.
 *
 * A guest, whose protectors are not changed here, and a locked vault have no
 * key to add, so the ceremony draws nothing beside the glyph's state.
 */
export function KeyVaultCeremony({ onClose }: { onClose: () => void }) {
  const { status, guest, tomb } = useVault();
  if (status !== "unlocked" || guest || isGuestSessionTomb(tomb ?? null)) {
    return null;
  }
  return <AddKeyProtection onDone={onClose} />;
}
