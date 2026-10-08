import type { SealedBlob } from "@opensesame/vault-core";
/** Optional operation limits supplement mandatory tomb/root admission. */
export type WriteOperation = { check(): void; accept(): void };
/** Acceptance is synchronous immediately before the raw write dispatch. */
export type SealedWrite = (
  tomb: string,
  path: string,
  blob: SealedBlob,
  operation?: WriteOperation,
) => Promise<void>;
