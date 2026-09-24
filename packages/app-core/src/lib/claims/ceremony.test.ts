/**
 * Opening a claim: the token phase, presenting, and resuming. Ported from the
 * console's `pages/ClaimPage.test.tsx` ("token phase", "presenting",
 * "resuming a presented claim") against the model the page will draw.
 */
import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { OPEN_CLAIM, TOKEN, claimHarness, json } from "./ceremony.fixture.js";
import { CLAIM_WORDS } from "./ceremony.js";

const OPEN_PHASE = {
  kind: "open",
  token: TOKEN,
  principalId: "prn_1",
  claim: {
    id: "clm_1",
    type: "agent",
    state: "presented",
    targetManifestDigest: "sha256:abc",
    itemIds: ["item-1", "item-2"],
  },
};

describe("token phase", () => {
  it("ignores a submit that is blank or only whitespace", async () => {
    const h = claimHarness();
    await expect(h.ceremony.submit("")).resolves.toBeNull();
    await expect(h.ceremony.submit("   ")).resolves.toBeNull();
    expect(h.routes.present).not.toHaveBeenCalled();
  });

  it("refuses a paste that is not a claim token without spending anything", async () => {
    const h = claimHarness();
    await expect(h.ceremony.submit("osc_dlg_a.b")).resolves.toEqual({
      phase: { kind: "token" },
      message: CLAIM_WORDS.notAToken,
    });
    expect(h.routes.present).not.toHaveBeenCalled();
  });

  it("pauses for an identity before spending an unpresented token", async () => {
    const h = claimHarness();
    h.signIn(null);
    const step = await h.ceremony.submit(` ${TOKEN} `);
    expect(h.routes.present).not.toHaveBeenCalled();
    expect(step).toEqual({
      phase: {
        kind: "paused",
        token: TOKEN,
        presented: false,
        reason: "identity",
      },
      message: CLAIM_WORDS.signInFirst,
    });
    expect(h.stashed()).toEqual({ token: TOKEN, presented: false });
  });

  it("resumes the ceremony once someone has signed in", async () => {
    const h = claimHarness();
    h.signIn(null);
    await h.ceremony.submit(TOKEN);
    h.signIn("prn_1");
    h.routes.present.mockResolvedValue(json(OPEN_CLAIM));
    const step = await h.ceremony.load(TOKEN, false);
    expect(h.routes.present).toHaveBeenCalledWith(TOKEN);
    expect(step?.phase).toEqual(OPEN_PHASE);
  });
});

describe("presenting", () => {
  it("presents a token for a signed-in principal and opens the claim", async () => {
    const h = claimHarness();
    h.routes.present.mockResolvedValue(json(OPEN_CLAIM));
    const step = await h.ceremony.submit(TOKEN);
    expect(h.routes.present).toHaveBeenCalledWith(TOKEN);
    expect(step).toEqual({ phase: OPEN_PHASE, message: null });
    expect(h.stashed()).toEqual({
      token: TOKEN,
      presented: true,
      claimId: "clm_1",
      principalId: "prn_1",
    });
  });

  it("refuses a claim that was already completed, and forgets it", async () => {
    const h = claimHarness();
    h.routes.present.mockResolvedValue(
      json({ ...OPEN_CLAIM, state: "completed" }),
    );
    expect(await h.ceremony.submit(TOKEN)).toEqual({
      phase: { kind: "token" },
      message: "This claim was already completed.",
    });
    expect(h.stashed()).toBeNull();
  });

  it("refuses a claim in any other unaccepted state", async () => {
    const h = claimHarness();
    h.routes.present.mockResolvedValue(
      json({ ...OPEN_CLAIM, state: "denied" }),
    );
    const step = await h.ceremony.submit(TOKEN);
    expect(step?.message).toBe(
      "This claim is denied and can no longer be accepted.",
    );
    expect(h.stashed()).toBeNull();
  });

  it("forgets a spent bearer when the server refuses it", async () => {
    const h = claimHarness();
    h.routes.present.mockResolvedValue(json({ error: "invalid_token" }, 401));
    expect(await h.ceremony.submit(TOKEN)).toEqual({
      phase: { kind: "token" },
      message: "This claim link is no longer valid. Ask for a fresh one.",
    });
    expect(h.stashed()).toBeNull();
  });

  it("explains an expired claim", async () => {
    const h = claimHarness();
    h.routes.present.mockResolvedValue(json({ error: "EXPIRED" }, 410));
    const step = await h.ceremony.submit(TOKEN);
    expect(step?.message).toBe("This claim expired. Ask for a fresh one.");
  });

  it("explains a claim that has already been decided", async () => {
    const h = claimHarness();
    h.routes.present.mockResolvedValue(
      json({ error: "INVALID_TRANSITION" }, 422),
    );
    const step = await h.ceremony.submit(TOKEN);
    expect(step?.message).toBe("This claim has already been decided.");
  });

  it("keeps the bearer and offers a retry on a server-side failure", async () => {
    const h = claimHarness();
    h.routes.present
      .mockResolvedValueOnce(json({ message: "overloaded" }, 500))
      .mockResolvedValueOnce(json(OPEN_CLAIM));
    expect(await h.ceremony.submit(TOKEN)).toEqual({
      phase: {
        kind: "paused",
        token: TOKEN,
        presented: false,
        reason: "retry",
      },
      message: "overloaded",
    });
    const retried = await h.ceremony.load(TOKEN, false);
    expect(h.routes.present).toHaveBeenCalledTimes(2);
    expect(retried?.phase).toEqual(OPEN_PHASE);
  });

  it("offers a retry when the network fails", async () => {
    const h = claimHarness();
    h.routes.present.mockRejectedValue(new TypeError("connection reset"));
    const step = await h.ceremony.submit(TOKEN);
    expect(step?.phase).toMatchObject({ kind: "paused", reason: "retry" });
    expect(step?.message).toMatch(/could not be reached/);
  });

  it("falls back to a plain message for a failure nobody named", async () => {
    const h = claimHarness();
    h.routes.present.mockResolvedValue(overlapCast(undefined));
    const step = await h.ceremony.submit(TOKEN);
    expect(step).toEqual({
      phase: {
        kind: "paused",
        token: TOKEN,
        presented: false,
        reason: "retry",
      },
      message: CLAIM_WORDS.loadFallback,
    });
  });

  it("never presents the same bearer twice while a load is in flight", async () => {
    const h = claimHarness();
    let release: (value: Response) => void = () => {};
    h.routes.present.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const first = h.ceremony.load(TOKEN, false);
    const second = h.ceremony.load(TOKEN, false);
    await expect(second).resolves.toBeNull();
    release(json(OPEN_CLAIM));
    expect((await first)?.phase).toEqual(OPEN_PHASE);
    expect(h.routes.present).toHaveBeenCalledTimes(1);
  });

  it("chaos: a superseded load never overwrites the one that replaced it", async () => {
    const h = claimHarness();
    let releaseOld: (value: Response) => void = () => {};
    h.routes.present
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            releaseOld = resolve;
          }),
      )
      .mockResolvedValueOnce(json({ ...OPEN_CLAIM, id: "clm_2" }));
    const older = h.ceremony.load("osc_clm_old.secret", false);
    const newer = await h.ceremony.load(TOKEN, false);
    releaseOld(json(OPEN_CLAIM));
    await expect(older).resolves.toBeNull();
    expect(newer?.phase).toMatchObject({ kind: "open", token: TOKEN });
    expect(h.stashed()).toMatchObject({ token: TOKEN, claimId: "clm_2" });
  });
});

describe("resuming a presented claim", () => {
  const PRESENTED = {
    token: TOKEN,
    presented: true,
    claimId: "clm_1",
    principalId: "prn_1",
  };

  it("reads the claim back when the stash and the session agree", async () => {
    const h = claimHarness();
    h.seed(PRESENTED);
    h.routes.read.mockResolvedValue(json(OPEN_CLAIM));
    const start = h.ceremony.start({ kind: "none" });
    expect(start).toEqual({ kind: "load", token: TOKEN, presented: true });
    const step = await h.ceremony.load(TOKEN, true);
    expect(h.routes.read).toHaveBeenCalledWith("clm_1", TOKEN);
    expect(h.routes.present).not.toHaveBeenCalled();
    expect(step?.phase).toEqual(OPEN_PHASE);
  });

  it("pauses for sign-in when a presented claim is waiting", async () => {
    const h = claimHarness();
    h.seed(PRESENTED);
    h.signIn(null);
    const step = await h.ceremony.load(TOKEN, true);
    expect(step?.message).toBe(CLAIM_WORDS.signInToFinish);
    expect(h.routes.read).not.toHaveBeenCalled();
  });

  it("gives up on a presented stash that cannot say whose review it is", async () => {
    const h = claimHarness();
    h.seed({ token: TOKEN, presented: true, claimId: "clm_1" });
    expect(await h.ceremony.load(TOKEN, true)).toEqual({
      phase: { kind: "token" },
      message: CLAIM_WORDS.unresumable,
    });
    expect(h.stashed()).toBeNull();
    expect(h.routes.read).not.toHaveBeenCalled();
  });

  it("refuses to resume a claim another account opened in this tab", async () => {
    const h = claimHarness();
    h.seed({ ...PRESENTED, principalId: "prn_other" });
    const step = await h.ceremony.load(TOKEN, true);
    expect(step?.message).toBe(CLAIM_WORDS.otherAccount);
    expect(h.stashed()).toBeNull();
    expect(h.routes.read).not.toHaveBeenCalled();
  });

  it("refuses to read one bearer's claim with another bearer", async () => {
    const h = claimHarness();
    h.seed(PRESENTED);
    const step = await h.ceremony.load("osc_clm_y.other", true);
    expect(step?.message).toBe(CLAIM_WORDS.unresumable);
    expect(h.routes.read).not.toHaveBeenCalled();
  });
});
