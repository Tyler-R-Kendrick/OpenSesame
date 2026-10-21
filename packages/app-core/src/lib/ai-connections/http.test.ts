import { afterEach, describe, expect, it, vi } from "vitest";
import {
  aiCompletionSeams,
  aiConnectionFetch,
  aiProtocolFetch,
  readAiJson,
} from "./http.js";
import type { AiConnectionDraft, AiConnectionTransport } from "./types.js";
const draft: AiConnectionDraft = {
  providerId: "byo-ai",
  name: "HTTP regression",
  family: "openai_chat",
  baseUrl: "https://inference.example/v1",
  model: "model",
  authentication: "api-key",
  apiKey: "owned-http-test-credential",
  tokenParameter: "max_tokens",
};
function port() {
  const abort = new AbortController();
  const fetch = vi.fn<AiConnectionTransport["fetch"]>(
    async () =>
      new Response('{"id":"model"}', {
        headers: { "content-type": "application/json" },
      }),
  );
  const transport: AiConnectionTransport = {
    signal: abort.signal,
    assertCurrent: () => abort.signal.throwIfAborted(),
    fetch,
  };
  return { abort, fetch, transport };
}
afterEach(() => {
  aiCompletionSeams.observe = undefined;
  vi.restoreAllMocks();
});
describe("captured AI HTTP boundary", () => {
  it("preserves JSON auth, serialization, HTTP policy and completion observation", async () => {
    const local = port();
    const owner = vi.fn();
    const observe = vi.fn();
    aiCompletionSeams.observe = observe;
    const response = await aiConnectionFetch(
      draft,
      new URL("https://inference.example/v1/chat/completions"),
      local.transport,
      owner,
      { model: "model", messages: [], stream: false },
    );
    const init = local.fetch.mock.calls[0]?.[1];
    expect(init).toMatchObject({
      method: "POST",
      body: '{"model":"model","messages":[],"stream":false}',
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${draft.apiKey}`,
    );
    expect(await readAiJson(response, owner)).toEqual({ id: "model" });
    expect(observe.mock.calls.map(([event]) => event.phase)).toEqual([
      "request",
      "body",
    ]);
    expect(observe.mock.calls[0]?.[0]).toMatchObject({
      owner,
      transportSignal: local.abort.signal,
    });
  });
  it("omits GET bodies and preserves binary bytes and caller headers", async () => {
    const local = port();
    await aiConnectionFetch(
      draft,
      new URL(`${draft.baseUrl}/models`),
      local.transport,
      () => {},
    );
    expect(local.fetch.mock.calls[0]?.[1]).not.toHaveProperty("body");
    const body = new Uint8Array([0, 255, 13, 10]).buffer;
    await aiProtocolFetch(
      draft,
      new URL(`${draft.baseUrl}/speech-to-text`),
      {
        method: "POST",
        headers: {
          "xi-api-key": draft.apiKey,
          "content-type": "application/octet-stream",
        },
        body,
      },
      local.transport,
      () => {},
    );
    const sent = local.fetch.mock.calls[1]?.[1];
    expect(sent?.body).toBe(body);
    expect(new Headers(sent?.headers).get("xi-api-key")).toBe(draft.apiKey);
    expect(new Headers(sent?.headers).has("authorization")).toBe(false);
  });
  it.each([
    "https://escape.example/v1/models",
    "https://inference.example/v10/models",
  ])("rejects endpoint escape %s before HTTP", async (url) => {
    const local = port();
    await expect(
      aiConnectionFetch(draft, new URL(url), local.transport, () => {}),
    ).rejects.toMatchObject({ code: "configuration" });
    expect(local.fetch).not.toHaveBeenCalled();
  });
  it("rejects ended authority before JSON serialization or network", async () => {
    const local = port();
    local.abort.abort();
    const serialize = vi.spyOn(JSON, "stringify");
    await expect(
      aiConnectionFetch(
        draft,
        new URL(`${draft.baseUrl}/models`),
        local.transport,
        () => {},
        { model: "model", messages: [], stream: false },
      ),
    ).rejects.toThrow();
    expect(serialize).not.toHaveBeenCalled();
    expect(local.fetch).not.toHaveBeenCalled();
  });
  it.each([401, 403, 500])(
    "keeps HTTP %s failure generic and credential-free",
    async (status) => {
      const local = port();
      local.fetch.mockImplementation(
        async () => new Response(draft.apiKey, { status }),
      );
      await expect(
        aiConnectionFetch(
          draft,
          new URL(`${draft.baseUrl}/models`),
          local.transport,
          () => {},
        ),
      ).rejects.toMatchObject({
        code: status === 500 ? "response" : "authentication",
      });
    },
  );
  it("rejects authority withdrawal during fetch without observing success", async () => {
    const local = port();
    const observe = vi.fn();
    aiCompletionSeams.observe = observe;
    local.fetch.mockImplementation(async () => {
      local.abort.abort();
      return new Response("{}");
    });
    await expect(
      aiConnectionFetch(
        draft,
        new URL(`${draft.baseUrl}/models`),
        local.transport,
        () => {},
      ),
    ).rejects.toThrow();
    expect(observe).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "releases actual JSON EOF without cancelling its completed reader (malformed=%s)",
    async (malformed) => {
      const cancel = vi.spyOn(ReadableStreamDefaultReader.prototype, "cancel");
      const response = new Response(malformed ? "{" : '{"answer":"complete"}');
      const result = readAiJson(response, () => {});
      if (malformed)
        await expect(result).rejects.toMatchObject({ code: "response" });
      else await expect(result).resolves.toEqual({ answer: "complete" });
      expect(response.body?.locked).toBe(false);
      expect(cancel).not.toHaveBeenCalled();
    },
  );
  it("cancels a partial JSON producer and preserves the original authority error even when cancellation rejects", async () => {
    const initiating = new Error("Original JSON owner ended");
    const cancel = vi.fn(() => Promise.reject(new Error("Cancel failed")));
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"answer":'));
        },
        cancel,
      }),
    );
    let checks = 0;
    await expect(
      readAiJson(response, () => {
        if (++checks === 2) throw initiating;
      }),
    ).rejects.toBe(initiating);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });
  it("cancels an oversized JSON producer before EOF", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(512 * 1024 + 1));
        },
        cancel,
      }),
    );
    await expect(readAiJson(response, () => {})).rejects.toThrow(
      "exceeds the supported size",
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });
});
