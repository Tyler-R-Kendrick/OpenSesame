/** Unlocked vault session root for CLI pairing / humanProof (no pairing wire imports). */

export async function readCliAppPairingVaultSessionRoot(): Promise<
  string | null
> {
  const { vaultStore } = await import("../vault/store.js");
  if (!vaultStore.isUnlocked()) return null;
  return vaultStore.readSessionRootDigest();
}
