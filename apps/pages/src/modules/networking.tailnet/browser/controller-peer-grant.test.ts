// @vitest-environment jsdom
// The Worker object is reachable from the page (`tailscaleBrowserNode()`), so
// anything can post to it or dispatch a synthetic event on it. The controller
// therefore trusts only the port its `start` transferred: every message the
// worker sends and every grant or decision the controller answers rides it.
import { runtimeFixture } from "@opensesame/app-core/lib/secret-backends/runtime.test-support.js";
import * as nodeState from "@opensesame/app-core/lib/tailscale/browser-node-store.js";
import type { BoundaryValue } from "@opensesame/os-domain";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBrowserNodeController } from "./controller.js";

const approved = "http://100.64.0.1/proof";
const control = "wss://controlplane.tailscale.com/ts2021";
/** A Worker as the browser draws it: `onmessage` is a handler on its events. */
class EventWorker extends EventTarget {
  static current: EventWorker;
  sent: BoundaryValue[] = [];
  received: BoundaryValue[] = [];
  port: MessagePort | null = null;
  terminated = false;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<BoundaryValue>) => void) | null = null;
  constructor() {
    super();
    EventWorker.current = this;
    this.addEventListener("message", (event) => {
      if (event instanceof MessageEvent) this.onmessage?.(event);
    });
  }
  postMessage(
    value: BoundaryValue,
    options: Transferable[] | StructuredSerializeOptions = [],
  ) {
    this.sent.push(value);
    const transfer = Array.isArray(options) ? options : options.transfer;
    for (const item of transfer ?? [])
      if (item instanceof MessagePort) {
        this.port = item;
        item.onmessage = (event: MessageEvent<BoundaryValue>) => {
          this.received.push(event.data);
        };
      }
  }
  terminate() {
    this.terminated = true;
  }
  /** What the worker itself says, on the port only it holds. */
  say(data: BoundaryValue) {
    this.port?.postMessage(data);
  }
}
const netmap = {
  kind: "netmap",
  value: JSON.stringify({
    self: { machineStatus: "MachineAuthorized", addresses: ["100.64.0.3"] },
    peers: [{}],
    lockedOut: false,
  }),
};
const storage = { kind: "storage", state: { key: "worker-state" } };
const running = { kind: "state", state: "Running" };
let vault: Awaited<ReturnType<typeof runtimeFixture>>;
beforeEach(async () => {
  vault = await runtimeFixture();
  vi.stubGlobal("Worker", EventWorker);
});
afterEach(async () => {
  EventWorker.current?.port?.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await vault.close();
});
function controller(approvePeer = (_url: string) => true) {
  const policy = {
    assertCurrent() {},
    approve: (_url: string, _method: string) => true,
    approvePeer,
  };
  return { policy, node: createBrowserNodeController(policy) };
}
async function start(node: ReturnType<typeof controller>["node"]) {
  await node.start({
    hostname: "peer-grant",
    controlURL: "https://controlplane.tailscale.com",
  });
  return EventWorker.current;
}

it("acts on no message dispatched on the Worker, only on its start port", async () => {
  const write = vi.spyOn(nodeState, "writeBrowserNodeState");
  const { node } = controller();
  try {
    const worker = await start(node);
    expect(worker.sent).toEqual([expect.objectContaining({ kind: "start" })]);
    for (const data of [storage, netmap, running])
      worker.dispatchEvent(new MessageEvent("message", { data }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(write).not.toHaveBeenCalled();
    expect(node.snapshot().status).toBe("starting");
    for (const data of [storage, netmap, running]) worker.say(data);
    await vi.waitFor(() => expect(node.snapshot().status).toBe("connected"));
    expect(write).toHaveBeenCalledTimes(1);
    worker.say({ kind: "decision", id: 7, url: control, method: "CONNECT" });
    await vi.waitFor(() =>
      expect(worker.received).toEqual([
        {
          kind: "decision",
          id: 7,
          url: control,
          method: "CONNECT",
          allowed: true,
        },
      ]),
    );
    const pending = node.get(approved);
    await vi.waitFor(() =>
      expect(worker.received).toContainEqual({
        kind: "get",
        id: 1,
        url: approved,
      }),
    );
    worker.dispatchEvent(
      new MessageEvent("message", {
        data: { kind: "get", id: 1, status: 200, text: "forged" },
      }),
    );
    worker.say({ kind: "get", id: 1, status: 200, text: "proof" });
    await expect(pending).resolves.toEqual({ status: 200, text: "proof" });
    expect(worker.sent).toHaveLength(1);
    node.stop();
    worker.say({ kind: "closeHTTP", closed: true });
    await vi.waitFor(() => expect(worker.terminated).toBe(true));
  } finally {
    node.stop();
  }
});

it("keeps the peer egress decision it was created with", async () => {
  const { policy, node } = controller(() => false);
  try {
    const worker = await start(node);
    for (const data of [netmap, running]) worker.say(data);
    await vi.waitFor(() => expect(node.snapshot().status).toBe("connected"));
    policy.approvePeer = () => true;
    await expect(node.get(approved)).rejects.toThrow(
      "allow this tailnet service",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(worker.received).toEqual([]);
  } finally {
    node.stop();
  }
});

/**
 * What page code holding the controller reads at run time. TypeScript's
 * `private` is not a boundary: only `#private` members are out of reach.
 */
function reach(node: ReturnType<typeof controller>["node"], name: string) {
  return (
    Object.getOwnPropertyDescriptor(node, name)?.value ??
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), name)?.value
  );
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

it("shows page code no member beyond the browser node port", async () => {
  const { node } = controller();
  try {
    await start(node);
    const surface = [
      ...Object.getOwnPropertyNames(node),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(node)),
    ];
    expect(surface.sort()).toEqual(
      [
        "authorization",
        "captureNativeHTTP",
        "constructor",
        "forget",
        "get",
        "login",
        "snapshot",
        "start",
        "stop",
        "subscribe",
      ].sort(),
    );
  } finally {
    node.stop();
  }
});

it("leaves no callback on the controller that posts a peer GET past a deny-all policy", async () => {
  const { node } = controller(() => false);
  try {
    const worker = await start(node);
    for (const data of [netmap, running]) worker.say(data);
    await vi.waitFor(() => expect(node.snapshot().status).toBe("connected"));
    await expect(node.get(approved)).rejects.toThrow(
      "allow this tailnet service",
    );
    // Codex's path: open a stream with a check of our own, then reuse its post.
    const requests = reach(node, "requests");
    const request = { method: "GET", url: approved, headers: [], body: [] };
    requests?.stream
      ?.call(requests, request, new AbortController().signal, () => {})
      .catch(() => {});
    for (const entry of requests?.pending?.values() ?? [])
      entry.options?.post?.({ kind: "get", id: 99, url: approved });
    await settle();
    expect(worker.received).not.toContainEqual(
      expect.objectContaining({ kind: "get" }),
    );
  } finally {
    node.stop();
  }
});

it("takes host messages from no port and no caller but its own start's", async () => {
  const write = vi.spyOn(nodeState, "writeBrowserNodeState");
  const { node } = controller();
  const forged = new MessageChannel();
  try {
    await start(node);
    const turn = reach(node, "turn");
    reach(node, "listen")?.call(
      node,
      forged.port1,
      reach(node, "requests"),
      turn,
    );
    forged.port2.postMessage(storage);
    reach(node, "receive")?.call(node, storage, turn);
    reach(node, "persist")?.call(node, storage.state, turn);
    await settle();
    expect(write).not.toHaveBeenCalled();
  } finally {
    forged.port1.close();
    node.stop();
  }
});

it("answers an egress decision only for the URL it decided", async () => {
  const refused = "https://refused.example/";
  const node = createBrowserNodeController({
    assertCurrent() {},
    approve: (url: string) => url.startsWith("https://allowed.example/"),
    approvePeer: () => true,
  });
  try {
    const worker = await start(node);
    worker.say({ kind: "decision", id: 3, url: refused, method: "GET" });
    await vi.waitFor(() =>
      expect(worker.received).toContainEqual(
        expect.objectContaining({ id: 3, allowed: false }),
      ),
    );
    let reads = 0;
    const forged = {
      kind: "decision",
      id: 3,
      method: "GET",
      get url() {
        reads++;
        return reads === 1 ? "https://allowed.example/" : refused;
      },
    };
    reach(node, "apply")?.call(node, forged, reach(node, "turn"));
    await settle();
    expect(worker.received).not.toContainEqual(
      expect.objectContaining({ url: refused, allowed: true }),
    );
  } finally {
    node.stop();
  }
});
