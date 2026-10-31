/** @vitest-environment jsdom */
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import * as apiResources from "@opensesame/app-core/lib/native-api-resources.js";
import { nativeConnectorDriver } from "@opensesame/app-core/lib/native-connector-drivers.js";
import { loadNativeConnectorRecord } from "@opensesame/app-core/lib/native-connector-store.js";
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
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NativeConnectorPanels } from "../../sections/connections/connect/NativeConnectorPanels.js";
import { nativeConnectorController } from "../../sections/connections/connect/native-connector-controller.js";
import { integrationProvider } from "../../sections/connections/connect/native-connector-integration.test-support.js";
import { createActivation } from "../activation.js";
import { createTestContext } from "../test-context.js";
import { bindNativeApiRuntime } from "./native-api-runtime.js";
import { bindNativeRuntime } from "./native-runtime.js";

const origin = "https://resource123-dsn.algolia.net";
const input = {
  method: "api-key" as const,
  displayName: "Late configured native route",
  parameters: { application_id: "RESOURCE123" },
  credentials: { api_key: "private-operation-fixture" },
  requestedScopes: {},
  targetIds: {},
};
let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
const releases: (() => void)[] = [];
beforeEach(async () => {
  fixture = await runtimeFixture();
});
afterEach(async () => {
  cleanup();
  for (const release of releases.splice(0).reverse()) release();
  await fixture.close();
});
async function save(endpoint = origin) {
  const config = {
    hostname: "operation-browser",
    controlURL: "https://controlplane.tailscale.com",
    nativeHTTP: TailscaleNativeHTTPConfiguration.parse({
      version: 1,
      exitNodeID: "approved-exit",
      trustMode: "public",
      targets: [{ origin: endpoint, prefixes: ["203.0.113.0/24"] }],
    }),
  };
  return openBrowserNodeState(config, vaultStore.getSnapshot().tomb, () => {
    if (!vaultStore.isUnlocked()) throw new Error("Vault locked");
  });
}
function node() {
  const lifetime = new AbortController();
  let reply = async (_request: Request) =>
    Response.json({ nbPages: 1, items: [{ name: "products" }] });
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    lifetime.signal.throwIfAborted();
    init?.signal?.throwIfAborted();
    const result = await reply(new Request(input, init));
    lifetime.signal.throwIfAborted();
    init?.signal?.throwIfAborted();
    return result;
  });
  const capture = vi.fn(() => ({
    fetch,
    signal: lifetime.signal,
    assertCurrent: () => lifetime.signal.throwIfAborted(),
  }));
  const value: TailscaleBrowserNode = {
    captureNativeHTTP: capture,
    snapshot: () => ({
      status: "connected",
      hostname: "operation-browser",
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
  releases.push(bindTailscaleBrowserNode(value));
  return {
    fetch,
    capture,
    lifetime,
    respond: (next: typeof reply) => {
      reply = next;
    },
  };
}
function activate() {
  const context = createTestContext();
  const activation = createActivation(context.ctx, "connectors.external");
  bindNativeRuntime(context.ctx, activation);
  bindNativeApiRuntime(activation);
  releases.push(activation.dispose);
  return { context, activation };
}
function controller() {
  return nativeConnectorController({ id: "algolia", refused: false });
}
it.each(["absent", "provided"])(
  "fences the registered API result when a caller signal is %s",
  async (caller) => {
    const bound = activate();
    await save();
    const native = node();
    const driver = nativeConnectorDriver("api-key", "algolia");
    const saved = await driver.configure({ ...input, providerId: "algolia" });
    const invoke = apiResources.invokeNativeApiResource;
    let completed = false;
    const spy = vi
      .spyOn(apiResources, "invokeNativeApiResource")
      .mockImplementation((...args) => {
        const pending = invoke(...args);
        return (
          pending?.then((result) => {
            expect(result.items[0]?.label).toBe("products");
            completed = true;
            bound.context.abort();
            return result;
          }) ?? null
        );
      });
    try {
      const signal =
        caller === "provided" ? new AbortController().signal : undefined;
      await expect(
        driver.invoke(saved.connectionId, "provider.indices.read", {}, signal),
      ).rejects.toThrow();
      expect(completed).toBe(true);
      expect(native.fetch).toHaveBeenCalledTimes(2);
      expect(bound.context.egressCalls).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  },
);
it("refuses an already-aborted configuration owner before capturing a native route", async () => {
  const bound = activate();
  await save();
  const originalRows = structuredClone(readDeviceRows());
  const native = node();
  const driver = nativeConnectorDriver("api-key", "algolia");
  await expect(
    driver.configure({
      ...input,
      providerId: "algolia",
      owner: { signal: AbortSignal.abort(), assertCurrent: () => {} },
    }),
  ).rejects.toThrow();
  expect(native.capture).not.toHaveBeenCalled();
  expect(native.fetch).not.toHaveBeenCalled();
  expect(readDeviceRows()).toEqual(originalRows);
  await expect(
    driver.configure({ ...input, providerId: "algolia" }),
  ).resolves.toMatchObject({ status: "connected" });
  expect(native.capture).toHaveBeenCalledOnce();
  expect(native.fetch).toHaveBeenCalledOnce();
  expect(bound.context.egressCalls).toEqual([]);
});
it("binds before node configuration then mounts, tests, connects, verifies and reads only through native HTTP", async () => {
  const bound = activate();
  const browser = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("No browser fallback"));
  await save();
  const native = node();
  const check = controller();
  if (!check.test) throw new Error("Native credential test was not registered");
  const tested = await check.test(input).finally(() => {
    expect(bound.context.egressCalls).toEqual([]);
    expect(browser).not.toHaveBeenCalled();
  });
  expect(tested).toEqual({ label: "Algolia API access verified" });
  render(
    <MemoryRouter>
      <NativeConnectorPanels
        provider={integrationProvider("algolia")}
        connection={null}
        onFlash={vi.fn()}
        onChanged={() => {}}
      />
    </MemoryRouter>,
  );
  await userEvent.type(screen.getByLabelText("Application ID"), "RESOURCE123");
  await userEvent.type(
    screen.getByLabelText("Algolia API key"),
    input.credentials.api_key,
  );
  await userEvent.click(
    screen.getByRole("button", { name: "Verify and connect Algolia" }),
  );
  await screen.findByRole("button", { name: "List indices" });
  const saved = readDeviceRows().find((row) => row.providerId === "algolia");
  if (!saved) throw new Error("Mounted connection not saved");
  const driver = nativeConnectorDriver("api-key", "algolia");
  await userEvent.click(screen.getByRole("button", { name: "List indices" }));
  await screen.findByText("products", { selector: "li" });
  await driver.verify(saved.connectionId);
  expect(native.fetch).toHaveBeenCalledTimes(4);
  expect(native.capture).toHaveBeenCalledTimes(4);
  expect(bound.context.egressCalls).toEqual([]);
  expect(browser).not.toHaveBeenCalled();
  for (const [request] of native.fetch.mock.calls) {
    expect(request).toBeInstanceOf(Request);
    if (request instanceof Request) {
      expect(new URL(request.url).origin).toBe(origin);
      expect(request.headers.get("x-algolia-api-key")).toBe(
        input.credentials.api_key,
      );
    }
  }
});
it("keeps an in-flight configure on its original node and saves no proof after replacement", async () => {
  const bound = activate();
  await save();
  const first = node();
  const entered = deferred<void>();
  const finish = deferred<Response>();
  first.respond(async () => {
    entered.resolve();
    return finish.promise;
  });
  const control = controller();
  const pending = control.connect(input);
  const rejected = expect(pending).rejects.toThrow();
  await entered.promise;
  const second = node();
  finish.resolve(Response.json({ nbPages: 1, items: [{ name: "old-node" }] }));
  await rejected;
  expect(
    readDeviceRows().filter((row) => row.providerId === "algolia"),
  ).toEqual([]);
  expect(second.capture).not.toHaveBeenCalled();
  expect(second.fetch).not.toHaveBeenCalled();
  expect(first.capture).toHaveBeenCalledTimes(1);
  expect((await control.connect(input)).status).toBe("connected");
  expect(second.capture).toHaveBeenCalledTimes(1);
  expect(second.fetch).toHaveBeenCalledTimes(1);
  expect(bound.context.egressCalls).toEqual([]);
});
it.each(["route", "lease", "activation"])(
  "rejects pending %s withdrawal without reusing its proof or another activation",
  async (reason) => {
    const bound = activate();
    const stored = await save();
    const first = node();
    const entered = deferred<void>();
    const finish = deferred<Response>();
    first.respond(async () => {
      entered.resolve();
      return finish.promise;
    });
    const control = controller();
    const driver = nativeConnectorDriver("api-key", "algolia");
    const pending = control.connect(input);
    const rejected = expect(pending).rejects.toThrow();
    await entered.promise;
    if (reason === "route") {
      const nativeHTTP = TailscaleNativeHTTPConfiguration.parse(
        stored.record.nativeHTTP,
      );
      await updateBrowserNodeNativeHTTP(
        stored.record,
        { ...nativeHTTP, exitNodeID: "other-exit" },
        () => {},
      );
    } else if (reason === "lease") bound.context.abort();
    else bound.activation.dispose();
    finish.resolve(
      Response.json({ nbPages: 1, items: [{ name: "withdrawn" }] }),
    );
    await rejected;
    expect(readDeviceRows().some((row) => row.providerId === "algolia")).toBe(
      false,
    );
    const second = node();
    if (reason === "route")
      expect((await control.connect(input)).status).toBe("connected");
    else {
      if (reason === "activation") activate();
      await expect(async () =>
        driver.configure({ ...input, providerId: "algolia" }),
      ).rejects.toThrow();
      expect(second.capture).not.toHaveBeenCalled();
      expect(second.fetch).not.toHaveBeenCalled();
    }
    expect(bound.context.egressCalls).toEqual([]);
  },
);
it("retains the configured Vault cleanup route across explicit later verification and refuses silent compensation rerouting", async () => {
  const bound = activate();
  await save("https://vault.example.test");
  const first = node();
  const lookup = async () =>
    Response.json({
      data: { policies: ["default"], ttl: 0, renewable: false },
    });
  first.respond(lookup);
  const driver = nativeConnectorDriver("api-key", "vault");
  const saved = await driver.configure({
    ...input,
    providerId: "vault",
    parameters: { endpoint: "https://vault.example.test", namespace: "" },
  });
  const record = loadNativeConnectorRecord(saved.connectionId);
  const grant = record?.privateState.grants.user;
  if (!record || !grant) throw new Error("Missing actual Vault grant");
  const second = node();
  second.respond(lookup);
  await driver.verify(saved.connectionId);
  const calls = second.fetch.mock.calls.length;
  await expect(async () =>
    driver.cleanup.cleanup(
      {
        id: "provider-self-revoke:1",
        kind: "revoke",
        providerId: "vault",
        actor: grant.actor,
        fingerprint: grant.fingerprint,
        targetId: grant.targetId ?? "vault",
        grant,
      },
      {
        connectionId: saved.connectionId,
        configuration: saved.configuration,
        persistGrantRotation: async () => {
          throw new Error("No rotation expected");
        },
      },
    ),
  ).rejects.toThrow();
  expect(first.fetch).toHaveBeenCalledTimes(1);
  expect(second.fetch).toHaveBeenCalledTimes(calls);
  expect(bound.context.egressCalls).toEqual([]);
});
