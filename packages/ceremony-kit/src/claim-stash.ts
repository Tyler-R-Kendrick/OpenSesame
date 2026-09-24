import {
  type BoundaryValue,
  isBoolean,
  isNumber,
  isString,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
/**
 * The claim bearer between steps of a ceremony.
 *
 * Presenting spends the token but completing needs it again, so a reload or a
 * detour through sign-in must not lose it — that would strand a claim in
 * `presented` with no way to accept it.
 *
 * Where it may be kept is the caller's decision, so the storage is injected
 * and this module never reaches for a global. The standalone apps bind
 * tab-scoped session storage; Pages (`app-core/lib/claims/stash.ts`) binds the
 * same tab scope through its host port and reads stricter — a claim-shaped
 * token only, and nothing older than the server's longest claim — because a
 * sign-in redirect is the one detour a bearer must survive, and nothing else.
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

/** Stricter reading a surface may ask for; the default reads as before. */
export interface ClaimStashOptions {
  /**
   * Forget a stash older than this. The write is stamped, and a read past the
   * horizon — or of an unstamped record — removes it and comes back empty.
   */
  maxAgeMs?: number;
  /** Whether a stored token has an acceptable shape; a mismatch is removed. */
  acceptToken?: (token: string) => boolean;
  now?: () => number;
}

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
  options: ClaimStashOptions = {},
) {
  const { maxAgeMs, acceptToken, now = Date.now } = options;
  /** A record past its horizon, or holding a token of the wrong shape. */
  const stale = (token: string, savedAt: BoundaryValue): boolean =>
    (acceptToken !== undefined && !acceptToken(token)) ||
    (maxAgeMs !== undefined &&
      (!isNumber(savedAt) || now() - savedAt > maxAgeMs || savedAt > now()));
  return {
    write(input: ClaimStash): void {
      const next =
        maxAgeMs === undefined ? input : { ...input, savedAt: now() };
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
        const { token, presented, claimId, principalId, savedAt } =
          overlapCast(parsed);
        if (!isString(token) || !isBoolean(presented)) {
          return null;
        }
        if (stale(token, savedAt)) {
          storage()?.removeItem(key);
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
