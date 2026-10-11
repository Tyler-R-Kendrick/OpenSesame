import { describe, expect, it } from "vitest";
import { detail, ready } from "./harness.fixtures.test-support.js";
import { FULL_BUDGET, expectRefused } from "./harness.test-support.js";

/** Wait until the exchange under test is parked on the held hash. */
async function parked(gate: { holdOn: number; calls: number }) {
  while (gate.calls < gate.holdOn)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("an exchange that is overtaken", () => {
  it("does not extend a key that was revoked while the exchange was in flight", async () => {
    const { h, signer, root } = await ready();
    let release: () => void = () => undefined;
    h.gate.hold = new Promise((resolve) => {
      release = resolve;
    });
    // hashes in an exchange: the subject token's, then the new key's
    h.gate.holdOn = h.gate.calls + 2;
    const pending = h.exchange(root.token, detail(), { signer });
    const settled = pending.then(
      () => null,
      (error) => error,
    );
    await parked(h.gate);
    await h.broker.revoke({ id: root.id });
    release();
    const error = await settled;
    expect(error).toMatchObject({
      error: "invalid_grant",
      reason: "subject.inactive",
    });
    expect(h.broker.list().filter((view) => view.status === "active")).toEqual(
      [],
    );
    expect(h.broker.list()).toHaveLength(1);
  });

  it("does not extend a key that expired while the exchange was in flight", async () => {
    const { h, signer, root } = await ready({ lifetimeSeconds: 60 });
    let release: () => void = () => undefined;
    h.gate.hold = new Promise((resolve) => {
      release = resolve;
    });
    h.gate.holdOn = h.gate.calls + 2;
    const settled = h.exchange(root.token, detail(), { signer }).then(
      () => null,
      (error) => error,
    );
    await parked(h.gate);
    h.clock.now = root.expiresAt + 1;
    release();
    expect(await settled).toMatchObject({ reason: "subject.inactive" });
  });

  it("checks the budget again when it commits, not when it began", async () => {
    const { h, signer, root } = await ready();
    let release: () => void = () => undefined;
    h.gate.hold = new Promise((resolve) => {
      release = resolve;
    });
    h.gate.holdOn = h.gate.calls + 2;
    const slow = h
      .exchange(
        root.token,
        detail({ budget: { ...FULL_BUDGET, requests: 60 } }),
        { signer },
      )
      .then(
        () => null,
        (error) => error,
      );
    await parked(h.gate);
    h.gate.holdOn = 0;
    await h.exchange(
      root.token,
      detail({ budget: { ...FULL_BUDGET, requests: 60 } }),
      { signer },
    );
    release();
    expect(await slow).toMatchObject({ reason: "escalation.budget_remaining" });
  });
});

describe("a call that is overtaken", () => {
  it("is not authorized when the key is revoked while its proof is being checked", async () => {
    const { h, signer, root } = await ready();
    const before = h.broker.list()[0]?.remaining;
    // the clock is read once at the start and once after the proof is awaited
    let reads = 0;
    h.clockHooks.push(() => {
      reads += 1;
      if (reads === 2) void h.broker.revoke({ id: root.id });
    });
    await expectRefused(
      h.call(root.token, signer, { body: h.chat() }),
      "invalid_token",
      "key.inactive",
    );
    expect(h.broker.list()[0]?.remaining).toEqual({
      requests: 0,
      input_tokens: 0,
      output_tokens: 0,
    });
    expect(before).toEqual({
      requests: 100,
      input_tokens: 100_000,
      output_tokens: 50_000,
    });
  });
});
