/**
 * Sealing the body to its tomb, and noting in the header how far it has got.
 *
 * Split out of `store.ts`: the store decides when a body is written; this file
 * seals it, stores it, and keeps the header's rollback witness behind it.
 */

import {
  type VaultBody,
  type VaultHeader,
  assertSealed,
  normalizeVaultBody,
  sealJson,
  vaultSealBinding,
} from "@opensesame/vault-core";
import { enqueueVfsWrite } from "../vfs-write-queue.js";
import {
  BODY_PATH,
  HEADER_PATH,
  refreshTombRootGeneration,
  writePlaintextFile,
  writeSealedFile,
} from "../vfs.js";
import { readTombHeader } from "./store-header.js";
import { pinStoredRootAuthority } from "./store-root-authority.js";

/** A body written to its tomb: its revision, its seal, and the header to hold after. */
export type WrittenBody = Readonly<{
  rev: number;
  mark: string;
  header: VaultHeader | null;
}>;

/**
 * Seal `body` as the next revision, store it, and then note the revision in
 * the header. The revision advances only after the sealed write lands, so the
 * caller records it on its body then.
 */
export async function writeBody(
  tomb: string,
  vaultKey: CryptoKey,
  body: VaultBody,
  header: VaultHeader | null,
): Promise<WrittenBody> {
  const assertCurrent = pinStoredRootAuthority(tomb, vaultKey);
  const rev = (body.rev ?? 0) + 1;
  const sealed = await sealJson(
    vaultKey,
    // The one door every write goes through: a `login` that reached memory by
    // any route is sealed as the account it is (ADR 0172), never as a login.
    normalizeVaultBody({ ...body, rev }),
    vaultSealBinding(tomb, BODY_PATH),
  );
  assertCurrent();
  assertSealed(sealed);
  await writeSealedFile(tomb, BODY_PATH, sealed);
  return {
    rev,
    mark: sealed.ivB64,
    header: await noteBodyRev(tomb, vaultKey, header, rev),
  };
}

/**
 * Note in the header how far the body has got, and return the header to hold.
 * Written after the body, never before: trailing by one is harmless — the body
 * is simply newer — while leading by one would accuse an intact vault of
 * having been rolled back.
 */
async function noteBodyRev(
  tomb: string,
  key: CryptoKey,
  header: VaultHeader | null,
  rev: number,
): Promise<VaultHeader | null> {
  if (!header || (header.bodyRev ?? 0) >= rev) return header;
  let next: VaultHeader = header;
  const assertCurrent = pinStoredRootAuthority(tomb, key);
  try {
    await enqueueVfsWrite(tomb, async () => {
      assertCurrent();
      const current = readTombHeader(tomb) ?? header;
      next = { ...current, bodyRev: Math.max(current.bodyRev ?? 0, rev) };
      await writePlaintextFile(tomb, HEADER_PATH, JSON.stringify(next));
      refreshTombRootGeneration(tomb, key);
    });
  } catch {
    // The body is safely stored; only the rollback witness is behind. Losing
    // it costs detection, not data, and the next write will catch it up.
    return header;
  }
  return next;
}
