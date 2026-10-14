import { runtimeFixture } from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import type { BoundaryValue } from "@opensesame/os-domain";
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBrowserNodeController } from "./controller.js";
class WorkerFixture {
  static current: WorkerFixture;
  onmessage: ((event: { data: BoundaryValue }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: BoundaryValue[] = [];
  terminated = false;
  constructor() {
    WorkerFixture.current = this;
  }
  postMessage(value: BoundaryValue) {
    this.sent.push(value);
  }
  terminate() {
    this.terminated = true;
  }
  emit(data: BoundaryValue) {
    this.onmessage?.({ data });
  }
}
let fixture: Awaited<ReturnType<typeof runtimeFixture>>;
let active = true;
const approve = vi.fn(() => true);
const config = {
  hostname: "operator-browser",
  controlURL: "https://controlplane.tailscale.com",
};
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
  vi.stubGlobal("Worker", WorkerFixture);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await fixture.close();
});
function authorized(worker: WorkerFixture) {
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
  const worker = WorkerFixture.current;
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
  const worker = WorkerFixture.current;
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
  expect(worker.sent).not.toContainEqual({
    kind: "decision",
    id: 2,
    allowed: true,
  });
});
it("clears a real authorization URL and terminates when actual vault credential bytes change", async () => {
  const node = controller();
  await node.start(config);
  const worker = WorkerFixture.current;
  worker.emit({ kind: "auth", url: "https://login.tailscale.com/a/fixture" });
  await vi.waitFor(() =>
    expect(node.snapshot().authURL).toContain("login.tailscale.com"),
  );
  const item = vaultStore
    .getSnapshot()
    .items.find((entry) => entry.kind === "credential");
  if (!item || item.kind !== "credential" || item.method.type !== "token")
    throw new Error("Expected node credential");
  const edited = structuredClone(item);
  if (edited.method.type === "token")
    edited.method.token = '{"person":"edited"}';
  await vaultStore.saveItem(edited);
  expect(worker.terminated).toBe(true);
  expect(node.snapshot().authURL).toBe("");
});
it("refuses redirected authorization origins and never publishes a late response after stop", async () => {
  const node = controller();
  await node.start(config);
  const worker = WorkerFixture.current;
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
  const worker = WorkerFixture.current;
  authorized(worker);
  await vi.waitFor(() => expect(node.snapshot().status).toBe("connected"));
  const response = node.get("http://100.64.0.1:8080/proof");
  node.stop();
  await expect(response).rejects.toThrow("stopped");
  worker.emit({ kind: "get", id: 1, status: 200, text: "late" });
  expect(node.snapshot().status).toBe("stopped");
});
it("never admits a connected node or peer request for an authorized netmap without addresses", async () => {
  const node = controller();
  await node.start(config);
  const worker = WorkerFixture.current;
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
it("terminates the actual worker when a peer GET times out because the SDK has no per-request abort", async () => {
  const node = controller();
  await node.start(config);
  const worker = WorkerFixture.current;
  authorized(worker);
  await vi.waitFor(() => expect(node.snapshot().status).toBe("connected"));
  vi.useFakeTimers();
  try {
    const pending = node.get("http://100.64.0.1:8080/proof");
    const refused = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(30_000);
    await refused;
    expect(worker.terminated).toBe(true);
    expect(node.snapshot().status).toBe("stopped");
  } finally {
    vi.useRealTimers();
    node.stop();
  }
});
