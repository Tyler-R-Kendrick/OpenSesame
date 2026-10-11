/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localRequestFixture } from "../local-request.fixture.js";
import { lockAllTombs } from "../vfs.js";
import { bindModelKeyBroker } from "./active.js";
import { expectRefused, harness } from "./harness.test-support.js";
import { custodianPrincipal, mintModelKey } from "./mint.js";
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

async function ready() {
  const fixture = await localRequestFixture();
  const h = harness({ senderConstraint: "dpop_optional" });
  releases.push(bindModelKeyBroker(h.broker));
  return { fixture, h };
}

describe("handing an agent a key", () => {
  it("issues a root the person's vault approved, answerable to that person", async () => {
    const { fixture, h } = await ready();
    const issued = await mintModelKey(fixture.tomb, choice);
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
      mintModelKey(fixture.tomb, {
        ...choice,
        resource: "https://nowhere.example.test/v1",
      }),
      "invalid_target",
      "draft.resource",
    );
    await expectRefused(
      mintModelKey(fixture.tomb, { ...choice, connectionId: "conn-missing" }),
      "invalid_target",
      "draft.connection",
    );
    await expectRefused(
      mintModelKey(fixture.tomb, {
        ...choice,
        lifetimeSeconds: 9 * 60 * 60,
      }),
      "invalid_authorization_details",
      "lifetime.ceiling",
    );
    await expectRefused(
      mintModelKey(fixture.tomb, {
        ...choice,
        budget: { ...choice.budget, max_output_tokens: 1_000_000 },
      }),
      "invalid_authorization_details",
      "budget.ceiling",
    );
    await expectRefused(
      mintModelKey(fixture.tomb, { ...choice, clientId: "bad client!" }),
      "invalid_request",
      "draft.identifier",
    );
    expect(h.broker.list()).toHaveLength(0);
  });

  it("issues nothing when no broker is bound", async () => {
    const fixture = await localRequestFixture();
    await expectRefused(
      mintModelKey(fixture.tomb, choice),
      "access_denied",
      "broker.unavailable",
    );
  });

  it("is refused by a vault that is locked, before it reaches the broker", async () => {
    const { fixture, h } = await ready();
    lockAllTombs();
    await expect(mintModelKey(fixture.tomb, choice)).rejects.toThrow();
    expect(h.broker.list()).toHaveLength(0);
  });
});
