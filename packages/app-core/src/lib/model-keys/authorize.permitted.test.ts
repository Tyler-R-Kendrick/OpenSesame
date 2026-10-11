import type { BoundaryValue } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { ready } from "./harness.fixtures.test-support.js";
import {
  ANTHROPIC,
  FULL_BUDGET,
  GEMINI,
  OPENAI,
  expectRefused,
  harness,
  newSigner,
} from "./harness.test-support.js";

describe("a call a key permits", () => {
  it("answers with where to send it and what to send, and nothing that authenticates", async () => {
    const { h, signer, token } = await ready();
    const body = h.chat();
    const authorized = await h.call(token, signer, { body });
    expect(authorized).toMatchObject({
      providerId: "openai",
      connectionId: "conn-openai",
      url: "https://api.openai.com/v1/chat/completions",
      method: "POST",
      model: "gpt-4o",
      outputTokens: 100,
    });
    expect(authorized.body).toEqual(body);
    // the executor sends what was inspected, never a second reading of the caller's object
    expect(authorized.body).not.toBe(body);
    const wire = JSON.stringify(authorized);
    expect(wire).not.toContain(token);
    expect(Object.keys(authorized)).not.toContain("headers");
  });

  it("forwards the body it inspected even if the caller changes theirs afterwards", async () => {
    const { h, signer, token } = await ready();
    const body = h.chat();
    const authorized = await h.call(token, signer, { body });
    body.model = "gpt-4";
    body.max_tokens = 1_000_000;
    expect(authorized.body).toMatchObject({ model: "gpt-4o", max_tokens: 100 });
  });

  it("reads a body once, whatever its toJSON says the second time", async () => {
    const { h, signer, token } = await ready();
    let reads = 0;
    const sly = {
      toJSON() {
        reads += 1;
        return reads === 1 ? h.chat() : h.chat({ model: "gpt-4" });
      },
    };
    const authorized = await h.call(token, signer, { body: sly });
    expect(reads).toBe(1);
    expect(authorized.model).toBe("gpt-4o");
  });

  it("lists models on a key that may, and takes one request from its budget", async () => {
    const { h, signer, token } = await ready();
    const authorized = await h.call(token, signer, { operation: "list" });
    expect(authorized).toMatchObject({
      url: "https://api.openai.com/v1/models",
      method: "GET",
      body: null,
      model: null,
    });
    expect(h.broker.list()[0]?.remaining.requests).toBe(99);
  });

  it("charges the call against the budget it reserves", async () => {
    const { h, signer, token } = await ready();
    await h.call(token, signer, { body: h.chat() });
    const [view] = h.broker.list();
    expect(view?.remaining.requests).toBe(99);
    expect(view?.remaining.output_tokens).toBe(50_000 - 100);
    expect(view?.remaining.input_tokens).toBeLessThan(100_000);
  });

  it("works for a derived key exactly as for a root", async () => {
    const { h, signer, token } = await ready();
    const child = await h.exchange(
      token,
      {
        locations: [OPENAI.baseUrl],
        models: ["gpt-4o-mini"],
        actions: ["model.invoke"],
        budget: FULL_BUDGET,
      },
      { signer },
    );
    await expect(
      h.call(child.access_token, signer, {
        body: h.chat({ model: "gpt-4o-mini" }),
      }),
    ).resolves.toBeDefined();
    await expectRefused(
      h.call(child.access_token, signer, { body: h.chat({ model: "gpt-4o" }) }),
      "insufficient_scope",
      "escalation.model",
    );
    await expectRefused(
      h.call(child.access_token, signer, { operation: "list" }),
      "insufficient_scope",
      "escalation.action",
    );
  });
});

describe("other protocols", () => {
  it("reads an Anthropic call: model and a required output limit in the body", async () => {
    const h = harness();
    const signer = await newSigner();
    const root = await h.root(signer, {
      connectionId: "conn-anthropic",
      resource: ANTHROPIC.baseUrl,
      models: ["claude-sonnet-4"],
    });
    const call = (body: BoundaryValue, path = "/messages") =>
      h.call(root.token, signer, { target: ANTHROPIC, path, body });
    const body = {
      model: "claude-sonnet-4",
      max_tokens: 500,
      messages: [{ role: "user", content: "hi" }],
    };
    await expect(call(body)).resolves.toMatchObject({
      url: "https://api.anthropic.com/v1/messages",
      model: "claude-sonnet-4",
    });
    await expectRefused(
      call({ ...body, model: "claude-opus-4" }),
      "insufficient_scope",
      "escalation.model",
    );
    await expectRefused(
      call({ ...body, max_tokens: 5000 }),
      "insufficient_scope",
      "escalation.tokens",
    );
    await expectRefused(
      call({ ...body, max_tokens: undefined }),
      "invalid_request",
      "body.max_tokens",
    );
    await expectRefused(
      call({ ...body, thinking: { type: "enabled", budget_tokens: 5000 } }),
      "insufficient_scope",
      "body.thinking",
    );
    await expectRefused(
      call({
        ...body,
        thinking: { type: "enabled", budget_tokens: 100, x: 1 },
      }),
      "insufficient_scope",
      "body.thinking",
    );
    await expectRefused(
      call(body, "/chat/completions"),
      "insufficient_scope",
      "call.route",
    );
  });

  it("reads a Gemini call: the model is in the route, and nowhere else", async () => {
    const h = harness();
    const signer = await newSigner();
    const root = await h.root(signer, {
      connectionId: "conn-gemini",
      resource: GEMINI.baseUrl,
      models: ["gemini-2.5-flash"],
    });
    const call = (path: string, body: BoundaryValue) =>
      h.call(root.token, signer, { target: GEMINI, path, body });
    const body = {
      contents: [{ parts: [{ text: "hi" }] }],
      generationConfig: { maxOutputTokens: 200 },
    };
    await expect(
      call("/models/gemini-2.5-flash:generateContent", body),
    ).resolves.toMatchObject({
      url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      model: "gemini-2.5-flash",
    });
    await expectRefused(
      call("/models/gemini-2.5-pro:generateContent", body),
      "insufficient_scope",
      "escalation.model",
    );
    await expectRefused(
      call("/models/gemini-2.5-flash:streamGenerateContent", body),
      "insufficient_scope",
      "call.route",
    );
    await expectRefused(
      call("/models/gemini-2.5-flash:generateContent", {
        ...body,
        model: "gemini-2.5-pro",
      }),
      "insufficient_scope",
      "body.field",
    );
    await expectRefused(
      call("/models/gemini-2.5-flash:generateContent", {
        ...body,
        generationConfig: { maxOutputTokens: 9999 },
      }),
      "insufficient_scope",
      "escalation.tokens",
    );
    await expectRefused(
      call("/models/gemini-2.5-flash:generateContent", {
        ...body,
        generationConfig: { candidateCount: 4, maxOutputTokens: 5 },
      }),
      "insufficient_scope",
      "body.n",
    );
    await expectRefused(
      call("/models/gemini-2.5-flash:generateContent", {
        contents: body.contents,
      }),
      "invalid_request",
      "body.generationConfig",
    );
    await expectRefused(
      call("/models/../gemini-2.5-flash:generateContent", body),
      "insufficient_scope",
      "call.route",
    );
  });
});
