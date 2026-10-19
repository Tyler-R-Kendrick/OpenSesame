import { afterEach, expect, it, vi } from "vitest";
import {
  aiConnectionDraft,
  aiConnectionFamilies,
  aiConnectionPreset,
} from "./presets.js";
import {
  aiConnectionHeaders,
  aiInferenceAnswer,
  aiInferenceRequest,
} from "./protocol.js";
import { aiHttpFixture } from "./protocol.test-support.js";
import { inferReplicateAi } from "./replicate-inference.js";
import { readAiTextStream } from "./stream.js";
import {
  bindAiConnectionTransport,
  captureAiConnectionTransport,
} from "./transport.js";
import type { AiConnectionDraft } from "./types.js";
it("never sends a prediction through generic chat/answer/header/SSE handling", async () => {
  const draft: AiConnectionDraft = {
    ...aiConnectionDraft("byo-ai"),
    family: "replicate_predictions",
    model: "owner/model",
    baseUrl: "https://api.replicate.com/v1",
    apiKey: "private-replicate-token",
  };
  const input = {
    model: draft.model,
    messages: [{ role: "user" as const, content: '{"prompt":"real input"}' }],
  };
  expect(() => aiConnectionHeaders(draft)).toThrow("finite");
  expect(() => aiInferenceRequest(draft, input)).toThrow("finite");
  expect(() => aiInferenceAnswer(draft.family, {})).toThrow("finite");
  const response = new Response("data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
  await expect(
    readAiTextStream(
      response,
      draft.family,
      () => {},
      () => {},
      new AbortController().signal,
    ),
  ).rejects.toThrow("finite");
  expect(response.body?.locked).toBe(false);
  await response.body?.cancel();
});

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
function operation(baseUrl: string) {
  return {
    ...aiConnectionDraft("byo-ai"),
    family: "replicate_predictions" as const,
    baseUrl,
    model: "owner/model",
    apiKey: "replicate-private-token",
  };
}
const input = {
  model: "owner/model",
  messages: [
    { role: "user" as const, content: '{"prompt":"Finite prediction input."}' },
  ],
};
it("consumes real terminal HTTP output through the finite adapter without following artifact URLs", async () => {
  let polls = 0;
  const fixture = await aiHttpFixture((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        id: "finite-1",
        status:
          request.method === "POST"
            ? "starting"
            : ++polls === 1
              ? "processing"
              : "succeeded",
        output:
          polls === 2
            ? {
                text: "Actual finite answer",
                asset: "https://untrusted.example/output",
              }
            : undefined,
        urls: {
          get: "https://untrusted.example/get",
          cancel: "https://untrusted.example/cancel",
        },
      }),
    );
  });
  closes.push(fixture.close);
  const ambient = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("No ambient fallback"));
  const text = vi.fn();
  const result = await inferReplicateAi(
    operation(fixture.baseUrl),
    input,
    fixture.transport,
    fixture.transport.assertCurrent,
    text,
  );
  expect(JSON.parse(result.answer)).toEqual({
    text: "Actual finite answer",
    asset: "https://untrusted.example/output",
  });
  expect(
    fixture.requests.map(({ method, path }) => ({ method, path })),
  ).toEqual([
    { method: "POST", path: "/custom/v1/models/owner/model/predictions" },
    { method: "GET", path: "/custom/v1/predictions/finite-1" },
    { method: "GET", path: "/custom/v1/predictions/finite-1" },
  ]);
  expect(JSON.parse(fixture.requests[0]?.body ?? "")).toEqual({
    input: { prompt: "Finite prediction input." },
  });
  expect(
    fixture.requests.every(
      (r) =>
        r.headers.authorization === "Bearer replicate-private-token" &&
        r.headers.cookie === undefined,
    ),
  ).toBe(true);
  expect(text).toHaveBeenCalledExactlyOnceWith(result.answer);
  expect(ambient).not.toHaveBeenCalled();
});
it.each(["[]", "null", '"text"', "not JSON"])(
  "rejects %s operation input before any HTTP request",
  async (content) => {
    const fetcher = vi.fn();
    const controller = new AbortController();
    await expect(
      inferReplicateAi(
        operation("https://api.replicate.com/v1"),
        { ...input, messages: [{ role: "user", content }] },
        { fetch: fetcher, assertCurrent: () => {}, signal: controller.signal },
        () => {},
      ),
    ).rejects.toThrow("JSON object");
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it.each(["failed", "canceled", "empty", "oversized", "wrong-id"])(
  "withholds %s responses from terminal inference",
  async (mode) => {
    const fixture = await aiHttpFixture((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id:
            mode === "wrong-id" && request.method === "GET"
              ? "other-1"
              : "finite-2",
          status:
            request.method === "POST" && mode === "wrong-id"
              ? "starting"
              : ["failed", "canceled"].includes(mode)
                ? mode
                : "succeeded",
          output:
            mode === "empty"
              ? null
              : mode === "oversized"
                ? "a".repeat(32769)
                : "response",
        }),
      );
    });
    closes.push(fixture.close);
    const text = vi.fn();
    await expect(
      inferReplicateAi(
        operation(fixture.baseUrl),
        input,
        fixture.transport,
        fixture.transport.assertCurrent,
        text,
      ),
    ).rejects.toThrow();
    expect(text).not.toHaveBeenCalled();
  },
);
it("retains original captured caller authority and physically closes a held poll without late output", async () => {
  let held = () => {};
  let closed = false;
  const waiting = new Promise<void>((resolve) => {
    held = resolve;
  });
  const fixture = await aiHttpFixture((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "POST")
      response.end(JSON.stringify({ id: "held-1", status: "starting" }));
    else {
      response.write('{"id":"held-1","status":"succeeded","output":');
      response.on("close", () => {
        closed = true;
      });
      held();
    }
  });
  closes.push(fixture.close);
  const caller = new AbortController();
  const detach = bindAiConnectionTransport({
    ...fixture.transport,
    signal: AbortSignal.any([fixture.transport.signal, caller.signal]),
  });
  closes.push(async () => detach());
  const captured = captureAiConnectionTransport();
  const text = vi.fn();
  const done = expect(
    inferReplicateAi(
      operation(fixture.baseUrl),
      input,
      captured,
      captured.assertCurrent,
      text,
    ),
  ).rejects.toThrow();
  await waiting;
  caller.abort();
  await done;
  await vi.waitFor(() => expect(closed).toBe(true));
  expect(text).not.toHaveBeenCalled();
  expect(fixture.requests).toHaveLength(2);
});
it("cannot borrow a replacement transport after capturing the original", async () => {
  const controller = new AbortController();
  const first = vi.fn();
  const next = vi.fn();
  const release = bindAiConnectionTransport({
    fetch: first,
    assertCurrent: () => {},
    signal: controller.signal,
  });
  const captured = captureAiConnectionTransport();
  const detach = bindAiConnectionTransport({
    fetch: next,
    assertCurrent: () => {},
    signal: controller.signal,
  });
  try {
    release();
    await expect(
      inferReplicateAi(
        operation("https://api.replicate.com/v1"),
        input,
        captured,
        captured.assertCurrent,
      ),
    ).rejects.toThrow("changed");
    expect(first).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  } finally {
    detach();
  }
});
it("keeps the prediction family and partner hidden until saved runtime and UI are ready", () => {
  expect(
    aiConnectionFamilies("byo-ai").map((family) => family.id),
  ).not.toContain("replicate_predictions");
  expect(aiConnectionPreset("replicate")).toBeNull();
});
