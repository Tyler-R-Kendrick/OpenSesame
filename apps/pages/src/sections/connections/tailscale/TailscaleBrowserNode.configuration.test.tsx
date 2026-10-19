/** @vitest-environment jsdom */
import { rootCertificates } from "node:tls";
import { DEVICE_CONNECTOR_KEYS } from "@opensesame/app-core/lib/device-connector-records.js";
import {
  kvFlush,
  kvForgetAll,
  kvHydrate,
} from "@opensesame/app-core/lib/kv.js";
import {
  deferred,
  runtimeFixture,
  runtimePassword,
} from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import {
  type TailscaleBrowserNode as Node,
  type TailscaleNodeSnapshot,
  bindTailscaleBrowserNode,
} from "@opensesame/app-core/lib/tailscale/browser-node-port.js";
import * as nodeState from "@opensesame/app-core/lib/tailscale/browser-node-store.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TailscaleBrowserNode } from "./TailscaleBrowserNode.js";
let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
let release = () => {};
beforeEach(async () => {
  fixture = await runtimeFixture();
});
afterEach(async () => {
  cleanup();
  release();
  vi.restoreAllMocks();
  await fixture.close();
});
function field(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
function configuration() {
  const config = nodeState.savedBrowserNodeConfiguration();
  if (!config) throw new Error("No saved browser node");
  return config;
}
function check() {
  if (vaultStore.getSnapshot().status !== "unlocked") throw new Error("locked");
}
function nativeFields() {
  field("Integration HTTP transport", "native");
  field("Approved exit node ID", "approved-exit");
  field(
    "Integration origins and destination CIDRs",
    "https://api.example.com 203.0.113.0/24, 2001:db8::/32",
  );
}
function save() {
  fireEvent.click(
    screen.getByRole("button", { name: "Save browser node configuration" }),
  );
}
async function saved() {
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Save browser node configuration" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
}
function node() {
  const state: TailscaleNodeSnapshot = {
    status: "stopped",
    hostname: "",
    controlURL: "",
    authURL: "",
    addresses: [],
    peerCount: 0,
    failure: "",
  };
  const port: Node = {
    snapshot: () => state,
    subscribe: () => () => {},
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    forget: vi.fn(async () => {}),
    login: vi.fn(),
    get: vi.fn(async () => ({ status: 200, text: "" })),
  };
  release = bindTailscaleBrowserNode(port);
  return port;
}
it("saves shared route controls without starting a runtime and restores them after a genuine sealed-vault cold reload", async () => {
  render(<TailscaleBrowserNode ready online />);
  field("Browser node hostname", "operator-browser");
  nativeFields();
  field("Integration TLS trust", "operator");
  field("Operator CA certificates (PEM)", rootCertificates[0] ?? "");
  field("Optional node auth key", "never-persist-this-auth-key");
  save();
  await saved();
  const config = configuration();
  expect(config.nativeHTTP?.trustMode).toBe("operator");
  const stored = await nodeState.openBrowserNodeState(
    config,
    vaultStore.getSnapshot().tomb,
    check,
  );
  await nodeState.writeBrowserNodeState(
    stored.record,
    stored.state,
    { "private-machine-key": "original-node-only" },
    () => {},
  );
  const fingerprint = nodeState.browserNodeCredentialFingerprint(stored.record);
  await vaultStore.flushPendingWrites();
  await kvFlush();
  cleanup();
  vaultStore.lock();
  await kvFlush();
  kvForgetAll();
  await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
  await vaultStore.unlock(runtimePassword);
  render(<TailscaleBrowserNode ready online />);
  expect(screen.getByLabelText("Approved exit node ID")).toHaveProperty(
    "value",
    "approved-exit",
  );
  expect(
    screen.getByLabelText("Operator CA certificates (PEM)"),
  ).toHaveProperty("value", rootCertificates[0]);
  expect(screen.getByLabelText("Optional node auth key")).toHaveProperty(
    "value",
    "",
  );
  const restored = await nodeState.openBrowserNodeState(
    config,
    vaultStore.getSnapshot().tomb,
    check,
  );
  expect(restored.record.reference).toEqual(stored.record.reference);
  expect(nodeState.browserNodeCredentialFingerprint(restored.record)).toBe(
    fingerprint,
  );
  expect(await nodeState.readBrowserNodeState(restored.record)).toEqual({
    "private-machine-key": "original-node-only",
  });
  expect(JSON.stringify(vaultStore.getSnapshot().items)).not.toContain(
    "never-persist-this-auth-key",
  );
});
it("connects the exact saved typed route and withdraws the original node before retargeting or disabling it", async () => {
  const original = node();
  render(<TailscaleBrowserNode ready online />);
  nativeFields();
  save();
  await saved();
  const initial = configuration();
  const stored = await nodeState.openBrowserNodeState(
    initial,
    vaultStore.getSnapshot().tomb,
    check,
  );
  const privateBinding = stored.record.reference;
  vi.mocked(original.stop).mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Connect browser node" }));
  await waitFor(() =>
    expect(original.start).toHaveBeenCalledWith({ ...initial, authKey: "" }),
  );
  expect(original.stop).not.toHaveBeenCalled();
  await saved();
  field("Approved exit node ID", "replacement-exit");
  save();
  await saved();
  expect(original.stop).toHaveBeenCalledTimes(1);
  expect(nodeState.savedBrowserNodeConfiguration()?.nativeHTTP).toMatchObject({
    version: 1,
    exitNodeID: "replacement-exit",
  });
  expect(
    (
      await nodeState.openBrowserNodeState(
        configuration(),
        vaultStore.getSnapshot().tomb,
        check,
      )
    ).record.reference,
  ).toEqual(privateBinding);
  field("Integration HTTP transport", "browser");
  save();
  await saved();
  expect(original.stop).toHaveBeenCalledTimes(2);
  expect(nodeState.savedBrowserNodeConfiguration()).not.toHaveProperty(
    "nativeHTTP",
  );
});
it("validates before publishing and removes operator CA fields when public trust is selected", async () => {
  render(<TailscaleBrowserNode ready online />);
  nativeFields();
  field(
    "Integration origins and destination CIDRs",
    "https://api.example.com 203.0.113.1/24",
  );
  save();
  await saved();
  expect(nodeState.savedBrowserNodeConfiguration()).toBeNull();
  expect(
    screen.getByRole("img", { name: /Complete the approved route identity/ }),
  ).toBeTruthy();
  field(
    "Integration origins and destination CIDRs",
    "https://api.example.com 203.0.113.0/24",
  );
  field("Integration TLS trust", "operator");
  field("Operator CA certificates (PEM)", rootCertificates[0] ?? "");
  field("Integration TLS trust", "public");
  expect(screen.queryByLabelText("Operator CA certificates (PEM)")).toBeNull();
  save();
  await saved();
  expect(
    nodeState.savedBrowserNodeConfiguration()?.nativeHTTP,
  ).not.toHaveProperty("operatorCAPEM");
});
it.each(["lock", "node"] as const)(
  "refuses a pending save when its original %s owner changes",
  async (cause) => {
    node();
    const held = deferred<void>();
    const configure = nodeState.configureBrowserNodeState;
    const started = deferred<void>();
    vi.spyOn(nodeState, "configureBrowserNodeState").mockImplementation(
      async (...args) => {
        started.resolve();
        await held.promise;
        return configure(...args);
      },
    );
    render(<TailscaleBrowserNode ready online />);
    nativeFields();
    save();
    await started.promise;
    await act(async () => {
      if (cause === "lock") vaultStore.lock();
      else {
        release();
        node();
      }
      held.resolve();
      await held.promise;
    });
    await saved();
    expect(nodeState.savedBrowserNodeConfiguration()).toBeNull();
  },
);

it("saves shared peer controls, restores exact CA/peer fields cold, and withdraws the original node on peer retarget", async () => {
  const original = node();
  render(<TailscaleBrowserNode ready online />);
  field("Integration HTTP transport", "native");
  field("Native HTTPS route", "peer");
  expect(screen.queryByLabelText("Approved exit node ID")).toBeNull();
  field("Approved peer stable ID", "n-original-peer");
  field(
    "Integration origins and destination CIDRs",
    "https://byo.example.test 100.64.0.1/32",
  );
  field("Integration TLS trust", "operator");
  field("Operator CA certificates (PEM)", rootCertificates[0] ?? "");
  save();
  await saved();
  expect(original.start).not.toHaveBeenCalled();
  const config = configuration();
  expect(config.nativeHTTP).toMatchObject({
    version: 2,
    routeMode: "peer",
    peerID: "n-original-peer",
  });
  const tomb = vaultStore.getSnapshot().tomb;
  const stored = await nodeState.openBrowserNodeState(config, tomb, check);
  await nodeState.writeBrowserNodeState(
    stored.record,
    stored.state,
    { machine: "same-original-private-key" },
    check,
  );
  const credential = nodeState.browserNodeCredentialFingerprint(stored.record);
  await vaultStore.flushPendingWrites();
  await kvFlush();
  cleanup();
  vaultStore.lock();
  await kvFlush();
  kvForgetAll();
  await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
  await vaultStore.unlock(runtimePassword);
  render(<TailscaleBrowserNode ready online />);
  expect(screen.getByLabelText("Native HTTPS route")).toHaveProperty(
    "value",
    "peer",
  );
  expect(screen.getByLabelText("Approved peer stable ID")).toHaveProperty(
    "value",
    "n-original-peer",
  );
  expect(
    screen.getByLabelText("Operator CA certificates (PEM)"),
  ).toHaveProperty("value", rootCertificates[0]);
  expect(screen.queryByLabelText("Approved exit node ID")).toBeNull();
  expect(screen.getByLabelText("Optional node auth key")).toHaveProperty(
    "value",
    "",
  );
  vi.mocked(original.stop).mockClear();
  field("Approved peer stable ID", "n-replacement-peer");
  save();
  await saved();
  expect(original.stop).toHaveBeenCalledTimes(1);
  expect(original.start).not.toHaveBeenCalled();
  const reopened = await nodeState.openBrowserNodeState(
    configuration(),
    tomb,
    check,
  );
  expect(reopened.record.reference).toBe(stored.record.reference);
  expect(nodeState.browserNodeCredentialFingerprint(reopened.record)).toBe(
    credential,
  );
  expect(nodeState.readBrowserNodeState(reopened.record)).toEqual({
    machine: "same-original-private-key",
  });
  expect(() => nodeState.readBrowserNodeState(stored.record)).toThrow();
});
