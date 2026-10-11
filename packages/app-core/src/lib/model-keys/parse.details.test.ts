import type { BoundaryObject, BoundaryValue } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { parseModelAccessDetails } from "./details.js";
import { expectRefused } from "./harness.test-support.js";

describe("RFC 9396 model_access details", () => {
  const detail = (extra: BoundaryObject = {}) => [
    { type: "model_access", ...extra },
  ];
  const parse = (extra: BoundaryObject = {}) =>
    parseModelAccessDetails(detail(extra));
  const bad = (
    details: readonly BoundaryValue[],
    error: string,
    reason: string,
  ) => expectRefused(() => parseModelAccessDetails(details), error, reason);

  it("reads every member it defines", () => {
    expect(
      parse({
        locations: ["https://api.openai.com/v1"],
        actions: ["model.invoke"],
        models: ["gpt-4o", "anthropic/*", "*", "a/b/c", "gpt-4o:ft-x"],
        budget: {
          requests: 0,
          input_tokens: 1,
          output_tokens: 2,
          max_output_tokens: 3,
        },
        lifetime_seconds: 60,
      }),
    ).toEqual({
      locations: ["https://api.openai.com/v1"],
      actions: ["model.invoke"],
      models: ["gpt-4o", "anthropic/*", "*", "a/b/c", "gpt-4o:ft-x"],
      budget: {
        requests: 0,
        input_tokens: 1,
        output_tokens: 2,
        max_output_tokens: 3,
      },
      lifetimeSeconds: 60,
    });
    expect(parse()).toEqual({
      locations: [],
      actions: null,
      models: null,
      budget: null,
      lifetimeSeconds: null,
    });
  });

  it("refuses any type but its own, and any count but one", async () => {
    await bad(
      [{ type: "payment_initiation" }],
      "invalid_authorization_details",
      "detail.type",
    );
    await bad(
      [{ type: "MODEL_ACCESS" }],
      "invalid_authorization_details",
      "detail.type",
    );
    await bad([{}], "invalid_authorization_details", "detail.type");
    await bad([], "invalid_authorization_details", "details.count");
    await bad(
      [...detail(), ...detail()],
      "invalid_authorization_details",
      "details.count",
    );
    for (const notObject of [null, "x", 4, [], new Map(), new Date()]) {
      await bad([notObject], "invalid_authorization_details", "detail.shape");
    }
  });

  it("refuses a member it does not define, including the ones that look like trouble", async () => {
    for (const member of [
      "card",
      "cardNumber",
      "cvv",
      "token",
      "headers",
      "url",
      "endpoint",
      "api_key",
      "authorization",
      "constructor",
      "prototype",
      "extra",
    ]) {
      await bad(
        detail({ [member]: "x" }),
        "invalid_authorization_details",
        "detail.member",
      );
    }
    await bad(
      JSON.parse('[{"type":"model_access","__proto__":{"models":["*"]}}]'),
      "invalid_authorization_details",
      "detail.member",
    );
  });

  it("refuses a card number wherever a string could hold one", async () => {
    await bad(
      detail({ models: ["4111111111111111"] }),
      "invalid_authorization_details",
      "detail.payment",
    );
    await bad(
      detail({ locations: ["4111111111111111"] }),
      "invalid_authorization_details",
      "detail.payment",
    );
  });

  it("holds locations to one canonical resource", async () => {
    await bad(
      detail({ locations: [] }),
      "invalid_authorization_details",
      "locations.shape",
    );
    await bad(
      detail({ locations: ["https://a.example.com", "https://b.example.com"] }),
      "invalid_authorization_details",
      "locations.shape",
    );
    await bad(
      detail({ locations: ["https://a.example.com", "https://a.example.com"] }),
      "invalid_authorization_details",
      "locations.shape",
    );
    await bad(
      detail({ locations: "https://a.example.com" }),
      "invalid_authorization_details",
      "locations.shape",
    );
    await bad(
      detail({ locations: ["https://A.example.com/"] }),
      "invalid_target",
      "resource.host",
    );
  });

  it("holds actions to the ones there are, once each", async () => {
    for (const actions of [
      [],
      ["model.delete"],
      ["model.invoke", "model.invoke"],
      "model.invoke",
      [1],
      ["*"],
      Array(5).fill("model.list"),
    ]) {
      await expect(() => parse({ actions })).toThrow();
    }
  });

  it("holds models to ids, namespaces and a lone star", async () => {
    for (const models of [
      [],
      "gpt-4o",
      [1],
      [null],
      ["gpt-4o", "gpt-4o"],
      Array.from({ length: 33 }, (_, i) => `m${i}`),
    ]) {
      await expect(() => parse({ models })).toThrow();
    }
    for (const entry of [
      "",
      " ",
      "*x",
      "x*",
      "**",
      "a/**",
      "a//b",
      "/a",
      "a/",
      "a/*/b",
      "..",
      "a/../b",
      "a/./b",
      ".a",
      "-a",
      "a b",
      "a\u0000",
      "a\n",
      "é",
      "a?b",
      "a[b",
      "a(b)",
      "gpt-*",
      `${"a".repeat(161)}`,
    ]) {
      await bad(
        detail({ models: [entry] }),
        "invalid_authorization_details",
        "models.entry",
      );
    }
  });

  it("holds a budget to whole, bounded, known amounts", async () => {
    await bad(
      detail({ budget: {} }),
      "invalid_authorization_details",
      "budget.empty",
    );
    for (const budget of [null, [], "x", 5]) {
      await bad(
        detail({ budget }),
        "invalid_authorization_details",
        "detail.shape",
      );
    }
    await bad(
      detail({ budget: { tokens: 5 } }),
      "invalid_authorization_details",
      "budget.key",
    );
    await bad(
      detail({ budget: { requests: 1, dollars: 5 } }),
      "invalid_authorization_details",
      "budget.key",
    );
    for (const amount of [
      -1,
      1.5,
      "5",
      null,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1_000_000_001,
      2 ** 53,
      [5],
      true,
    ]) {
      await bad(
        detail({ budget: { requests: amount } }),
        "invalid_authorization_details",
        "budget.value",
      );
    }
    await bad(
      detail({ budget: { max_output_tokens: 0 } }),
      "invalid_authorization_details",
      "budget.value",
    );
    expect(parse({ budget: { requests: 0 } }).budget).toEqual({ requests: 0 });
  });

  it("holds a lifetime to a positive whole number of seconds a day or less", async () => {
    for (const lifetime_seconds of [
      0,
      -1,
      1.5,
      "60",
      null,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      86_401,
      [60],
    ]) {
      await bad(
        detail({ lifetime_seconds }),
        "invalid_authorization_details",
        "lifetime",
      );
    }
    expect(parse({ lifetime_seconds: 86_400 }).lifetimeSeconds).toBe(86_400);
  });

  it("refuses a detail nested deep enough to hide something", async () => {
    let nested: BoundaryObject = { v: 1 };
    for (let i = 0; i < 40; i += 1) nested = { n: nested };
    await bad(
      detail({ budget: nested }),
      "invalid_authorization_details",
      "budget.key",
    );
  });
});
