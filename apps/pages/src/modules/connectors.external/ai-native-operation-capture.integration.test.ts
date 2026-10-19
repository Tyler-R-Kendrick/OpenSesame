import { executeAiDelegatedRequest } from "@opensesame/app-core/lib/ai-connections/delegation.js";
import {
  canonicalCall,
  canonicalDraft,
  delegationFence,
} from "@opensesame/app-core/lib/ai-connections/delegation.test-support.js";
/** @vitest-environment jsdom */
import { aiNativeTlsFixture } from "@opensesame/app-core/lib/ai-connections/native-tls.test-support.js";
import { aiConnectionDraft } from "@opensesame/app-core/lib/ai-connections/presets.js";
import {
  performSavedAiInference,
  saveAiConnection,
  testAiConnection,
} from "@opensesame/app-core/lib/ai-connections/runtime.js";
import { savedAiConnections } from "@opensesame/app-core/lib/ai-connections/store.js";
import { aiConnectionTransport } from "@opensesame/app-core/lib/ai-connections/transport.js";
import {
  aiVaultSeams,
  captureAiVault,
} from "@opensesame/app-core/lib/ai-connections/vault-guard.js";
import { performHostedInference } from "@opensesame/app-core/lib/hosted-inference.js";
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
import { bindAiConnectionRuntime } from "./ai-connection-runtime.js";
import { bindNativeModelRuntime } from "./native-model-runtime.js";
import { bindNativeRuntime } from "./native-runtime.js";

const origin = "https://owned-ai.example";
const key = "private-native-ai-fixture";
const answer = "Independent TLS model answer";
const releases: (() => void)[] = [];
let vault: Awaited<ReturnType<typeof runtimeFixture>>;
let http: Awaited<ReturnType<typeof aiNativeTlsFixture>>;
beforeEach(async () => {
  vault = await runtimeFixture();
  http = await aiNativeTlsFixture(answer, [key, canonicalDraft().apiKey]);
});
afterEach(async () => {
  for (const release of releases.splice(0).reverse()) release();
  await http.close();
  await vault.close();
  for (const request of http.requests)
    expect([`Bearer ${key}`, `Bearer ${canonicalDraft().apiKey}`]).toContain(
      request.headers.authorization,
    );
});

function node() {
  const lifetime = new AbortController();
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      lifetime.signal.throwIfAborted();
      const request = new Request(input, init);
      expect(request.headers.get("authorization")).toMatch(/^Bearer /);
      const url = new URL(request.url);
      expect([origin, "https://api.openai.com"]).toContain(url.origin);
      url.hostname = "127.0.0.1";
      url.port = String(http.port);
      const forwarded = new Request(url, {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: await request.arrayBuffer(),
        signal: request.signal,
      });
      expect(forwarded.headers.get("authorization")).toBe(
        request.headers.get("authorization"),
      );
      const response = await http.secureFetch(forwarded);
      expect(http.requests.at(-1)?.headers.authorization).toBe(
        request.headers.get("authorization"),
      );
      return response;
    },
  );
  const capture = vi.fn(() => ({
    fetch: fetcher,
    signal: lifetime.signal,
    assertCurrent: () => lifetime.signal.throwIfAborted(),
  }));
  const port: TailscaleBrowserNode = {
    captureNativeHTTP: capture,
    snapshot: () => ({
      status: "connected",
      hostname: "ai-browser",
      controlURL: "https://controlplane.tailscale.com",
      authURL: "",
      addresses: ["100.64.0.4"],
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
  return { fetcher, capture };
}
async function route() {
  return openBrowserNodeState(
    {
      hostname: "ai-browser",
      controlURL: "https://controlplane.tailscale.com",
      nativeHTTP: TailscaleNativeHTTPConfiguration.parse({
        version: 1,
        exitNodeID: "approved-exit",
        trustMode: "public",
        targets: [origin, "https://api.openai.com"].map((target) => ({
          origin: target,
          prefixes: ["203.0.113.0/24"],
        })),
      }),
    },
    vaultStore.getSnapshot().tomb,
    () => {
      if (!vaultStore.isUnlocked()) throw new Error("Vault locked");
    },
  );
}
function activate() {
  const context = createTestContext();
  const activation = createActivation(context.ctx, "connectors.external");
  bindNativeRuntime(context.ctx, activation);
  bindNativeModelRuntime(activation);
  bindAiConnectionRuntime(context.ctx, activation);
  releases.push(activation.dispose);
  return { context, activation };
}
function draft(family: "openai_chat" | "openai_responses" = "openai_chat") {
  return {
    ...aiConnectionDraft("byo-ai"),
    baseUrl: `${origin}/custom/v1`,
    model: "custom-model",
    family,
    apiKey: key,
  };
}
const input = {
  model: "custom-model",
  messages: [{ role: "user" as const, content: "Actual custom inference" }],
  maxOutputTokens: 16,
};
it.each(["openai_chat", "openai_responses"] as const)(
  "saves custom %s then consumes its saved model over independently verified native TLS",
  async (family) => {
    const active = activate();
    const browser = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No browser fetch"));
    await route();
    const native = node();
    const projected = aiConnectionTransport();
    expect(await testAiConnection(draft(family))).toBe(
      "Model inference verified",
    );
    const saved = await saveAiConnection(draft(family));
    const caller = delegationFence();
    await expect(
      performHostedInference(saved.connectionId, input, caller),
    ).resolves.toEqual({ providerId: "byo-ai", model: input.model, answer });
    if (family === "openai_chat") {
      const chunks: string[] = [];
      await expect(
        performSavedAiInference(saved.connectionId, input, caller, (text) =>
          chunks.push(text),
        ),
      ).resolves.toEqual({ providerId: "byo-ai", model: input.model, answer });
      expect(chunks.join("")).toBe(answer);
    }
    expect(aiConnectionTransport()).toBe(projected);
    expect(native.capture).toHaveBeenCalledTimes(
      family === "openai_chat" ? 4 : 3,
    );
    expect(http.requests).toHaveLength(family === "openai_chat" ? 4 : 3);
    for (const request of http.requests) {
      expect(request.method).toBe("POST");
      expect(request.path).toBe(
        `/custom/v1/${family === "openai_chat" ? "chat/completions" : "responses"}`,
      );
      expect(request.headers.authorization).toBe(`Bearer ${key}`);
      expect(JSON.parse(request.body).model).toBe(input.model);
    }
    const generated = http.requests[2];
    if (!generated) throw new Error("Missing actual inference request");
    expect(JSON.parse(generated.body)).toEqual(
      family === "openai_responses"
        ? {
            model: input.model,
            input: input.messages,
            max_output_tokens: 16,
            stream: false,
          }
        : {
            model: input.model,
            messages: input.messages,
            max_completion_tokens: 16,
            stream: false,
          },
    );
    expect(JSON.stringify(savedAiConnections())).not.toContain(key);
    expect(active.context.egressCalls).toEqual([]);
    expect(caller.fetch).not.toHaveBeenCalled();
    expect(browser).not.toHaveBeenCalled();
  },
);
it("delegates canonical saved credentials through the captured native route and refuses BYO protocol lending", async () => {
  const active = activate();
  const browser = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("No browser fetch"));
  await route();
  const native = node();
  const saved = await saveAiConnection(canonicalDraft());
  const call = canonicalCall();
  const fence = delegationFence();
  await expect(
    executeAiDelegatedRequest(
      saved.connectionId,
      call.definition,
      call.body,
      (body) => body,
      fence,
    ),
  ).resolves.toMatchObject({ choices: [{ message: { content: answer } }] });
  const delegated = http.requests[1];
  if (!delegated) throw new Error("Missing actual delegated request");
  expect(delegated.path).toBe(call.definition.path);
  expect(delegated.headers.authorization).toBe(
    `Bearer ${canonicalDraft().apiKey}`,
  );
  expect(JSON.parse(delegated.body)).toEqual(call.body);
  const custom = await saveAiConnection(draft());
  const sent = http.requests.length;
  await expect(
    executeAiDelegatedRequest(
      custom.connectionId,
      call.definition,
      call.body,
      (body) => body,
      fence,
    ),
  ).rejects.toThrow(/canonical|delegation/);
  expect(http.requests).toHaveLength(sent);
  expect(native.capture).toHaveBeenCalledTimes(4);
  expect(active.context.egressCalls).toEqual([]);
  expect(fence.fetch).not.toHaveBeenCalled();
  expect(browser).not.toHaveBeenCalled();
});
it.each(["node", "route", "activation", "lease"])(
  "holds one stream route and rejects its %s replacement before accepting terminal completion",
  async (reason) => {
    const active = activate();
    const stored = await route();
    const native = node();
    const browser = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No browser fetch"));
    const saved = await saveAiConnection(draft());
    native.capture.mockClear();
    http.hold();
    const chunks: string[] = [];
    const pending = performSavedAiInference(
      saved.connectionId,
      input,
      undefined,
      (text) => chunks.push(text),
    );
    const refused = expect(pending).rejects.toThrow();
    await http.progress.promise;
    let replacement: ReturnType<typeof node> | undefined;
    if (reason === "node") replacement = node();
    else if (reason === "activation") activate();
    else if (reason === "lease") active.context.abort();
    else {
      const nativeHTTP = stored.record.nativeHTTP;
      if (!nativeHTTP || nativeHTTP.version !== 1)
        throw new Error("Missing original exit route");
      await updateBrowserNodeNativeHTTP(
        stored.record,
        { ...nativeHTTP, exitNodeID: "other-exit" },
        () => {},
      );
    }
    http.finish();
    await refused;
    expect(native.capture).toHaveBeenCalledTimes(1);
    expect(replacement?.capture.mock.calls ?? []).toEqual([]);
    expect(replacement?.fetcher.mock.calls ?? []).toEqual([]);
    expect(active.context.egressCalls).toEqual([]);
    expect(browser).not.toHaveBeenCalled();
  },
);
it.each(["test", "save", "infer", "delegate"])(
  "captures %s before the vault await and never adopts its replacement activation",
  async (operation) => {
    activate();
    await route();
    const native = node();
    const saved = await saveAiConnection(canonicalDraft());
    const entered = deferred<void>();
    const finish = deferred<void>();
    vi.spyOn(aiVaultSeams, "capture").mockImplementationOnce(async () => {
      const guard = await captureAiVault();
      entered.resolve();
      await finish.promise;
      return guard;
    });
    native.capture.mockClear();
    const sent = http.requests.length;
    const call = canonicalCall();
    const pending =
      operation === "test"
        ? testAiConnection(draft())
        : operation === "save"
          ? saveAiConnection(draft())
          : operation === "infer"
            ? performSavedAiInference(saved.connectionId, {
                ...input,
                model: canonicalDraft().model,
              })
            : executeAiDelegatedRequest(
                saved.connectionId,
                call.definition,
                call.body,
                (body) => body,
                delegationFence(),
              );
    const refused = expect(pending).rejects.toThrow();
    await entered.promise;
    expect(native.capture).toHaveBeenCalledTimes(1);
    activate();
    finish.resolve();
    await refused;
    expect(native.capture).toHaveBeenCalledTimes(1);
    expect(http.requests).toHaveLength(sent);
  },
);

it.each(["fetch", "decide", "egress", "lease"])(
  "refuses an edited original context %s after the vault await",
  async (field) => {
    const active = activate();
    await route();
    const native = node();
    const entered = deferred<void>();
    const finish = deferred<void>();
    vi.spyOn(aiVaultSeams, "capture").mockImplementationOnce(async () => {
      const guard = await captureAiVault();
      entered.resolve();
      await finish.promise;
      return guard;
    });
    const pending = testAiConnection(draft());
    const refused = expect(pending).rejects.toThrow();
    await entered.promise;
    if (field === "lease")
      Object.assign(active.context.ctx, {
        lease: {
          ...active.context.ctx.lease,
          signal: new AbortController().signal,
        },
      });
    else if (field === "egress")
      Object.assign(active.context.ctx, {
        egress: { ...active.context.ctx.egress },
      });
    else Object.assign(active.context.ctx.egress, { [field]: vi.fn() });
    finish.resolve();
    await refused;
    expect(native.capture).toHaveBeenCalledTimes(1);
    expect(native.fetcher).not.toHaveBeenCalled();
    expect(http.requests).toEqual([]);
  },
);
