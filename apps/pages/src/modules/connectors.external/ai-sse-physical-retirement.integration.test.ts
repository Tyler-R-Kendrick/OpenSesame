/** @vitest-environment jsdom */
import type { ServerResponse } from "node:http";
import { aiCompletionSeams } from "@opensesame/app-core/lib/ai-connections/http.js";
import { inferAiConnection } from "@opensesame/app-core/lib/ai-connections/inference.js";
import { aiConnectionDraft } from "@opensesame/app-core/lib/ai-connections/presets.js";
import { aiHttpFixture } from "@opensesame/app-core/lib/ai-connections/protocol.test-support.js";
import {
  performSavedAiInference,
  saveAiConnection,
} from "@opensesame/app-core/lib/ai-connections/runtime.js";
import { captureAiConnectionTransport } from "@opensesame/app-core/lib/ai-connections/transport.js";
import { approvedPlan } from "@opensesame/app-core/lib/capabilities/__tests__/plan-fixtures.js";
import { describeCapability } from "@opensesame/app-core/lib/capabilities/catalog.js";
import { createEgressPort } from "@opensesame/app-core/lib/capabilities/egress.js";
import {
  deferred,
  runtimeFixture,
} from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import { bindAiConnectionRuntime } from "./ai-connection-runtime.js";

const endpoint = "https://owned-ai.example/custom/v1";
const answer = "Actual completed stream";
const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\ndata: [DONE]\n\n`;
let vault: Awaited<ReturnType<typeof runtimeFixture>>;
let http: Awaited<ReturnType<typeof aiHttpFixture>>;
let activation: ReturnType<typeof createActivation>;
let held: ServerResponse | undefined;
let hold: boolean;
let wrongMime: boolean;
let progress: ReturnType<typeof deferred<void>>;
let closed: ReturnType<typeof deferred<void>>;
let previousObserver: typeof aiCompletionSeams.observe;
const captures: { response: Response; signal: AbortSignal }[] = [];

beforeEach(async () => {
  vault = await runtimeFixture();
  hold = false;
  wrongMime = false;
  held = undefined;
  progress = deferred<void>();
  closed = deferred<void>();
  captures.length = 0;
  previousObserver = aiCompletionSeams.observe;
  http = await aiHttpFixture((request, response) => {
    const stream = Boolean(JSON.parse(request.body).stream);
    response.setHeader(
      "content-type",
      stream && !wrongMime ? "text/event-stream" : "application/json",
    );
    if (hold) {
      held = response;
      response.on("close", () => {
        if (!response.writableEnded) closed.resolve();
      });
      response.write(sse);
      progress.resolve();
    } else
      response.end(
        stream
          ? sse
          : JSON.stringify({ choices: [{ message: { content: answer } }] }),
      );
  });
  const descriptor = describeCapability("connectors.external");
  if (!descriptor) throw new Error("External connector capability missing");
  const plan = approvedPlan(["connectors.external"]);
  const admitted = {
    ...plan,
    network: {
      ...plan.network,
      externalServices: "allow" as const,
      allowedServiceOrigins: [new URL(endpoint).origin],
    },
  };
  const egress = createEgressPort({
    capability: descriptor,
    plan: () => admitted,
    allowedOrigins: [window.location.origin],
    async fetchImpl(input, init) {
      if (!init?.signal)
        throw new Error("Original physical Fetch signal missing");
      const url = new URL(String(input));
      expect(url.origin).toBe(new URL(endpoint).origin);
      const local = new URL(http.baseUrl);
      url.protocol = local.protocol;
      url.host = local.host;
      const response = await fetch(url, init);
      captures.push({ response, signal: init.signal });
      return response;
    },
  });
  const pages = createTestContext();
  const ctx = { ...pages.ctx, egress };
  activation = createActivation(ctx, "connectors.external");
  bindAiConnectionRuntime(ctx, activation);
});
afterEach(async () => {
  aiCompletionSeams.observe = previousObserver;
  held?.destroy();
  activation.dispose();
  await http.close();
  await vault.close();
});
function draft() {
  return {
    ...aiConnectionDraft("byo-ai"),
    baseUrl: endpoint,
    model: "actual-model",
    apiKey: "private-sse-retirement-key",
  };
}
const input = {
  model: "actual-model",
  messages: [{ role: "user" as const, content: "Question" }],
};
function captured() {
  const last = captures.at(-1);
  if (!last) throw new Error("Actual response missing");
  return last;
}

it("retires physical forwarding after real saved SSE EOF without replacing its Response", async () => {
  const saved = await saveAiConnection(draft());
  const caller = new AbortController();
  const chunks: string[] = [];
  const result = await performSavedAiInference(
    saved.connectionId,
    input,
    {
      signal: caller.signal,
      assertCurrent: () => caller.signal.throwIfAborted(),
    },
    (text) => chunks.push(text),
  );
  expect(result.answer).toBe(answer);
  expect(chunks).toEqual([answer]);
  const last = captured();
  expect(last.response.url).toContain("127.0.0.1:");
  expect(last.response.bodyUsed).toBe(true);
  expect(last.response.body?.locked).toBe(false);
  expect(last.signal.aborted).toBe(false);
  caller.abort();
  activation.dispose();
  expect(last.signal.aborted).toBe(false);
});

it("cancels a real held SSE body on caller withdrawal even after DONE was received", async () => {
  const saved = await saveAiConnection(draft());
  const caller = new AbortController();
  hold = true;
  const firstText = deferred<void>();
  const job = performSavedAiInference(
    saved.connectionId,
    input,
    {
      signal: caller.signal,
      assertCurrent: () => caller.signal.throwIfAborted(),
    },
    () => firstText.resolve(),
  );
  const rejected = expect(job).rejects.toThrow();
  await progress.promise;
  await firstText.promise;
  caller.abort();
  await rejected;
  await closed.promise;
  expect(held?.writableEnded).toBe(false);
  expect(captured().signal.aborted).toBe(true);
});

it("closes a held wrong-content-type response without relying on outer vault abort", async () => {
  hold = true;
  wrongMime = true;
  const transport = captureAiConnectionTransport();
  const job = inferAiConnection(
    draft(),
    input,
    transport,
    () => transport.assertCurrent(),
    () => {},
  );
  await expect(job).rejects.toThrow("invalid or incomplete");
  await closed.promise;
  expect(held?.writableEnded).toBe(false);
  activation.dispose();
  expect(captured().signal.aborted).toBe(false);
});

it("keeps logical owner withdrawal authoritative after real SSE EOF retirement", async () => {
  const saved = await saveAiConnection(draft());
  aiCompletionSeams.observe = (event) => {
    previousObserver?.(event);
    if (event.phase === "body" && event.format === "sse") activation.dispose();
  };
  await expect(
    performSavedAiInference(saved.connectionId, input, undefined, () => {}),
  ).rejects.toThrow();
  expect(captured().response.bodyUsed).toBe(true);
  expect(captured().signal.aborted).toBe(false);
});
