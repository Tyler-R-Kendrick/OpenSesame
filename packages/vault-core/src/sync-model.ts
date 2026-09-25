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
