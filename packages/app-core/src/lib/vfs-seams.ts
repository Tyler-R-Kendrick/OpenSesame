import type { BoundaryValue } from "@opensesame/os-domain";
import { type SealedBlob, openJson, sealJson } from "@opensesame/vault-core";
import { kvDeleteDurable, kvGet, kvSetDurable } from "./kv.js";

/**
 * Where the VFS keeps its bytes and how it seals them (ADR 0063). A host swaps
 * these to put the vault somewhere else — the CLI's directory of real files,
 * a privately hosted store (`secret-fs/vfs-files.ts`, ADR 0182) — and a test
 * swaps them to put a fault where the disk would be.
 */
export type VfsSeams = {
  /** Sync read of hydrated kv memory (OPFS is pulled in by `kvHydrate`). */
  readRaw: (key: string) => string | null;
  /**
   * `vaultKey` is the tomb's key when the caller holds it. A store that keeps
   * each secret as its own file needs it to take the sealed body apart.
   */
  writeRaw: (key: string, value: string, vaultKey?: CryptoKey) => Promise<void>;
  deleteRaw: (key: string) => Promise<void>;
  /** A file-per-secret store assembles the body here, before it is first read. */
  openBody?: (tomb: string, vaultKey: CryptoKey) => Promise<void>;
  seal: (
    vaultKey: CryptoKey,
    value: BoundaryValue,
    binding?: string,
  ) => Promise<SealedBlob>;
  open: <T>(
    vaultKey: CryptoKey,
    blob: SealedBlob,
    binding?: string,
  ) => Promise<T>;
};

export const vfsSeams: VfsSeams = {
  readRaw: (key) => kvGet(key),
  writeRaw: (key, value) => kvSetDurable(key, value),
  deleteRaw: (key) => kvDeleteDurable(key),
  seal: (vaultKey, value, binding) =>
    binding ? sealJson(vaultKey, value, binding) : sealJson(vaultKey, value),
  open: (vaultKey, blob, binding) =>
    binding ? openJson(vaultKey, blob, binding) : openJson(vaultKey, blob),
};
