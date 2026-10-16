import { createServer } from "node:http";
import { z } from "zod";

export const AI_FIXTURE_KEY = "ai-browser-fixture-key";
export const AI_FIXTURE_MODEL = "fixture-model";

function familyOf(path) {
  if (path === "/custom/v1/chat/completions") return "openai_chat";
  if (path === "/custom/v1/responses") return "openai_responses";
  if (path === "/custom/v1/messages") return "anthropic_messages";
  if (
    path === `/custom/v1/models/${AI_FIXTURE_MODEL}:generateContent` ||
    path === `/custom/v1/models/${AI_FIXTURE_MODEL}:streamGenerateContent`
  )
    return "gemini_generate_content";
  return null;
}
function authenticated(family, headers) {
  if (family === "anthropic_messages")
    return (
      headers["x-api-key"] === AI_FIXTURE_KEY &&
      headers["anthropic-version"] === "2023-06-01"
    );
  if (family === "gemini_generate_content")
    return headers["x-goog-api-key"] === AI_FIXTURE_KEY;
  return headers.authorization === `Bearer ${AI_FIXTURE_KEY}`;
}
const Body = z
  .object({
    model: z.string().optional(),
    input: z.array(z.object({}).passthrough()).optional(),
    messages: z.array(z.object({}).passthrough()).optional(),
    contents: z.array(z.object({}).passthrough()).optional(),
    generationConfig: z
      .object({ maxOutputTokens: z.number().int() })
      .optional(),
    max_output_tokens: z.number().int().optional(),
    max_tokens: z.number().int().optional(),
    max_completion_tokens: z.number().int().optional(),
  })
  .passthrough();
function validBody(family, supplied) {
  const result = Body.safeParse(supplied);
  if (!result.success) return false;
  const body = result.data;
  if (family === "gemini_generate_content")
    return (
      Array.isArray(body.contents) &&
      body.contents.length > 0 &&
      Number.isInteger(body.generationConfig?.maxOutputTokens) &&
      !body.messages
    );
  if (body.model !== AI_FIXTURE_MODEL) return false;
  if (family === "openai_responses")
    return (
      Array.isArray(body.input) &&
      body.input.length > 0 &&
      Number.isInteger(body.max_output_tokens) &&
      !body.messages
    );
  return (
    Array.isArray(body.messages) &&
    body.messages.length > 0 &&
    Number.isInteger(body.max_tokens ?? body.max_completion_tokens)
  );
}
function jsonReply(family, text) {
  if (family === "openai_responses")
    return {
      id: "resp_fixture",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        },
      ],
    };
  if (family === "anthropic_messages")
    return {
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
    };
  if (family === "gemini_generate_content")
    return {
      candidates: [
        { content: { role: "model", parts: [{ text }] }, finishReason: "STOP" },
      ],
    };
  return {
    id: "chat_fixture",
    choices: [
      { message: { role: "assistant", content: text }, finish_reason: "stop" },
    ],
  };
}
function streamFrames(family, text) {
  const parts = ["Fixture ", text.slice("Fixture ".length)];
  if (family === "openai_responses")
    return [
      ...parts.map((delta) => ({ type: "response.output_text.delta", delta })),
      { type: "response.completed", response: { status: "completed" } },
    ];
  if (family === "anthropic_messages")
    return [
      ...parts.map((part) => ({
        type: "content_block_delta",
        delta: { type: "text_delta", text: part },
      })),
      { type: "message_stop" },
    ];
  if (family === "gemini_generate_content")
    return parts.map((part, index) => {
      const candidate = { content: { parts: [{ text: part }] } };
      if (index === parts.length - 1) candidate.finishReason = "STOP";
      return { candidates: [candidate] };
    });
  return [
    ...parts.map((content) => ({ choices: [{ delta: { content } }] })),
    "[DONE]",
  ];
}
function cors(request, response, origins) {
  const origin = request.headers.origin;
  if (origin && origins.has(origin))
    response.setHeader("access-control-allow-origin", origin);
  response.setHeader("vary", "Origin");
  response.setHeader("access-control-allow-methods", "POST, OPTIONS");
  response.setHeader(
    "access-control-allow-headers",
    "authorization,content-type,x-api-key,x-goog-api-key,anthropic-version,anthropic-dangerous-direct-browser-access",
  );
}

function fixtureHandler({
  port,
  origins,
  requests,
  preflights,
  errors,
  bodies,
  timers,
}) {
  return (request, response) => {
    cors(request, response, origins);
    if (request.method === "OPTIONS") {
      preflights.push({
        path: request.url,
        origin: request.headers.origin ?? "",
        method: request.headers["access-control-request-method"] ?? "",
        headers: request.headers["access-control-request-headers"] ?? "",
      });
      response.writeHead(204);
      response.end();
      return;
    }
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk.toString();
      if (raw.length > 64 * 1024) request.destroy();
    });
    request.on("end", () => {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
      const family = familyOf(url.pathname);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      const allowed = family && authenticated(family, request.headers);
      const stream = Boolean(
        body?.stream || url.pathname.endsWith(":streamGenerateContent"),
      );
      const id = `request-${requests.length + 1}`;
      requests.push({
        id,
        path: url.pathname + url.search,
        family,
        method: request.method,
        authenticated: Boolean(allowed),
        stream,
        bytes: Buffer.byteLength(raw),
      });
      bodies.set(id, body);
      const status =
        !family || request.method !== "POST"
          ? 404
          : !allowed
            ? 401
            : !validBody(family, body)
              ? 400
              : 200;
      if (status !== 200) {
        errors.push({ id, status });
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Fixture rejected request" }));
        return;
      }
      const text = `Fixture ${family} answer`;
      if (!stream) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(jsonReply(family, text)));
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      });
      const frames = streamFrames(family, text);
      function send(index) {
        if (response.destroyed) return;
        const frame = frames[index];
        response.write(
          `data: ${frame === "[DONE]" ? frame : JSON.stringify(frame)}\n\n`,
        );
        if (index === frames.length - 1) {
          response.end();
          return;
        }
        const timer = setTimeout(() => {
          timers.delete(timer);
          send(index + 1);
        }, 15);
        timers.add(timer);
      }
      send(0);
    });
  };
}

/** Synthetic account only. Request summaries are safe to export; raw bodies stay in memory. */
export async function createAiConnectionHttpFixture({
  port = 41912,
  appOrigin = "http://127.0.0.1:41911",
} = {}) {
  const requests = [];
  const preflights = [];
  const errors = [];
  const bodies = new Map();
  const timers = new Set();
  const origins = new Set([appOrigin, "http://localhost:41911"]);
  const server = createServer(
    fixtureHandler({
      port,
      origins,
      requests,
      preflights,
      errors,
      bodies,
      timers,
    }),
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    baseUrl: `http://127.0.0.1:${port}/custom/v1`,
    requests,
    preflights,
    errors,
    bodies,
    async close() {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
