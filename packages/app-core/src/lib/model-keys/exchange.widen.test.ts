import type { JsonObject } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { narrow } from "./harness.fixtures.test-support.js";
import {
  ANTHROPIC,
  FULL_BUDGET,
  expectRefused,
  harness,
  newSigner,
} from "./harness.test-support.js";

describe("what an exchange refuses to widen", () => {
  async function ready(overrides = {}) {
    const h = harness();
    const signer = await newSigner();
    const parent = await h.root(signer, overrides);
    const before = JSON.stringify(h.broker.list());
    const attempt = (
      details: JsonObject | null,
      options: Parameters<typeof h.exchange>[2] = {},
    ) => h.exchange(parent.token, details, { signer, ...options });
    return { h, signer, parent, before, attempt };
  }

  it("another provider's resource", async () => {
    const { attempt, h, before } = await ready();
    await expectRefused(
      attempt(narrow({ locations: [ANTHROPIC.baseUrl] })),
      "invalid_target",
      "escalation.resource",
    );
    await expectRefused(
      attempt(narrow({ locations: undefined }), {
        extra: { resource: ANTHROPIC.baseUrl },
      }),
      "invalid_target",
      "escalation.resource",
    );
    await expectRefused(
      attempt(narrow(), {
        extra: { audience: "urn:opensesame:model:anthropic" },
      }),
      "invalid_target",
      "escalation.resource",
    );
    expect(JSON.stringify(h.broker.list())).toBe(before);
  });

  it("two resources that disagree, or one spelled another way", async () => {
    const { attempt } = await ready();
    await expectRefused(
      attempt(narrow(), { extra: { resource: ANTHROPIC.baseUrl } }),
      "invalid_target",
      "resource.disagree",
    );
    for (const spelled of [
      "https://API.openai.com/v1",
      "https://api.openai.com/v1/",
      "https://api.openai.com:443/v1",
      "https://api.openai.com/v1?x=1",
      "http://api.openai.com/v1",
      "https://api.openai.com.evil.test/v1",
      "https://api.openai.com@evil.test/v1",
    ]) {
      await expect(
        attempt(null, { extra: { resource: spelled } }),
      ).rejects.toMatchObject({ error: "invalid_target" });
    }
  });

  it("models outside the parent's list, including a wildcard over an exact list", async () => {
    const { attempt, h, before } = await ready();
    for (const models of [
      ["gpt-4"],
      ["gpt-4o", "gpt-4"],
      ["*"],
      ["gpt-4o/*"],
      ["GPT-4O"],
      ["gpt-4o "],
    ]) {
      await expect(attempt(narrow({ models }))).rejects.toMatchObject({
        error: "invalid_authorization_details",
      });
    }
    await expectRefused(
      attempt(narrow({ models: ["gpt-4"] })),
      "invalid_authorization_details",
      "escalation.models",
    );
    expect(JSON.stringify(h.broker.list())).toBe(before);
  });

  it("a subtree wider than the one the parent holds", async () => {
    const h = harness();
    const signer = await newSigner();
    const parent = await h.root(signer, {
      connectionId: "conn-openrouter",
      resource: "https://openrouter.ai/api/v1",
      models: ["anthropic/*", "openai/gpt-4o"],
    });
    const base = {
      locations: ["https://openrouter.ai/api/v1"],
      actions: ["model.invoke"],
      budget: FULL_BUDGET,
    };
    const ok = await h.exchange(
      parent.token,
      { ...base, models: ["anthropic/claude-3"] },
      { signer },
    );
    expect(ok.authorization_details[0]).toMatchObject({
      models: ["anthropic/claude-3"],
    });
    for (const models of [
      ["anthropic-evil/x"],
      ["*"],
      ["openai/*"],
      ["anthropic/claude-3", "meta/llama"],
    ]) {
      await expectRefused(
        h.exchange(parent.token, { ...base, models }, { signer }),
        "invalid_authorization_details",
        "escalation.models",
      );
    }
  });

  it("an action the parent does not hold, or two statements of the actions that disagree", async () => {
    const { attempt, h } = await ready({ actions: ["model.invoke"] });
    await expectRefused(
      attempt(narrow({ actions: ["model.list"] })),
      "invalid_scope",
      "escalation.actions",
    );
    await expectRefused(
      attempt(narrow({ actions: undefined }), {
        extra: { scope: "model.list" },
      }),
      "invalid_scope",
      "escalation.actions",
    );
    await expectRefused(
      attempt(narrow(), { extra: { scope: "model.list" } }),
      "invalid_request",
      "actions.disagree",
    );
    await expectRefused(
      attempt(narrow(), { extra: { scope: "admin" } }),
      "invalid_scope",
      "scope.unknown",
    );
    expect(h.broker.list()).toHaveLength(1);
  });

  it("more of any budget than the parent was given, or than it has left", async () => {
    const { attempt, h, before } = await ready();
    for (const key of ["requests", "input_tokens", "output_tokens"] as const) {
      await expectRefused(
        attempt(
          narrow({
            budget: {
              ...FULL_BUDGET,
              [key]: {
                requests: 101,
                input_tokens: 100_001,
                output_tokens: 50_001,
              }[key],
            },
          }),
        ),
        "invalid_authorization_details",
        "escalation.budget",
      );
    }
    await expectRefused(
      attempt(narrow({ budget: { ...FULL_BUDGET, max_output_tokens: 4097 } })),
      "invalid_authorization_details",
      "escalation.budget",
    );
    expect(JSON.stringify(h.broker.list())).toBe(before);
    // spend most of the parent's requests on one child; the next cannot exceed what is left
    await attempt(narrow({ budget: { ...FULL_BUDGET, requests: 95 } }));
    await expectRefused(
      attempt(narrow({ budget: { ...FULL_BUDGET, requests: 6 } })),
      "invalid_authorization_details",
      "escalation.budget_remaining",
    );
    await expect(
      attempt(narrow({ budget: { ...FULL_BUDGET, requests: 5 } })),
    ).resolves.toBeDefined();
  });

  it("an exchange that does not say what budget it wants", async () => {
    const { attempt } = await ready();
    await expectRefused(
      attempt(narrow({ budget: undefined })),
      "invalid_authorization_details",
      "budget.required",
    );
    await expectRefused(
      attempt(null),
      "invalid_authorization_details",
      "budget.required",
    );
    await expectRefused(
      attempt(narrow({ budget: { requests: 1 } })),
      "invalid_authorization_details",
      "budget.required",
    );
  });

  it("a delegation chain longer than the root allows", async () => {
    const h = harness();
    const signer = await newSigner();
    const root = await h.root(signer, { maximumDelegationDepth: 2 });
    const first = await h.exchange(
      root.token,
      narrow({ budget: { ...FULL_BUDGET, requests: 9 } }),
      { signer },
    );
    const second = await h.exchange(
      first.access_token,
      narrow({ budget: { ...FULL_BUDGET, requests: 8 } }),
      { signer },
    );
    await expectRefused(
      h.exchange(
        second.access_token,
        narrow({ budget: { ...FULL_BUDGET, requests: 7 } }),
        { signer },
      ),
      "invalid_grant",
      "depth.exceeded",
    );
    const flat = await h.root(signer, { maximumDelegationDepth: 0 });
    await expectRefused(
      h.exchange(flat.token, narrow(), { signer }),
      "invalid_grant",
      "depth.exceeded",
    );
  });

  it("a key whose connection was removed, or never verified", async () => {
    const { attempt, h } = await ready();
    h.connections.delete("conn-openai");
    await expectRefused(
      attempt(narrow()),
      "invalid_grant",
      "connection.unavailable",
    );
    h.connections.set("conn-openai", { providerId: "openai", verified: false });
    await expectRefused(
      attempt(narrow()),
      "invalid_grant",
      "connection.unavailable",
    );
    h.connections.set("conn-openai", {
      providerId: "anthropic",
      verified: true,
    });
    await expectRefused(
      attempt(narrow()),
      "invalid_grant",
      "connection.unavailable",
    );
  });
});
