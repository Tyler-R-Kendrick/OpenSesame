/**
 * Document lifecycle decisions the vault shell and a live session share.
 *
 * A script-created `visibilitychange` is not a window hide. A back/forward
 * cache restore must not keep authority that was live when the document froze.
 */

export type TrustedHide = {
  readonly trusted: boolean;
  readonly hidden: boolean;
  readonly lockOnHide: boolean;
  readonly unlocked: boolean;
};

/** Lock, and therefore retire a hosted session, only for a real hide. */
export function trustedHideRetires(hide: TrustedHide): boolean {
  return hide.trusted && hide.hidden && hide.lockOnHide && hide.unlocked;
}

export type PersistedRestore = {
  readonly persisted: boolean;
  readonly hadAuthority: boolean;
};

/** A bfcache return refuses the session that was still live when frozen. */
export function persistedRestoreRefuses(restore: PersistedRestore): boolean {
  return restore.persisted && restore.hadAuthority;
}
