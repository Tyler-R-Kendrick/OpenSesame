/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localRequestFixture } from "../local-request.fixture.js";
import { lockAllTombs } from "../vfs.js";
import { bindModelKeyBroker } from "./active.js";
import { expectRefused, harness } from "./harness.test-support.js";
import {
  PRESS_WINDOW_MS,
  confirmMint,
  custodianPrincipal,
  mintModelKey,
} from "./mint.js";
import { KEY_PATTERN } from "./vocabulary.js";

const releases: (() => void)[] = [];

beforeEach(() => {
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
});
afterEach(() => {
  for (const release of releases.splice(0)) release();
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const choice = {
  clientId: "agent-1",
  connectionId: "conn-openai",
  resource: "https://api.openai.com/v1",
  actions: ["model.invoke"] as const,
  models: ["gpt-4o"],
  budget: {
    requests: 20,
    input_tokens: 20_000,
    output_tokens: 10_000,
    max_output_tokens: 1024,
  },
  lifetimeSeconds: 3600,
};

/** Mint `what` on the person's press of Create for `shown`, the draft the sheet displayed. */
async function pressed(
  tomb: string,
  what: typeof choice,
  shown: typeof choice = what,
  at: number = Date.now(),
) {
  return mintModelKey(tomb, what, await confirmMint(tomb, shown, at));
}

async function ready() {
  const fixture = await localRequestFixture();
  const h = harness({ senderConstraint: "dpop_optional" });
  releases.push(bindModelKeyBroker(h.broker));
  return { fixture, h };
}

describe("handing an agent a key", () => {
  it("issues a root the person's vault approved, answerable to that person", async () => {
    const { fixture, h } = await ready();
    const issued = await pressed(fixture.tomb, choice);
    expect(issued.token).toMatch(KEY_PATTERN);
    const [view] = h.broker.list();
    expect(view).toMatchObject({
      clientId: "agent-1",
      providerId: "openai",
      models: ["model:openai/gpt-4o"],
      actions: ["model.invoke"],
      depth: 0,
      bound: false,
      status: "active",
    });
    expect(view?.remaining).toEqual({
      requests: 20,
      input_tokens: 20_000,
      output_tokens: 10_000,
    });
  });

  it("answers to the vault's custodian and to nobody a caller names", async () => {
    const { fixture } = await ready();
    expect(custodianPrincipal(fixture.tomb)).toBe(`custodian:${fixture.tomb}`);
    expect(custodianPrincipal("a b/c")).toBe("custodian:a_b_c");
    expect(custodianPrincipal("x".repeat(500))).toHaveLength(128);
  });

  it("refuses what the catalog, the connection or the policy cannot support", async () => {
    const { fixture, h } = await ready();
    await expectRefused(
      pressed(fixture.tomb, {
        ...choice,
        resource: "https://nowhere.example.test/v1",
      }),
      "invalid_target",
      "draft.resource",
    );
    await expectRefused(
      pressed(fixture.tomb, { ...choice, connectionId: "conn-missing" }),
      "invalid_target",
      "draft.connection",
    );
    await expectRefused(
      pressed(fixture.tomb, {
        ...choice,
        lifetimeSeconds: 9 * 60 * 60,
      }),
      "invalid_authorization_details",
      "lifetime.ceiling",
    );
    await expectRefused(
      pressed(fixture.tomb, {
        ...choice,
        budget: { ...choice.budget, max_output_tokens: 1_000_000 },
      }),
      "invalid_authorization_details",
      "budget.ceiling",
    );
    await expectRefused(
      pressed(fixture.tomb, { ...choice, clientId: "bad client!" }),
      "invalid_request",
      "draft.identifier",
    );
    expect(h.broker.list()).toHaveLength(0);
  });

  it("issues nothing when no broker is bound", async () => {
    const fixture = await localRequestFixture();
    await expectRefused(
      pressed(fixture.tomb, choice),
      "access_denied",
      "broker.unavailable",
    );
  });

  it("is refused by a vault that is locked, before it reaches the broker", async () => {
    const { fixture, h } = await ready();
    lockAllTombs();
    await expect(pressed(fixture.tomb, choice)).rejects.toThrow();
    expect(h.broker.list()).toHaveLength(0);
  });

  it("issues what the sheet showed, on a press that is still fresh", async () => {
    const { fixture, h } = await ready();
    const at = Date.now();
    const confirmation = await confirmMint(fixture.tomb, choice, at);
    const issued = await mintModelKey(
      fixture.tomb,
      choice,
      confirmation,
      () => at + PRESS_WINDOW_MS,
    );
    expect(issued.token).toMatch(KEY_PATTERN);
    expect(h.broker.list()).toHaveLength(1);
  });

  it("refuses a draft that is not the one the person was shown, and issues nothing", async () => {
    const { fixture, h } = await ready();
    const shown = await confirmMint(fixture.tomb, choice);
    for (const changed of [
      { ...choice, models: ["gpt-4o", "gpt-4o-mini"] },
      { ...choice, models: ["*"] },
      { ...choice, clientId: "agent-2" },
      { ...choice, lifetimeSeconds: 8 * 60 * 60 },
      { ...choice, budget: { ...choice.budget, requests: 21 } },
    ])
      await expectRefused(
        mintModelKey(fixture.tomb, changed, shown),
        "access_denied",
        "approval.digest_mismatch",
      );
    // A confirmation made in another vault is for another issuer.
    await expectRefused(
      mintModelKey(
        fixture.tomb,
        choice,
        await confirmMint("someone-elses-tomb", choice),
      ),
      "access_denied",
      "approval.digest_mismatch",
    );
    expect(h.broker.list()).toHaveLength(0);
  });

  it("makes one key per press: the same confirmation twice, or at once, is refused", async () => {
    const { fixture, h } = await ready();
    const press = await confirmMint(fixture.tomb, choice);
    const first = await mintModelKey(fixture.tomb, choice, press);
    expect(first.token).toMatch(KEY_PATTERN);
    await expectRefused(
      mintModelKey(fixture.tomb, choice, press),
      "access_denied",
      "approval.spent",
    );
    expect(h.broker.list()).toHaveLength(1);
    // Two tries at once on a new press: exactly one key.
    const next = await confirmMint(fixture.tomb, choice);
    const both = await Promise.allSettled([
      mintModelKey(fixture.tomb, choice, next),
      mintModelKey(fixture.tomb, choice, next),
    ]);
    expect(both.filter((one) => one.status === "fulfilled")).toHaveLength(1);
    expect(h.broker.list()).toHaveLength(2);
    // A new press of the same draft is a new approval.
    await pressed(fixture.tomb, choice);
    expect(h.broker.list()).toHaveLength(3);
  });

  it("does not spend a press that was refused", async () => {
    const { fixture, h } = await ready();
    const shown = await confirmMint(fixture.tomb, choice);
    await expectRefused(
      mintModelKey(fixture.tomb, { ...choice, models: ["*"] }, shown),
      "access_denied",
      "approval.digest_mismatch",
    );
    expect((await mintModelKey(fixture.tomb, choice, shown)).token).toMatch(
      KEY_PATTERN,
    );
    expect(h.broker.list()).toHaveLength(1);
  });

  it("refuses a press older than the window, and one from the future", async () => {
    const { fixture, h } = await ready();
    const at = Date.now();
    const old = await confirmMint(fixture.tomb, choice, at);
    await expectRefused(
      mintModelKey(fixture.tomb, choice, old, () => at + PRESS_WINDOW_MS + 1),
      "access_denied",
      "approval.stale",
    );
    await expectRefused(
      mintModelKey(fixture.tomb, choice, old, () => at + 5 * 60_000),
      "access_denied",
      "approval.stale",
    );
    await expectRefused(
      mintModelKey(
        fixture.tomb,
        choice,
        await confirmMint(fixture.tomb, choice, at + 60_000),
        () => at,
      ),
      "access_denied",
      "approval.stale",
    );
    expect(h.broker.list()).toHaveLength(0);
  });
});
