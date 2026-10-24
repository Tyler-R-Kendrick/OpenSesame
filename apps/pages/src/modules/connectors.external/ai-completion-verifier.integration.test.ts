/** @vitest-environment jsdom */
import type { ServerResponse } from "node:http";
import {
  aiCompletionSeams,
  aiConnectionFetch,
  readAiJson,
} from "@opensesame/app-core/lib/ai-connections/http.js";
import { aiConnectionDraft } from "@opensesame/app-core/lib/ai-connections/presets.js";
import { aiInferenceRequest } from "@opensesame/app-core/lib/ai-connections/protocol.js";
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
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { aiCompletionSnapshot } from "../../verification/ai-completion-verifier.js";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import { bindAiConnectionRuntime } from "./ai-connection-runtime.js";

const endpoint = "https://owned-ai.example/custom/v1";
const token = "private-v2-collector-token";
const answer = "Actual V2 answer";
const json = JSON.stringify({ choices: [{ message: { content: answer } }] });
const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\ndata: [DONE]\n\n`;
type Snapshot = ReturnType<typeof aiCompletionSnapshot>;
type Captured = { exchange: string; response: Response; signal: AbortSignal };
let vault: Awaited<ReturnType<typeof runtimeFixture>>;
let http: Awaited<ReturnType<typeof aiHttpFixture>>;
let activation: ReturnType<typeof createActivation>;
let pages: ReturnType<typeof createTestContext>;
let held: ServerResponse | undefined;
let holdNext: boolean;
let progress: ReturnType<typeof deferred<void>>;
let closed: ReturnType<typeof deferred<void>>;
let serial = 0;
const captures: Captured[] = [];

beforeEach(async () => {
  vault = await runtimeFixture();
  held = undefined;
  holdNext = false;
  progress = deferred<void>();
  closed = deferred<void>();
  captures.length = 0;
  http = await aiHttpFixture((request, response) => {
    const stream = Boolean(JSON.parse(request.body).stream);
    response.setHeader("x-opensesame-ai-exchange", `owned-v2-${++serial}`);
    response.setHeader(
      "content-type",
      stream ? "text/event-stream" : "application/json",
    );
    if (holdNext) {
      holdNext = false;
      held = response;
      response.on("close", () => {
        if (!response.writableEnded) closed.resolve();
      });
      response.write(sse);
    } else response.end(stream ? sse : json);
  });
  const descriptor = describeCapability("connectors.external");
  if (!descriptor)
    throw new Error("Missing actual external connector capability");
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
      if (!init?.signal) throw new Error("Actual Pages request signal missing");
      const url = new URL(String(input));
      expect(url.origin).toBe(new URL(endpoint).origin);
      const local = new URL(http.baseUrl);
      url.protocol = local.protocol;
      url.host = local.host;
      const response = await fetch(url, init);
      const exchange = response.headers.get("x-opensesame-ai-exchange");
      if (!exchange) throw new Error("Actual fixture exchange missing");
      captures.push({ exchange, response, signal: init.signal });
      return response;
    },
  });
  pages = createTestContext();
  const ctx = { ...pages.ctx, egress };
  activation = createActivation(ctx, "connectors.external");
  bindAiConnectionRuntime(ctx, activation);
});
afterEach(async () => {
  held?.destroy();
  activation.dispose();
  await http.close();
  await vault.close();
});
function draft(name = "Actual V2 Save") {
  return {
    ...aiConnectionDraft("byo-ai"),
    baseUrl: endpoint,
    model: "actual-model",
    apiKey: token,
    name,
  };
}
function input() {
  return {
    model: "actual-model",
    messages: [{ role: "user" as const, content: "Private V2 question" }],
  };
}
function record(snapshot: Snapshot, capture: Captured) {
  const matches = snapshot.requests.filter(
    (row) => row.exchange === capture.exchange,
  );
  expect(matches).toHaveLength(1);
  return matches[0];
}
function phaseChain(
  snapshot: Snapshot,
  capture: Captured,
  format: "json" | "sse",
) {
  const request = record(snapshot, capture);
  const bodies = snapshot.bodies.filter((row) => row.response === request.id);
  const operations = snapshot.operations.filter(
    (row) => row.owner === request.owner,
  );
  const links = snapshot.signalLinks.filter(
    (row) => row.httpSignal === request.httpSignal,
  );
  expect(bodies).toHaveLength(1);
  expect(operations).toHaveLength(1);
  expect(links).toHaveLength(1);
  const body = bodies[0];
  const operation = operations[0];
  const link = links[0];
  expect(body.owner).toBe(request.owner);
  expect(body.exchange).toBe(
    capture.response.headers.get("x-opensesame-ai-exchange"),
  );
  expect(body.format).toBe(format);
  expect(body.bytes).toBe(
    new TextEncoder().encode(format === "json" ? json : sse).byteLength,
  );
  expect(link.fetchSignal).toBe(request.fetchSignal);
  expect(link.at).toBeLessThan(request.requestAt);
  expect(request.requestAt).toBeLessThan(body.at);
  expect(body.at).toBeLessThan(operation.at);
  expect(operation.at).toBe(request.operationAt);
  expect(body.at).toBe(request.bodyAt);
  expect(request.signalsLiveThroughOperation).toBe(true);
  expect(capture.signal.aborted).toBe(false);
  expect(capture.response.body?.locked).toBe(false);
  return { request, body, operation, link };
}

it("records independently sourced body/exchange, operation owner and exact signal-link phases for actual Save and SSE", async () => {
  const saved = await saveAiConnection(draft());
  const onText = vi.fn();
  const result = await performSavedAiInference(
    saved.connectionId,
    input(),
    undefined,
    onText,
  );
  expect(onText).toHaveBeenCalledWith(answer);
  expect(result.answer).toBe(answer);
  expect(captures).toHaveLength(2);
  const snapshot = aiCompletionSnapshot();
  expect(snapshot.version).toBe(2);
  expect(snapshot.faults).toEqual([]);
  const savedChain = phaseChain(snapshot, captures[0], "json");
  const inferenceChain = phaseChain(snapshot, captures[1], "sse");
  expect(savedChain.request.owner).not.toBe(inferenceChain.request.owner);
  expect(savedChain.request.id).not.toBe(inferenceChain.request.id);
  expect(savedChain.link.fetchSignal).not.toBe(inferenceChain.link.fetchSignal);
  const exported = JSON.stringify(snapshot);
  for (const secret of [token, answer, "Private V2 question"])
    expect(exported).not.toContain(secret);
  snapshot.bodies[0].owner = -1;
  expect(aiCompletionSnapshot().bodies[0].owner).not.toBe(-1);
});

it.each(["caller", "lease"] as const)(
  "actual held A has no body/op seal while B finishes; %s withdrawal stays isolated",
  async (withdraw) => {
    const saved = await saveAiConnection(draft());
    const caller = new AbortController();
    holdNext = true;
    const pending = performSavedAiInference(
      saved.connectionId,
      input(),
      {
        signal: caller.signal,
        assertCurrent: () => caller.signal.throwIfAborted(),
      },
      () => progress.resolve(),
    );
    const settled = pending.then(
      (value) => ({ value }),
      (error: Error) => ({ error }),
    );
    try {
      await progress.promise;
      expect(captures).toHaveLength(2);
      const heldCapture = captures[1];
      const before = aiCompletionSnapshot();
      const a = record(before, heldCapture);
      expect(before.bodies.filter((row) => row.response === a.id)).toEqual([]);
      expect(before.operations.filter((row) => row.owner === a.owner)).toEqual(
        [],
      );
      await saveAiConnection(draft("Actual independent B"));
      expect(captures).toHaveLength(3);
      const completed = aiCompletionSnapshot();
      const b = phaseChain(completed, captures[2], "json");
      expect(b.request.owner).not.toBe(a.owner);
      expect(b.body.exchange).not.toBe(heldCapture.exchange);
      expect(b.link.httpSignal).not.toBe(a.httpSignal);
      expect(b.link.fetchSignal).not.toBe(a.fetchSignal);
      expect(heldCapture.signal.aborted).toBe(false);
      expect(held?.destroyed).toBe(false);
      if (withdraw === "caller") caller.abort();
      else pages.abort("Actual lease withdrawn");
      expect(await settled).toHaveProperty("error");
      await closed.promise;
      const after = aiCompletionSnapshot();
      expect(after.faults).toEqual([]);
      expect(after.bodies.filter((row) => row.response === a.id)).toEqual([]);
      expect(after.operations.filter((row) => row.owner === a.owner)).toEqual(
        [],
      );
      expect(after.signals.find((row) => row.id === a.httpSignal)).toEqual(
        expect.objectContaining({ abortedAt: expect.any(Number) }),
      );
      expect(after.signals.find((row) => row.id === a.fetchSignal)).toEqual(
        expect.objectContaining({ abortedAt: expect.any(Number) }),
      );
      expect(heldCapture.signal.aborted).toBe(true);
      expect(after.bodies.find((row) => row.response === b.request.id)).toEqual(
        b.body,
      );
      expect(
        after.operations.find((row) => row.owner === b.request.owner),
      ).toEqual(b.operation);
      expect(record(after, captures[2]).signalsLiveThroughOperation).toBe(true);
    } finally {
      caller.abort();
      await settled;
    }
  },
);

it("retires only physical forwarding at real JSON EOF without replacing the native Response", async () => {
  const transport = captureAiConnectionTransport();
  const check = () => transport.assertCurrent();
  const request = aiInferenceRequest(draft(), input());
  const response = await aiConnectionFetch(
    draft(),
    request.url,
    transport,
    check,
    request.body,
  );
  const capture = captures.at(-1);
  if (!capture) throw new Error("Missing actual fetch capture");
  expect(response).toBe(capture.response);
  expect(response.url).toBe(capture.response.url);
  expect(response.type).toBe(capture.response.type);
  expect(response.redirected).toBe(false);
  expect(response.status).toBe(200);
  expect(response.bodyUsed).toBe(false);
  const clone = Response.prototype.clone.call(response);
  expect(clone.url).toBe(response.url);
  expect(clone.type).toBe(response.type);
  expect(clone.redirected).toBe(response.redirected);
  expect(clone.status).toBe(response.status);
  expect(clone.statusText).toBe(response.statusText);
  expect([...clone.headers]).toEqual([...response.headers]);
  expect(clone.headers).not.toBe(response.headers);
  expect(await Response.prototype.text.call(clone)).toBe(json);
  expect(response.bodyUsed).toBe(false);
  await expect(readAiJson(response, check)).resolves.toEqual(JSON.parse(json));
  expect(response.bodyUsed).toBe(true);
  expect(response.body?.locked).toBe(false);
  pages.abort("Original lease ended after actual JSON EOF");
  expect(capture.signal.aborted).toBe(false);
  expect(() => transport.assertCurrent()).toThrow();
  expect(() => transport.fetch(request.url, { method: "POST" })).toThrow();
  expect(captures).toHaveLength(1);
});

it("keeps physical lease cancellation connected while a JSON body remains held open", async () => {
  holdNext = true;
  const transport = captureAiConnectionTransport();
  const check = () => transport.assertCurrent();
  const request = aiInferenceRequest(draft(), input());
  const response = await aiConnectionFetch(
    draft(),
    request.url,
    transport,
    check,
    request.body,
  );
  const capture = captures.at(-1);
  if (!capture) throw new Error("Missing actual held fetch capture");
  const before = aiCompletionSnapshot();
  const pending = readAiJson(response, check);
  const settled = pending.then(
    () => false,
    () => true,
  );
  expect(response.body?.locked).toBe(true);
  expect(capture.signal.aborted).toBe(false);
  pages.abort("Original lease ended before JSON EOF");
  expect(await settled).toBe(true);
  await closed.promise;
  expect(capture.signal.aborted).toBe(true);
  expect(response.body?.locked).toBe(false);
  const after = aiCompletionSnapshot();
  expect(after.bodies).toHaveLength(before.bodies.length);
  expect(after.operations).toHaveLength(before.operations.length);
});

it("still refuses a public Save when logical authority ends after EOF and before commit", async () => {
  const observe = aiCompletionSeams.observe;
  const before = aiCompletionSnapshot();
  aiCompletionSeams.observe = (event) => {
    observe?.(event);
    if (event.phase === "body") pages.abort("Original lease ended after EOF");
  };
  try {
    await expect(saveAiConnection(draft())).rejects.toThrow();
    expect(captures).toHaveLength(1);
    expect(captures[0].response.bodyUsed).toBe(true);
    expect(captures[0].signal.aborted).toBe(false);
    const after = aiCompletionSnapshot();
    expect(after.bodies).toHaveLength(before.bodies.length + 1);
    expect(after.operations).toHaveLength(before.operations.length);
    expect(vaultStore.getSnapshot().items).toHaveLength(0);
  } finally {
    aiCompletionSeams.observe = observe;
  }
});
