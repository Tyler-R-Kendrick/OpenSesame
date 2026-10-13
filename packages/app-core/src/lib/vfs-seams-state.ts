/** Installed ciphertext operations only; no owner issuer or realm dependency. */
import type { BoundaryValue } from "@opensesame/os-domain";
import type { SealedBlob } from "@opensesame/vault-core";

/**
 * Where the VFS keeps its bytes and how it seals them (ADR 0063). A host swaps
 * these to put the vault somewhere else — the CLI's directory of real files,
 * a privately hosted store (`secret-fs/vfs-files.ts`, ADR 0182) — and a test
 * swaps them to put a fault where the disk would be.
 */
export type VfsSeams = {
  /** Transport DATA only: installed file storage requires an actual BODY grant. */
  authenticationStorage?: "file-backed";
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
  /** Bounded physical refresh; absence refuses fresh authentication snapshots. */
  refreshRaw?: (
    key: string,
    maxBytes: number,
    check?: () => void,
  ) => Promise<void>;
  /** Physical scalar compare/readback under original caller locks; no memory fallback. */
  comparePublishRaw?: (
    key: string,
    expected: string | null,
    next: string,
    maxBytes: number,
    original: () => void,
  ) => Promise<void>;
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

/**
 * No callable transport exists until the ordinary VFS initializes this object.
 * Leaf-only authentication must refuse missing captured operations explicitly.
 */
export const vfsSeams: Partial<VfsSeams> = {};
