/** @vitest-environment jsdom */
import type { ServerResponse } from "node:http";
import { aiHttpFixture } from "@opensesame/app-core/lib/ai-connections/protocol.test-support.js";
import { inferStabilityAi } from "@opensesame/app-core/lib/ai-connections/stability-inference.js";
import { RASTER_FIXTURES } from "@opensesame/app-core/lib/ai-connections/stability-tls.test-support.js";
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

const endpoint = "https://owned-image.example/custom/images";
const token = "private-image-retirement-key";
const reply = JSON.stringify({
  image: RASTER_FIXTURES.png,
  finish_reason: "SUCCESS",
  seed: 23,
});
let vault: Awaited<ReturnType<typeof runtimeFixture>>;
let http: Awaited<ReturnType<typeof aiHttpFixture>>;
let activation: ReturnType<typeof createActivation>;
let held: ServerResponse | undefined;
let mode: "complete" | "held" | "wrong-mime" | "oversized";
let progress: ReturnType<typeof deferred<void>>;
let closed: ReturnType<typeof deferred<void>>;
let capturedHeaders: ReturnType<typeof deferred<void>>;
const captures: { response: Response; signal: AbortSignal }[] = [];

beforeEach(async () => {
  vault = await runtimeFixture();
  mode = "complete";
  held = undefined;
  progress = deferred<void>();
  closed = deferred<void>();
  capturedHeaders = deferred<void>();
  captures.length = 0;
  http = await aiHttpFixture((request, response) => {
    expect(request.headers.authorization).toBe(`Bearer ${token}`);
    expect(request.path).toBe("/custom/images/generate/sd3");
    expect(request.headers["content-type"]).toContain(
      "multipart/form-data; boundary=",
    );
    response.setHeader(
      "content-type",
      mode === "wrong-mime" ? "text/plain" : "application/json",
    );
    if (mode !== "complete") {
      held = response;
      response.on("close", () => {
        if (!response.writableEnded) closed.resolve();
      });
      response.write(
        mode === "oversized"
          ? `"${"x".repeat(4 * 1024 * 1024)}`
          : reply.slice(0, 30),
      );
      progress.resolve();
    } else response.end(reply);
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
      capturedHeaders.resolve();
      return response;
    },
  });
  const pages = createTestContext();
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
function invoke(signal?: AbortSignal) {
  const port = captureAiConnectionTransport();
  return inferStabilityAi(
    {
      providerId: "byo-ai",
      baseUrl: endpoint,
      model: "custom-image-model",
      authentication: "api-key",
      apiKey: token,
    },
    {
      model: "custom-image-model",
      messages: [{ role: "user", content: "A small lighthouse" }],
    },
    port,
    () => port.assertCurrent(),
    { signal },
  );
}
function captured() {
  const last = captures.at(-1);
  if (!last) throw new Error("Actual image response missing");
  return last;
}

it("retires physical forwarding only after actual image JSON EOF and retains its decoded raster", async () => {
  const result = await invoke();
  expect(result.image.copyBytes()).toEqual(
    new Uint8Array(Buffer.from(RASTER_FIXTURES.png, "base64")),
  );
  const last = captured();
  expect(last.response.bodyUsed).toBe(true);
  expect(last.response.body?.locked).toBe(false);
  activation.dispose();
  expect(last.signal.aborted).toBe(false);
  expect(result.image.width).toBe(2);
  result.image.release();
});

it("closes the actual held image body immediately on caller abort", async () => {
  mode = "held";
  const caller = new AbortController();
  const job = invoke(caller.signal);
  const rejected = expect(job).rejects.toThrow();
  await progress.promise;
  await capturedHeaders.promise;
  caller.abort();
  await rejected;
  await closed.promise;
  expect(held?.writableEnded).toBe(false);
  expect(captured().signal.aborted).toBe(true);
});

it.each(["wrong-mime", "oversized"] as const)(
  "retires %s refusal after closing the real held body",
  async (invalid) => {
    mode = invalid;
    await expect(invoke()).rejects.toThrow();
    await closed.promise;
    expect(held?.writableEnded).toBe(false);
    activation.dispose();
    expect(captured().signal.aborted).toBe(false);
  },
);
