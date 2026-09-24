/**
 * What an ownership claim looks like to the person reviewing it, and the
 * decision sent back (ADR 0045, ADR 0140 plan step 4).
 *
 * Claim state is always the server's: a presentation or a read is projected
 * here, never remembered past the step that fetched it.
 */

import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";

/** The claim as the page shows and accepts it. */
export type ClaimReview = {
  id: string;
  type: string;
  state: string;
  targetManifestDigest: string;
  /** Accepting names every item; the server refuses a wildcard. */
  itemIds: string[];
};

/** The body of `POST /v1/claims/:id/complete`. */
export type ClaimCompletion = {
  acceptedItemIds: string[];
  userCode: string;
  claimToken: string;
};

/** States a claim can still be accepted from. */
export const OPEN_CLAIM_STATES: ReadonlySet<string> = new Set([
  "presented",
  "authenticated",
  "reviewed",
]);

/**
 * A claim call that failed. `spent` says whether the same bearer could ever
 * succeed again; `kind` is ceremony-kit's reading of the server's code, so a
 * surface can offer the right next step without re-deriving it.
 */
export class ClaimError extends Error {
  constructor(
    readonly kind: string,
    message: string,
    readonly spent: boolean,
    readonly status = 0,
  ) {
    super(message);
    this.name = "ClaimError";
  }
}

const NO_ITEMS =
  "This service did not report what the claim covers, so there is nothing to accept by id. Ask for a fresh claim link.";

/**
 * Project a presentation (or a read) into what the page needs to accept it.
 *
 * An itemless claim accepts an empty set — the manifest digest on the page is
 * what the reviewer vouches for. An *absent* `items` is a different answer:
 * the server projects the field on every claim, so its absence means whatever
 * answered does not report what a claim covers, and accepting by id would be
 * guessing. Presenting has already spent the token by then, so the refusal is
 * final.
 */
export function toClaimReview(value: BoundaryValue): ClaimReview {
  const body: JsonObject = isJsonObject(value) ? value : {};
  const { id, type, state, targetManifestDigest, items } = body;
  if (
    !isString(id) ||
    !isString(type) ||
    !isString(state) ||
    !isString(targetManifestDigest)
  ) {
    throw new ClaimError(
      "malformed",
      "The answer did not look like a claim. Ask for a fresh claim link.",
      true,
    );
  }
  if (!Array.isArray(items)) throw new ClaimError("malformed", NO_ITEMS, true);
  const itemIds = items.map((item) => (isJsonObject(item) ? item.id : null));
  if (!itemIds.every(isString)) {
    throw new ClaimError("malformed", NO_ITEMS, true);
  }
  return { id, type, state, targetManifestDigest, itemIds };
}

/**
 * The decision sent to the server. Completion requires all three together —
 * the accepted items, the claim bearer, and the user code that proves human
 * consent — so building it in one place keeps a caller from omitting the
 * code, which the server rejects. Pasted whitespace is not part of a code.
 */
export function buildClaimCompletion(
  claim: Pick<ClaimReview, "itemIds">,
  userCode: string,
  claimToken: string,
): ClaimCompletion {
  return {
    acceptedItemIds: [...claim.itemIds],
    userCode: userCode.trim(),
    claimToken,
  };
}
