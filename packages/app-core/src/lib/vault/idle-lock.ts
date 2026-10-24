/**
 * What may finish before the idle timer locks the vault.
 *
 * The timer itself stays synchronous when this returns null, which is the
 * default: a deferred service-worker reload is the only caller that needs
 * to persist an edit before the key is dropped.
 */

export const idleLockSeams = {
  beforeLock: (): Promise<void> | null => null,
};
