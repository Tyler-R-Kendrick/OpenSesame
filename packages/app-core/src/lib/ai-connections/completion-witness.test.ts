import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  deferred,
  runtimeFixture,
} from "../secret-backends/runtime.test-support.js";
import { vaultStore } from "../vault/store.js";
import { type AiCompletionObservation, aiCompletionSeams } from "./http.js";
import { aiConnectionDraft } from "./presets.js";
import { aiHttpFixture } from "./protocol.test-support.js";
import {
  performSavedAiInference,
  saveAiConnection,
  testAiConnection,
} from "./runtime.js";
import { savedAiConnections } from "./store.js";
import { bindAiConnectionTransport } from "./transport.js";
import { aiVaultSeams, captureAiVault } from "./vault-guard.js";

type Mode =
  | "valid"
  | "held"
  | "truncated"
  | "malformed"
  | "protocol"
  | "oversize";
let vault: Awaited<ReturnType<typeof runtimeFixture>>;
let http: Awaited<ReturnType<typeof aiHttpFixture>>;
let lease: AbortController;
let release = () => {};
let mode: Mode;
let held: ServerResponse | undefined;
let started: ReturnType<typeof deferred<void>>;
let closed: ReturnType<typeof deferred<void>>;
const events: AiCompletionObservation[] = [];
const responses: Response[] = [];
const httpSignals = new WeakMap<Response, AbortSignal>();
const chronology: string[] = [];
const json = JSON.stringify({
  choices: [{ message: { content: "Actual answer" } }],
});
const sse =
  'data: {"choices":[{"delta":{"content":"Actual answer"}}]}\n\ndata: [DONE]\n\n';

function reply(response: ServerResponse, stream: boolean) {
  const selected = mode;
  mode = "valid";
  response.setHeader(
    "content-type",
    stream ? "text/event-stream" : "application/json",
  );
  if (selected === "held" || selected === "oversize") {
    held = response;
    response.on("close", () => {
      if (!response.writableEnded) closed.resolve();
    });
    response.write(
      selected === "oversize" ? `"${"x".repeat(512 * 1024)}` : sse,
    );
    started.resolve();
  } else if (selected === "truncated") {
    response.setHeader("content-length", json.length + 10);
    response.setHeader("connection", "close");
    response.end(json);
  } else if (selected === "malformed")
    response.end(stream ? "data: {\n\n" : "{");
  else if (selected === "protocol")
    response.end(stream ? sse.replace("[DONE]", "{}") : "{}");
  else response.end(stream ? sse : json);
}

beforeEach(async () => {
  vault = await runtimeFixture();
  mode = "valid";
  held = undefined;
  events.length = 0;
  responses.length = 0;
  chronology.length = 0;
  started = deferred<void>();
  closed = deferred<void>();
  lease = new AbortController();
  http = await aiHttpFixture((request, response) => {
    reply(response, Boolean(JSON.parse(request.body).stream));
  });
  aiCompletionSeams.observe = (event) => {
    events.push(event);
    chronology.push(event.phase);
    if (event.phase === "body") expect(event.response.body?.locked).toBe(false);
  };
  vi.spyOn(aiVaultSeams, "capture").mockImplementation(async () => {
    const guard = await captureAiVault();
    const close = guard.close;
    guard.close = (completed) => {
      close(completed);
      chronology.push(`closed:${completed}`);
    };
    return guard;
  });
  release = bindAiConnectionTransport({
    signal: lease.signal,
    assertCurrent: () => lease.signal.throwIfAborted(),
    async fetch(input, init) {
      const response = await fetch(input, init);
      if (init?.signal) httpSignals.set(response, init.signal);
      responses.push(response);
      return response;
    },
  });
});
afterEach(async () => {
  aiCompletionSeams.observe = undefined;
  held?.destroy();
  release();
  lease.abort();
  vi.restoreAllMocks();
  await http.close();
  await vault.close();
});
function draft() {
  return {
    ...aiConnectionDraft("byo-ai"),
    baseUrl: http.baseUrl,
    model: "test-model",
    apiKey: "actual-completion-vault-token",
  };
}
function input() {
  return {
    model: "test-model",
    messages: [{ role: "user" as const, content: "Question" }],
  };
}
function reset() {
  events.length = 0;
  responses.length = 0;
  chronology.length = 0;
}
function completed() {
  return events.filter((event) => event.phase === "operation");
}
function bodyEvents() {
  return events.filter((event) => event.phase === "body");
}
function assertChain(format: "json" | "sse") {
  expect(events.map((event) => event.phase)).toEqual([
    "request",
    "body",
    "operation",
  ]);
  const request = events[0];
  const body = events[1];
  const operation = events[2];
  if (
    request?.phase !== "request" ||
    body?.phase !== "body" ||
    operation?.phase !== "operation"
  )
    throw new Error("Missing actual operation chain");
  expect(request.response).toBe(responses[0]);
  expect(request.httpSignal).toBe(httpSignals.get(request.response));
  expect(body.response).toBe(request.response);
  expect(body.owner).toBe(request.owner);
  expect(operation.owner).toBe(request.owner);
  expect(body.format).toBe(format);
  expect(body.bytes).toBe(
    new TextEncoder().encode(format === "json" ? json : sse).length,
  );
  expect(request.httpSignal.aborted).toBe(false);
  expect(request.transportSignal.aborted).toBe(false);
  expect(chronology).toEqual(["request", "body", "closed:true", "operation"]);
}

it("witnesses actual public Test, durable Save and selected SSE inference only after successful close", async () => {
  await expect(testAiConnection(draft())).resolves.toBe(
    "Model inference verified",
  );
  assertChain("json");
  reset();
  const saved = await saveAiConnection(draft());
  assertChain("json");
  expect(savedAiConnections().map(({ view }) => view.connectionId)).toContain(
    saved.connectionId,
  );
  expect(vaultStore.getSnapshot().items).toHaveLength(1);
  reset();
  const chunks: string[] = [];
  await expect(
    performSavedAiInference(saved.connectionId, input(), undefined, (text) =>
      chunks.push(text),
    ),
  ).resolves.toMatchObject({ answer: "Actual answer" });
  expect(chunks).toEqual(["Actual answer"]);
  assertChain("sse");
});

it("does not seal a fully consumed Save whose actual durable ledger write fails", async () => {
  vault.beforeAtomicWrite(async () => {
    throw new Error("Actual sealed ledger refused");
  });
  await expect(saveAiConnection(draft())).rejects.toThrow(
    "Actual sealed ledger refused",
  );
  vault.beforeAtomicWrite();
  expect(bodyEvents()).toHaveLength(1);
  expect(completed()).toHaveLength(0);
  expect(savedAiConnections()).toHaveLength(0);
  expect(chronology).toEqual(["request", "body", "closed:false"]);
});

it.each(["truncated", "malformed", "protocol", "oversize"] as const)(
  "withholds completion for a real %s JSON response",
  async (failure) => {
    mode = failure;
    await expect(testAiConnection(draft())).rejects.toThrow();
    expect(completed()).toHaveLength(0);
    expect(bodyEvents()).toHaveLength(failure === "protocol" ? 1 : 0);
    if (failure === "oversize") {
      await closed.promise;
      expect(held?.writableEnded).toBe(false);
    }
  },
);

it.each(["malformed", "protocol"] as const)(
  "withholds physical/protocol completion for a real %s SSE response",
  async (failure) => {
    const saved = await saveAiConnection(draft());
    reset();
    mode = failure;
    await expect(
      performSavedAiInference(saved.connectionId, input(), undefined, () => {}),
    ).rejects.toThrow();
    expect(bodyEvents()).toHaveLength(0);
    expect(completed()).toHaveLength(0);
  },
);

it.each(["caller", "lease", "lock"] as const)(
  "requires physical EOF after DONE and closes the actual body on %s withdrawal",
  async (owner) => {
    const saved = await saveAiConnection(draft());
    reset();
    mode = "held";
    const caller = new AbortController();
    const chunks: string[] = [];
    const progress = deferred<void>();
    const running = performSavedAiInference(
      saved.connectionId,
      input(),
      {
        signal: caller.signal,
        assertCurrent: () => caller.signal.throwIfAborted(),
      },
      (text) => {
        chunks.push(text);
        progress.resolve();
      },
    );
    const rejected = expect(running).rejects.toThrow();
    await started.promise;
    await progress.promise;
    expect(chunks).toEqual(["Actual answer"]);
    expect(bodyEvents()).toHaveLength(0);
    expect(completed()).toHaveLength(0);
    if (owner === "caller") caller.abort();
    else if (owner === "lease") lease.abort();
    else vaultStore.lock();
    await rejected;
    await closed.promise;
    expect(held?.writableEnded).toBe(false);
    expect(bodyEvents()).toHaveLength(0);
    expect(completed()).toHaveLength(0);
  },
);

it("cannot borrow concurrent B's successful owner/Response for held A", async () => {
  const saved = await saveAiConnection(draft());
  reset();
  mode = "held";
  const caller = new AbortController();
  const running = performSavedAiInference(
    saved.connectionId,
    input(),
    {
      signal: caller.signal,
      assertCurrent: () => caller.signal.throwIfAborted(),
    },
    () => {},
  );
  const rejected = expect(running).rejects.toThrow();
  await started.promise;
  await expect(testAiConnection(draft())).resolves.toBe(
    "Model inference verified",
  );
  const requests = events.filter((event) => event.phase === "request");
  expect(requests).toHaveLength(2);
  const first = requests[0];
  const second = requests[1];
  if (!first || !second) throw new Error("Missing actual concurrent requests");
  expect(first.response).not.toBe(second.response);
  expect(first.owner).not.toBe(second.owner);
  expect(completed().map((event) => event.owner)).toEqual([second.owner]);
  expect(bodyEvents().map((event) => event.response)).toEqual([
    second.response,
  ]);
  caller.abort();
  await rejected;
  await closed.promise;
  expect(completed().map((event) => event.owner)).toEqual([second.owner]);
});

it("withholds operation completion if original close throws after retiring its real guard", async () => {
  vi.spyOn(aiVaultSeams, "capture").mockImplementation(async () => {
    const guard = await captureAiVault();
    return {
      ...guard,
      close(completed) {
        guard.close(completed);
        expect(() => guard.check()).toThrow();
        throw new Error("Actual guard close failed");
      },
    };
  });
  await expect(testAiConnection(draft())).rejects.toThrow(
    "Actual guard close failed",
  );
  expect(bodyEvents()).toHaveLength(1);
  expect(completed()).toHaveLength(0);
});
