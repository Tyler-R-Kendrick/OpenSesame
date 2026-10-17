import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { z } from "zod";
import { AI_EXCHANGE_HEADER } from "./ai-request-lifecycle.mjs";

export const AI_FIXTURE_KEY = "ai-browser-fixture-key";
export const AI_FIXTURE_MODEL = "fixture-model";
export const AZURE_FIXTURE_KEY = "azure-browser-fixture-key";
export const AZURE_FIXTURE_ENTRA = "azure-browser-fixture-entra";
const AZURE_TARGETS = [
  [
    "/azure/native-chat/openai/v1/chat/completions",
    "native-chat-deployment",
    "openai_chat",
    false,
  ],
  [
    "/azure/native-responses/openai/v1/responses",
    "native-responses-deployment",
    "openai_responses",
    true,
  ],
  [
    "/azure/byo-chat/openai/deployments/byo-chat-deployment/chat/completions?api-version=2024-06-01",
    "byo-chat-deployment",
    "openai_chat",
    true,
  ],
  [
    "/azure/byo-responses/openai/v1/responses",
    "byo-responses-deployment",
    "openai_responses",
    false,
  ],
];
function azureTarget(path) {
  const row = AZURE_TARGETS.find(([url]) => url === path);
  return row ? { model: row[1], family: row[2], bearer: row[3] } : null;
}
function azureAuth(target, headers) {
  return (
    headers["api-key"] === (target.bearer ? undefined : AZURE_FIXTURE_KEY) &&
    headers.authorization ===
      (target.bearer ? `Bearer ${AZURE_FIXTURE_ENTRA}` : undefined) &&
    headers["content-type"] === "application/json"
  );
}

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
function validBody(family, supplied, model) {
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
  if (body.model !== model) return false;
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
    "api-key,authorization,content-type,x-api-key,x-goog-api-key,anthropic-version,anthropic-dangerous-direct-browser-access",
  );
}

function sendFrames(response, frames, timers, index = 0) {
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
    sendFrames(response, frames, timers, index + 1);
  }, 15);
  timers.add(timer);
}
function deliver(response, family, text, stream, state, row) {
  const frames = streamFrames(family, text);
  const pending = state.pending;
  if (pending && pending.path === row.path && pending.stream === stream) {
    state.pending = null;
    pending.id = row.id;
    response.on("close", () => {
      pending.closed = !response.writableEnded;
      state.observer?.closed(pending, pending.closed);
    });
    pending.release = () => {
      if (pending.released) return;
      pending.released = true;
      state.observer?.release(pending);
      response.end(
        stream
          ? frames
              .slice(1)
              .map(
                (frame) =>
                  `data: ${frame === "[DONE]" ? frame : JSON.stringify(frame)}\n\n`,
              )
              .join("")
          : JSON.stringify(jsonReply(family, text)),
      );
    };
    Promise.resolve()
      .then(() => state.observer?.bindHold(pending, row.correlation))
      .then(() => {
        pending.started = true;
      })
      .catch(() => {
        state.errors.push({ id: row.id, status: "hold-binding" });
        response.destroy();
      });
    response.flushHeaders();
    if (stream) response.write(`data: ${JSON.stringify(frames[0])}\n\n`);
    return;
  }
  if (stream) sendFrames(response, frames, state.timers);
  else response.end(JSON.stringify(jsonReply(family, text)));
}
function requestStatus(row, allowed, body, target) {
  if (!row.family || row.method !== "POST") return 404;
  if (!allowed) return 401;
  if (!validBody(row.family, body, target?.model ?? AI_FIXTURE_MODEL))
    return 400;
  // This fixed dated target uses the documented legacy Chat cap.
  if (
    row.path ===
      "/azure/byo-chat/openai/deployments/byo-chat-deployment/chat/completions?api-version=2024-06-01" &&
    ("max_completion_tokens" in body || "max_output_tokens" in body)
  )
    return 400;
  return 200;
}
function accept(request, response, raw, state) {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${state.port}`);
  const path = url.pathname + url.search;
  const target = azureTarget(path);
  const family = target?.family ?? familyOf(url.pathname);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  const allowed =
    family &&
    (target
      ? azureAuth(target, request.headers)
      : authenticated(family, request.headers));
  const stream = Boolean(
    body?.stream || url.pathname.endsWith(":streamGenerateContent"),
  );
  const row = {
    id: `request-${state.requests.length + 1}`,
    correlation: `${state.nonce}:request-${state.requests.length + 1}`,
    path,
    family,
    method: request.method,
    authenticated: Boolean(allowed),
    stream,
    bytes: Buffer.byteLength(raw),
  };
  state.requests.push(row);
  state.bodies.set(row.id, body);
  const status = requestStatus(row, allowed, body, target);
  if (status !== 200) {
    state.errors.push({ id: row.id, status });
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Fixture rejected request" }));
    return;
  }
  const text = target
    ? `Fixture Azure ${target.model} answer`
    : `Fixture ${family} answer`;
  response.writeHead(200, {
    "content-type": stream ? "text/event-stream" : "application/json",
    "cache-control": "no-store",
    [AI_EXCHANGE_HEADER]: row.correlation,
  });
  deliver(response, family, text, stream, state, row);
}
function fixtureHandler(state) {
  return (request, response) => {
    cors(request, response, state.origins);
    if (request.method === "OPTIONS") {
      state.preflights.push({
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
      if (Buffer.byteLength(raw) > 64 * 1024) request.destroy();
    });
    request.on("end", () => accept(request, response, raw, state));
  };
}

/** Synthetic account only. Request summaries are safe to export; raw bodies stay in memory. */
export async function createAiConnectionHttpFixture({
  port = 41912,
  appOrigin = "http://127.0.0.1:41911",
  observer,
} = {}) {
  const requests = [];
  const preflights = [];
  const errors = [];
  const bodies = new Map();
  const timers = new Set();
  const origins = new Set([appOrigin, "http://localhost:41911"]);
  const state = {
    nonce: randomUUID(),
    observer,
    port,
    origins,
    requests,
    preflights,
    errors,
    bodies,
    timers,
    pending: null,
  };
  const holds = new Set();
  const server = createServer(fixtureHandler(state));
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
    holdNext(path, stream) {
      if (state.pending || !azureTarget(path))
        throw new Error("Invalid overlapping fixture hold");
      const pending = {
        path,
        stream,
        started: false,
        closed: false,
        released: false,
        id: null,
        release() {},
      };
      observer?.reserve(pending);
      pending.armCancellation = (reason) => {
        if (!observer) throw new Error("Cancellation observer missing");
        observer.arm(pending, reason);
      };
      state.pending = pending;
      holds.add(pending);
      return pending;
    },
    async close() {
      for (const pending of holds) pending.release();
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
