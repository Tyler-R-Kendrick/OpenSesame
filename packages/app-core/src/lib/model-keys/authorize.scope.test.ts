import { describe, expect, it } from "vitest";
import { ready } from "./harness.fixtures.test-support.js";
import {
  ANTHROPIC,
  expectRefused,
  harness,
  newSigner,
} from "./harness.test-support.js";

describe("what a key may not do", () => {
  it("use a model it was not narrowed to, in any spelling", async () => {
    const { h, signer, token } = await ready();
    for (const model of [
      "gpt-4",
      "GPT-4O",
      "gpt-4o/../x",
      "gpt-4o:ft",
      "gpt-4o-mini2",
      "o1",
    ]) {
      await expectRefused(
        h.call(token, signer, { body: h.chat({ model }) }),
        "insufficient_scope",
        "escalation.model",
      );
    }
    for (const model of [
      ["gpt-4o"],
      { id: "gpt-4o" },
      4,
      null,
      undefined,
      "",
      "gpt 4o",
      "gpt-4o\u0000",
      "gpt-4o\n",
    ]) {
      await expectRefused(
        h.call(token, signer, { body: h.chat({ model }) }),
        "invalid_request",
        "body.model",
      );
    }
  });

  it("use a wildcard grant on another provider's models", async () => {
    const h = harness();
    const signer = await newSigner();
    const root = await h.root(signer, { models: ["*"] });
    await expect(
      h.call(root.token, signer, {
        body: h.chat({ model: "anything-at-all" }),
      }),
    ).resolves.toBeDefined();
    await expectRefused(
      h.call(root.token, signer, {
        body: h.chat(),
        resource: ANTHROPIC.baseUrl,
      }),
      "invalid_token",
      "aud.mismatch",
    );
  });

  it("ask for more output than it may, or for no limit at all", async () => {
    const { h, signer, token } = await ready();
    await expect(
      h.call(token, signer, { body: h.chat({ max_tokens: 4096 }) }),
    ).resolves.toBeDefined();
    await expectRefused(
      h.call(token, signer, { body: h.chat({ max_tokens: 4097 }) }),
      "insufficient_scope",
      "escalation.tokens",
    );
    await expectRefused(
      h.call(token, signer, {
        body: h.chat({ max_tokens: 10, max_completion_tokens: 5000 }),
      }),
      "insufficient_scope",
      "escalation.tokens",
    );
    const noLimit = h.chat();
    noLimit.max_tokens = undefined;
    await expectRefused(
      h.call(token, signer, { body: noLimit }),
      "insufficient_scope",
      "tokens.required",
    );
    for (const max_tokens of [
      "100",
      1.5,
      0,
      -5,
      null,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      [100],
      { n: 1 },
      true,
    ]) {
      await expectRefused(
        h.call(token, signer, { body: h.chat({ max_tokens }) }),
        "invalid_request",
        "body.max_tokens",
      );
    }
  });

  it("turn on a feature nobody priced", async () => {
    const { h, signer, token } = await ready();
    await expectRefused(
      h.call(token, signer, { body: h.chat({ stream: true }) }),
      "insufficient_scope",
      "body.stream",
    );
    await expectRefused(
      h.call(token, signer, { body: h.chat({ n: 5 }) }),
      "insufficient_scope",
      "body.n",
    );
    await expectRefused(
      h.call(token, signer, { body: h.chat({ web_search_options: {} }) }),
      "insufficient_scope",
      "body.field",
    );
    await expectRefused(
      h.call(token, signer, { body: h.chat({ audio: { voice: "x" } }) }),
      "insufficient_scope",
      "body.field",
    );
    const poisoned = JSON.parse(
      '{"model":"gpt-4o","messages":[{"role":"user","content":"x"}],"max_tokens":5,"__proto__":{"admin":true}}',
    );
    await expectRefused(
      h.call(token, signer, { body: poisoned }),
      "insufficient_scope",
      "body.field",
    );
    await expect(
      h.call(token, signer, { body: h.chat({ stream: false, n: 1 }) }),
    ).resolves.toBeDefined();
  });

  it("send a body that is not a plain, bounded JSON object", async () => {
    const { h, signer, token } = await ready();
    const cycle = h.chat();
    cycle.self = cycle;
    await expectRefused(
      h.call(token, signer, { body: cycle }),
      "invalid_request",
      "body.json",
    );
    await expectRefused(
      h.call(token, signer, { body: { ...h.chat(), big: 10n } }),
      "invalid_request",
      "body.json",
    );
    await expectRefused(
      h.call(token, signer, { body: undefined }),
      "invalid_request",
      "body.json",
    );
    await expectRefused(
      h.call(token, signer, { body: null }),
      "invalid_request",
      "body.shape",
    );
    await expectRefused(
      h.call(token, signer, { body: [h.chat()] }),
      "invalid_request",
      "body.shape",
    );
    await expectRefused(
      h.call(token, signer, { body: "hello" }),
      "invalid_request",
      "body.shape",
    );
    await expectRefused(
      h.call(token, signer, {
        body: h.chat({
          messages: [{ role: "user", content: "x".repeat(130 * 1024) }],
        }),
      }),
      "invalid_request",
      "body.size",
    );
    await expectRefused(
      h.call(token, signer, { body: h.chat({ messages: [] }) }),
      "invalid_request",
      "body.messages",
    );
    await expectRefused(
      h.call(token, signer, { body: h.chat({ messages: "hi" }) }),
      "invalid_request",
      "body.messages",
    );
  });

  it("reach any route but the one its protocol names", async () => {
    const { h, signer, token } = await ready();
    for (const path of [
      "/chat/completions/",
      "//chat/completions",
      "/chat/completions?x=1",
      "/chat/completions#a",
      "/chat/../chat/completions",
      "/./chat/completions",
      "/Chat/Completions",
      "/chat/completions%2e",
      "chat/completions",
      "/v1/chat/completions",
      "/chat\\completions",
      "/chat/completions/../../files",
      `/${"a".repeat(300)}`,
      "/embeddings",
      "/files",
      "",
    ]) {
      await expectRefused(
        h
          .call(token, null, { path, body: h.chat(), proof: null, ...{} })
          .catch((error) => {
            // a bound key reaches the proof check only after the route is read, so route errors come first
            throw error;
          }),
        "insufficient_scope",
        "call.route",
      );
    }
    for (const method of ["GET", "PUT", "DELETE", "PATCH", "post"]) {
      await expectRefused(
        h.call(token, signer, { method, body: h.chat() }),
        "insufficient_scope",
        "call.route",
      );
    }
    await expectRefused(
      h.call(token, signer, { operation: "list", method: "POST" }),
      "insufficient_scope",
      "call.route",
    );
    await expectRefused(
      h.call(token, signer, { operation: "list", body: { x: 1 } }),
      "insufficient_scope",
      "call.route",
    );
    await expectRefused(
      h.call(token, signer, { operation: "list", path: "/files" }),
      "insufficient_scope",
      "call.route",
    );
  });
});
