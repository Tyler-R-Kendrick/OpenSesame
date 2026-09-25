/**
 * The review's refusals and endings, ported from the "refusals in words" and
 * "what never reaches the page" suites of
 * `apps/ceremonies/src/pages/ApprovalReview.test.tsx`.
 */
import { describe, expect, it } from "vitest";
import {
  REQUEST,
  REQUIREMENT,
  SECRET_CODE,
  challenge,
  confirmed,
  json,
  reviewHarness,
} from "./approval-review.fixture.js";

const APPROVE = { confirmed: true, comparison: SECRET_CODE };

describe("approval review — refusals in words", () => {
  it("treats a comparison mismatch as a security signal, not a form error", async () => {
    const h = reviewHarness();
    h.seedLoad();
    h.answer(
      challenge(),
      confirmed(),
      json({ error: "comparison_mismatch" }, 409),
    );
    await h.review.load();

    const step = await h.review.approve({
      confirmed: true,
      comparison: "111111",
    });

    expect(step?.alarm).toBe(true);
    expect(step?.phase.kind).toBe("review");
    expect(step?.message).toContain("That code doesn't match");
    expect(step?.message).toContain(
      "Someone else may have started this request",
    );
    // Not the generic 409 or 422 wording.
    expect(step?.message).not.toMatch(/already decided|changed since/);
  });

  it("says a 409 changed since it was shown, and stops", async () => {
    const h = reviewHarness();
    h.answer(json({ error: "digest_changed" }, 409));

    const step = await h.review.load();

    expect(step?.phase).toMatchObject({
      kind: "done",
      ending: { kind: "ended" },
    });
    expect(step?.phase.kind === "done" && step.phase.ending.words).toMatch(
      /changed since it was shown.*nothing was decided/,
    );
  });

  it("says a 410 expired, and stops", async () => {
    const h = reviewHarness();
    h.answer(json({ error: "expired" }, 410));

    const step = await h.review.load();

    expect(step?.phase.kind === "done" && step.phase.ending.words).toMatch(
      /expired before it was decided/,
    );
  });

  it("says an activation that timed out did not decide anything", async () => {
    const h = reviewHarness();
    h.seedLoad();
    h.answer(challenge(), json({ error: "activation_expired" }, 410));
    await h.review.load();

    const step = await h.review.approve(APPROVE);

    expect(step?.message).toMatch(/authenticator touch took too long/);
    // A lapsed activation is not an expired request: the review stays open.
    expect(step?.phase.kind).toBe("review");
    expect(h.paths().some((path) => path.endsWith("/approve"))).toBe(false);
  });

  it("reads a refused assertion as the passkey step, not a sign-in", async () => {
    const h = reviewHarness();
    h.seedLoad();
    h.answer(
      challenge(),
      json({ error: "activation_verification_failed" }, 401),
    );
    await h.review.load();

    const step = await h.review.approve(APPROVE);

    expect(step?.message).toMatch(/passkey touch was not accepted/);
    expect(step?.message).not.toMatch(/Sign in/);
  });

  it("reads a 403 for more assurance as that, not as someone else's request", async () => {
    const h = reviewHarness();
    h.seedLoad();
    h.answer(
      challenge(),
      confirmed(),
      json({ error: "assurance_insufficient" }, 403),
    );
    await h.review.load();

    const step = await h.review.approve(APPROVE);

    expect(step?.message).toMatch(/needs more proof/);
    expect(step?.message).not.toMatch(/not addressed to you/);
  });

  it("says a revoked binding can no longer decide, and stops", async () => {
    const h = reviewHarness();
    h.answer(json({ error: "binding_revoked" }, 403));

    const step = await h.review.load();

    expect(step?.phase.kind === "done" && step.phase.ending.words).toMatch(
      /has been revoked/,
    );
  });

  it("says an already-decided request changed nothing", async () => {
    const h = reviewHarness();
    h.answer(json({ error: "request_not_pending" }, 422));

    const step = await h.review.load();

    expect(step?.phase.kind === "done" && step.phase.ending.words).toMatch(
      /already decided/,
    );
  });

  it("stalls rather than ends when the Identity API cannot be reached", async () => {
    const h = reviewHarness();
    h.answer(new TypeError("offline"));

    const step = await h.review.load();

    expect(step?.phase.kind).toBe("stalled");
    expect(step?.message).toMatch(/not reachable/);
  });
});

describe("approval review — what never reaches the screen", () => {
  it("never carries the comparison value back", async () => {
    const h = reviewHarness();
    h.seedLoad();
    // A server that leaked the value back must not get it into a step.
    h.answer(
      challenge({ comparisonValue: SECRET_CODE }),
      confirmed(),
      json({ ...REQUEST, status: "approved", comparisonValue: SECRET_CODE }),
    );
    await h.review.load();

    const step = await h.review.approve(APPROVE);

    expect(JSON.stringify(step)).not.toContain(SECRET_CODE);
    expect(JSON.stringify(h.review.phase())).not.toContain(SECRET_CODE);
  });

  it("drops a bearer or a provider subject that came back with the request", async () => {
    const h = reviewHarness();
    h.answer(
      json({
        ...REQUEST,
        providerSubjectId: "U0FAKESUBJECT",
        accessToken: "osc_at_leaked",
      }),
      json(REQUIREMENT),
    );

    const step = await h.review.load();

    const seen = JSON.stringify(step);
    expect(seen).toContain("Deploy the billing service");
    expect(seen).not.toContain("U0FAKESUBJECT");
    expect(seen).not.toContain("osc_at_leaked");
  });

  it("puts nothing but a request id in a path", async () => {
    const h = reviewHarness();
    h.seedLoad();
    h.answer(
      challenge(),
      confirmed(),
      json({ ...REQUEST, status: "approved" }),
    );
    await h.review.load();
    await h.review.approve(APPROVE);

    for (const path of h.paths()) {
      expect(path).not.toContain(SECRET_CODE);
      expect(path).not.toContain("act_9");
      expect(path).not.toContain("?");
    }
  });
});
