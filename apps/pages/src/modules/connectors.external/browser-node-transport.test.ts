import type { NativeProviderTransport } from "@opensesame/app-core/lib/native-connector-transport.js";
import { runtimeFixture } from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
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
import { createTestContext } from "../test-context.js";
import { captureBrowserNodeTransport } from "./browser-node-transport.js";
let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
const releases: (() => void)[] = [];
beforeEach(async () => {
  fixture = await runtimeFixture();
});
afterEach(async () => {
  for (const release of releases.splice(0).reverse()) release();
  await fixture.close();
});
const config = {
  hostname: "original-browser",
  controlURL: "https://controlplane.tailscale.com",
  nativeHTTP: TailscaleNativeHTTPConfiguration.parse({
    version: 1,
    exitNodeID: "approved-exit",
    trustMode: "public",
    targets: [
      { origin: "https://api.example.com", prefixes: ["203.0.113.0/24"] },
    ],
  }),
};
async function save() {
  return openBrowserNodeState(
    structuredClone(config),
    vaultStore.getSnapshot().tomb,
    () => {
      if (vaultStore.getSnapshot().status !== "unlocked")
        throw new Error("locked");
    },
  );
}
function base() {
  const owner = new AbortController();
  const fetch = vi.fn(async () => new Response("direct"));
  const mutation = vi.fn(async () => new Response("mutation"));
  const openWebSocket = vi.fn(() => {
    throw new Error("No test socket");
  });
  const transport: NativeProviderTransport = {
    fetch,
    settleCredentialMutation: mutation,
    openWebSocket,
    signal: owner.signal,
    assertCurrent: () => owner.signal.throwIfAborted(),
  };
  return { transport, owner, fetch, mutation, openWebSocket };
}
function node() {
  const lifetime = new AbortController();
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    lifetime.signal.throwIfAborted();
    init?.signal?.throwIfAborted();
    return new Response("native");
  });
  const port = {
    fetch,
    signal: lifetime.signal,
    assertCurrent: () => lifetime.signal.throwIfAborted(),
  };
  const capture = vi.fn(() => port);
  const value: TailscaleBrowserNode = {
    captureNativeHTTP: capture,
    snapshot: () => ({
      status: "connected",
      hostname: config.hostname,
      controlURL: config.controlURL,
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
      throw new Error("No peer GET fixture");
    },
  };
  releases.push(bindTailscaleBrowserNode(value));
  return { value, fetch, capture, lifetime };
}
it("leaves the exact original browser and WebSocket transport unchanged without an explicit saved native route", () => {
  const b = base();
  expect(
    captureBrowserNodeTransport(b.transport, createTestContext().ctx),
  ).toBe(b.transport);
});
it("uses the original node only for exact opted-in origins, with the same external egress decision and preserved WebSocket port", async () => {
  await save();
  const n = node();
  const b = base();
  const context = createTestContext();
  const decide = vi.spyOn(context.ctx.egress, "decide");
  const captured = captureBrowserNodeTransport(b.transport, context.ctx);
  expect(captured.openWebSocket).toBe(b.openWebSocket);
  expect(captured.supportsNativeOrigin?.("https://api.example.com")).toBe(true);
  expect(captured.supportsNativeOrigin?.("https://other.example")).toBe(false);
  expect(captured.supportsNativeOrigin?.("https://api.example.com/path")).toBe(
    false,
  );
  expect(
    await (await captured.fetch("https://other.example/item")).text(),
  ).toBe("direct");
  expect(
    await (
      await captured.fetch("https://api.example.com/item", {
        headers: { authorization: "Bearer fixture" },
      })
    ).text(),
  ).toBe("native");
  expect(n.capture).toHaveBeenCalledTimes(1);
  expect(n.fetch).toHaveBeenCalledTimes(1);
  expect(b.fetch).toHaveBeenCalledTimes(1);
  expect(decide).toHaveBeenCalledWith(new URL("https://api.example.com/item"), {
    capability: "connectors.external",
    purpose:
      "Native provider authorization, verification and documented API or MCP operations",
  });
  const request = n.fetch.mock.calls[0]?.[0];
  expect(request).toBeInstanceOf(Request);
  if (request instanceof Request)
    expect(request.headers.get("authorization")).toBe("Bearer fixture");
});
it("never falls back to direct fetch or a newly connected node when the originally captured node was unavailable", async () => {
  await save();
  const b = base();
  const context = createTestContext();
  const captured = captureBrowserNodeTransport(b.transport, context.ctx);
  const n = node();
  await expect(captured.fetch("https://api.example.com/item")).rejects.toThrow(
    "Reconnect",
  );
  expect(captured.supportsNativeOrigin?.("https://api.example.com")).toBe(
    false,
  );
  expect(n.capture).not.toHaveBeenCalled();
  expect(n.fetch).not.toHaveBeenCalled();
  expect(b.fetch).not.toHaveBeenCalled();
  expect(
    await (
      await captureBrowserNodeTransport(b.transport, context.ctx).fetch(
        "https://api.example.com/item",
      )
    ).text(),
  ).toBe("native");
});
it("refuses replacement nodes and edited saved route/trust authority before another provider operation", async () => {
  const stored = await save();
  const n = node();
  const b = base();
  const captured = captureBrowserNodeTransport(
    b.transport,
    createTestContext().ctx,
  );
  await captured.fetch("https://api.example.com/item");
  await updateBrowserNodeNativeHTTP(
    stored.record,
    {
      ...structuredClone(config.nativeHTTP),
      exitNodeID: "other-approved-exit",
    },
    () => {},
  );
  await expect(captured.fetch("https://api.example.com/item")).rejects.toThrow(
    "Reconnect",
  );
  expect(() => captured.assertCurrent()).toThrow("Reconnect");
  expect(captured.supportsNativeOrigin?.("https://api.example.com")).toBe(
    false,
  );
  expect(n.fetch).toHaveBeenCalledTimes(1);
  expect(b.fetch).not.toHaveBeenCalled();
  const replacement = node();
  await expect(captured.fetch("https://api.example.com/item")).rejects.toThrow(
    "Reconnect",
  );
  expect(replacement.capture).not.toHaveBeenCalled();
});
it("honors egress rejection before sending through the node and never falls back", async () => {
  await save();
  const n = node();
  const b = base();
  const context = createTestContext();
  vi.spyOn(context.ctx.egress, "decide").mockReturnValue({
    ok: false,
    code: "origin-not-allowed",
    destination: "https://api.example.com",
  });
  const captured = captureBrowserNodeTransport(b.transport, context.ctx);
  await expect(
    captured.fetch("https://api.example.com/item"),
  ).rejects.toThrow();
  expect(n.fetch).not.toHaveBeenCalled();
  expect(b.fetch).not.toHaveBeenCalled();
});
it("retains the original submitted credential-mutation deadline after external withdrawal while rejecting every new request", async () => {
  await save();
  const n = node();
  const b = base();
  const captured = captureBrowserNodeTransport(
    b.transport,
    createTestContext().ctx,
  );
  let finish: (() => void) | undefined;
  let signal: AbortSignal | null | undefined;
  n.fetch.mockImplementation(async (_input, init) => {
    signal = init?.signal;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return new Response("settled");
  });
  const pending = captured.settleCredentialMutation?.(
    "https://api.example.com/token",
    { method: "POST" },
  );
  expect(finish).toBeTypeOf("function");
  b.owner.abort();
  expect(signal?.aborted).toBe(false);
  finish?.();
  expect(await (await pending)?.text()).toBe("settled");
  await expect(
    captured.fetch("https://api.example.com/item"),
  ).rejects.toThrow();
  expect(b.mutation).not.toHaveBeenCalled();
});

it.each(["route", "node"] as const)(
  "qualifying a native origin pins its original %s before authentication awaits or sends",
  async (cause) => {
    const stored = await save();
    const original = node();
    const b = base();
    const captured = captureBrowserNodeTransport(
      b.transport,
      createTestContext().ctx,
    );
    expect(captured.supportsNativeOrigin?.("https://api.example.com")).toBe(
      true,
    );
    if (cause === "route")
      await updateBrowserNodeNativeHTTP(
        stored.record,
        {
          ...structuredClone(config.nativeHTTP),
          exitNodeID: "replacement-exit",
        },
        () => {},
      );
    else node();
    expect(() => captured.assertCurrent()).toThrow("Reconnect");
    expect(captured.supportsNativeOrigin?.("https://api.example.com")).toBe(
      false,
    );
    expect(original.fetch).not.toHaveBeenCalled();
    expect(original.capture).toHaveBeenCalledTimes(1);
    expect(b.fetch).not.toHaveBeenCalled();
  },
);
it("an unrelated origin projection does not pin or replace the original direct browser transport", async () => {
  await save();
  node();
  const b = base();
  const captured = captureBrowserNodeTransport(
    b.transport,
    createTestContext().ctx,
  );
  expect(captured.supportsNativeOrigin?.("https://other.example")).toBe(false);
  node();
  expect(() => captured.assertCurrent()).not.toThrow();
  expect(
    await (await captured.fetch("https://other.example/item")).text(),
  ).toBe("direct");
});
