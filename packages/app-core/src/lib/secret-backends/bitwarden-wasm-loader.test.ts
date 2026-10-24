/** BWS parent/Worker IPC failures only; no personal vault or SDK authentication claim. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../../host.js";
import { createTestHost } from "../../test-host.js";
import {
  type BitwardenSdkClient,
  createBrowserBitwardenClient,
} from "./bitwarden-wasm-loader.js";
import { BitwardenWorkerRequestSchema } from "./bitwarden-worker-protocol.js";

class WorkerFixture extends EventTarget implements Worker {
  static instances: WorkerFixture[] = [];
  static autoInitialize = true;
  static afterConstruction: (() => void) | undefined;
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
    WorkerFixture.afterConstruction?.();
  }
  postMessage(value: BoundaryValue): void {
    if (this.throwPost) throw new Error("private post failure detail");
    this.messages.push(structuredClone(value));
    const parsed = BitwardenWorkerRequestSchema.safeParse(value);
    if (
      parsed.success &&
      parsed.data.type === "initialize" &&
      WorkerFixture.autoInitialize
    )
      this.emit({ id: parsed.data.id, ok: true, result: "null" });
  }
  emit(data: BoundaryValue): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}
const settings = {
  apiUrl: "https://api.example.com/api",
  identityUrl: "https://identity.example.com/identity",
};
const clients: BitwardenSdkClient[] = [];
let owner: AbortController;
beforeEach(() => {
  vi.useFakeTimers();
  WorkerFixture.instances = [];
  WorkerFixture.autoInitialize = true;
  WorkerFixture.afterConstruction = undefined;
  owner = new AbortController();
  configureHost(createTestHost({ worker: WorkerFixture }));
});
afterEach(() => {
  owner.abort();
  for (const client of clients.splice(0)) client.free();
  vi.useRealTimers();
  configureHost(createTestHost());
  vi.restoreAllMocks();
});
async function open(fetcher: typeof fetch = vi.fn()) {
  const client = await createBrowserBitwardenClient(
    settings,
    fetcher,
    owner.signal,
  );
  clients.push(client);
  const worker = WorkerFixture.instances.at(-1);
  if (!worker) throw new Error("Original worker fixture required");
  return { client, worker };
}
async function sameFailure(promises: Promise<BoundaryValue>[]) {
  const outcomes = await Promise.allSettled(promises);
  const errors = outcomes.map((outcome) => {
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected")
      throw new Error("Pending command unexpectedly succeeded");
    return outcome.reason;
  });
  for (const error of errors) expect(error).toBe(errors[0]);
  return errors[0];
}
it.each(["error", "messageerror", "corrupt", "unmatched", "owner"])(
  "%s terminal failure rejects concurrent commands and remains sticky after late replies",
  async (cause) => {
    const { client, worker } = await open();
    const remove = vi.spyOn(worker, "removeEventListener");
    const first = client.run_command("first");
    const second = client.run_command("second");
    const rejected = sameFailure([first, second]);
    if (cause === "owner") owner.abort();
    else if (cause === "corrupt") worker.emit({ corrupted: true });
    else if (cause === "unmatched")
      worker.emit({ id: 999, ok: true, result: "private late result" });
    else worker.dispatchEvent(new Event(cause));
    const error = await rejected;
    expect(error).toMatchObject({ code: "network" });
    expect(error.message).not.toContain("private");
    worker.emit({ id: 2, ok: true, result: "late" });
    await expect(client.run_command("after failure")).rejects.toBe(error);
    client.free();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    for (const type of ["message", "error", "messageerror"])
      expect(remove).toHaveBeenCalledWith(type, expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    expect(worker.messages).toHaveLength(3);
  },
);
it("a throwing post rejects every registered command without retaining a deadline", async () => {
  const { client, worker } = await open();
  const held = client.run_command("held");
  worker.throwPost = true;
  const error = await sameFailure([held, client.run_command("throws")]);
  await expect(client.run_command("later")).rejects.toBe(error);
  expect(error.message).not.toContain("private post failure detail");
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it("a silent or unresponsive worker ends at the unchanged thirty-second main-realm deadline", async () => {
  const { client, worker } = await open();
  const rejected = sameFailure([
    client.run_command("held one"),
    client.run_command("held two"),
  ]);
  await vi.advanceTimersByTimeAsync(30_000);
  const error = await rejected;
  expect(error).toMatchObject({
    code: "network",
    message: "The Bitwarden operation timed out.",
  });
  await expect(client.run_command("later")).rejects.toBe(error);
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it("withdraws initialization when the owner ends during Worker construction", async () => {
  WorkerFixture.afterConstruction = () => owner.abort();
  await expect(
    createBrowserBitwardenClient(settings, vi.fn(), owner.signal),
  ).rejects.toMatchObject({ code: "network" });
  expect(WorkerFixture.instances[0].messages).toEqual([]);
  expect(WorkerFixture.instances[0].terminate).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it("leaves an operation-level SDK refusal isolated from another live command", async () => {
  const { client, worker } = await open();
  const refusal = expect(client.run_command("refused")).rejects.toMatchObject({
    code: "response",
  });
  const live = client.run_command("live");
  worker.emit({ id: 2, ok: false, result: "" });
  worker.emit({ id: 3, ok: true, result: "stored value" });
  await refusal;
  expect(await live).toBe("stored value");
  expect(worker.terminate).not.toHaveBeenCalled();
});
it("never posts a late forwarded response or starts new HTTP after disposal", async () => {
  let resolve: (response: Response) => void = () => {};
  const fetcher = vi.fn<typeof fetch>(
    () =>
      new Promise<Response>((yes) => {
        resolve = yes;
      }),
  );
  const { client, worker } = await open(fetcher);
  const request = {
    type: "fetch",
    id: 1,
    url: "https://api.example.com/api/secrets",
    method: "GET",
    headers: [],
    body: "",
  };
  worker.emit(request);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const signal = fetcher.mock.calls[0]?.[1]?.signal;
  client.free();
  expect(signal?.aborted).toBe(true);
  worker.emit({ ...request, id: 2 });
  resolve(new Response("late bytes"));
  await vi.advanceTimersByTimeAsync(0);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(worker.messages).toHaveLength(1);
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});
it("a forwarding post failure withdraws pending commands without an unhandled rejection", async () => {
  const { client, worker } = await open(
    vi.fn(async () => new Response("body")),
  );
  const rejected = sameFailure([
    client.run_command("held one"),
    client.run_command("held two"),
  ]);
  worker.throwPost = true;
  worker.emit({
    type: "fetch",
    id: 1,
    url: "https://api.example.com/api/secrets",
    method: "GET",
    headers: [],
    body: "",
  });
  await rejected;
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("an initialization refusal terminates the isolated realm without accepting a late success", async () => {
  WorkerFixture.autoInitialize = false;
  const pending = createBrowserBitwardenClient(settings, vi.fn(), owner.signal);
  const rejected = expect(pending).rejects.toMatchObject({ code: "response" });
  const worker = WorkerFixture.instances[0];
  worker.emit({ id: 1, ok: false, result: "" });
  await rejected;
  worker.emit({ id: 1, ok: true, result: "late" });
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it("rejects concurrent callers even when physical termination itself throws", async () => {
  const { client, worker } = await open();
  const rejected = sameFailure([
    client.run_command("one"),
    client.run_command("two"),
  ]);
  worker.terminate.mockImplementation(() => {
    throw new Error("private termination detail");
  });
  worker.dispatchEvent(new Event("error"));
  const error = await rejected;
  expect(error.message).not.toContain("private termination detail");
  await expect(client.run_command("later")).rejects.toBe(error);
  expect(worker.terminate).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
