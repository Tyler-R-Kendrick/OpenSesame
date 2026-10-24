// @vitest-environment jsdom
import { runtimeFixture } from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import * as nodeState from "@opensesame/app-core/lib/tailscale/browser-node-store.js";
import { expect, it, vi } from "vitest";
import {
  StatusWorker,
  stubBrowserNodeWorker,
} from "./authorization.test-support.js";
import { BrowserNodeRequests } from "./controller-requests.js";
import { BrowserNodeRetirement } from "./controller-retirement.js";
import { createBrowserNodeController } from "./controller.js";
it("withdraws page requests immediately but preserves original close receipt until drain", async () => {
  const worker = { postMessage: vi.fn() };
  const owner = vi.fn();
  const port = new BrowserNodeRequests(
    worker,
    owner,
    () => true,
    () => true,
    vi.fn(),
    false,
  );
  const request = port.get("http://100.64.0.1/proof");
  const refused = expect(request).rejects.toThrow("stopped");
  let closed = false;
  const closing = port.close().then((value) => {
    closed = true;
    return value;
  });
  await refused;
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(worker.postMessage).toHaveBeenCalledWith({ kind: "closeHTTP" });
  port.receive({ kind: "get", id: 1, status: 200, text: "late" });
  port.receive({ kind: "closeHTTP", closed: true });
  await expect(closing).resolves.toBe(true);
});
it("does not publish a response after its exact destination grant is withdrawn", async () => {
  let allowed = true;
  const worker = { postMessage: vi.fn() };
  const port = new BrowserNodeRequests(
    worker,
    () => {},
    () => true,
    () => allowed,
    vi.fn(),
    false,
  );
  const request = port.get("http://100.64.0.1/proof");
  allowed = false;
  port.receive({ kind: "get", id: 1, status: 200, text: "late" });
  await expect(request).rejects.toThrow("changed");
  const close = port.close();
  port.receive({ kind: "closeHTTP", closed: true });
  await close;
});

it("keeps replacement admission pending until the original peer drain completes", async () => {
  let finish: ((closed: boolean) => void) | undefined;
  const drain = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  const worker = { terminate: vi.fn() };
  const retirement = new BrowserNodeRetirement();
  retirement.retire({ usedPeer: true, close: () => drain }, worker);
  let admitted = false;
  const admission = retirement.ready().then(() => {
    admitted = true;
  });
  await Promise.resolve();
  expect(admitted).toBe(false);
  expect(worker.terminate).not.toHaveBeenCalled();
  finish?.(true);
  await admission;
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});

it("bounds a drain that never acknowledges", async () => {
  vi.useFakeTimers();
  try {
    const worker = { terminate: vi.fn() };
    const retirement = new BrowserNodeRetirement();
    retirement.retire(
      { usedPeer: true, close: () => new Promise<boolean>(() => {}) },
      worker,
    );
    const admission = retirement.ready().catch(() => ({
      message: "The original peer transport did not confirm closure.",
    }));
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(admission).resolves.toMatchObject({
      message: "The original peer transport did not confirm closure.",
    });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("does not reset a failed drain by stopping an already withdrawn node", async () => {
  const retirement = new BrowserNodeRetirement();
  const worker = { terminate: vi.fn() };
  retirement.retire({ usedPeer: true, close: async () => false }, worker);
  await expect(retirement.ready()).rejects.toThrow("did not confirm closure");
  retirement.retire(null, null);
  await expect(retirement.ready()).rejects.toThrow("did not confirm closure");
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});

it("does not reopen custody or create a replacement Worker before the original drain acknowledgement", async () => {
  const vault = await runtimeFixture();
  const open = vi.spyOn(nodeState, "openBrowserNodeState");
  let original: StatusWorker | undefined;
  let replacement: Promise<void> | undefined;
  stubBrowserNodeWorker();
  const node = createBrowserNodeController({
    assertCurrent() {},
    approve: () => true,
    approvePeer: () => true,
  });
  const config = {
    hostname: "peer-retirement-test",
    controlURL: "https://controlplane.tailscale.com",
  };
  try {
    await node.start(config);
    original = StatusWorker.current;
    original.emit({
      kind: "netmap",
      value: JSON.stringify({
        self: { machineStatus: "MachineAuthorized", addresses: ["100.64.0.3"] },
        peers: [{}],
        lockedOut: false,
      }),
    });
    original.emit({ kind: "state", state: "Running" });
    await vi.waitFor(() => expect(node.snapshot().status).toBe("connected"));
    const pending = node.get("http://100.64.0.1/proof");
    const withdrawn = expect(pending).rejects.toThrow("stopped");
    replacement = node.start(config);
    void replacement.catch(() => {});
    await withdrawn;
    await Promise.resolve();
    expect(open).toHaveBeenCalledTimes(1);
    expect(StatusWorker.current).toBe(original);
    expect(original.terminated).toBe(false);
    expect(original.sent).toContainEqual({ kind: "closeHTTP" });
    original.emit({ kind: "closeHTTP", closed: true });
    await replacement;
    expect(open).toHaveBeenCalledTimes(2);
    expect(StatusWorker.current).not.toBe(original);
    expect(original.terminated).toBe(true);
  } finally {
    original?.emit({ kind: "closeHTTP", closed: true });
    node.stop();
    await replacement?.catch(() => {});
    open.mockRestore();
    vi.unstubAllGlobals();
    await vault.close();
  }
});
