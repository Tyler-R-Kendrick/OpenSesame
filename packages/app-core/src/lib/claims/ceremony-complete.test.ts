/**
 * Accepting a claim, the guest path, and what an arrival asks for. Ported
 * from the console's `pages/ClaimPage.test.tsx` ("completing") and the
 * ceremonies app's `ClaimCeremony` guest path, plus the refusals a code-keyed
 * reading fixes.
 */
import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { OPEN_CLAIM, TOKEN, claimHarness, json } from "./ceremony.fixture.js";
import { CLAIM_WORDS, type ClaimOpen } from "./ceremony.js";

async function opened(presentation: BoundaryValue = OPEN_CLAIM) {
  const h = claimHarness();
  h.routes.present.mockResolvedValue(json(presentation));
  const step = await h.ceremony.submit(TOKEN);
  const phase = step?.phase;
  return { h, phase, message: step?.message ?? null };
}

function asOpen(phase: object | undefined): ClaimOpen {
  expect(phase).toMatchObject({ kind: "open" });
  return overlapCast(phase);
}

describe("completing", () => {
  it("completes an open claim as the same principal and forgets the bearer", async () => {
    const { h, phase } = await opened();
    h.routes.complete.mockResolvedValue(
      json({ ...OPEN_CLAIM, state: "completed", won: true }),
    );
    const step = await h.ceremony.complete(asOpen(phase), " WORD-WORD ");
    expect(h.routes.complete).toHaveBeenCalledWith(
      "clm_1",
      JSON.stringify({
        acceptedItemIds: ["item-1", "item-2"],
        userCode: "WORD-WORD",
        claimToken: TOKEN,
      }),
    );
    expect(step).toEqual({ phase: { kind: "done" }, message: null });
    expect(h.stashed()).toBeNull();
  });

  it("never opens a claim whose API never named what it covers", async () => {
    // An empty item list is a legitimate answer; no list at all is not.
    // Presenting already spent the token, so the bearer is forgotten.
    const { items: _items, ...withoutItems } = OPEN_CLAIM;
    const { h, phase, message } = await opened(withoutItems);
    expect(phase).toEqual({ kind: "token" });
    expect(message).toMatch(/did not report/);
    expect(h.stashed()).toBeNull();
  });

  it("refuses to complete without the consent code", async () => {
    const { h, phase } = await opened();
    const open = asOpen(phase);
    expect(await h.ceremony.complete(open, "   ")).toEqual({
      phase: open,
      message: CLAIM_WORDS.needCode,
    });
    expect(h.routes.complete).not.toHaveBeenCalled();
  });

  it("abandons the completion when the signed-in account changed", async () => {
    const { h, phase } = await opened();
    h.signIn("prn_other");
    expect(await h.ceremony.complete(asOpen(phase), "WORD-WORD")).toEqual({
      phase: { kind: "token" },
      message: CLAIM_WORDS.identityChanged,
    });
    expect(h.routes.complete).not.toHaveBeenCalled();
    expect(h.stashed()).toBeNull();
  });

  it("treats a spent refusal on completion as the end of the bearer", async () => {
    const { h, phase } = await opened();
    h.routes.complete.mockResolvedValue(json({ error: "CONFLICT" }, 409));
    expect(await h.ceremony.complete(asOpen(phase), "WORD-WORD")).toEqual({
      phase: { kind: "token" },
      message: "This claim has already been decided.",
    });
    expect(h.stashed()).toBeNull();
  });

  it("keeps the claim open when completion fails retryably", async () => {
    const { h, phase } = await opened();
    const open = asOpen(phase);
    h.routes.complete.mockResolvedValue(
      json({ message: "backend exploded" }, 500),
    );
    expect(await h.ceremony.complete(open, "WORD-WORD")).toEqual({
      phase: open,
      message: "backend exploded",
    });
  });

  it("falls back to a plain message for a completion failure nobody named", async () => {
    const { h, phase } = await opened();
    const open = asOpen(phase);
    h.routes.complete.mockResolvedValue(overlapCast(undefined));
    expect(await h.ceremony.complete(open, "WORD-WORD")).toEqual({
      phase: open,
      message: CLAIM_WORDS.completeFallback,
    });
  });

  it("adversarial: a mistyped code keeps the claim open, never spends it", async () => {
    // A 401, like a spent bearer's — only the body's code tells them apart.
    const { h, phase } = await opened();
    const open = asOpen(phase);
    h.routes.complete.mockResolvedValue(
      json({ error: "invalid_user_code" }, 401),
    );
    const step = await h.ceremony.complete(open, "WRONG-CODE");
    expect(step.phase).toEqual(open);
    expect(step.message).toMatch(/did not match this claim/);
    expect(h.stashed()).toMatchObject({ claimId: "clm_1" });
  });

  it("forgets the bearer once the attempt fence closes", async () => {
    const { h, phase } = await opened();
    h.routes.complete.mockResolvedValue(
      json({ error: "too_many_attempts" }, 429),
    );
    const step = await h.ceremony.complete(asOpen(phase), "WRONG-CODE");
    expect(step.phase).toEqual({ kind: "token" });
    expect(h.stashed()).toBeNull();
  });

  it("pauses for sign-in, keeping the claim, when the session lapsed", async () => {
    const { h, phase } = await opened();
    h.routes.complete.mockResolvedValue(json({ error: "unauthorized" }, 401));
    const step = await h.ceremony.complete(asOpen(phase), "WORD-WORD");
    expect(step.phase).toEqual({
      kind: "paused",
      token: TOKEN,
      presented: true,
      reason: "identity",
    });
    expect(h.stashed()).toMatchObject({
      claimId: "clm_1",
      principalId: "prn_1",
    });
  });
});

describe("the guest path", () => {
  it("mints a provisional principal, then presents to it", async () => {
    const h = claimHarness();
    h.signIn(null);
    await h.ceremony.submit(TOKEN);
    expect(h.routes.present).not.toHaveBeenCalled();
    h.routes.present.mockResolvedValue(json(OPEN_CLAIM));
    const step = await h.ceremony.continueAsGuest(TOKEN, false);
    expect(h.routes.provisional).toHaveBeenCalledTimes(1);
    expect(step?.phase).toMatchObject({
      kind: "open",
      principalId: "prn_guest",
    });
    expect(h.stashed()).toMatchObject({ principalId: "prn_guest" });
  });

  it("keeps the claim waiting when no guest session can be started", async () => {
    const h = claimHarness();
    h.signIn(null);
    h.routes.provisional.mockRejectedValue(new Error("503"));
    expect(await h.ceremony.continueAsGuest(TOKEN, false)).toEqual({
      phase: {
        kind: "paused",
        token: TOKEN,
        presented: false,
        reason: "identity",
      },
      message: CLAIM_WORDS.guestFailed,
    });
    expect(h.routes.present).not.toHaveBeenCalled();
  });
});

describe("arrival", () => {
  it("hands a drop to the drop code and stashes nothing", () => {
    const h = claimHarness();
    const drop = { kind: "drop" as const, token: "osc_clm_a.b", key: "k" };
    expect(h.ceremony.start(drop)).toEqual(drop);
    expect(h.stashed()).toBeNull();
  });

  it("loads a fresh link, even over a stashed claim", () => {
    const h = claimHarness();
    h.seed({ token: "osc_clm_old.secret", presented: false });
    expect(h.ceremony.start({ kind: "claim", token: TOKEN })).toEqual({
      kind: "load",
      token: TOKEN,
      presented: false,
    });
  });

  it("refuses a leaked link and rests when nothing is waiting", () => {
    const h = claimHarness();
    expect(h.ceremony.start({ kind: "leaked" })).toEqual({
      kind: "refused",
      message: CLAIM_WORDS.leaked,
    });
    expect(h.ceremony.start({ kind: "none" })).toEqual({ kind: "idle" });
  });

  it("forgets the bearer on sign-out", () => {
    const h = claimHarness();
    h.seed({ token: TOKEN, presented: false });
    h.ceremony.forget();
    expect(h.stashed()).toBeNull();
  });
});
