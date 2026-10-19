import type { BoundaryValue } from "@opensesame/os-domain";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import {
  type BitwardenNativeClient,
  createBrowserBitwardenNativeClient,
} from "./bitwarden-native-worker-client.js";
import {
  NativeWorkerRequest,
  type NativeWorkerSettings,
} from "./bitwarden-native-worker-protocol.js";
import type { SecretBackendTransport } from "./transport.js";

class WorkerFixture extends EventTarget implements Worker {
  static instances: WorkerFixture[] = [];
  static autoInitialize = true;
  readonly messages: BoundaryValue[] = [];
  readonly terminate = vi.fn();
  onmessage: Worker["onmessage"] = null;
  onmessageerror: Worker["onmessageerror"] = null;
  onerror: Worker["onerror"] = null;
  throwPost = false;
  constructor(
    readonly url: URL | string,
    readonly options?: WorkerOptions,
  ) {
    super();
    WorkerFixture.instances.push(this);
  }
  postMessage(value: BoundaryValue): void {
    if (this.throwPost) throw new Error("private post detail");
    this.messages.push(structuredClone(value));
    const request = NativeWorkerRequest.safeParse(value);
    if (
      request.success &&
      request.data.type === "initialize" &&
      WorkerFixture.autoInitialize
    )
      this.emit({ id: request.data.id, ok: true, value: null });
  }
  emit(data: BoundaryValue): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}
const settings: NativeWorkerSettings = {
  providerId: "bitwarden",
  name: "Native IPC fixture",
  baseUrl: "https://owned.example/api",
  identityUrl: "https://owned.example/identity",
  clientId: "user.00000000-0000-4000-8000-000000000001",
  clientSecret: "synthetic-personal-api-secret",
  accountEmail: "owned@example.test",
  masterPassword: "synthetic-master-password",
  deviceIdentifier: "00000000-0000-4000-8000-000000000002",
  vaultId: "",
};
let owner: AbortController;
let transport: SecretBackendTransport;
let current: boolean;
const clients: BitwardenNativeClient[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  WorkerFixture.instances = [];
  WorkerFixture.autoInitialize = true;
  configureHost(createTestHost({ worker: WorkerFixture }));
  owner = new AbortController();
  current = true;
  transport = {
    signal: owner.signal,
    assertCurrent() {
      if (!current) throw new Error("private lease details");
    },
    fetch: vi.fn(),
  };
});
afterEach(() => {
  owner.abort();
  for (const client of clients.splice(0)) {
    client.dispose();
    expect(client.closed.aborted).toBe(true);
  }
  vi.useRealTimers();
  configureHost(createTestHost());
});
async function open() {
  const client = await createBrowserBitwardenNativeClient(settings, transport);
  clients.push(client);
  const worker = WorkerFixture.instances.at(-1);
  if (!worker) throw new Error("Missing owned worker fixture.");
  return { client, worker };
}
it("uses a disposable literal worker module and clears only its cloned initialization strings (IPC fixture, no auth proof)", async () => {
  const { client, worker } = await open();
  expect(new URL(worker.url).pathname).toMatch(
    /\/bitwarden-native\.worker\.ts$/,
  );
  expect(worker.options).toEqual({
    type: "module",
    name: "opensesame-bitwarden-native",
  });
  expect(worker.messages[0]).toMatchObject({
    id: 1,
    type: "initialize",
    settings,
  });
  expect(settings.masterPassword).toBe("synthetic-master-password");
  expect(settings.clientSecret).toBe("synthetic-personal-api-secret");
  client.dispose();
  client.dispose();
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});
it("physically terminates held initialization on its owner signal independently of worker responsiveness", async () => {
  WorkerFixture.autoInitialize = false;
  const signal = new AbortController();
  const pending = createBrowserBitwardenNativeClient(
    settings,
    transport,
    signal.signal,
  );
  const rejected = expect(pending).rejects.toMatchObject({ code: "stale" });
  const worker = WorkerFixture.instances[0];
  signal.abort();
  await rejected;
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  worker.emit({ id: 1, ok: true, value: null });
  expect(worker.messages).toHaveLength(1);
});
it("has a main-realm deadline that terminates even a blocked worker", async () => {
  const { client, worker } = await open();
  const pending = client.invoke({ type: "list" });
  const rejected = expect(pending).rejects.toMatchObject({ code: "stale" });
  await vi.advanceTimersByTimeAsync(60000);
  await rejected;
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  expect(client.closed.aborted).toBe(true);
});
it("withdraws every pending command, ignores late replies, and never borrows another lease", async () => {
  const { client, worker } = await open();
  const first = client.invoke({ type: "list" });
  const second = client.invoke({ type: "get", selector: "owned" });
  const rejected = [
    expect(first).rejects.toMatchObject({ code: "stale" }),
    expect(second).rejects.toMatchObject({ code: "stale" }),
  ];
  owner.abort();
  await Promise.all(rejected);
  worker.emit({ id: 2, ok: true, value: [] });
  await expect(client.invoke({ type: "list" })).rejects.toMatchObject({
    code: "stale",
  });
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  expect(worker.messages).toHaveLength(3);
});
it.each(["error", "messageerror"])(
  "ends the exact worker on a platform %s event",
  async (type) => {
    const { client, worker } = await open();
    const rejected = expect(
      client.invoke({ type: "list" }),
    ).rejects.toMatchObject({ code: "stale" });
    worker.dispatchEvent(new Event(type));
    await rejected;
    expect(client.closed.aborted).toBe(true);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  },
);
it("accepts typed operation failures while closing on provider session end or a malformed result", async () => {
  const { client, worker } = await open();
  const missing = client.invoke({ type: "get", selector: "missing" });
  worker.emit({
    id: 2,
    ok: false,
    code: "not-found",
    message: "No matching item.",
  });
  await expect(missing).rejects.toMatchObject({ code: "not-found" });
  expect(client.closed.aborted).toBe(false);
  const held = expect(client.invoke({ type: "list" })).rejects.toMatchObject({
    code: "stale",
  });
  worker.emit({ type: "native-worker-closed" });
  await held;
  const later = await open();
  const invalid = expect(
    later.client.invoke({ type: "list" }),
  ).rejects.toMatchObject({ code: "stale" });
  later.worker.emit({ id: 2, ok: true, value: { key: "never an item" } });
  await invalid;
});
it("fails stale checks and posting errors without retaining private exception details", async () => {
  current = false;
  await expect(
    createBrowserBitwardenNativeClient(settings, transport),
  ).rejects.toMatchObject({
    code: "stale",
    message: "The isolated native account session ended. Connect again.",
  });
  expect(WorkerFixture.instances).toEqual([]);
  current = true;
  const first = await open();
  current = false;
  await expect(first.client.invoke({ type: "list" })).rejects.toMatchObject({
    code: "stale",
    message: "The isolated native account session ended. Connect again.",
  });
  expect(first.worker.terminate).toHaveBeenCalledTimes(1);
  current = true;
  const second = await open();
  second.worker.throwPost = true;
  await expect(second.client.invoke({ type: "list" })).rejects.toMatchObject({
    code: "stale",
  });
  expect(second.worker.terminate).toHaveBeenCalledTimes(1);
});
