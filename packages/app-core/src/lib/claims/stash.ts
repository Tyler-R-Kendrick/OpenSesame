/**
 * The claim bearer between steps of the ceremony, in Pages.
 *
 * Presenting spends the token but completing needs it again, and signing in
 * may leave the page (a federated sign-in is a full redirect), so the bearer
 * waits in tab-scoped storage — the host's session port, never local storage,
 * never the URL. This is the one binding the console's and the ceremonies
 * app's `claim-stash.ts` copies become; it keeps what both did (tab scope, a
 * validated read, a storage failure is a single-sitting ceremony, not an
 * error) and reads stricter:
 *
 *   - only a claim-shaped bearer is resumed, and anything else is removed;
 *   - nothing older than the server's longest claim (24 hours) is resumed;
 *   - it holds the bearer, the claim id and the principal only — never the
 *     consent code, and never a drop key: a drop is opened in one sitting.
 *
 * Forget it on completion, on a refusal the bearer cannot come back from, and
 * on sign-out.
 */

import {
  type ClaimStash,
  createClaimStash,
  isClaimToken,
} from "@opensesame/ceremony-kit";
import { maybeSessionStore } from "../../ports.js";

export type { ClaimStash };

/** The server's ceiling on a claim's life (`CreateClaimRequestSchema`). */
export const CLAIM_STASH_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const KEY = "opensesame.claim";

/** The slice of the stash the ceremony uses; a test passes its own. */
export interface ClaimStashPort {
  read(): ClaimStash | null;
  write(next: ClaimStash): void;
  clear(): void;
}

export function createPagesClaimStash(
  now: () => number = Date.now,
): ClaimStashPort {
  return createClaimStash(
    () => {
      try {
        return maybeSessionStore() ?? null;
      } catch {
        // Storage is withheld; the ceremony still works in one sitting.
        return null;
      }
    },
    KEY,
    { maxAgeMs: CLAIM_STASH_MAX_AGE_MS, acceptToken: isClaimToken, now },
  );
}

export const claimStash: ClaimStashPort = createPagesClaimStash();

/** Forget the bearer: on completion, on sign-out, once it cannot be used. */
export function clearClaimStash(): void {
  claimStash.clear();
}
