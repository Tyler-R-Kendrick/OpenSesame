import {
  assertLeaseCurrent,
  mintLease,
} from "@opensesame/app-core/lib/capabilities/lease.js";
import {
  deferred,
  runtimeFixture,
} from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import * as nodeState from "@opensesame/app-core/lib/tailscale/browser-node-store.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  StatusWorker,
  stubBrowserNodeWorker,
} from "./authorization.test-support.js";
import { createBrowserNodeController } from "./controller.js";
let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
let active = true;
const approve = vi.fn(() => true);
const config = {
  hostname: "operator-browser",
  controlURL: "https://controlplane.tailscale.com",
};
type HeldWrite = { resume(): void; returned: boolean };
const heldWrites: HeldWrite[] = [];
function holdWrites() {
  const write = nodeState.writeBrowserNodeState;
  vi.spyOn(nodeState, "writeBrowserNodeState").mockImplementation(
    async (...args) => {
      const receipt = await write(...args);
      const gate = deferred<void>();
      const held = { resume: () => gate.resolve(), returned: false };
      heldWrites.push(held);
      await gate.promise;
      held.returned = true;
      return receipt;
    },
  );
}
async function editToken() {
  const item = vaultStore
    .getSnapshot()
    .items.find((entry) => entry.kind === "credential");
  if (!item || item.kind !== "credential" || item.method.type !== "token")
    throw new Error("Expected node credential");
  await vaultStore.saveItem({
    ...item,
    method: { ...item.method, token: '{"person":"edited"}' },
  });
}
function controller() {
  return createBrowserNodeController({
    assertCurrent() {
      if (!active) throw new Error("disposed");
    },
    approve,
    approvePeer: () => true,
  });
}
beforeEach(async () => {
  fixture = await runtimeFixture();
  active = true;
  approve.mockClear();
  stubBrowserNodeWorker();
});
afterEach(async () => {
  for (const write of heldWrites.splice(0)) write.resume();
  vi.unstubAllGlobals();
  await fixture.close();
});
function authorized(worker: StatusWorker) {
  worker.emit({
    kind: "netmap",
    value: JSON.stringify({
      self: { machineStatus: "MachineAuthorized", addresses: ["100.64.0.3"] },
      peers: [{}],
      lockedOut: false,
    }),
  });
  worker.emit({ kind: "state", state: "Running" });
}
it("requires both real SDK state signals and sealed state persistence before admitting later requests", async () => {
  const node = controller();
  await node.start(config);
  const worker = StatusWorker.current;
  worker.emit({
    kind: "netmap",
    value: JSON.stringify({
      self: { machineStatus: "MachineAuthorized", addresses: ["100.64.0.3"] },
      peers: [],
      lockedOut: false,
    }),
  });
  await vi.waitFor(() =>
    expect(node.snapshot().addresses).toEqual(["100.64.0.3"]),
  );
  expect(node.snapshot().status).toBe("starting");
  worker.emit({
    kind: "storage",
    state: { privateKey: "fixture-private-node-key" },
  });
  worker.emit({
    kind: "decision",
    id: 7,
    url: "wss://controlplane.tailscale.com/ts2021",
    method: "CONNECT",
  });
  authorized(worker);
  await vi.waitFor(() => expect(node.snapshot().status).toBe("connected"));
  expect(worker.sent).toContainEqual({
    kind: "decision",
    id: 7,
    url: "wss://controlplane.tailscale.com/ts2021",
    method: "CONNECT",
    allowed: true,
  });
  expect(
    vaultStore
      .getSnapshot()
      .items.some(
        (item) =>
          item.kind === "credential" &&
          item.method.type === "token" &&
          item.method.token.includes("fixture-private-node-key"),
      ),
  ).toBe(true);
  node.stop();
  expect(worker.terminated).toBe(true);
  expect(node.snapshot().addresses).toEqual([]);
});
it("refuses optional telemetry and late policy decisions after disposal", async () => {
  const node = controller();
  await node.start(config);
  const worker = StatusWorker.current;
  worker.emit({
    kind: "decision",
    id: 1,
    url: "https://log.tailscale.com/c/opaque",
    method: "POST",
  });
  await vi.waitFor(() =>
    expect(worker.sent).toContainEqual({
      kind: "decision",
      id: 1,
      url: "https://log.tailscale.com/c/opaque",
      method: "POST",
      allowed: false,
    }),
  );
  expect(approve).not.toHaveBeenCalled();
  active = false;
  worker.emit({
    kind: "decision",
    id: 2,
    url: "https://controlplane.tailscale.com/key",
    method: "GET",
  });
  await vi.waitFor(() => expect(worker.terminated).toBe(true));
  expect(worker.sent).not.toContainEqual(
    expect.objectContaining({ kind: "decision", id: 2, allowed: true }),
  );
});
it("clears a real authorization URL and terminates when actual vault credential bytes change", async () => {
  const node = controller();
  await node.start(config);
  const worker = StatusWorker.current;
  worker.emit({ kind: "auth", url: "https://login.tailscale.com/a/fixture" });
  await vi.waitFor(() =>
    expect(node.snapshot().authURL).toContain("login.tailscale.com"),
  );
  await editToken();
  expect(worker.terminated).toBe(true);
  expect(node.snapshot().authURL).toBe("");
});
it("refuses redirected authorization origins and never publishes a late response after stop", async () => {
  const node = controller();
  await node.start(config);
  const worker = StatusWorker.current;
  worker.emit({ kind: "auth", url: "https://attacker.example/auth" });
  await vi.waitFor(() => expect(worker.terminated).toBe(true));
  worker.emit({ kind: "state", state: "Running" });
  authorized(worker);
  await Promise.resolve();
  expect(node.snapshot().status).toBe("error");
  expect(node.snapshot().addresses).toEqual([]);
});
it("rejects pending peer results when a browser node is disconnected", async () => {
  const node = controller();
  await node.start(config);
  const worker = StatusWorker.current;
  authorized(worker);
  await vi.waitFor(() => expect(node.snapshot().status).toBe("connected"));
  const response = node.get("http://100.64.0.1:8080/proof");
  node.stop();
  await expect(response).rejects.toThrow("stopped");
  worker.emit({ kind: "get", id: 1, status: 200, text: "late" });
  expect(worker.terminated).toBe(false);
  worker.emit({ kind: "closeHTTP", closed: true });
  await vi.waitFor(() => expect(worker.terminated).toBe(true));
  expect(node.snapshot().status).toBe("stopped");
});
it("never admits a connected node or peer request for an authorized netmap without addresses", async () => {
  const node = controller();
  await node.start(config);
  const worker = StatusWorker.current;
  worker.emit({
    kind: "netmap",
    value: JSON.stringify({
      self: { machineStatus: "MachineAuthorized", addresses: [] },
      peers: [{}],
      lockedOut: false,
    }),
  });
  worker.emit({ kind: "state", state: "Running" });
  await vi.waitFor(() => expect(node.snapshot().peerCount).toBe(1));
  expect(node.snapshot().status).toBe("starting");
  await expect(node.get("http://100.64.0.1:8080/proof")).rejects.toThrow(
    "Connect a browser node",
  );
  expect(worker.sent).not.toContainEqual(
    expect.objectContaining({ kind: "get" }),
  );
  node.stop();
});
it("withdraws a timed-out peer GET before terminating its original drained worker", async () => {
  const node = controller();
  await node.start(config);
  const worker = StatusWorker.current;
  authorized(worker);
  await vi.waitFor(() => expect(node.snapshot().status).toBe("connected"));
  vi.useFakeTimers();
  try {
    const pending = node.get("http://100.64.0.1:8080/proof");
    const refused = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(30_000);
    await refused;
    expect(worker.terminated).toBe(false);
    worker.emit({ kind: "closeHTTP", closed: true });
    // The acknowledged drain, not the 60 s bound: waitFor advances ~1 s.
    await vi.waitFor(() => expect(worker.terminated).toBe(true));
    expect(node.snapshot().status).toBe("stopped");
  } finally {
    vi.useRealTimers();
    node.stop();
  }
});

it.each(["edited", "deleted"])(
  "refuses an actual token %s after store completion but before controller adoption",
  async (change) => {
    holdWrites();
    const node = controller();
    await node.start(config);
    const worker = StatusWorker.current;
    worker.emit({ kind: "storage", state: { key: "real-committed-state" } });
    await vi.waitFor(() => expect(heldWrites).toHaveLength(1));
    if (change === "edited") await editToken();
    else {
      const item = vaultStore.getSnapshot().items[0];
      if (!item) throw new Error("Missing actual node Token");
      await vaultStore.trashItem(item.id);
      await vaultStore.purgeItem(item.id);
    }
    expect(worker.terminated).toBe(false);
    heldWrites[0]?.resume();
    await vi.waitFor(() => expect(worker.terminated).toBe(true));
    expect(node.snapshot().status).toBe("error");
    expect(node.snapshot().addresses).toEqual([]);
  },
);

it("cannot adopt an old receipt into a different restarted node record", async () => {
  holdWrites();
  const node = controller();
  await node.start(config);
  const older = StatusWorker.current;
  older.emit({ kind: "storage", state: { key: "older-turn" } });
  await vi.waitFor(() => expect(heldWrites).toHaveLength(1));
  await node.forget();
  await node.start({ ...config, hostname: "new-node-record" });
  const newer = StatusWorker.current;
  heldWrites[0]?.resume();
  await vi.waitFor(() => expect(heldWrites[0]?.returned).toBe(true));
  newer.emit({ kind: "storage", state: { key: "newer-turn" } });
  await vi.waitFor(() => expect(heldWrites).toHaveLength(2));
  heldWrites[1]?.resume();
  authorized(newer);
  await vi.waitFor(() => expect(node.snapshot().status).toBe("connected"));
  expect(older.terminated).toBe(true);
  expect(newer.terminated).toBe(false);
  expect(node.snapshot().hostname).toBe("new-node-record");
  node.stop();
});

it("does not decrement a newer turn's in-flight write when an old write settles", async () => {
  holdWrites();
  const node = controller();
  await node.start(config);
  StatusWorker.current.emit({ kind: "storage", state: { key: "older" } });
  await vi.waitFor(() => expect(heldWrites).toHaveLength(1));
  await node.start(config);
  const newer = StatusWorker.current;
  newer.emit({ kind: "storage", state: { key: "newer" } });
  await vi.waitFor(() => expect(heldWrites).toHaveLength(2));
  heldWrites[0]?.resume();
  await vi.waitFor(() => expect(heldWrites[0]?.returned).toBe(true));
  expect(() => node.login()).not.toThrow();
  heldWrites[1]?.resume();
  authorized(newer);
  await vi.waitFor(() => expect(node.snapshot().status).toBe("connected"));
  await editToken();
  expect(newer.terminated).toBe(true);
});

it("cannot recover an actual withdrawn activation lease after a held store receipt", async () => {
  const authority = mintLease(
    {
      instanceId: "fixture",
      installationId: "fixture",
      vaultId: null,
      distributionId: "fixture",
      policyRevision: "1",
      selectionRevision: "1",
      planDigest: "sha256:fixture",
    },
    1,
  );
  const node = createBrowserNodeController({
    assertCurrent: () =>
      assertLeaseCurrent(authority.lease, 1, "networking.tailnet"),
    approve,
    approvePeer: () => true,
  });
  holdWrites();
  await node.start(config);
  const worker = StatusWorker.current;
  worker.emit({
    kind: "storage",
    state: { key: "committed-before-withdrawal" },
  });
  await vi.waitFor(() => expect(heldWrites).toHaveLength(1));
  authority.abort("operator withdrew networking");
  heldWrites[0]?.resume();
  authorized(worker);
  await vi.waitFor(() => expect(worker.terminated).toBe(true));
  expect(node.snapshot().status).toBe("error");
  expect(node.snapshot().addresses).toEqual([]);
});

it("cannot commit an old turn's still-pending vault write after restarting", async () => {
  const node = controller();
  await node.start(config);
  const gate = deferred<void>();
  const entered = deferred<void>();
  const save = vaultStore.saveItems.bind(vaultStore);
  const pending = vi
    .spyOn(vaultStore, "saveItems")
    .mockImplementationOnce(async (...args) => {
      entered.resolve();
      await gate.promise;
      return save(...args);
    });
  StatusWorker.current.emit({
    kind: "storage",
    state: { key: "pending-old-turn" },
  });
  await entered.promise;
  await node.start(config);
  const newer = StatusWorker.current;
  newer.emit({ kind: "storage", state: { key: "committed-new-turn" } });
  authorized(newer);
  await vi.waitFor(() => expect(node.snapshot().status).toBe("connected"));
  gate.resolve();
  await expect(pending.mock.results[0]?.value).rejects.toThrow();
  expect(newer.terminated).toBe(false);
  expect(JSON.stringify(vaultStore.getSnapshot().items)).toContain(
    "committed-new-turn",
  );
  expect(JSON.stringify(vaultStore.getSnapshot().items)).not.toContain(
    "pending-old-turn",
  );
  await editToken();
  expect(newer.terminated).toBe(true);
});
