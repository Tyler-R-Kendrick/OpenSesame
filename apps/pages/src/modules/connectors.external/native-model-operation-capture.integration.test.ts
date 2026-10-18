/** @vitest-environment jsdom */
import { performHostedInference } from "@opensesame/app-core/lib/hosted-inference.js";
import { hostedModelAuthority } from "@opensesame/app-core/lib/hosted-model-authority.js";
import {
  MODEL_TEST_SECRET,
  saveModelFixture,
} from "@opensesame/app-core/lib/hosted-model.test-support.js";
import {
  deferred,
  runtimeFixture,
} from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import {
  type TailscaleBrowserNode,
  TailscaleNativeHTTPConfiguration,
  bindTailscaleBrowserNode,
} from "@opensesame/app-core/lib/tailscale/browser-node-port.js";
import {
  openBrowserNodeState,
  updateBrowserNodeNativeHTTP,
} from "@opensesame/app-core/lib/tailscale/browser-node-store.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import { bindNativeModelRuntime } from "./native-model-runtime.js";
import { bindNativeRuntime } from "./native-runtime.js";

const releases: (() => void)[] = [];
let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
beforeEach(async () => {
  fixture = await runtimeFixture();
  await saveModelFixture("openai");
});
afterEach(async () => {
  for (const release of releases.splice(0).reverse()) release();
  await fixture.close();
});
const origin = "https://api.openai.com";
async function saveRoute() {
  return openBrowserNodeState(
    {
      hostname: "model-browser",
      controlURL: "https://controlplane.tailscale.com",
      nativeHTTP: TailscaleNativeHTTPConfiguration.parse({
        version: 1,
        exitNodeID: "approved-exit",
        trustMode: "public",
        targets: [{ origin, prefixes: ["203.0.113.0/24"] }],
      }),
    },
    vaultStore.getSnapshot().tomb,
    () => {
      if (!vaultStore.isUnlocked()) throw new Error("Vault locked");
    },
  );
}
function node() {
  const lifetime = new AbortController();
  const requests: Request[] = [];
  let reply = async (_request: Request) =>
    Response.json({
      choices: [{ message: { content: "Actual model answer" } }],
    });
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    lifetime.signal.throwIfAborted();
    init?.signal?.throwIfAborted();
    const request = new Request(input, init);
    requests.push(request.clone());
    const response = await reply(request);
    lifetime.signal.throwIfAborted();
    init?.signal?.throwIfAborted();
    return response;
  });
  const capture = vi.fn(() => ({
    fetch,
    signal: lifetime.signal,
    assertCurrent: () => lifetime.signal.throwIfAborted(),
  }));
  const port: TailscaleBrowserNode = {
    captureNativeHTTP: capture,
    snapshot: () => ({
      status: "connected",
      hostname: "model-browser",
      controlURL: "https://controlplane.tailscale.com",
      authURL: "",
      addresses: ["100.64.0.3"],
      peerCount: 1,
      failure: "",
    }),
    subscribe: () => () => {},
    start: async () => {},
    stop: () => lifetime.abort(),
    forget: async () => {},
    login() {},
    get: async () => {
      throw new Error("No peer fixture");
    },
  };
  releases.push(bindTailscaleBrowserNode(port));
  return {
    fetch,
    capture,
    requests,
    respond: (next: typeof reply) => {
      reply = next;
    },
  };
}
function activate() {
  const context = createTestContext();
  const activation = createActivation(context.ctx, "connectors.external");
  bindNativeRuntime(context.ctx, activation);
  bindNativeModelRuntime(activation);
  releases.push(activation.dispose);
  return { context, activation };
}
function inference() {
  const injected = vi.fn<typeof fetch>();
  const pending = performHostedInference(
    "openai",
    {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Where is Lock?" }],
      maxOutputTokens: 100,
    },
    {
      fetch: injected,
      assertCurrent() {},
      signal: new AbortController().signal,
    },
  );
  return { pending, injected };
}
it("binds before native node configuration and consumes one original-route model response", async () => {
  const bound = activate();
  const browser = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("No browser fallback"));
  await saveRoute();
  const native = node();
  expect(hostedModelAuthority()?.connections()).toEqual([
    expect.objectContaining({ providerId: "openai", status: "connected" }),
  ]);
  expect(native.capture).not.toHaveBeenCalled();
  const call = inference();
  await expect(call.pending).resolves.toEqual({
    providerId: "openai",
    model: "gpt-4o",
    answer: "Actual model answer",
  });
  expect(native.capture).toHaveBeenCalledTimes(1);
  expect(native.fetch).toHaveBeenCalledTimes(1);
  const request = native.requests[0];
  if (!request) throw new Error("Missing actual model request");
  expect(request.url).toBe(`${origin}/v1/chat/completions`);
  expect(request.method).toBe("POST");
  expect(request.headers.get("authorization")).toBe(
    `Bearer ${MODEL_TEST_SECRET}`,
  );
  expect(await request.json()).toEqual({
    model: "gpt-4o",
    messages: [{ role: "user", content: "Where is Lock?" }],
    max_completion_tokens: 100,
    stream: false,
  });
  expect(bound.context.egressCalls).toEqual([]);
  expect(call.injected).not.toHaveBeenCalled();
  expect(browser).not.toHaveBeenCalled();
});
it.each(["node", "route", "activation", "lease"])(
  "rejects a pending model answer after original %s withdrawal without recapture",
  async (reason) => {
    const bound = activate();
    const stored = await saveRoute();
    const first = node();
    const browser = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No browser fallback"));
    const entered = deferred<void>();
    const finish = deferred<Response>();
    first.respond(async () => {
      entered.resolve();
      return finish.promise;
    });
    const call = inference();
    const rejected = expect(call.pending).rejects.toThrow();
    await entered.promise;
    let replacement: ReturnType<typeof node> | undefined;
    if (reason === "node") replacement = node();
    else if (reason === "route") {
      const nativeHTTP = stored.record.nativeHTTP;
      if (!nativeHTTP) throw new Error("Missing original route");
      await updateBrowserNodeNativeHTTP(
        stored.record,
        { ...nativeHTTP, exitNodeID: "other-exit" },
        () => {},
      );
    } else if (reason === "activation") activate();
    else bound.context.abort();
    finish.resolve(
      Response.json({
        choices: [{ message: { content: "Withdrawn model answer" } }],
      }),
    );
    await rejected;
    expect(first.capture).toHaveBeenCalledTimes(1);
    expect(first.fetch).toHaveBeenCalledTimes(1);
    expect(replacement?.capture.mock.calls ?? []).toEqual([]);
    expect(replacement?.fetch.mock.calls ?? []).toEqual([]);
    expect(bound.context.egressCalls).toEqual([]);
    expect(call.injected).not.toHaveBeenCalled();
    expect(browser).not.toHaveBeenCalled();
  },
);
it("a retained original model authority refuses replacement activation before another route is captured", async () => {
  activate();
  await saveRoute();
  const native = node();
  const original = hostedModelAuthority();
  if (!original) throw new Error("Missing original model authority");
  activate();
  await expect(async () =>
    original.execute(
      "openai",
      {
        providerId: "openai",
        operationId: "model.inference",
        method: "POST",
        origin,
        path: "/v1/chat/completions",
      },
      {
        model: "gpt-4o",
        messages: [{ role: "user", content: "forbidden replacement" }],
      },
      (body) => body,
      {
        fetch: vi.fn(),
        assertCurrent() {},
        signal: new AbortController().signal,
      },
    ),
  ).rejects.toThrow();
  expect(native.capture).not.toHaveBeenCalled();
  expect(native.fetch).not.toHaveBeenCalled();
});
