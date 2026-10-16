import { afterEach, describe, expect, it, vi } from "vitest";
import { validateAiConnection } from "./configuration.js";
import { inferAiConnection } from "./inference.js";
import { aiConnectionDraft } from "./presets.js";
import { aiHttpFixture } from "./protocol.test-support.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const input = {
  model: "test-model",
  maxOutputTokens: 32,
  messages: [
    { role: "system", content: "Be brief." },
    { role: "user", content: "Hello" },
  ] as const,
};
const contracts = [
  {
    family: "openai_responses",
    path: "/custom/v1/responses",
    reply: {
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "Responses answer" }],
        },
      ],
    },
    answer: "Responses answer",
  },
  {
    family: "openai_chat",
    path: "/custom/v1/chat/completions",
    reply: { choices: [{ message: { content: "Chat answer" } }] },
    answer: "Chat answer",
  },
  {
    family: "anthropic_messages",
    path: "/custom/v1/messages",
    reply: {
      type: "message",
      content: [{ type: "text", text: "Messages answer" }],
    },
    answer: "Messages answer",
  },
  {
    family: "gemini_generate_content",
    path: "/custom/v1/models/test-model:generateContent",
    reply: {
      candidates: [{ content: { parts: [{ text: "Gemini answer" }] } }],
    },
    answer: "Gemini answer",
  },
] as const;

describe("actual AI HTTP families", () => {
  it.each(contracts)(
    "uses $family wire format at the saved custom base",
    async (contract) => {
      const fixture = await aiHttpFixture((_request, response) => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(contract.reply));
      });
      cleanups.push(fixture.close);
      const draft = validateAiConnection({
        ...aiConnectionDraft("byo-ai"),
        family: contract.family,
        baseUrl: fixture.baseUrl,
        model: "test-model",
        apiKey: "private-api-key",
      });
      const result = await inferAiConnection(
        draft,
        { ...input, messages: [...input.messages] },
        fixture.transport,
        () => fixture.transport.assertCurrent(),
      );
      expect(result.answer).toBe(contract.answer);
      const request = fixture.requests[0];
      if (!request)
        throw new Error("The independent HTTP fixture received no request.");
      expect(request.path).toBe(contract.path);
      expect(request.method).toBe("POST");
      const body = JSON.parse(request.body);
      if (contract.family === "openai_responses") {
        expect(request.headers.authorization).toBe("Bearer private-api-key");
        expect(body).toMatchObject({
          model: "test-model",
          input: input.messages,
          max_output_tokens: 32,
          stream: false,
        });
        expect(body).not.toHaveProperty("messages");
      } else if (contract.family === "openai_chat") {
        expect(request.headers.authorization).toBe("Bearer private-api-key");
        expect(body).toMatchObject({
          model: "test-model",
          messages: input.messages,
          max_completion_tokens: 32,
          stream: false,
        });
      } else if (contract.family === "anthropic_messages") {
        expect(request.headers["x-api-key"]).toBe("private-api-key");
        expect(request.headers.authorization).toBeUndefined();
        expect(request.headers["anthropic-version"]).toBe("2023-06-01");
        expect(body).toMatchObject({
          model: "test-model",
          system: "Be brief.",
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 32,
        });
      } else {
        expect(request.headers["x-goog-api-key"]).toBe("private-api-key");
        expect(request.headers.authorization).toBeUndefined();
        expect(body).toMatchObject({
          contents: [{ role: "user", parts: [{ text: "Hello" }] }],
          systemInstruction: { parts: [{ text: "Be brief." }] },
          generationConfig: { maxOutputTokens: 32 },
        });
        expect(body).not.toHaveProperty("messages");
      }
      expect(request.path).not.toContain("private-api-key");
    },
  );

  it("allows explicit no-auth local endpoints and refuses a different model before HTTP", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const lifetime = new AbortController();
    const draft = validateAiConnection({
      ...aiConnectionDraft("byo-ai"),
      baseUrl: "http://localhost:11434/v1",
      model: "test-model",
      authentication: "none",
      apiKey: "ignored-key",
    });
    expect(draft.apiKey).toBe("");
    await expect(
      inferAiConnection(
        draft,
        { ...input, model: "other", messages: [...input.messages] },
        { fetch: fetcher, signal: lifetime.signal, assertCurrent: vi.fn() },
        vi.fn(),
      ),
    ).rejects.toThrow(/model saved/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sanitizes refused provider bodies and never reflects the submitted API key", async () => {
    const fixture = await aiHttpFixture((_request, response) => {
      response.statusCode = 401;
      response.end('{"error":"private-api-key"}');
    });
    cleanups.push(fixture.close);
    const draft = validateAiConnection({
      ...aiConnectionDraft("byo-ai"),
      baseUrl: fixture.baseUrl,
      model: "test-model",
      apiKey: "private-api-key",
    });
    await expect(
      inferAiConnection(
        draft,
        { ...input, messages: [...input.messages] },
        fixture.transport,
        vi.fn(),
      ),
    ).rejects.toMatchObject({ code: "authentication" });
  });
});
