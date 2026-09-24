/**
 * The authorization-request review, ported from
 * `apps/ceremonies/src/pages/ApprovalReview.test.tsx`: the order of the
 * ceremony, what never goes on the wire, and the endings.
 */
import { describe, expect, it } from "vitest";
import {
  DIGEST,
  POLICY,
  REQUEST,
  REQUIREMENT,
  SECRET_CODE,
  challenge,
  confirmed,
  json,
  reviewHarness,
} from "./approval-review.fixture.js";
import { InteractionStepUpError } from "./interaction-approval.js";

const APPROVE = { confirmed: true, comparison: SECRET_CODE };

describe("approval review — the ceremony", () => {
  it("runs activation, then complete, then settle, and settles with the activation id", async () => {
    const h = reviewHarness();
    h.seedLoad();
    h.answer(
      challenge(),
      confirmed(),
      json({ ...REQUEST, status: "approved" }),
    );

    expect((await h.review.load())?.phase.kind).toBe("review");
    const step = await h.review.approve(APPROVE);

    expect(step?.phase).toMatchObject({
      kind: "done",
      ending: { kind: "approved" },
    });
    // The order is the security property: mint, prove, then settle.
    expect(h.paths()).toEqual([
      "/v1/authorization-requests/areq_1",
      "/v1/authorization-requests/areq_1/requirement",
      "/v1/authorization-requests/areq_1/activation",
      "/v1/authorization-requests/areq_1/activation/complete",
      "/v1/authorization-requests/areq_1/approve",
    ]);
    expect(h.assert).toHaveBeenCalledTimes(1);
    // The authority's options reach the authenticator unaltered.
    expect(h.assert).toHaveBeenCalledWith({
      challenge: "Y2hhbGxlbmdl",
      userVerification: "required",
    });
    // Minted against the digest that was displayed, for this verb…
    expect(h.body(2)).toEqual({ decision: "approved", requestDigest: DIGEST });
    // …proved once…
    expect(h.body(3)).toMatchObject({
      activationId: "act_9",
      signature: "c2ln",
    });
    // …and named, not re-proved, at settle.
    expect(h.body(4)).toEqual({
      requestDigest: DIGEST,
      activationId: "act_9",
      comparisonValue: SECRET_CODE,
    });
  });

  it("binds a denial's activation to the deny verb", async () => {
    const h = reviewHarness();
    h.seedLoad();
    h.answer(challenge(), confirmed(), json({ ...REQUEST, status: "denied" }));
    await h.review.load();

    const step = await h.review.deny({ comparison: SECRET_CODE });

    expect(step?.phase).toMatchObject({ ending: { kind: "denied" } });
    expect(h.body(2)).toEqual({ decision: "denied", requestDigest: DIGEST });
    expect(h.paths().at(-1)).toBe("/v1/authorization-requests/areq_1/deny");
  });

  it("settles a request that needs nothing extra with the digest alone", async () => {
    const h = reviewHarness({
      requirement: {
        riskClass: "low",
        policyDigest: POLICY,
        requireTransactionBoundActivation: false,
        requireComparison: false,
        required: ["subject_kind:human"],
        maximumApprovalAgeSeconds: 900,
      },
    });
    h.seedLoad();
    h.answer(json({ ...REQUEST, status: "approved" }));
    await h.review.load();

    await h.review.approve({ confirmed: true });

    expect(h.assert).not.toHaveBeenCalled();
    expect(h.body(2)).toEqual({ requestDigest: DIGEST });
  });

  it("never settles when the authenticator is unreachable", async () => {
    const h = reviewHarness({ authenticator: false });
    h.seedLoad();
    await h.review.load();

    const step = await h.review.approve(APPROVE);

    expect(step?.message).toMatch(/credential API is missing/);
    expect(step?.message).toMatch(/Nothing has been approved/);
    // The activation was never even begun, let alone skipped past.
    expect(h.paths()).toHaveLength(2);
  });

  it("requires the explicit confirmation before the passkey step", async () => {
    const h = reviewHarness();
    h.seedLoad();
    await h.review.load();

    const step = await h.review.approve({ comparison: SECRET_CODE });

    expect(step?.message).toMatch(/Confirm that you have read/);
    expect(step?.phase.kind).toBe("review");
    expect(h.paths()).toHaveLength(2);
    expect(h.assert).not.toHaveBeenCalled();
  });

  it("asks for the six-digit code before any call", async () => {
    const h = reviewHarness();
    h.seedLoad();
    await h.review.load();

    const step = await h.review.approve({ confirmed: true, comparison: "12a" });

    expect(step?.message).toMatch(/Type the six-digit code/);
    expect(h.paths()).toHaveLength(2);
  });

  it("refuses a challenge minted under another policy before any passkey", async () => {
    const h = reviewHarness();
    h.seedLoad();
    h.answer(challenge({ policyDigest: "a-laxer-policy" }));
    await h.review.load();

    const step = await h.review.approve(APPROVE);

    expect(h.assert).not.toHaveBeenCalled();
    expect(step?.phase).toMatchObject({
      kind: "done",
      ending: { kind: "ended" },
    });
    expect(h.paths().some((path) => path.endsWith("/approve"))).toBe(false);
  });

  it("refuses an activation the authority confirms under another id", async () => {
    const h = reviewHarness();
    h.seedLoad();
    h.answer(challenge(), confirmed("act_someone_elses"));
    await h.review.load();

    const step = await h.review.approve(APPROVE);

    expect(step?.phase.kind).toBe("review");
    expect(step?.message).toMatch(/passkey touch was not accepted/);
    expect(h.paths().some((path) => path.endsWith("/approve"))).toBe(false);
  });

  it("stays on the review when the passkey sheet is dismissed", async () => {
    const h = reviewHarness();
    h.seedLoad();
    h.answer(challenge());
    h.assert.mockRejectedValueOnce(new InteractionStepUpError("cancelled"));
    await h.review.load();

    const step = await h.review.approve(APPROVE);

    expect(step?.phase.kind).toBe("review");
    expect(step?.message).toMatch(/Passkey cancelled/);
    expect(h.paths()).toHaveLength(3);
  });

  it("ignores a second decision while one is in flight", async () => {
    const h = reviewHarness();
    h.seedLoad();
    h.answer(
      challenge(),
      confirmed(),
      json({ ...REQUEST, status: "approved" }),
    );
    await h.review.load();

    const [first, second] = await Promise.all([
      h.review.approve(APPROVE),
      h.review.approve(APPROVE),
    ]);

    expect(first?.phase.kind).toBe("done");
    expect(second).toBeNull();
    expect(h.assert).toHaveBeenCalledTimes(1);
  });
});

describe("approval review — report", () => {
  it("reports with the digest shown, and leaves nothing settled", async () => {
    const h = reviewHarness();
    h.seedLoad();
    h.answer(json({ reported: true }));
    await h.review.load();

    const step = await h.review.report();

    expect(step?.phase).toMatchObject({
      ending: { kind: "reported", title: "Refused and reported" },
    });
    expect(h.paths().at(-1)).toBe("/v1/authorization-requests/areq_1/report");
    expect(h.body(2)).toEqual({
      requestDigest: DIGEST,
      reason: "not_recognized",
    });
    // A report is not a denial: nothing was settled, no passkey was asked.
    expect(h.paths().some((path) => path.endsWith("/deny"))).toBe(false);
    expect(h.assert).not.toHaveBeenCalled();
  });
});

describe("approval review — a request that changed", () => {
  it("ends a review whose request was rewritten between reads", async () => {
    const h = reviewHarness();
    h.seedLoad();
    await h.review.load();
    h.answer(
      json({ ...REQUEST, requestDigest: "digest-rewritten-000002" }),
      json(REQUIREMENT),
    );

    const step = await h.review.load();

    expect(step?.phase).toMatchObject({
      kind: "done",
      ending: { kind: "ended" },
    });
    expect(step?.phase.kind === "done" && step.phase.ending.words).toMatch(
      /changed since it was shown/,
    );
    // Nothing after it: an ended review answers no further call.
    expect(await h.review.approve(APPROVE)).toBeNull();
  });

  it("ends a review whose policy changed between reads", async () => {
    const h = reviewHarness();
    h.seedLoad();
    await h.review.load();
    h.answer(json(REQUEST), json({ ...REQUIREMENT, policyDigest: "new" }));

    const step = await h.review.load();

    expect(step?.phase).toMatchObject({
      kind: "done",
      ending: { kind: "ended" },
    });
    expect(step?.phase.kind === "done" && step.phase.ending.words).toMatch(
      /rules for this request changed/,
    );
  });
});
