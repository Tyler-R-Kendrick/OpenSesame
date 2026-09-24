/**
 * Claim projection and the completion payload. Ported from the console's
 * `pages/ClaimPage.test.ts`.
 */
import type { BoundaryValue } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { ClaimError, buildClaimCompletion, toClaimReview } from "./review.js";

const presentation = (items?: BoundaryValue): BoundaryValue => ({
  id: "clm_1",
  type: "project",
  state: "presented",
  targetManifestDigest: "d".repeat(64),
  ...(items === undefined ? undefined : { items }),
});

describe("claim projection", () => {
  it("property: an itemless claim accepts an empty set, not an unknown one", () => {
    // Every claim the server mints today is itemless, and it says so by
    // projecting an empty array. Reading that as "unknown" made the page
    // refuse to complete any of them.
    expect(toClaimReview(presentation([])).itemIds).toEqual([]);
  });

  it("adversarial: a claim that never says what it covers is refused", () => {
    // Empty and absent are different answers. Treating the second as the
    // first is how an item-bearing claim gets accepted without anyone seeing
    // what was in it — so the model stops rather than guessing, and says the
    // bearer is spent: presenting already spent it.
    expect(() => toClaimReview(presentation())).toThrow(/did not report/);
    expect(() => toClaimReview(presentation())).toThrow(ClaimError);
    try {
      toClaimReview(presentation());
    } catch (error) {
      expect(error).toMatchObject({ spent: true });
    }
  });

  it("contract: a claim with items names every one of them", () => {
    const claim = toClaimReview(
      presentation([{ id: "itm_a" }, { id: "itm_b" }]),
    );
    expect(claim.itemIds).toEqual(["itm_a", "itm_b"]);
  });

  it("adversarial: an item with no id is as good as no list", () => {
    expect(() => toClaimReview(presentation([{ id: "itm_a" }, {}]))).toThrow(
      /did not report/,
    );
  });

  it("refuses an answer that is not a claim at all", () => {
    for (const value of [null, "clm_1", { id: "clm_1" }, []]) {
      expect(() => toClaimReview(value)).toThrow(ClaimError);
    }
  });
});

describe("claim completion payload", () => {
  it("contract: carries the consent code the server requires", () => {
    // Omitting it is not a soft failure: CompleteClaimRequestSchema rejects
    // the request outright, so no claim could ever be completed.
    expect(
      buildClaimCompletion({ itemIds: [] }, "abcd-efgh", "osc_clm_x"),
    ).toEqual({
      acceptedItemIds: [],
      userCode: "abcd-efgh",
      claimToken: "osc_clm_x",
    });
  });

  it("adversarial: pasted whitespace does not become a different code", () => {
    expect(
      buildClaimCompletion({ itemIds: [] }, "  ABCD-EFGH  ", "t").userCode,
    ).toBe("ABCD-EFGH");
  });
});
