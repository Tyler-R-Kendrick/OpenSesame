import { overlapCast, isTypeofObject, isString, isBoolean } from "@opensesame/os-domain";
/**
 * The claim bearer between steps of the ceremony. Presenting spends the token
 * but completing needs it again, so a reload or a detour through sign-in must
 * not lose it — that would strand a claim in `presented` with no way to accept
 * it. Session storage keeps it to this tab and clears when the tab closes, and
 * it stays out of the URL so it cannot be read from the address bar or history.
 *
 * Only the bearer, the claim id and who is accepting are kept. Claim state is
 * re-read from the server on resume: a snapshot cannot say whether the claim has
 * since expired, been denied, or been completed by somebody else.
 */
export interface ClaimStash {
  token: string;
  /** Whether the token has been spent on a presentation yet. */
  presented: boolean;
  /** Known once presented; a bearer alone does not say which claim it opens. */
  claimId?: string;
  /**
   * The principal this claim was presented to. Completion attaches ownership to
   * whoever accepts, so a different principal resuming means the tab changed
   * hands and the claim is not theirs to accept.
   */
  principalId?: string;
}

const STASH_KEY = "opensesame.claim";

export function writeClaimStash(next: ClaimStash): void {
  try {
    // The bearer must survive same-tab sign-in; sessionStorage is tab-scoped
    // and keeps it out of URLs/history.
    // ast-grep-ignore: ts-localstorage-set
    sessionStorage.setItem(STASH_KEY, JSON.stringify(next));
  } catch {
    // Storage is unavailable. The ceremony still works in a single sitting.
  }
}

/** Forget the bearer: on completion, on sign-out, and once it cannot be used. */
export function clearClaimStash(): void {
  try {
    sessionStorage.removeItem(STASH_KEY);
  } catch {
    // Nothing was stored, so nothing to forget.
  }
}

export function readClaimStash(): ClaimStash | null {
  try {
    const raw = sessionStorage.getItem(STASH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isTypeofObject(parsed) || parsed === null) return null;
    const { token, presented, claimId, principalId } =
      overlapCast(parsed);
    if (!isString(token) || !isBoolean(presented))
      return null;
    return {
      token,
      presented,
      ...(isString(claimId) ? { claimId } : undefined),
      ...(isString(principalId) ? { principalId } : undefined),
    };
  } catch {
    return null;
  }
}
