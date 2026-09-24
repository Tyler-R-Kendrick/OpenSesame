/**
 * How the approval ceremony ends, stalls and refuses to be driven twice.
 * Ports mobile-MFA's "terminal states" cases (`App.interaction.test.tsx`) and
 * adds the ordering rules its component kept implicitly.
 */
import type { JsonObject } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  activationBegin,
  activationDone,
  ceremony,
  detailBody,
  json,
  summaryBody,
} from "./interaction-approval.fixture.js";

const EXPIRES = new Date("2026-09-01T00:00:00.000Z");

describe("terminal states", () => {
  const cases: ReadonlyArray<[JsonObject, string]> = [
    [{ status: "expired" }, "expired"],
    [{ status: "consumed" }, "consumed"],
    [{ status: "revoked" }, "revoked"],
    [{ status: "denied" }, "denied"],
    [{ status: "approved" }, "approved"],
  ];

  for (const [over, outcome] of cases) {
    it(`ends on ${outcome} straight from the resolve, reading nothing`, async () => {
      const { approval, calls } = ceremony({
        resolve: json(200, summaryBody(over)),
      });
      expect((await approval.load())?.phase).toEqual({ kind: "done", outcome });
      expect(calls).toHaveLength(1);
      // Nothing is left to answer.
      expect(await approval.approve()).toBeNull();
      expect(await approval.deny()).toBeNull();
      expect(await approval.read()).toBeNull();
    });
  }

  it("ends a 410 as expired", async () => {
    const { approval } = ceremony({
      resolve: json(410, { error: "interaction_expired" }),
    });
    expect((await approval.load())?.phase).toEqual({
      kind: "done",
      outcome: "expired",
    });
  });

  it("ends a 404 as not found, telling nobody whether it ever existed", async () => {
    const { approval } = ceremony({ resolve: json(404, {}) });
    expect((await approval.load())?.phase).toEqual({
      kind: "done",
      outcome: "missing",
    });
  });

  it("stalls on a fault rather than spinning, and loads again on request", async () => {
    let answer = json(500, {});
    const { approval } = ceremony({ resolve: () => answer });
    const stalled = await approval.load();
    expect(stalled).toEqual({
      phase: { kind: "stalled" },
      message: "That request could not be answered. Try again shortly.",
    });
    answer = json(200, summaryBody());
    expect((await approval.load())?.phase.kind).toBe("signin");
  });

  it("says so when the session is refused, and stays on sign-in", async () => {
    const run = ceremony({
      resolve: json(200, summaryBody()),
      detail: json(401, {}),
    });
    // Nothing held yet: the phase says "sign in", so the message stays silent.
    expect((await run.approval.load())?.message).toBeNull();
    run.signIn();
    expect(await run.approval.read()).toEqual({
      phase: { kind: "signin", expiresAt: EXPIRES },
      message: "That sign-in was not accepted. Sign in again.",
    });
  });

  it("keeps a rate limit answerable rather than terminal", async () => {
    const run = ceremony({
      resolve: json(200, summaryBody()),
      detail: json(429, {}),
    });
    await run.approval.load();
    run.signIn();
    expect(await run.approval.read()).toEqual({
      phase: { kind: "signin", expiresAt: EXPIRES },
      message: "Too many attempts. Try again shortly.",
    });
  });

  it("ends when the request is withdrawn while it is on screen", async () => {
    const run = ceremony({
      resolve: json(200, summaryBody()),
      detail: json(200, detailBody()),
      deny: json(409, { error: "interaction_revoked" }),
    });
    await run.approval.load();
    run.signIn();
    await run.approval.read();
    expect((await run.approval.deny())?.phase).toEqual({
      kind: "done",
      outcome: "revoked",
    });
  });
});

describe("ordering", () => {
  const answering = () => ({
    resolve: json(200, summaryBody()),
    detail: () => json(200, detailBody()),
    activation: activationBegin(),
    complete: activationDone(),
    approve: json(200, detailBody({ status: "approved" })),
    deny: json(200, detailBody({ status: "denied" })),
  });

  it("drives one decision at a time", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = {
      available: () => true,
      assert: async () => {
        await gate;
        return {
          credentialId: "c",
          clientDataJSON: "a",
          authenticatorData: "b",
          signature: "d",
        };
      },
    };
    const run = ceremony(answering(), { port: slow, signedIn: true });
    await run.approval.load();
    const first = run.approval.approve();
    // A second tap, a deny and a re-read while the first is in flight: all
    // ignored, and only one activation is ever begun.
    expect(await run.approval.approve()).toBeNull();
    expect(await run.approval.deny()).toBeNull();
    expect(await run.approval.read()).toBeNull();
    release();
    expect((await first)?.phase).toEqual({ kind: "done", outcome: "approved" });
    const begun = run.calls.filter(({ url }) => url.endsWith("/activation"));
    expect(begun).toHaveLength(1);
  });

  it("drops a read that a decision overtook", async () => {
    const run = ceremony(answering(), { signedIn: true });
    await run.approval.load();
    const before = run.calls.length;
    const reading = run.approval.read();
    // The read is on the wire; the person denies before it answers.
    expect(run.calls.length).toBe(before + 1);
    const denied = await run.approval.deny();
    expect(denied?.phase).toEqual({ kind: "done", outcome: "denied" });
    expect(await reading).toBeNull();
    expect(run.approval.phase()).toEqual({ kind: "done", outcome: "denied" });
  });
});
