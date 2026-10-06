/**
 * The master-password wrap: enrolling, changing and removing it, and carrying
 * the change to every device.
 *
 * A master password changed on one device opens the vault on the others
 * (ADR 0144). The header — where the password wrap lives — never syncs: it is
 * this device's own. So every change to the wrap is also recorded in the
 * sealed body (`VaultBody.masterWrap`), which does, and a device that merges a
 * newer record takes it into its header.
 *
 * Only a device holding the vault key can write the body, so a drive cannot
 * plant a wrap; and a wrap only ever opens the same vault key, so taking one
 * in changes which password opens this vault, never which vault it is. The
 * PIN, passkeys and second steps are untouched: they wrap the vault key
 * themselves. The hint is dropped, because it describes the old password.
 */
import {
  type MasterWrap,
  type VaultBody,
  type VaultHeader,
  rewrapVaultKey,
  wrapVaultKeyWithPassword,
} from "@opensesame/vault-core";
import { assertKeepsPrimaryUnlock } from "./unlock-methods.js";
import { assertNewPassword } from "./unlock-secret-guard.js";

/** `header` with a password wrap added. */
export async function headerWithPassword(
  header: VaultHeader,
  rawVaultKey: Uint8Array,
  password: string,
): Promise<VaultHeader> {
  await assertNewPassword(password);
  return sealAdmittedPasswordHeader(header, rawVaultKey, password);
}

/** Cryptographic header construction after the caller admits the password policy. */
export async function sealAdmittedPasswordHeader(
  header: VaultHeader,
  rawVaultKey: Uint8Array,
  password: string,
): Promise<VaultHeader> {
  const { kdf, wrap } = await wrapVaultKeyWithPassword(rawVaultKey, password);
  return { ...header, kdf, wrap };
}

/** `header` without its password wrap; refused when it is the last way in. */
export function headerWithoutPassword(header: VaultHeader): VaultHeader {
  assertKeepsPrimaryUnlock(header, "password");
  const { wrap: _w, kdf: _k, ...rest } = header;
  return { ...rest, wrap: undefined, kdf: undefined };
}

/** `header` re-wrapped under a new password, given the current one. */
export async function headerWithNewPassword(
  header: VaultHeader,
  current: string,
  next: string,
  hint?: string,
): Promise<VaultHeader> {
  if (!header.wrap || !header.kdf) {
    throw new Error(
      "This vault has no master password. Add one under Unlock methods first.",
    );
  }
  await assertNewPassword(next);
  return rekeyAdmittedPasswordHeader(header, current, next, hint);
}

/** Rewrap construction for a password admitted through its full commit mutex. */
export function rekeyAdmittedPasswordHeader(
  header: VaultHeader,
  current: string,
  next: string,
  hint?: string,
): Promise<VaultHeader> {
  return rewrapVaultKey(header, current, next, hint);
}

function sameWrap(wrap: MasterWrap | undefined, header: VaultHeader): boolean {
  return (
    (wrap?.wrap?.ctB64 ?? null) === (header.wrap?.ctB64 ?? null) &&
    (wrap?.kdf?.saltB64 ?? null) === (header.kdf?.saltB64 ?? null)
  );
}

/**
 * Whether writing `next` changes the password wrap the body records. A vault
 * that never recorded one starts recording at its first change.
 */
export function wrapMoved(
  previous: VaultHeader | null,
  next: VaultHeader,
  body: VaultBody,
): boolean {
  if (
    previous &&
    sameWrap({ at: "", kdf: previous.kdf, wrap: previous.wrap }, next)
  ) {
    return false;
  }
  return body.masterWrap === undefined || !sameWrap(body.masterWrap, next);
}

/** Record `header`'s password wrap (or its absence) in the body; the store stamps it. */
export function noteMasterWrap(body: VaultBody, header: VaultHeader): void {
  body.masterWrap = {
    at: new Date().toISOString(),
    ...(header.kdf && header.wrap
      ? { kdf: header.kdf, wrap: header.wrap }
      : undefined),
  };
}

/**
 * The header this device should hold after a merge brought another device's
 * password change, or `null` when it already holds it. A removal is taken in
 * only where another way in remains, so a merge never strands a device.
 */
export function adoptedMasterWrap(
  body: VaultBody,
  header: VaultHeader,
): VaultHeader | null {
  const wrap = body.masterWrap;
  if (!wrap || sameWrap(wrap, header)) return null;
  const { hint: _old, kdf: _k, wrap: _w, ...rest } = header;
  if (wrap.kdf && wrap.wrap) return { ...rest, kdf: wrap.kdf, wrap: wrap.wrap };
  if (!header.wrap) return null;
  try {
    assertKeepsPrimaryUnlock(header, "password");
  } catch {
    return null;
  }
  return rest;
}
