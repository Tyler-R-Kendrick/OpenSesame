import type { KdfParams, SealedBlob } from "./crypto.js";

/**
 * What a merge needs beyond the item model (ADR 0144): when something was
 * removed, and when an item type was installed, so the newer of two devices'
 * choices wins on both.
 */

/** Id → ISO time of the purge, delete or uninstall. Ids only: a tombstone names nothing. */
export type VaultTombstones = {
  items?: Readonly<Record<string, string>>;
  folders?: Readonly<Record<string, string>>;
  /** Uninstalled item types, so a device that still has one cannot sync it back. */
  itemTypes?: Readonly<Record<string, string>>;
};

/** Item type id → ISO time it was last installed; an install after an uninstall wins. */
export type ItemTypeInstallTimes = Readonly<Record<string, string>>;

/** Item field key → ISO time it last changed (`stamps.ts`, `item-merge.ts`). */
export type FieldTimes = Readonly<Record<string, string>>;

/** Field times while a stamp or a merge builds them. */
export type FieldTimesDraft = Record<string, string>;

/**
 * The vault's master-password wrap as last set on any device, and when (ADR
 * 0144). Sealed in the body, so only a device holding the vault key can write
 * it; a device that merges a newer one takes it into its own header, which is
 * how a password changed on one device opens the vault on the others. No
 * `kdf`/`wrap` means the password was removed.
 */
export type MasterWrap = {
  at: string;
  kdf?: KdfParams | undefined;
  wrap?: SealedBlob | undefined;
};
