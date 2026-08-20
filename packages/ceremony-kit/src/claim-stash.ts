import { overlapCast, isTypeofObject, isString, isBoolean } from "@opensesame/os-domain";
/**
 * The claim bearer between steps of a ceremony.
 *
 * Presenting spends the token but completing needs it again, so a reload or a
 * detour through sign-in must not lose it — that would strand a claim in
 * `presented` with no way to accept it.
 *
 * Where it may be kept is the caller's decision, and the surfaces disagree for
 * good reason: the standalone ceremonies app uses tab-scoped session storage,
 * while the Pages vault app keeps claim bearers in memory only, because
 * anything it persists lands beside vault material and must survive a lock
 * (see `apps/pages/src/lib/queue.ts`). The storage is therefore injected, and
 * this module never reaches for a global.
 *
 * Only the bearer, the claim id, and who is accepting are kept. Claim state is
 * re-read from the server on resume: a snapshot cannot say whether the claim
 * has since expired, been denied, or been completed by somebody else.
 */

export interface ClaimStash {
  token: string;
  /** Whether the token has been spent on a presentation yet. */
  presented: boolean;
  /** Known once presented; a bearer alone does not say which claim it opens. */
  claimId?: string;
  /**
   * The principal this claim was presented to. Completion attaches ownership
   * to whoever accepts, so a different principal resuming means the tab
   * changed hands and the claim is not theirs to accept.
   */
  principalId?: string;
}

/** The slice of a `Storage` this needs. Any conforming object works. */
export interface StashStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const DEFAULT_KEY = "opensesame.claim";

/**
 * Bind a stash to one storage and key.
 *
 * `storage` is resolved per call rather than captured, so a surface can return
 * `null` once a bearer may no longer be held (a locked vault, a storage-denied
 * browser) and every subsequent read comes back empty.
 */
export function createClaimStash(
  storage: () => StashStorage | null,
  key: string = DEFAULT_KEY,
) {
  return {
    write(next: ClaimStash): void {
      try {
        storage()?.setItem(key, JSON.stringify(next));
      } catch {
        // Storage is unavailable. The ceremony still works in one sitting.
      }
    },

    /** Forget the bearer: on completion, on sign-out, once it cannot be used. */
    clear(): void {
      try {
        storage()?.removeItem(key);
      } catch {
        // Nothing was stored, so nothing to forget.
      }
    },

    read(): ClaimStash | null {
      try {
        const raw = storage()?.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!isTypeofObject(parsed) || parsed === null) return null;
        const { token, presented, claimId, principalId } =
          overlapCast(parsed);
        if (!isString(token) || !isBoolean(presented)) {
          return null;
        }
        return {
          token,
          presented,
          ...(isString(claimId) ? { claimId } : undefined),
          ...(isString(principalId) ? { principalId } : undefined),
        };
      } catch {
        return null;
      }
    },
  };
}
