// @vitest-environment jsdom
import { installNativeApiTests } from "@opensesame/app-core/lib/native-api.test-support.js";
import { bindNativeBrowserPolicyOrigin } from "@opensesame/app-core/lib/native-browser-policy.js";
import { nativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import { registerNativeProviderCleanup } from "@opensesame/app-core/lib/native-connector-lifecycle.js";
import * as records from "@opensesame/app-core/lib/native-connector-store.js";
import {
  type NativeProviderTransport,
  bindNativeProviderTransport,
} from "@opensesame/app-core/lib/native-connector-transport.js";
import { target } from "@opensesame/app-core/lib/native-mcp-oauth-fixtures.test-helper.js";
import { NativeMcpSession } from "@opensesame/app-core/lib/native-mcp-protocol.js";
import { requireNativeMcpRecord } from "@opensesame/app-core/lib/native-mcp-records.js";
import { bindNativeOAuthBrowserPort } from "@opensesame/app-core/lib/native-oauth-browser-port.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nativeConnectorController } from "../../sections/connections/connect/native-connector-controller.js";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import { deferred, ownedProtocol } from "./native-mcp-runtime.test-support.js";
import { bindNativeOAuthRuntime } from "./native-oauth-runtime.js";

installNativeApiTests();
async function context() {
  const protocol = await ownedProtocol();
  const native = vi.fn(protocol.fetcher);
  const browser = vi.fn<typeof fetch>(async () => {
    throw new Error("Browser fetch forbidden");
  });
  vi.stubGlobal("fetch", browser);
  const releasePolicy = bindNativeBrowserPolicyOrigin(
    () => "https://self-host.example.org",
  );
  let ready = false;
  let generation = 0;
  let route = new AbortController();
  const captures: number[] = [];
  const calls: number[] = [];
  const test = createTestContext();
  const activation = createActivation(test.ctx, "connectors.external");
  const releaseTransport = bindNativeProviderTransport({
    assertCurrent: () => {
      if (activation.disposed()) throw new Error("Original activation retired");
    },
    fetch: browser,
    capture: () => {
      if (!ready) throw new Error("No selected browser node");
      const selected = generation;
      const lifetime = route.signal;
      captures.push(selected);
      const send =
        (settling: boolean): typeof fetch =>
        (input, init) => {
          calls.push(selected);
          return native(input, {
            ...init,
            signal: settling
              ? init?.signal
              : AbortSignal.any([
                  lifetime,
                  ...(init?.signal ? [init.signal] : []),
                ]),
          });
        };
      return {
        assertCurrent: () => {
          lifetime.throwIfAborted();
        },
        fetch: send(false),
        settleCredentialMutation: send(true),
        signal: lifetime,
      } satisfies NativeProviderTransport;
    },
  });
  activation.onDispose(() => {
    route.abort();
    releaseTransport();
  });
  return {
    protocol,
    activation,
    captures,
    calls,
    browser,
    native,
    start: () => {
      ready = true;
    },
    replaceRoute: (reason?: Error) => {
      route.abort(reason);
      route = new AbortController();
      generation++;
    },
    bind: () => bindNativeOAuthRuntime(activation),
    cleanup: () =>
      registerNativeProviderCleanup(
        "adobe",
        nativeConnectorDriver("mcp", "adobe").cleanup,
      ),
    consent: () =>
      bindNativeOAuthBrowserPort({
        redirectUri: target.redirectUri,
        navigate: () => {
          throw new Error("Original popup required");
        },
        scrubCallback: () => {},
        authorize: async (url, expected) => {
          expect(new URL(url).searchParams.get("state")).toBe(expected.state);
          protocol.consent(url);
          return `?native_state=${expected.state}&native_code=owned-return`;
        },
      }),
    close: async () => {
      activation.dispose();
      releasePolicy();
      await protocol.close();
    },
  };
}
const draft = {
  providerId: "adobe",
  method: "mcp" as const,
  displayName: "Owned MCP",
  parameters: {},
  credentials: {},
  requestedScopes: { user: [] },
  targetIds: {},
};

let active: Awaited<ReturnType<typeof context>> | undefined;
const releases: (() => void)[] = [];
function requiredContext() {
  if (!active) throw new Error("Owned fixture is not available");
  return active;
}
beforeEach(async () => {
  active = await context();
  active.bind();
  expect(active.captures).toEqual([]);
  active.start();
  releases.push(active.cleanup(), active.consent());
});
afterEach(async () => {
  for (const release of releases.splice(0).reverse()) release();
  if (active) {
    expect(active.browser).not.toHaveBeenCalled();
    await active.close();
    active = undefined;
  }
  vi.unstubAllGlobals();
});

it("captures after node selection and consumes actual OAuth/MCP replies through the common controller", async () => {
  const c = requiredContext();
  expect(c.captures).toEqual([]);
  const consumer = nativeConnectorController({ id: "adobe", refused: false });
  const saved = await consumer.configure(draft);
  await consumer.authorize("user");
  await consumer.verify();
  const output = await consumer.invoke("mcp.tool:provider.search", {
    arguments: '{"query":"records"}',
  });
  expect(output.items).toEqual([{ id: "0", label: "Actual owned MCP result" }]);
  expect(c.captures).toEqual([0, 0, 0, 0]);
  expect(c.calls.every((route) => route === 0)).toBe(true);
  expect(records.readNativeConnector(saved.connectionId)?.status).toBe(
    "connected",
  );
  const requests = c.protocol.requests;
  expect(requests.some((r) => r.url === target.metadata.resourceMetadata)).toBe(
    true,
  );
  expect(
    requests.some((r) => r.url === target.metadata.registrationEndpoint),
  ).toBe(true);
  const token = requests.find((r) => r.url === target.metadata.tokenEndpoint);
  expect(token?.headers.has("authorization")).toBe(false);
  expect(new URLSearchParams(await token?.clone().text()).get("resource")).toBe(
    target.binding.resource,
  );
  const rpc = requests.filter(
    (r) => r.url === target.binding.endpoint && r.method === "POST",
  );
  expect(
    rpc.every((r) => r.headers.get("authorization") === "Bearer issued-access"),
  ).toBe(true);
  expect(
    rpc.some((r) => r.headers.get("mcp-protocol-version") === "2025-11-25"),
  ).toBe(true);
});

it("physically cancels an original pending metadata body without adopting a replacement route", async () => {
  const c = requiredContext();
  const driver = nativeConnectorDriver("mcp", "adobe");
  const saved = await driver.configure(draft);
  c.protocol.hold("oauth-protected-resource");
  const pending = driver.authorize?.(saved.connectionId);
  const rejected = expect(pending).rejects.toThrow();
  await c.protocol.entered.promise;
  c.replaceRoute();
  await rejected;
  await expect.poll(c.protocol.premature).toBe(true);
  expect(c.calls.every((route) => route === 0)).toBe(true);
  expect(c.captures).toEqual([0, 0]);
});

it("journals a late issued token and refuses original cleanup through a replacement route", async () => {
  const c = requiredContext();
  const driver = nativeConnectorDriver("mcp", "adobe");
  const saved = await driver.configure(draft);
  c.protocol.hold("/ims/token/");
  const pending = driver.authorize?.(saved.connectionId);
  const rejected = expect(pending).rejects.toThrow();
  await c.protocol.entered.promise;
  c.replaceRoute();
  c.protocol.finish();
  await rejected;
  const recovery = requireNativeMcpRecord(saved.connectionId).privateState
    .recovery;
  expect(
    recovery.some((entry) => entry.grant?.accessToken === "issued-access"),
  ).toBe(true);
  const before = c.calls.length;
  await expect(driver.cleanup.prepare?.(saved.connectionId)).rejects.toThrow();
  expect(c.calls).toHaveLength(before);
  expect(c.calls.every((route) => route === 0)).toBe(true);
});

it("rechecks the originating route before automatic reconsent cleanup selects a global adapter", async () => {
  const c = requiredContext();
  const driver = nativeConnectorDriver("mcp", "adobe");
  const saved = await driver.configure(draft);
  await driver.authorize?.(saved.connectionId);
  const original = records.updateNativeConnector;
  const entered = deferred();
  const release = deferred();
  vi.spyOn(records, "updateNativeConnector").mockImplementation(
    async (...args) => {
      const result = await original(...args);
      if (
        requireNativeMcpRecord(saved.connectionId).privateState.recovery.some(
          (entry) => entry.id.startsWith("reconsent:"),
        )
      ) {
        entered.resolve();
        await release.promise;
      }
      return result;
    },
  );
  const pending = driver.authorize?.(saved.connectionId);
  const initiatingError = new Error("Original operator route retired");
  const rejected = expect(pending).rejects.toBe(initiatingError);
  await entered.promise;
  c.replaceRoute(initiatingError);
  for (const release of releases.splice(0, 1)) release();
  const replacementCleanup = vi.fn(async () => "provider-revoked" as const);
  releases.push(
    registerNativeProviderCleanup("adobe", {
      classification: driver.cleanup.classification,
      cleanup: replacementCleanup,
    }),
  );
  release.resolve();
  await rejected;
  expect(replacementCleanup).not.toHaveBeenCalled();
  expect(
    requireNativeMcpRecord(saved.connectionId).privateState.recovery.some(
      (entry) => entry.grant?.accessToken === "issued-access",
    ),
  ).toBe(true);
});

it.each(["caller", "route", "activation"] as const)(
  "physically closes the held original MCP call within two seconds of %s retirement",
  async (reason) => {
    const c = requiredContext();
    const driver = nativeConnectorDriver("mcp", "adobe");
    const saved = await driver.configure(draft);
    await driver.authorize?.(saved.connectionId);
    c.protocol.hold("tools/call");
    const caller = new AbortController();
    const pending = driver.invoke(
      saved.connectionId,
      "mcp.tool:provider.search",
      {
        arguments: '{"query":"held records"}',
      },
      caller.signal,
    );
    void pending.catch(() => undefined);
    await c.protocol.entered.promise;
    const at = performance.now();
    if (reason === "caller") caller.abort();
    else if (reason === "route") c.replaceRoute();
    else c.activation.dispose();
    await expect
      .poll(c.protocol.premature, { timeout: 2000, interval: 20 })
      .toBe(true);
    expect(performance.now() - at).toBeLessThan(2000);
    await expect(pending).rejects.toThrow();
    expect(c.calls.every((route) => route === 0)).toBe(true);
  },
);

it("does not expose a configuration saved after its initiating route retired", async () => {
  const c = requiredContext();
  const original = records.saveNativeConnector;
  vi.spyOn(records, "saveNativeConnector").mockImplementation(
    async (...args) => {
      const result = await original(...args);
      c.replaceRoute();
      return result;
    },
  );
  const driver = nativeConnectorDriver("mcp", "adobe");
  await expect(driver.configure(draft)).rejects.toThrow();
  expect(c.protocol.requests).toEqual([]);
});

it("does not publish a tool result after the original SDK session drain retires its route", async () => {
  const c = requiredContext();
  const driver = nativeConnectorDriver("mcp", "adobe");
  const saved = await driver.configure(draft);
  await driver.authorize?.(saved.connectionId);
  const original = NativeMcpSession.prototype.dispose;
  vi.spyOn(NativeMcpSession.prototype, "dispose").mockImplementation(
    async function (this: NativeMcpSession) {
      await original.call(this);
      c.replaceRoute();
    },
  );
  await expect(
    driver.invoke(saved.connectionId, "mcp.tool:provider.search", {
      arguments: '{"query":"retired result"}',
    }),
  ).rejects.toThrow();
  expect(
    c.protocol.requests.some(
      (request) => request.url === target.binding.endpoint,
    ),
  ).toBe(true);
});
