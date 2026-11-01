import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo, Socket } from "node:net";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { asBufferSource, overlapCast } from "@opensesame/os-domain";
import { afterEach, expect, it, vi } from "vitest";
import type { SecretBackendFetch } from "./types.js";
import { createGzipWasmAssetFetch } from "./wasm-gzip-asset.js";

const require = createRequire(import.meta.url);
const raw = readFileSync(
  join(
    dirname(require.resolve("@bitwarden/sdk-wasm/package.json")),
    "bitwarden_wasm_bg.wasm",
  ),
);
const RAW_HASH =
  "3722dfbef74f28d49c8e70aeeb532a4be21a1884abcc6292f0d1a58b0c612861";
const wire = gzipSync(raw, { level: 9 });
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const failure = () => new Error("The pinned WASM asset failed.");
function asset(url = "https://app.example/subpath/bws.wasm.gz", bytes = wire) {
  return {
    url,
    compressed: { bytes: bytes.length, hash: hash(bytes) },
    raw: { bytes: 2013908, hash: RAW_HASH },
  };
}
function reply(url: string, bytes: Uint8Array = wire) {
  const response = new Response(asBufferSource(bytes));
  Object.defineProperty(response, "url", { value: url });
  return response;
}
function fixture(configuration = asset()) {
  const owner = new AbortController();
  const check = vi.fn(() => owner.signal.throwIfAborted());
  const native = vi.fn<SecretBackendFetch>(async () =>
    reply(configuration.url),
  );
  const fetcher = createGzipWasmAssetFetch(
    configuration,
    owner.signal,
    check,
    native,
    failure,
  );
  return { owner, check, native, fetcher };
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("decodes the actual official Bitwarden browser WASM through native gzip without SDK execution", async () => {
  expect(raw.length).toBe(2013908);
  expect(hash(raw)).toBe(RAW_HASH);
  const configuration = asset();
  const f = fixture(configuration);
  const output = await f.fetcher(configuration.url);
  expect([...output.headers]).toEqual([["content-type", "application/wasm"]]);
  const bytes = await output.arrayBuffer();
  expect(bytes.byteLength).toBe(raw.length);
  expect(hash(new Uint8Array(bytes))).toBe(RAW_HASH);
  expect(WebAssembly.validate(bytes)).toBe(true);
});

it("captures URL and both pins before callers can mutate configuration", async () => {
  const configuration = asset();
  const originalUrl = configuration.url;
  const f = fixture(configuration);
  f.native.mockResolvedValueOnce(reply(originalUrl));
  configuration.url = "https://other.example/replaced";
  configuration.raw.bytes = 1;
  configuration.raw.hash = "0".repeat(64);
  configuration.compressed.bytes = 1;
  configuration.compressed.hash = "0".repeat(64);
  expect(
    hash(new Uint8Array(await (await f.fetcher(originalUrl)).arrayBuffer())),
  ).toBe(RAW_HASH);
  expect(f.native.mock.calls[0]?.[0]).toBe(originalUrl);
});

it.each(["compressed", "raw"] as const)(
  "rejects malformed %s pins before native fetch",
  (which) => {
    for (const value of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1.1,
      67108865,
    ]) {
      const configuration = asset();
      configuration[which].bytes = value;
      expect(() => fixture(configuration)).toThrow(failure().message);
    }
    for (const value of ["", "g".repeat(64), "F".repeat(64), "0".repeat(63)]) {
      const configuration = asset();
      configuration[which].hash = value;
      expect(() => fixture(configuration)).toThrow(failure().message);
    }
  },
);

it("rejects tampered compressed bytes before invoking the decoder", async () => {
  const configuration = asset();
  const f = fixture(configuration);
  const changed = new Uint8Array(wire);
  changed[16] ^= 1;
  f.native.mockResolvedValueOnce(reply(configuration.url, changed));
  const decoder = vi.spyOn(globalThis, "DecompressionStream");
  await expect(f.fetcher(configuration.url)).rejects.toThrow(failure().message);
  expect(decoder).not.toHaveBeenCalled();
});

it.each(["short", "oversized", "wrong-hash"] as const)(
  "enforces decoded %s integrity using the actual native decoder",
  async (change) => {
    const configuration = asset();
    if (change === "short") configuration.raw.bytes++;
    else if (change === "oversized") configuration.raw.bytes--;
    else configuration.raw.hash = "0".repeat(64);
    const f = fixture(configuration);
    const digest = vi.spyOn(crypto.subtle, "digest");
    await expect(f.fetcher(configuration.url)).rejects.toThrow(
      failure().message,
    );
    expect(digest).toHaveBeenCalledTimes(change === "wrong-hash" ? 2 : 1);
  },
);

it.each(["CRC", "truncated"] as const)(
  "fails closed on authenticated synthetic %s gzip with the native decoder",
  async (change) => {
    const damaged = Buffer.from(
      change === "truncated" ? wire.subarray(0, wire.length - 1) : wire,
    );
    if (change === "CRC") damaged[damaged.length - 8] ^= 1;
    // This synthetic fixture pins its damaged transport honestly; the official raw pin stays fixed.
    const configuration = asset(undefined, damaged);
    const f = fixture(configuration);
    f.native.mockResolvedValueOnce(reply(configuration.url, damaged));
    await expect(f.fetcher(configuration.url)).rejects.toThrow(
      failure().message,
    );
  },
);

it("fails closed without native gzip support and never falls back to raw fetch", async () => {
  const configuration = asset();
  const f = fixture(configuration);
  vi.stubGlobal("DecompressionStream", undefined);
  await expect(f.fetcher(configuration.url)).rejects.toThrow(failure().message);
  expect(f.native).toHaveBeenCalledOnce();
});

async function coldHttp(mode: "complete" | "held" | "encoded") {
  const sockets = new Set<Socket>();
  const requests: { path: string; method: string; authorization?: string }[] =
    [];
  let premature = false;
  let entered = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const server = createServer((request, response) => {
    requests.push({
      path: request.url ?? "",
      method: request.method ?? "",
      authorization: request.headers.authorization,
    });
    response.once("close", () => {
      premature = !response.writableEnded;
    });
    if (mode === "encoded") response.setHeader("Content-Encoding", "gzip");
    response.writeHead(200, { "Content-Type": "application/gzip" });
    if (mode === "held") response.write(wire.subarray(0, 64));
    else response.end(wire);
    entered();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  // The explicit TCP listener above returns AddressInfo, not a named pipe.
  const address: AddressInfo = overlapCast(server.address());
  expect(address).toMatchObject({ address: "127.0.0.1", family: "IPv4" });
  cleanup.push(async () => {
    const stopped = once(server, "close");
    const closed = [...sockets].map((socket) => once(socket, "close"));
    server.close();
    server.closeAllConnections();
    await Promise.all([stopped, ...closed]);
    expect(sockets.size).toBe(0);
  });
  return {
    url: `http://127.0.0.1:${address.port}/subpath/bws.wasm.gz`,
    started,
    requests,
    premature: () => premature,
  };
}
function httpFetcher(url: string, owner: AbortSignal) {
  return createGzipWasmAssetFetch(
    asset(url),
    owner,
    () => owner.throwIfAborted(),
    fetch,
    failure,
  );
}

it("loads a cold owned HTTP resource with exact subpath/MIME and no credentials", async () => {
  const http = await coldHttp("complete");
  const output = await httpFetcher(
    http.url,
    new AbortController().signal,
  )(new Request(http.url, { headers: { Authorization: "must not forward" } }));
  expect(hash(new Uint8Array(await output.arrayBuffer()))).toBe(RAW_HASH);
  expect(output.headers.get("content-type")).toBe("application/wasm");
  expect(output.headers.has("content-encoding")).toBe(false);
  expect(http.requests).toEqual([
    { path: "/subpath/bws.wasm.gz", method: "GET", authorization: undefined },
  ]);
});

it.each(["owner", "request"] as const)(
  "physically cancels a held cold HTTP body within two seconds on %s loss",
  async (source) => {
    const http = await coldHttp("held");
    const owner = new AbortController();
    const request = new AbortController();
    const pending = httpFetcher(http.url, owner.signal)(http.url, {
      signal: request.signal,
    });
    void pending.catch(() => undefined);
    await http.started;
    const before = performance.now();
    (source === "owner" ? owner : request).abort();
    await expect
      .poll(http.premature, { timeout: 2000, interval: 20 })
      .toBe(true);
    expect(performance.now() - before).toBeLessThan(2000);
    await expect(pending).rejects.toThrow();
    expect(http.requests).toHaveLength(1);
  },
);

it("rejects HTTP Content-Encoding auto-decoding instead of silently decoding twice", async () => {
  const http = await coldHttp("encoded");
  await expect(
    httpFetcher(http.url, new AbortController().signal)(http.url),
  ).rejects.toThrow(failure().message);
  expect(http.requests).toHaveLength(1);
});
