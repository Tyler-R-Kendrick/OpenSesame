import type { JsonObject } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  FULL_BUDGET,
  OPENAI,
  expectRefused,
  harness,
  newSigner,
} from "./harness.test-support.js";

type BudgetPart = Partial<typeof FULL_BUDGET>;

const detail = (budget: BudgetPart, extra: JsonObject = {}) => ({
  locations: [OPENAI.baseUrl],
  models: ["gpt-4o"],
  actions: ["model.invoke", "model.list"],
  budget: { ...FULL_BUDGET, ...budget },
  ...extra,
});

async function rig(overrides = {}) {
  const h = harness();
  const signer = await newSigner();
  const root = await h.root(signer, overrides);
  const remaining = () =>
    h.broker.list().find((view) => view.id === root.id)?.remaining;
  const childOf = (token: string, budget: BudgetPart, from = signer) =>
    h.exchange(token, detail(budget), { signer: from });
  return { h, signer, root, remaining, childOf };
}

describe("authority is conserved down a chain", () => {
  it("gives two children no more between them than the parent held", async () => {
    const { h, signer, root, remaining } = await rig();
    const results = await Promise.allSettled([
      h.exchange(root.token, detail({ requests: 60 }), { signer }),
      h.exchange(root.token, detail({ requests: 60 }), { signer }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected");
    expect(refused?.status === "rejected" && refused.reason).toMatchObject({
      error: "invalid_authorization_details",
      reason: "escalation.budget_remaining",
    });
    expect(remaining()?.requests).toBe(40);
  });

  it("lets the parent split exactly what it has, and not one more", async () => {
    const { root, childOf, remaining } = await rig();
    await childOf(root.token, { requests: 60 });
    await childOf(root.token, { requests: 40 });
    expect(remaining()?.requests).toBe(0);
    await expectRefused(
      childOf(root.token, { requests: 1 }),
      "invalid_authorization_details",
      "escalation.budget_remaining",
    );
  });

  it("returns what a revoked child left unspent, and not what it spent", async () => {
    const { h, signer, root, childOf, remaining } = await rig();
    const child = await childOf(root.token, { requests: 60 });
    for (let i = 0; i < 10; i += 1) {
      const made = await h.call(child.access_token, signer, {
        operation: "list",
      });
      h.broker.settle(made.reservation, { sent: true });
    }
    expect(remaining()?.requests).toBe(40);
    await h.broker.revoke({ token: child.access_token });
    expect(remaining()?.requests).toBe(90);
    // spending is gone for good: the parent never gets back the ten the child used
    expect(remaining()?.requests).toBeLessThan(100);
  });

  it("returns a grandchild's remainder to its own parent, and a child's whole remainder to the root", async () => {
    const { h, signer, root, childOf, remaining } = await rig();
    const child = await childOf(root.token, { requests: 50 });
    const grand = await h.exchange(
      child.access_token,
      detail({ requests: 30 }),
      { signer },
    );
    const view = (id: string) => h.broker.list().find((row) => row.id === id);
    const childId = h.broker.list().find((row) => row.depth === 1)?.id ?? "";
    expect(view(childId)?.remaining.requests).toBe(20);
    await expectRefused(
      h.exchange(child.access_token, detail({ requests: 21 }), { signer }),
      "invalid_authorization_details",
      "escalation.budget_remaining",
    );
    await h.broker.revoke({ token: grand.access_token });
    expect(view(childId)?.remaining.requests).toBe(50);
    expect(remaining()?.requests).toBe(50);
    await h.broker.revoke({ token: child.access_token });
    expect(remaining()?.requests).toBe(100);
  });

  it("returns the budget of a key that simply expired", async () => {
    const { h, signer, root, remaining } = await rig();
    await h.exchange(
      root.token,
      detail({ requests: 70 }, { lifetime_seconds: 60 }),
      { signer },
    );
    expect(remaining()?.requests).toBe(30);
    h.clock.now += 61_000;
    expect(remaining()?.requests).toBe(100);
  });

  it("charges a derived key's calls to the derived key and never to its parent", async () => {
    const { h, signer, root, childOf, remaining } = await rig();
    const child = await childOf(root.token, { requests: 5 });
    await h.call(child.access_token, signer, { body: h.chat() });
    expect(remaining()?.requests).toBe(95);
    expect(
      h.broker.list().find((row) => row.depth === 1)?.remaining.requests,
    ).toBe(4);
  });
});

describe("a call reserves what it may cost, and settles to what it did", () => {
  it("refuses once the requests are gone", async () => {
    const { h, signer, root } = await rig({
      budget: {
        requests: 2,
        input_tokens: 100_000,
        output_tokens: 50_000,
        max_output_tokens: 4096,
      },
    });
    await h.call(root.token, signer, { body: h.chat() });
    await h.call(root.token, signer, { operation: "list" });
    await expectRefused(
      h.call(root.token, signer, { body: h.chat() }),
      "insufficient_scope",
      "budget.exhausted",
    );
  });

  it("refuses a call whose worst case does not fit, even though the key may issue it", async () => {
    const { h, signer, root } = await rig({
      budget: {
        requests: 10,
        input_tokens: 100_000,
        output_tokens: 50,
        max_output_tokens: 4096,
      },
    });
    await expectRefused(
      h.call(root.token, signer, { body: h.chat({ max_tokens: 100 }) }),
      "insufficient_scope",
      "budget.exhausted",
    );
    await expect(
      h.call(root.token, signer, { body: h.chat({ max_tokens: 50 }) }),
    ).resolves.toBeDefined();
  });

  it("counts the input it was sent", async () => {
    const { h, signer, root } = await rig({
      budget: {
        requests: 10,
        input_tokens: 1000,
        output_tokens: 50_000,
        max_output_tokens: 4096,
      },
    });
    const big = h.chat({
      messages: [{ role: "user", content: "x".repeat(5000) }],
    });
    await expectRefused(
      h.call(root.token, signer, { body: big }),
      "insufficient_scope",
      "budget.exhausted",
    );
  });

  it("refunds what a call did not use, from the provider's own report", async () => {
    const { h, signer, root, remaining } = await rig();
    const authorized = await h.call(root.token, signer, {
      body: h.chat({ max_tokens: 1000 }),
    });
    expect(remaining()?.output_tokens).toBe(50_000 - 1000);
    h.broker.settle(authorized.reservation, {
      sent: true,
      answer: { usage: { prompt_tokens: 12, completion_tokens: 40 } },
    });
    expect(remaining()).toEqual({
      requests: 99,
      input_tokens: 100_000 - 12,
      output_tokens: 50_000 - 40,
    });
  });

  it("gives back everything for a call that never left", async () => {
    const { h, signer, root, remaining } = await rig();
    const authorized = await h.call(root.token, signer, { body: h.chat() });
    h.broker.settle(authorized.reservation, { sent: false });
    expect(remaining()).toEqual({
      requests: 100,
      input_tokens: 100_000,
      output_tokens: 50_000,
    });
  });

  it("keeps the worst case when the provider reports no usage", async () => {
    const { h, signer, root, remaining } = await rig();
    const authorized = await h.call(root.token, signer, {
      body: h.chat({ max_tokens: 300 }),
    });
    h.broker.settle(authorized.reservation, {
      sent: true,
      answer: { choices: [] },
    });
    expect(remaining()?.output_tokens).toBe(50_000 - 300);
  });

  it("charges the usage a provider reports beyond the reservation, but never below zero", async () => {
    const { h, signer, root, remaining } = await rig({
      budget: {
        requests: 10,
        input_tokens: 100_000,
        output_tokens: 100,
        max_output_tokens: 4096,
      },
    });
    const authorized = await h.call(root.token, signer, {
      body: h.chat({ max_tokens: 100 }),
    });
    h.broker.settle(authorized.reservation, {
      sent: true,
      answer: { usage: { prompt_tokens: 5, completion_tokens: 5000 } },
    });
    expect(remaining()?.output_tokens).toBe(0);
  });

  it("ignores a usage report that is not a count", async () => {
    const { h, signer, root, remaining } = await rig();
    const authorized = await h.call(root.token, signer, {
      body: h.chat({ max_tokens: 100 }),
    });
    h.broker.settle(authorized.reservation, {
      sent: true,
      answer: { usage: { prompt_tokens: -5, completion_tokens: "lots" } },
    });
    expect(remaining()?.output_tokens).toBe(50_000 - 100);
  });

  it("settles once: a second settlement changes nothing", async () => {
    const { h, signer, root, remaining } = await rig();
    const authorized = await h.call(root.token, signer, {
      body: h.chat({ max_tokens: 100 }),
    });
    const answer = { usage: { prompt_tokens: 1, completion_tokens: 1 } };
    h.broker.settle(authorized.reservation, { sent: true, answer });
    const once = remaining();
    h.broker.settle(authorized.reservation, { sent: true, answer });
    h.broker.settle(authorized.reservation, { sent: false });
    expect(remaining()).toEqual(once);
  });

  it("cannot be talked into a refund by a settlement for a reservation it never made", async () => {
    const { h, signer, root, remaining } = await rig();
    await h.call(root.token, signer, { body: h.chat() });
    const before = remaining();
    h.broker.settle(
      {
        id: "made-up",
        keyId: root.id,
        requests: 1,
        inputTokens: 9999,
        outputTokens: 9999,
        settled: false,
      },
      { sent: false },
    );
    expect(remaining()).toEqual(before);
  });

  it("lets no more than the key's budget be spent however many calls arrive together", async () => {
    const { h, signer, root } = await rig({
      budget: {
        requests: 5,
        input_tokens: 100_000,
        output_tokens: 50_000,
        max_output_tokens: 4096,
      },
    });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        h.call(root.token, signer, { body: h.chat() }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    for (const r of results) {
      if (r.status === "rejected")
        expect(r.reason).toMatchObject({ error: "insufficient_scope" });
    }
  });

  it("holds the number of calls in flight, and frees a place when one settles", async () => {
    const { h, signer, root } = await rig();
    const held = [];
    for (let i = 0; i < 8; i += 1)
      held.push(await h.call(root.token, signer, { body: h.chat() }));
    await expectRefused(
      h.call(root.token, signer, { body: h.chat() }),
      "insufficient_scope",
      "inflight.limit",
    );
    const [first] = held;
    if (!first) throw new Error("no reservation");
    h.broker.settle(first.reservation, { sent: true, answer: {} });
    await expect(
      h.call(root.token, signer, { body: h.chat() }),
    ).resolves.toBeDefined();
  });

  it("returns a refund to the parent when the key was revoked while its call was in flight", async () => {
    const { h, signer, root, childOf, remaining } = await rig();
    const child = await childOf(root.token, {
      requests: 10,
      output_tokens: 1000,
      input_tokens: 5000,
    });
    const authorized = await h.call(child.access_token, signer, {
      body: h.chat({ max_tokens: 500 }),
    });
    await h.broker.revoke({ token: child.access_token });
    const before = remaining();
    h.broker.settle(authorized.reservation, {
      sent: true,
      answer: { usage: { prompt_tokens: 1, completion_tokens: 1 } },
    });
    // the 499 output tokens the call did not use go to the parent; the one it used stays spent
    expect(remaining()?.output_tokens).toBe((before?.output_tokens ?? 0) + 499);
  });
});
