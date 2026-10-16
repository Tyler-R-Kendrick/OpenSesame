/** @vitest-environment jsdom */
import {
  readDeviceRows,
  removeDeviceConfigurationDurable,
  updateDeviceConfigurationDurable,
} from "@opensesame/app-core/lib/device-connector-records.js";
import {
  deviceConnectorView,
  isNativeDeviceConnection,
} from "@opensesame/app-core/lib/device-connector-view.js";
import { saveDeviceConnectorConfigurationDurable } from "@opensesame/app-core/lib/device-connectors.js";
import { runtimePassword } from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import { deferred } from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import {
  bindTailscaleBrowserNode,
  tailscaleBrowserNode,
  tailscaleNodeAuthorization,
} from "@opensesame/app-core/lib/tailscale/browser-node-port.js";
import * as nodeState from "@opensesame/app-core/lib/tailscale/browser-node-store.js";
import { enrollTotp } from "@opensesame/app-core/lib/vault/store-totp.fixture.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { netmap, statusFixture } from "./authorization.test-support.js";
let fixture: Awaited<ReturnType<typeof statusFixture>>;
beforeEach(async () => {
  fixture = await statusFixture();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fixture.close();
  vi.unstubAllGlobals();
});
function current() {
  return fixture.connection();
}
function pending() {
  expect(current().status).toBe("pending");
  expect(tailscaleNodeAuthorization()?.connected ?? false).toBe(false);
}
it("projects authenticated browser membership, without peer or account claims", async () => {
  await fixture.connect();
  expect(fixture.node.authorization?.()).toMatchObject({ connected: true });
  const connection = current();
  expect(connection).toMatchObject({
    status: "active",
    statusDetail: "Browser node connected",
    grantedScopes: [],
    accountLabel: null,
    expiresAt: null,
    refreshable: false,
  });
  expect(isNativeDeviceConnection(connection)).toBe(true);
  expect(tailscaleNodeAuthorization()).toEqual({
    connectionId: connection.connectionId,
    connected: true,
  });
  expect(fixture.fetcher).not.toHaveBeenCalled();
});
it.each(["login", "approval", "running-only", "unauthorized", "no-addresses"])(
  "keeps %s pending",
  async (state) => {
    const worker = await fixture.start();
    if (state === "login") worker.emit({ kind: "state", state: "NeedsLogin" });
    if (state === "approval")
      worker.emit({ kind: "state", state: "NeedsMachineAuth" });
    if (state === "unauthorized")
      netmap(worker, ["100.64.0.3"], "MachineUnauthorized");
    if (state === "no-addresses") netmap(worker, []);
    if (state !== "login" && state !== "approval")
      worker.emit({ kind: "state", state: "Running" });
    pending();
  },
);
it.each(["stop", "lock", "lease", "dispose", "credential", "policy"])(
  "withdraws live authority on %s",
  async (cause) => {
    const worker = await fixture.connect();
    if (cause === "stop") fixture.node.stop();
    if (cause === "lock") vaultStore.lock();
    if (cause === "lease") fixture.revoke();
    if (cause === "dispose") fixture.activation.dispose();
    if (cause === "credential") await fixture.editToken();
    if (cause === "policy")
      fixture.plan.network.allowedServiceOrigins = [
        "https://other-approved.example",
      ];
    pending();
    if (cause !== "policy") expect(worker.terminated).toBe(true);
    if (cause !== "policy")
      expect(() => fixture.node.get("http://100.64.0.4/health")).toThrow();
  },
);
it.each([
  "delete",
  "replace",
  "drop-selfhost",
  "drop-both",
  "malformed-native",
])(
  "terminates on durable public row %s while leaving the Token unchanged",
  async (change) => {
    const worker = await fixture.connect();
    const connection = current();
    const token = JSON.stringify(vaultStore.getSnapshot().items);
    const request = fixture.node.get("http://100.64.0.4/health");
    const rejected = expect(request).rejects.toThrow();
    if (change === "delete")
      await removeDeviceConfigurationDurable(connection.connectionId);
    else
      await updateDeviceConfigurationDurable(
        connection.connectionId,
        async (record) => {
          const fields = Object.fromEntries(
            Object.entries(record.row.fields).filter(
              ([key]) =>
                !(
                  change !== "replace" && key === "self_hosted_configuration"
                ) &&
                !(
                  (change === "drop-both" || change === "malformed-native") &&
                  key === "tailscale_browser_node"
                ),
            ),
          );
          if (change === "malformed-native")
            fields.native_configuration = "malformed";
          return {
            ...record,
            row: {
              ...record.row,
              fields,
              displayName: "Changed public binding",
            },
          };
        },
      );
    await rejected;
    expect(worker.terminated).toBe(true);
    expect(JSON.stringify(vaultStore.getSnapshot().items)).toBe(token);
    expect(tailscaleNodeAuthorization()).toBeNull();
    const row = readDeviceRows().find(
      (entry) => entry.connectionId === connection.connectionId,
    );
    if (row) expect(deviceConnectorView(row).status).toBe("pending");
    expect(() => fixture.node.get("http://100.64.0.4/health")).toThrow();
  },
);
it("does not treat an unmarked local Tailscale auth-key configuration as a live node", async () => {
  const saved = await saveDeviceConnectorConfigurationDurable(() => ({
    providerId: "tailscale",
    displayName: "Legacy key",
    fields: { auth_key: "public-placeholder" },
    scopes: [],
    secrets: {},
  }));
  const row = readDeviceRows().find(
    (entry) => entry.connectionId === saved.connectionId,
  );
  if (!row) throw new Error("Missing real saved row");
  expect(deviceConnectorView(row).status).toBe("pending");
  expect(isNativeDeviceConnection(deviceConnectorView(row))).toBe(true);
});
it("does not stop a live node for another provider's public write", async () => {
  const worker = await fixture.connect();
  await saveDeviceConnectorConfigurationDurable(() => ({
    providerId: "linear",
    displayName: "Other",
    fields: {},
    scopes: [],
    secrets: {},
  }));
  expect(worker.terminated).toBe(false);
  expect(current().status).toBe("active");
});
it("withdraws during real private-state persistence and notifies again after the committed receipt settles", async () => {
  const worker = await fixture.connect();
  const changes = vi.fn();
  const release = fixture.node.subscribe(changes);
  const held = fixture.holdReceipt();
  worker.emit({ kind: "storage", state: { key: "next-sdk-state" } });
  await held.ready;
  pending();
  const count = changes.mock.calls.length;
  held.release();
  await vi.waitFor(() => expect(current().status).toBe("active"));
  expect(changes.mock.calls.length).toBeGreaterThan(count);
  release();
});
it.each(["delete", "restart", "lease"])(
  "does not adopt an old held write after %s",
  async (cause) => {
    const worker = await fixture.connect();
    const id = current().connectionId;
    const held = fixture.holdReceipt();
    worker.emit({ kind: "storage", state: { key: "pending-old-turn" } });
    await held.ready;
    if (cause === "delete") await removeDeviceConfigurationDurable(id);
    if (cause === "lease") fixture.revoke();
    if (cause === "restart") {
      fixture.node.stop();
      await fixture.start();
    }
    expect(worker.terminated).toBe(true);
    held.release();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(tailscaleNodeAuthorization()?.connected ?? false).toBe(false);
    expect(fixture.node.snapshot().status).not.toBe("connected");
  },
);
it("rejects a port replaced during a pure authorization read; an old release cannot clear the replacement", async () => {
  await fixture.connect();
  const original = fixture.node.authorization;
  if (!original) throw new Error("Missing real authorization reader");
  const replacement = {
    ...fixture.node,
    stop: () => {},
    authorization: () => null,
  };
  let release = () => {};
  vi.spyOn(fixture.node, "authorization").mockImplementation(() => {
    const result = original();
    release = bindTailscaleBrowserNode(replacement);
    return result;
  });
  expect(tailscaleNodeAuthorization()).toBeNull();
  expect(tailscaleBrowserNode()).toBe(replacement);
  fixture.activation.dispose();
  expect(tailscaleBrowserNode()).toBe(replacement);
  release();
});
it("keeps policy rejection a pure read without stopping or publishing the node", async () => {
  const worker = await fixture.connect();
  const changed = vi.fn();
  const release = fixture.node.subscribe(changed);
  fixture.plan.network.allowedServiceOrigins = [
    "https://other-approved.example",
  ];
  expect(tailscaleNodeAuthorization()).toBeNull();
  expect(worker.terminated).toBe(false);
  expect(changed).not.toHaveBeenCalled();
  release();
});

it("does not lend an old node to a new guest vault", async () => {
  const worker = await fixture.connect();
  vaultStore.lock();
  await vaultStore.createGuest();
  expect(vaultStore.getSnapshot().guest).toBe(true);
  expect(worker.terminated).toBe(true);
  expect(tailscaleNodeAuthorization()).toBeNull();
  await expect(fixture.start()).rejects.toThrow();
});
it("cannot restore active proof while the owning vault awaits its second step", async () => {
  await enrollTotp(vaultStore);
  const selfId = vaultStore.getSnapshot().header?.unlocks?.totp?.selfItemId;
  if (!selfId) throw new Error("Missing actual self authenticator");
  await vaultStore.trashItem(selfId);
  const worker = await fixture.connect();
  vaultStore.lock();
  await vaultStore.unlock(runtimePassword);
  expect(vaultStore.getSnapshot().awaitingSecondStep).toBe(true);
  expect(worker.terminated).toBe(true);
  pending();
  await expect(fixture.start()).rejects.toThrow();
});
it("does not use a record owned by a different current vault", async () => {
  const worker = await fixture.connect();
  const before = [...worker.sent];
  const snapshot = vaultStore.getSnapshot();
  vi.spyOn(vaultStore, "getSnapshot").mockReturnValue({
    ...snapshot,
    tomb: "different-current-owner",
  });
  expect(tailscaleNodeAuthorization()).toBeNull();
  expect(() => fixture.node.get("http://100.64.0.4/health")).toThrow();
  expect(worker.sent).toEqual(before);
});

it.each(["new", "saved"])(
  "refuses a credential edited after the real %s open result but before startup adopts it",
  async (kind) => {
    if (kind === "saved") {
      await fixture.connect();
      fixture.node.stop();
    }
    const original = nodeState.openBrowserNodeState;
    const entered = deferred<void>();
    const resume = deferred<void>();
    vi.spyOn(nodeState, "openBrowserNodeState").mockImplementationOnce(
      async (...args) => {
        const result = await original(...args);
        entered.resolve();
        await resume.promise;
        return result;
      },
    );
    const starting = fixture.start();
    const rejected = expect(starting).rejects.toThrow(/changed during startup/);
    await entered.promise;
    try {
      await fixture.editToken();
    } finally {
      resume.resolve();
    }
    await rejected;
    expect(tailscaleNodeAuthorization()).toBeNull();
    expect(fixture.node.snapshot().status).not.toBe("connected");
  },
);
it("preserves the startup state size limit while decoding the same captured receipt", async () => {
  await fixture.connect();
  fixture.node.stop();
  const item = vaultStore.getSnapshot().items[0];
  if (!item || item.kind !== "credential" || item.method.type !== "token")
    throw new Error("Missing real node credential");
  const value = "x".repeat(850_000);
  await vaultStore.saveItem({
    ...item,
    method: {
      ...item.method,
      token: JSON.stringify({
        first: value,
        second: value,
        third: value,
        fourth: value,
        fifth: value,
      }),
    },
  });
  await expect(fixture.start()).rejects.toThrow(/missing or oversized/);
  expect(tailscaleNodeAuthorization()).toBeNull();
});
