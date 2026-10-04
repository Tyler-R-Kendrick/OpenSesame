/**
 * Starting a write from what the disk holds (ADR 0160 §5a).
 *
 * Two tabs can have one vault open. A tab that loaded the body before the other
 * wrote it holds a stale copy, and sealing that copy back drops the other tab's
 * edit, the identity key the other tab published among them, and can seal a
 * revision the header has already moved past (which the next unlock would call
 * a rollback). Every write the store makes therefore starts here, under the
 * cross-tab body lock: the header is read again, and when another writer has
 * left a different body on disk its newer copy replaces the stale one.
 */

import type { VaultBody, VaultHeader } from "@opensesame/vault-core";
import { BODY_PATH, readSealedFile } from "../vfs.js";
import { loadVaultBody } from "./store-body.js";

/** What a write starts from: the header as stored, and a newer body if there is one. */
export type FreshBody = Readonly<{
  header: VaultHeader | null;
  /** The disk's body when it is newer than the one held; null when the held one stands. */
  body: VaultBody | null;
}>;

/**
 * The seal this tab last wrote or read, by its random IV, which names one seal
 * and no other. A body on disk that still carries it has not been written by
 * anyone else, so there is nothing to open.
 */
export function sealMark(tomb: string): string | null {
  try {
    return readSealedFile(tomb, BODY_PATH)?.ivB64 ?? null;
  } catch {
    return null;
  }
}

/**
 * Read the header and, when the body on disk is not the one this tab last
 * wrote or read, open it. The caller holds the body lock and has refreshed the
 * stored copies. Throws what `loadVaultBody` throws for a body that is missing,
 * unreadable or older than the header's witness: a write over that would
 * undo the rollback guard.
 */
export async function freshBody(
  tomb: string,
  vaultKey: CryptoKey,
  held: Readonly<{
    header: VaultHeader | null;
    body: VaultBody;
    mark: string | null;
  }>,
  readHeader: () => VaultHeader | null,
): Promise<FreshBody> {
  const header = readHeader() ?? held.header;
  const mark = sealMark(tomb);
  if (mark !== null && mark === held.mark) return { header, body: null };
  const disk = await loadVaultBody(tomb, vaultKey, header);
  return {
    header,
    body: (disk.rev ?? 0) > (held.body.rev ?? 0) ? disk : null,
  };
}
