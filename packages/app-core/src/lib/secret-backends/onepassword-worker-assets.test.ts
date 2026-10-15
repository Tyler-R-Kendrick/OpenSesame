import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import artifacts from "./onepassword-artifacts.json" with { type: "json" };
import { createOnePasswordAssetFetch } from "./onepassword-worker-assets.js";
import type { SecretBackendFetch } from "./types.js";

const require = createRequire(import.meta.url);
const raw = readFileSync(
  join(
    dirname(require.resolve("@1password/sdk-core/package.json")),
    "nodejs/core_bg.wasm",
  ),
);
const assets = {
  origin: "https://app.example",
  runtimeUrl: `https://app.example/subpath/${artifacts.assets.runtime}`,
  wasmUrl: `https://app.example/subpath/${artifacts.assets.wasm}`,
};
afterEach(() => vi.restoreAllMocks());
function stream(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
function response(
  body: ReadableStream<Uint8Array> | null = stream(raw),
  init?: ResponseInit,
) {
  const reply = new Response(body, init);
  Object.defineProperty(reply, "url", {
    value: assets.wasmUrl,
    configurable: true,
  });
  return reply;
}
function fixture() {
  const owner = new AbortController();
  const request = new AbortController();
  const guard = vi.fn(() => owner.signal.throwIfAborted());
  const native = vi.fn<SecretBackendFetch>(async () => response());
  const fetcher = createOnePasswordAssetFetch(
    assets,
    owner.signal,
    guard,
    native,
  );
  return { owner, request, guard, native, fetcher };
}
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("returns fresh raw WASM with exact actual package length/hash and no upstream headers", async () => {
  expect(raw.length).toBe(artifacts.sdk.wasmBytes);
  expect(createHash("sha256").update(raw).digest("hex")).toBe(
    artifacts.sdk.wasmHash,
  );
  const f = fixture();
  const upstream = response(stream(raw), {
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Fixture": "not forwarded",
    },
  });
  f.native.mockResolvedValueOnce(upstream);
  const output = await f.fetcher(assets.wasmUrl);
  expect(output === upstream).toBe(false);
  expect(output.headers.get("Content-Type")).toBe("application/wasm");
  expect(output.headers.has("X-Fixture")).toBe(false);
  expect(output.url).toBe("");
  const bytes = await output.arrayBuffer();
  expect(bytes.byteLength).toBe(raw.length);
  expect(createHash("sha256").update(new Uint8Array(bytes)).digest("hex")).toBe(
    artifacts.sdk.wasmHash,
  );
  expect(f.guard.mock.calls.length).toBeGreaterThan(3);
});

it("forwards only the captured native fetch options and combined owner/Request authority", async () => {
  const f = fixture();
  const input = new Request(assets.wasmUrl, {
    signal: f.request.signal,
    credentials: "include",
    headers: { Authorization: "must not forward" },
  });
  const output = await f.fetcher(input);
  expect(output.headers.get("Content-Type")).toBe("application/wasm");
  const [url, options] = f.native.mock.calls[0] ?? [];
  expect(url).toBe(assets.wasmUrl);
  expect(options).toMatchObject({
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    referrerPolicy: "no-referrer",
  });
  expect(options?.headers).toBeUndefined();
  expect(options?.signal).toBeInstanceOf(AbortSignal);
  expect(options?.signal === f.owner.signal).toBe(false);
  f.request.abort();
  expect(options?.signal?.aborted).toBe(true);
  expect(f.owner.signal.aborted).toBe(false);
});

it.each(["origin", "path", "query", "head", "post"] as const)(
  "refuses %s substitution before native fetch",
  async (change) => {
    const f = fixture();
    const url =
      change === "origin"
        ? assets.wasmUrl.replace("app.example", "other.example")
        : change === "path"
          ? `${assets.wasmUrl}/other`
          : change === "query"
            ? `${assets.wasmUrl}?token=no`
            : assets.wasmUrl;
    const method =
      change === "head" ? "HEAD" : change === "post" ? "POST" : "GET";
    await expect(f.fetcher(url, { method })).rejects.toThrow(
      "The 1Password network request failed",
    );
    expect(f.native).not.toHaveBeenCalled();
  },
);

it.each(["status", "redirect", "url", "body"] as const)(
  "rejects %s response before digest",
  async (change) => {
    const f = fixture();
    const reply =
      change === "body"
        ? response(null)
        : response(stream(raw), { status: change === "status" ? 404 : 200 });
    if (change === "redirect")
      Object.defineProperty(reply, "redirected", { value: true });
    if (change === "url")
      Object.defineProperty(reply, "url", { value: `${assets.wasmUrl}/other` });
    f.native.mockResolvedValueOnce(reply);
    const digest = vi.spyOn(crypto.subtle, "digest");
    await expect(f.fetcher(assets.wasmUrl)).rejects.toThrow(
      "The 1Password network request failed",
    );
    expect(digest).not.toHaveBeenCalled();
  },
);

it.each(["short", "oversize", "hash"] as const)(
  "refuses %s raw bytes without logging their contents",
  async (change) => {
    const f = fixture();
    const bytes =
      change === "short"
        ? raw.subarray(0, raw.length - 1)
        : change === "oversize"
          ? new Uint8Array(raw.length + 1)
          : new Uint8Array(raw);
    if (change === "hash") bytes[0] = (bytes[0] ?? 0) ^ 1;
    f.native.mockResolvedValueOnce(response(stream(bytes)));
    const digest = vi.spyOn(crypto.subtle, "digest");
    await expect(f.fetcher(assets.wasmUrl)).rejects.toThrow(
      "The 1Password network request failed",
    );
    expect(digest).toHaveBeenCalledTimes(change === "hash" ? 1 : 0);
  },
);

it("checks an already-ended owner or denied guard before native fetch", async () => {
  const f = fixture();
  f.owner.abort();
  await expect(f.fetcher(assets.wasmUrl)).rejects.toThrow();
  expect(f.native).not.toHaveBeenCalled();
  const denied = fixture();
  denied.guard.mockImplementation(() => {
    throw new Error("Guard ended");
  });
  await expect(denied.fetcher(assets.wasmUrl)).rejects.toThrow("Guard ended");
  expect(denied.native).not.toHaveBeenCalled();
});

it.each(["owner", "request"] as const)(
  "forwards %s cancellation to cooperative native fetch before reply release",
  async (source) => {
    const f = fixture();
    const reply = deferred<Response>();
    f.native.mockImplementation(
      (_url, options) =>
        new Promise<Response>((resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () =>
              reject(new DOMException("Aborted fixture fetch", "AbortError")),
            { once: true },
          );
          void reply.promise.then(resolve);
        }),
    );
    const pending = f.fetcher(assets.wasmUrl, { signal: f.request.signal });
    const cancelled = expect(pending).rejects.toThrow("Aborted fixture fetch");
    expect(f.native).toHaveBeenCalledOnce();
    f[source].abort();
    expect(f.native.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await cancelled;
    reply.resolve(response());
    expect(f.native).toHaveBeenCalledOnce();
  },
);

it.each(["owner", "request", "guard"] as const)(
  "rejects %s withdrawal while reading and cancels the upstream body",
  async (source) => {
    const f = fixture();
    const reading = deferred<void>();
    const sourceController =
      deferred<ReadableStreamDefaultController<Uint8Array>>();
    f.guard.mockImplementation(() => {
      f.owner.signal.throwIfAborted();
      if (f.guard.mock.calls.length === 3) reading.resolve();
    });
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        sourceController.resolve(controller);
        controller.enqueue(raw.subarray(0, 64));
      },
      cancel,
    });
    f.native.mockResolvedValueOnce(response(body));
    const pending = f.fetcher(assets.wasmUrl, { signal: f.request.signal });
    const cancelled = expect(pending).rejects.toThrow();
    await reading.promise;
    if (source === "guard") {
      f.guard.mockImplementation(() => {
        throw new Error("Guard ended");
      });
      (await sourceController.promise).enqueue(raw.subarray(64, 128));
      expect(f.owner.signal.aborted).toBe(false);
      expect(f.request.signal.aborted).toBe(false);
    } else f[source].abort();
    await cancelled;
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  },
);

it.each(["owner", "request", "guard"] as const)(
  "discards a completed digest after %s withdrawal",
  async (source) => {
    const f = fixture();
    const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
    const result = deferred<ArrayBuffer>();
    const digest = vi
      .spyOn(crypto.subtle, "digest")
      .mockReturnValueOnce(result.promise);
    let completed = false;
    const pending = f
      .fetcher(assets.wasmUrl, { signal: f.request.signal })
      .then((value) => {
        completed = true;
        return value;
      });
    const cancelled = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(digest).toHaveBeenCalledOnce());
    if (source === "guard")
      f.guard.mockImplementation(() => {
        throw new Error("Guard ended");
      });
    else f[source].abort();
    expect(completed).toBe(false);
    result.resolve(await nativeDigest("SHA-256", new Uint8Array(raw).buffer));
    await cancelled;
    expect(completed).toBe(false);
  },
);
