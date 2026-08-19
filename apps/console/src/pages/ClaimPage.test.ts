import type { ClaimPresentation } from "@opensesame/sdk-browser";
import { describe, expect, it } from "vitest";
import { buildClaimCompletion, toClaim } from "./ClaimPage.js";

const presentation = (items?: ClaimPresentation["items"]): ClaimPresentation =>
  ({
    id: "clm_1",
    type: "project",
    state: "presented",
    targetManifestDigest: "d".repeat(64),
    ...(items ? { items } : {}),
  }) as ClaimPresentation;

describe("claim projection", () => {
  it("property: an itemless claim accepts an empty set, not an unknown one", () => {
    // Every claim the server mints today is itemless, and it says so by
    // projecting an empty array. Reading that as "unknown" made the page
    // refuse to complete any of them.
    expect(toClaim(presentation([])).itemIds).toEqual([]);
  });

  it("adversarial: a claim that never says what it covers is refused", () => {
    // Empty and absent are different answers. Treating the second as the first
    // is how an item-bearing claim gets accepted without anyone seeing what
    // was in it — so the page stops rather than guessing, even though
    // presenting has already spent the token by this point.
    expect(() => toClaim(presentation())).toThrow(/did not report/);
  });

  it("contract: a claim with items names every one of them", () => {
    const claim = toClaim(
      presentation([
        { id: "itm_a" },
        { id: "itm_b" },
      ] as ClaimPresentation["items"]),
    );
    expect(claim.itemIds).toEqual(["itm_a", "itm_b"]);
  });
});

describe("claim completion payload", () => {
  it("contract: carries the consent code the server requires", () => {
    // Omitting it is not a soft failure: CompleteClaimRequestSchema rejects the
    // request outright, so the console could never complete a claim.
    const decision = buildClaimCompletion(
      { itemIds: [] },
      "abcd-efgh",
      "osc_clm_x",
    );
    expect(decision).toEqual({
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
