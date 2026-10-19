import { afterEach, describe, expect, it, vi } from "vitest";
import { validateAiConnection } from "./configuration.js";
import { inferAiConnection } from "./inference.js";
import { aiConnectionDraft } from "./presets.js";
import { aiHttpFixture } from "./protocol.test-support.js";
import { readAiTextStream } from "./stream.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});
const contracts = [
  {
    family: "openai_responses",
    path: "/custom/v1/responses",
    frames: [
      '{"type":"response.output_text.delta","delta":"Hello "}',
      '{"type":"response.output_text.delta","delta":"world"}',
      '{"type":"response.completed","response":{"status":"completed"}}',
    ],
  },
  {
    family: "openai_chat",
    path: "/custom/v1/chat/completions",
    frames: [
      '{"choices":[{"delta":{"role":"assistant"}}]}',
      '{"choices":[{"delta":{"content":"Hello "}}]}',
      '{"choices":[{"delta":{"content":"world"}}]}',
      "[DONE]",
    ],
  },
  {
    family: "anthropic_messages",
    path: "/custom/v1/messages",
    frames: [
      '{"type":"content_block_start","content_block":{"type":"text","text":""}}',
      '{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}',
      '{"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}',
      '{"type":"message_stop"}',
    ],
  },
  {
    family: "gemini_generate_content",
    path: "/custom/v1/models/test-model:streamGenerateContent?alt=sse",
    frames: [
      '{"candidates":[{"content":{"parts":[{"text":"Hello "}]}}]}',
      '{"candidates":[{"content":{"parts":[{"text":"world"}]},"finishReason":"STOP"}]}',
    ],
  },
] as const;

describe("streaming AI families over independent HTTP", () => {
  it.each(contracts)(
    "decodes $family completion and text deltas",
    async (contract) => {
      const fixture = await aiHttpFixture((_request, response) => {
        response.setHeader("content-type", "text/event-stream");
        for (const frame of contract.frames)
          response.write(`data: ${frame}\r\n\r\n`);
        response.end();
      });
      cleanups.push(fixture.close);
      const draft = validateAiConnection({
        ...aiConnectionDraft("byo-ai"),
        family: contract.family,
        baseUrl: fixture.baseUrl,
        model: "test-model",
        apiKey: "private-stream-key",
      });
      const chunks: string[] = [];
      const result = await inferAiConnection(
        draft,
        { model: draft.model, messages: [{ role: "user", content: "Hello" }] },
        fixture.transport,
        vi.fn(),
        (text) => chunks.push(text),
      );
      expect(chunks).toEqual(["Hello ", "world"]);
      expect(result.answer).toBe("Hello world");
      expect(fixture.requests[0]?.path).toBe(contract.path);
      const body = JSON.parse(fixture.requests[0]?.body ?? "{}");
      if (contract.family === "gemini_generate_content")
        expect(body).not.toHaveProperty("stream");
      else expect(body.stream).toBe(true);
    },
  );

  it("handles UTF-8 and CRLF split across arbitrary byte boundaries", async () => {
    const bytes = new TextEncoder().encode(
      'data: {"choices":[{"delta":{"content":"雪"}}]}\r\n\r\ndata: [DONE]\r\n\r\n',
    );
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    const chunks: string[] = [];
    expect(
      await readAiTextStream(
        response,
        "openai_chat",
        (text) => chunks.push(text),
        vi.fn(),
        new AbortController().signal,
      ),
    ).toBe("雪");
    expect(chunks).toEqual(["雪"]);
  });

  it("refuses truncated streams instead of reporting the partial answer as complete", async () => {
    const response = new Response(
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
    await expect(
      readAiTextStream(
        response,
        "openai_chat",
        vi.fn(),
        vi.fn(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "response" });
  });

  it("cancels a pending body read when the owning lease ends", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      headers: { "content-type": "text/event-stream" },
    });
    const lifetime = new AbortController();
    const pending = readAiTextStream(
      response,
      "openai_chat",
      vi.fn(),
      vi.fn(),
      lifetime.signal,
    );
    lifetime.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
