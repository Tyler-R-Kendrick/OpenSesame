import { afterEach, beforeEach, expect, it } from "vitest";
import { bindHostedModelAuthority } from "../hosted-model-authority.js";
import { bindModelKeyBroker } from "../model-keys/active.js";
import { invokeWithModelKey } from "../model-keys/gateway.js";
import { harness } from "../model-keys/harness.test-support.js";
import { executeAiDelegatedRequest } from "./delegation.js";
import {
  canonicalDraft,
  delegatedAnswer,
  delegationFence,
  delegationFixture,
} from "./delegation.test-support.js";
import { saveAiConnection } from "./runtime.js";

let fixture: Awaited<ReturnType<typeof delegationFixture>>;
const releases: (() => void)[] = [];
beforeEach(async () => {
  fixture = await delegationFixture();
});
afterEach(async () => {
  for (const release of releases.splice(0).reverse()) release();
  await fixture.close();
});
const CALL = {
  operation: "invoke" as const,
  method: "POST",
  path: "/chat/completions",
  resource: "https://api.openai.com/v1",
  body: {
    model: "gpt-4o",
    messages: [{ role: "user", content: "Question" }],
    max_tokens: 100,
  },
};
async function delegatedRoot(id: string) {
  const h = harness({ senderConstraint: "dpop_optional" });
  // Keep a stale port deliberately: the execution boundary must independently reject a changed connection.
  h.connections.set(id, { providerId: "openai", verified: true });
  const key = await h.root(null, {
    connectionId: id,
    models: ["gpt-4o"],
    budget: {
      requests: 2,
      input_tokens: 1000,
      output_tokens: 300,
      max_output_tokens: 100,
    },
  });
  releases.push(bindModelKeyBroker(h.broker));
  releases.push(
    bindHostedModelAuthority({
      assertCurrent() {},
      fetch: delegationFence().fetch,
      read: () => null,
      connections: () => [],
      execute: executeAiDelegatedRequest,
    }),
  );
  return {
    h,
    key,
    remaining: () => h.broker.list()[0]?.remaining,
    spend: (call = CALL) =>
      invokeWithModelKey(
        { token: key.token, clientId: "app-1" },
        call,
        delegationFence(),
      ),
  };
}

it("preserves broker resource/model/output limits, request budgets and actual raw usage settlement", async () => {
  const id = await fixture.save();
  const root = await delegatedRoot(id);
  const budget = root.remaining();
  await expect(
    root.spend({ ...CALL, resource: "https://api.anthropic.com/v1" }),
  ).rejects.toMatchObject({ reason: "aud.mismatch" });
  await expect(
    root.spend({ ...CALL, body: { ...CALL.body, model: "gpt-4" } }),
  ).rejects.toMatchObject({ reason: "escalation.model" });
  await expect(
    root.spend({ ...CALL, body: { ...CALL.body, max_tokens: 101 } }),
  ).rejects.toMatchObject({ reason: "escalation.tokens" });
  expect(fixture.fetcher).not.toHaveBeenCalled();
  expect(root.remaining()).toEqual(budget);
  const first = await root.spend();
  expect(first.answer).toEqual(delegatedAnswer("openai"));
  expect(root.remaining()).toEqual({
    requests: 1,
    input_tokens: 991,
    output_tokens: 296,
  });
  await root.spend();
  await expect(root.spend()).rejects.toMatchObject({
    reason: "budget.exhausted",
  });
  expect(fixture.fetcher).toHaveBeenCalledTimes(2);
  expect(root.remaining()).toEqual({
    requests: 0,
    input_tokens: 982,
    output_tokens: 292,
  });
});

it("an old delegated key cannot lend a reconfigured custom connection to the canonical host, and undispatched work is refunded", async () => {
  const id = await fixture.save();
  const root = await delegatedRoot(id);
  const budget = root.remaining();
  await saveAiConnection(
    { ...canonicalDraft(), baseUrl: "https://custom.example/v1" },
    id,
  );
  fixture.fetcher.mockClear();
  await expect(root.spend()).rejects.toThrow(/canonical|delegation/);
  expect(fixture.fetcher).not.toHaveBeenCalled();
  expect(root.remaining()).toEqual(budget);
});
