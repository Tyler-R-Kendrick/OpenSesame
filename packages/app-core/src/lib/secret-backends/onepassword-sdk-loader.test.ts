// @vitest-environment jsdom
import type { BoundaryValue } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureHost } from "../../host.js";
import { pageOrigin } from "../../ports.js";
import { createTestHost } from "../../test-host.js";
import artifacts from "./onepassword-artifacts.json" with { type: "json" };
import {
  type OnePasswordSdkClient,
  createBrowserOnePasswordClient,
} from "./onepassword-sdk-loader.js";
import {
  type OnePasswordAssets,
  OnePasswordWorkerRequestSchema,
} from "./onepassword-worker-protocol.js";
import type { SecretBackendTransport } from "./transport.js";

class WorkerFixture extends EventTarget implements Worker {
  static instances: WorkerFixture[] = [];
  static autoInitialize = true;
  readonly messages: BoundaryValue[] = [];
  readonly terminate = vi.fn();
  onmessage: Worker["onmessage"] = null;
  onmessageerror: Worker["onmessageerror"] = null;
  onerror: Worker["onerror"] = null;
  throwPosts = false;
  constructor(
    readonly url: URL | string,
    readonly options?: WorkerOptions,
  ) {
    super();
    WorkerFixture.instances.push(this);
  }
  postMessage(message: BoundaryValue): void {
    if (this.throwPosts) throw new Error("private token in post failure");
    this.messages.push(message);
    const parsed = OnePasswordWorkerRequestSchema.safeParse(message);
    if (
      parsed.success &&
      parsed.data.type === "initialize" &&
      WorkerFixture.autoInitialize
    )
      this.emit({ type: "initialized", id: parsed.data.id });
  }
  emit(data: BoundaryValue): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}
const settings = {
  accountOrigin: "https://account.example",
  serviceAccountToken: "private-fixture-not-a-provider-token",
  vaultId: "chosen-vault",
};
const failure = "The 1Password network request failed or its session ended.";
let assets: OnePasswordAssets;
let controller: AbortController;
let port: SecretBackendTransport;
let current: boolean;
const clients: OnePasswordSdkClient[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  WorkerFixture.instances = [];
  WorkerFixture.autoInitialize = true;
  configureHost(createTestHost({ worker: WorkerFixture }));
  assets = {
    origin: pageOrigin(),
    runtimeUrl: `${pageOrigin()}/base/${artifacts.assets.runtime}`,
    wasmUrl: `${pageOrigin()}/base/${artifacts.assets.wasm}`,
  };
  controller = new AbortController();
  current = true;
  port = {
    signal: controller.signal,
    assertCurrent() {
      if (!current) throw new Error("private vault detail");
    },
    fetch: vi.fn(),
  };
});
afterEach(() => {
  controller.abort();
  for (const client of clients.splice(0))
    expect(client.closed.aborted).toBe(true);
  vi.useRealTimers();
  configureHost(createTestHost());
});
async function create() {
  const client = await createBrowserOnePasswordClient(settings, assets, port);
  clients.push(client);
  const worker = WorkerFixture.instances.at(-1);
  if (!worker) throw new Error("Missing fixture worker");
  return { client, worker };
}
function deferredResponse() {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("1Password loader IPC/lifetime (fake Worker, no SDK authentication)", () => {
  it("uses the captured constructor port and dedicated literal module URL", async () => {
    const { worker, client } = await create();
    expect(new URL(worker.url).pathname).toMatch(
      /\/onepassword-sdk\.worker\.ts$/,
    );
    expect(worker.options).toEqual({
      type: "module",
      name: "opensesame-onepassword",
    });
    expect(port.fetch).not.toHaveBeenCalled();
    expect(client.closed.aborted).toBe(false);
    expect(worker.messages[0]).toMatchObject({
      type: "initialize",
      id: 1,
      assets,
      settings,
    });
  });

  it.each(["error", "messageerror", "abort", "timeout"])(
    "terminates once and rejects pending work on %s",
    async (cause) => {
      const { client, worker } = await create();
      const closed = vi.fn();
      client.closed.addEventListener("abort", closed);
      const pending = expect(
        client.invoke({ name: "ItemsList" }),
      ).rejects.toThrow(failure);
      if (cause === "abort") controller.abort();
      else if (cause === "timeout") await vi.advanceTimersByTimeAsync(30_000);
      else worker.dispatchEvent(new Event(cause));
      await pending;
      expect(closed).toHaveBeenCalledOnce();
      expect(worker.terminate).toHaveBeenCalledOnce();
      worker.emit({ type: "result", id: 2, result: { late: true } });
      await expect(client.invoke({ name: "ItemsList" })).rejects.toThrow(
        failure,
      );
    },
  );

  it("checks the captured owner after a result, not a replacement transport", async () => {
    const { client, worker } = await create();
    const pending = expect(
      client.invoke({ name: "ItemsGet", itemId: "item" }),
    ).rejects.toThrow(failure);
    current = false;
    worker.emit({ type: "result", id: 2, result: { secret: "not returned" } });
    await pending;
    expect(client.closed.aborted).toBe(true);
  });

  it("ignores unknown/duplicate replies and keeps HTTP IDs separate", async () => {
    port = {
      ...port,
      fetch: vi.fn(async () => {
        throw new Error("private network detail");
      }),
    };
    const { client, worker } = await create();
    const first = client.invoke({ name: "ItemsList" });
    worker.emit({
      type: "fetch",
      id: 2,
      url: `${settings.accountOrigin}/api/v3/auth/start`,
      method: "GET",
      headers: [],
      body: new Uint8Array(),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(worker.messages.at(-1)).toEqual({
      type: "fetch-result",
      id: 2,
      ok: false,
    });
    worker.emit({ type: "result", id: 999, result: "unmatched" });
    worker.emit({ type: "result", id: 2, result: ["matched"] });
    expect(await first).toEqual(["matched"]);
    const second = client.invoke({ name: "VaultsList" });
    worker.emit({ type: "result", id: 2, result: "duplicate" });
    worker.emit({ type: "result", id: 3, result: [] });
    expect(await second).toEqual([]);
    expect(client.closed.aborted).toBe(false);
  });

  it.each(["malformed", "wrong-type", "terminal"] as const)(
    "closes on %s reply without exposing its contents",
    async (kind) => {
      const { client, worker } = await create();
      const pending = expect(
        client.invoke({ name: "ItemsList" }),
      ).rejects.toThrow(failure);
      const messages = {
        malformed: { type: "result", id: 2, result: null, token: "raw" },
        "wrong-type": { type: "initialized", id: 2 },
        terminal: { type: "closed", code: "protocol" },
      } as const;
      worker.emit(messages[kind]);
      await pending;
      expect(worker.terminate).toHaveBeenCalledOnce();
    },
  );

  it("ordinary operation failure is safe and does not claim terminal revocation", async () => {
    const { client, worker } = await create();
    const pending = expect(
      client.invoke({ name: "ItemsList" }),
    ).rejects.toThrow(failure);
    worker.emit({ type: "failed", id: 2, code: "operation" });
    await pending;
    expect(client.closed.aborted).toBe(false);
  });

  it.each(["resolve", "reject"])(
    "drops late HTTP %s after hard termination",
    async (outcome) => {
      const held = deferredResponse();
      port = { ...port, fetch: () => held.promise };
      const { client, worker } = await create();
      worker.emit({
        type: "fetch",
        id: 1,
        url: `${settings.accountOrigin}/api/v3/auth/start`,
        method: "GET",
        headers: [],
        body: new Uint8Array(),
      });
      const before = worker.messages.length;
      controller.abort();
      if (outcome === "resolve") held.resolve(new Response("private response"));
      else held.reject(new Error("private token in failure"));
      await vi.advanceTimersByTimeAsync(0);
      expect(worker.messages).toHaveLength(before);
      expect(client.closed.aborted).toBe(true);
    },
  );

  it("postMessage failure hard-terminates and settles pending operations", async () => {
    const { client, worker } = await create();
    worker.throwPosts = true;
    await expect(client.invoke({ name: "VaultsList" })).rejects.toThrow(
      failure,
    );
    expect(client.closed.aborted).toBe(true);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it.each(["ack", "failed", "lost"])(
    "attempts graceful release then always terminates (%s)",
    async (outcome) => {
      const { client, worker } = await create();
      const invoke = expect(
        client.invoke({ name: "ItemsList" }),
      ).rejects.toThrow(failure);
      const disposed = client.dispose();
      expect(client.dispose()).toBe(disposed);
      expect(client.closed.aborted).toBe(true);
      expect(worker.messages.at(-1)).toEqual({ type: "dispose", id: 3 });
      expect(worker.terminate).not.toHaveBeenCalled();
      if (outcome === "ack") worker.emit({ type: "disposed", id: 3 });
      else if (outcome === "failed")
        worker.emit({ type: "failed", id: 3, code: "operation" });
      else await vi.advanceTimersByTimeAsync(1000);
      await Promise.all([disposed, invoke]);
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("external revoke during graceful release never waits for its deadline", async () => {
    const { client, worker } = await create();
    const disposed = client.dispose();
    controller.abort();
    await disposed;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a late initialization after caller abort", async () => {
    WorkerFixture.autoInitialize = false;
    const signal = new AbortController();
    const pending = expect(
      createBrowserOnePasswordClient(settings, assets, port, signal.signal),
    ).rejects.toThrow(failure);
    const worker = WorkerFixture.instances[0];
    signal.abort();
    worker?.emit({ type: "initialized", id: 1 });
    await pending;
    expect(worker?.terminate).toHaveBeenCalledOnce();
  });

  it("refuses wrong-origin assets before an initialization post", async () => {
    await expect(
      createBrowserOnePasswordClient(
        settings,
        { ...assets, origin: "https://other.example" },
        port,
      ),
    ).rejects.toThrow(failure);
    expect(WorkerFixture.instances[0]?.messages).toEqual([]);
    expect(WorkerFixture.instances[0]?.terminate).toHaveBeenCalledOnce();
  });

  it("sanitizes a stale constructor guard before creating any worker", async () => {
    current = false;
    await expect(
      createBrowserOnePasswordClient(settings, assets, port),
    ).rejects.toThrow(failure);
    expect(WorkerFixture.instances).toEqual([]);
  });

  it("a non-aborting owner change between operations closes the terminal signal", async () => {
    const { client, worker } = await create();
    current = false;
    await expect(client.invoke({ name: "ItemsList" })).rejects.toThrow(failure);
    expect(client.closed.aborted).toBe(true);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("rechecks ownership after the reply but before its await continuation", async () => {
    const { client, worker } = await create();
    const pending = expect(
      client.invoke({ name: "ItemsList" }),
    ).rejects.toThrow(failure);
    worker.emit({ type: "result", id: 2, result: { private: true } });
    current = false;
    await pending;
    expect(client.closed.aborted).toBe(true);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("invalid replay dispatch closes instead of stranding the worker", async () => {
    const held = deferredResponse();
    port = { ...port, fetch: () => held.promise };
    const { client, worker } = await create();
    const message = {
      type: "fetch",
      id: 1,
      url: `${settings.accountOrigin}/api/v3/auth/start`,
      method: "GET",
      headers: [],
      body: new Uint8Array(),
    };
    worker.emit(message);
    worker.emit(message);
    expect(client.closed.aborted).toBe(true);
    held.reject(new Error("private late rejection"));
    await vi.advanceTimersByTimeAsync(0);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("bounds outstanding parent operations and settles all on exhaustion", async () => {
    const { client, worker } = await create();
    const pending = Array.from({ length: 32 }, () =>
      expect(client.invoke({ name: "ItemsList" })).rejects.toThrow(failure),
    );
    await expect(client.invoke({ name: "ItemsList" })).rejects.toThrow(failure);
    await Promise.all(pending);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
