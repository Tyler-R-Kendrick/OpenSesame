import { describe, expect, it } from "vitest";
import { harness } from "./harness.test-support.js";
import {
  BUDGET_PRESETS,
  KEY_LIFETIMES,
  modelNames,
  parseClientName,
  parseModelList,
  requestsLeft,
  timeLeft,
} from "./mint-form.js";

describe("what the sheet offers", () => {
  it("offers only choices the broker will issue, under the page's own policy", async () => {
    for (const preset of BUDGET_PRESETS)
      for (const lifetime of KEY_LIFETIMES) {
        const h = harness({ senderConstraint: "dpop_optional" });
        const issued = await h.root(null, {
          budget: preset.budget,
          lifetimeSeconds: lifetime.seconds,
        });
        expect(issued.token, `${preset.id}/${lifetime.label}`).toMatch(/^osk_/);
      }
  });

  it("names three budgets that grow, each with a cap on one answer", () => {
    expect(BUDGET_PRESETS.map((p) => p.id)).toEqual([
      "small",
      "medium",
      "large",
    ]);
    for (let i = 1; i < BUDGET_PRESETS.length; i++) {
      const [a, b] = [BUDGET_PRESETS[i - 1], BUDGET_PRESETS[i]];
      expect(b?.budget.requests).toBeGreaterThan(a?.budget.requests ?? 0);
      expect(b?.budget.output_tokens).toBeGreaterThan(
        a?.budget.output_tokens ?? 0,
      );
    }
  });
});

describe("reading what was typed", () => {
  it("reads a list of models however it is separated, once each", () => {
    expect(parseModelList("gpt-4o, gpt-4o-mini\ngpt-4o")).toEqual([
      "gpt-4o",
      "gpt-4o-mini",
    ]);
    expect(parseModelList("anthropic/*")).toEqual(["anthropic/*"]);
    expect(parseModelList("*")).toEqual(["*"]);
  });

  it("refuses a list with one entry that is not a model, rather than dropping it", () => {
    for (const text of [
      "",
      "   ",
      ",",
      "gpt-4o, bad entry!",
      "gpt-4o;rm",
      "../x",
      "a".repeat(161),
      Array.from({ length: 33 }, (_, i) => `m${i}`).join(","),
    ])
      expect(parseModelList(text), text).toBeNull();
  });

  it("reads an app's name only when it is one the broker will accept", () => {
    expect(parseClientName("  my-agent.v2 ")).toBe("my-agent.v2");
    for (const text of ["", " ", "has space", "-lead", "x".repeat(129), "é"])
      expect(parseClientName(text), text).toBeNull();
  });
});

describe("showing a key", () => {
  it("strips the provider off a model selector", () => {
    expect(
      modelNames({
        providerId: "openai",
        models: ["model:openai/gpt-4o", "model:openai/*", "other"],
      }),
    ).toEqual(["gpt-4o", "*", "other"]);
  });

  it("says how long is left in the largest whole unit", () => {
    const now = 1_000_000;
    expect(timeLeft(now - 1, now)).toBe("ended");
    expect(timeLeft(now, now)).toBe("ended");
    expect(timeLeft(now + 30_000, now)).toBe("under a minute");
    expect(timeLeft(now + 42 * 60_000 + 5, now)).toBe("42 min");
    expect(timeLeft(now + 3 * 3_600_000 + 59 * 60_000, now)).toBe("3 h");
  });

  it("counts requests left", () => {
    expect(
      requestsLeft({
        remaining: { requests: 1200, input_tokens: 0, output_tokens: 0 },
      }),
    ).toBe("1,200 requests left");
  });
});
