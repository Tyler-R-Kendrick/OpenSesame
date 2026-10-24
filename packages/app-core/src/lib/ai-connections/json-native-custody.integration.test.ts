import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readDeviceRows } from "../device-connector-records.js";
import {
  deferred,
  runtimeFixture,
} from "../secret-backends/runtime.test-support.js";
import { vaultStore } from "../vault/store.js";
import { aiCompletionSeams, bindAiResponseLifetime } from "./http.js";
import { aiConnectionDraft } from "./presets.js";
import { aiHttpFixture } from "./protocol.test-support.js";
import { saveAiConnection } from "./runtime.js";
import { bindAiConnectionTransport } from "./transport.js";

const reply = JSON.stringify({
  choices: [{ message: { content: "Native-complete answer" } }],
});
let vault: Awaited<ReturnType<typeof runtimeFixture>>;
let http: Awaited<ReturnType<typeof aiHttpFixture>>;
let lease: AbortController;
let caller: AbortController;
let release: () => void;
let mode: "valid" | "held" | "oversized" | "malformed" | "refused" | "empty";
let gateNative: boolean;
let nativeFinished: boolean;
let held: ServerResponse | undefined;
let captured: Response | undefined;
let requestSignal: AbortSignal | undefined;
let gate: ReturnType<typeof deferred<void>>;
let capturedHeaders: ReturnType<typeof deferred<void>>;
let bodyClosed: ReturnType<typeof deferred<void>>;
let boundary: ReturnType<typeof deferred<"native-drain" | "body-seal">>;
let previousObserver: typeof aiCompletionSeams.observe;
const bodies: number[] = [];
const retired = vi.fn();
const pending: Promise<unknown>[] = [];

beforeEach(async () => {
  vault = await runtimeFixture();
  lease = new AbortController();
  caller = new AbortController();
  mode = "valid";
  gateNative = false;
  nativeFinished = false;
  held = undefined;
  captured = undefined;
  requestSignal = undefined;
  gate = deferred<void>();
  capturedHeaders = deferred<void>();
  bodyClosed = deferred<void>();
  boundary = deferred<"native-drain" | "body-seal">();
  bodies.length = 0;
  pending.length = 0;
  retired.mockReset();
  http = await aiHttpFixture((_request, response) => {
    response.setHeader("content-type", "application/json");
    if (mode === "refused") response.statusCode = 403;
    if (mode === "empty") {
      response.statusCode = 204;
      response.end();
      return;
    }
    if (mode === "held" || mode === "oversized") {
      held = response;
      response.on("close", () => {
        if (!response.writableEnded) bodyClosed.resolve();
      });
      response.write(
        mode === "oversized" ? `"${"x".repeat(512 * 1024)}` : '{"choices":',
      );
    } else response.end(mode === "malformed" ? "{" : reply);
  });
  previousObserver = aiCompletionSeams.observe;
  aiCompletionSeams.observe = (event) => {
    previousObserver?.(event);
    if (event.phase === "body") {
      bodies.push(event.bytes);
      boundary.resolve("body-seal");
    }
  };
  release = bindAiConnectionTransport({
    signal: lease.signal,
    assertCurrent: () => lease.signal.throwIfAborted(),
    async fetch(input, init) {
      if (!init?.signal) throw new Error("Original HTTP signal missing");
      requestSignal = init.signal;
      const response = await fetch(input, init);
      captured = response;
      bindAiResponseLifetime(
        response,
        () => retired(nativeFinished),
        init.signal,
      );
      if (gateNative) {
        const clone = response.clone.bind(response);
        vi.spyOn(response, "clone").mockImplementation(() => {
          const mirror = clone();
          const consume = mirror.arrayBuffer.bind(mirror);
          vi.spyOn(mirror, "arrayBuffer").mockImplementation(async () => {
            boundary.resolve("native-drain");
            await gate.promise;
            const bytes = await consume();
            nativeFinished = true;
            return bytes;
          });
          return mirror;
        });
      }
      capturedHeaders.resolve();
      return response;
    },
  });
});
afterEach(async () => {
  lease.abort();
  caller.abort();
  gate.resolve();
  held?.destroy();
  await Promise.allSettled(pending);
  release();
  aiCompletionSeams.observe = previousObserver;
  await http.close();
  await vault.close();
});
function save() {
  const job = saveAiConnection(
    {
      ...aiConnectionDraft("byo-ai"),
      name: "Native JSON custody",
      baseUrl: http.baseUrl,
      model: "fixture-model",
      apiKey: "private-native-json-fixture-token",
    },
    undefined,
    undefined,
    { signal: caller.signal },
  );
  // Attach a rejection handler before a synchronous owner withdrawal can occur.
  pending.push(
    job.then(
      () => undefined,
      () => undefined,
    ),
  );
  return job;
}
function noCustody() {
  expect(vaultStore.getSnapshot().items).toHaveLength(0);
  expect(readDeviceRows()).toHaveLength(0);
  expect(bodies).toEqual([]);
}

it("withholds body completion, physical retirement and public Save custody until bounded JSON EOF and native consumption both finish", async () => {
  gateNative = true;
  const job = save();
  expect(await boundary.promise).toBe("native-drain");
  expect(captured?.bodyUsed).toBe(true);
  expect(captured?.body?.locked).toBe(false);
  expect(requestSignal?.aborted).toBe(false);
  noCustody();
  expect(retired).not.toHaveBeenCalled();
  gate.resolve();
  await expect(job).resolves.toHaveProperty("connectionId");
  expect(nativeFinished).toBe(true);
  expect(retired).toHaveBeenCalledExactlyOnceWith(true);
  expect(bodies).toEqual([new TextEncoder().encode(reply).byteLength]);
  expect(vaultStore.getSnapshot().items).toHaveLength(1);
  expect(readDeviceRows()).toHaveLength(1);
  expect(requestSignal?.aborted).toBe(false);
});

it.each(["caller", "lease", "vault"] as const)(
  "still denies Save immediately when its original %s ends during the native drain",
  async (owner) => {
    gateNative = true;
    const job = save();
    expect(await boundary.promise).toBe("native-drain");
    noCustody();
    expect(retired).not.toHaveBeenCalled();
    if (owner === "caller") caller.abort();
    else if (owner === "lease") lease.abort();
    else vaultStore.lock();
    // The native-consumer gate remains closed: withdrawal cannot await it.
    await expect(job).rejects.toThrow();
    expect(nativeFinished).toBe(false);
    expect(requestSignal?.aborted).toBe(true);
    noCustody();
    expect(retired).toHaveBeenCalledExactlyOnceWith(false);
  },
);

it("keeps a real JSON body cancellable before EOF and grants no credential custody", async () => {
  mode = "held";
  const job = save();
  await capturedHeaders.promise;
  caller.abort();
  await expect(job).rejects.toThrow();
  await bodyClosed.promise;
  expect(held?.writableEnded).toBe(false);
  expect(requestSignal?.aborted).toBe(true);
  noCustody();
  expect(retired).toHaveBeenCalledExactlyOnceWith(false);
});

it("rejects a real body over the original 512KiB cap before EOF and closes both branches", async () => {
  mode = "oversized";
  await expect(save()).rejects.toThrow("exceeds the supported size");
  await bodyClosed.promise;
  expect(held?.writableEnded).toBe(false);
  noCustody();
  expect(retired).toHaveBeenCalledExactlyOnceWith(false);
});

it("refuses fully received malformed JSON without a completion seal or saved credential", async () => {
  mode = "malformed";
  await expect(save()).rejects.toThrow("unreadable JSON");
  expect(captured?.bodyUsed).toBe(true);
  expect(captured?.body?.locked).toBe(false);
  noCustody();
  expect(retired).toHaveBeenCalledExactlyOnceWith(false);
});

it("releases refused HTTP response resources after cancellation without a completion seal or custody", async () => {
  mode = "refused";
  await expect(save()).rejects.toThrow("refused the credential");
  expect(captured?.body?.locked).toBe(false);
  noCustody();
  expect(retired).toHaveBeenCalledExactlyOnceWith(false);
});

it("releases actual204 no-body response resources without a completion seal or custody", async () => {
  mode = "empty";
  await expect(save()).rejects.toThrow("no response body");
  expect(captured?.status).toBe(204);
  expect(captured?.body).toBeNull();
  noCustody();
  expect(retired).toHaveBeenCalledExactlyOnceWith(false);
});
