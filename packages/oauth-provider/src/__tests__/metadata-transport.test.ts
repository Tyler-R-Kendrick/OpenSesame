import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  UnsafeMetadataUrlError,
  defaultPinnedTransport,
} from "../metadata/safe-fetcher.js";

/**
 * defaultPinnedTransport is the raw pinned GET; the SSRF policy lives in
 * SafeMetadataFetcher. These tests pin to a loopback server on purpose.
 */

let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.on("error", () => {});
    switch (req.url) {
      case "/json":
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"client_id":"loopback"}');
        return;
      case "/redirect":
        res.writeHead(302, { location: "http://127.0.0.1/json" });
        res.end();
        return;
      case "/text":
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("hello");
        return;
      case "/big": {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(`{"pad":"${"x".repeat(128 * 1024)}"}`);
        return;
      }
      case "/hang":
        // Never respond — exercises the timeout path.
        return;
      default:
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

function get(path: string, timeoutMs = 2_000) {
  return defaultPinnedTransport({
    url: new URL(`${base}${path}`),
    address: "127.0.0.1",
    timeoutMs,
  });
}

describe("defaultPinnedTransport", () => {
  it("returns status, content type and body for a JSON response", async () => {
    const res = await get("/json");
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("application/json");
    expect(res.body).toBe('{"client_id":"loopback"}');
  });

  it("keeps the original host header while pinning to the address", async () => {
    const seen = new Promise<string>((resolve) => {
      server.once("request", (req) => resolve(req.headers.host ?? ""));
    });
    await get("/json");
    await expect(seen).resolves.toMatch(/^127\.0\.0\.1:\d+$/);
  });

  it("refuses redirects instead of following them", async () => {
    await expect(get("/redirect")).rejects.toThrow(/refused a redirect/);
  });

  it("refuses non-JSON content types", async () => {
    await expect(get("/text")).rejects.toThrow(
      /content-type must be application\/json/,
    );
  });

  it("refuses bodies larger than 64KiB", async () => {
    await expect(get("/big")).rejects.toThrow(/exceeds 64KiB/);
  });

  it("times out when the server never responds", async () => {
    await expect(get("/hang", 50)).rejects.toThrow(/timed out/);
  });

  it("wraps connection errors in UnsafeMetadataUrlError", async () => {
    // Bind and immediately close a throwaway server to get a free port.
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve, reject) =>
      probe.close((err) => (err ? reject(err) : resolve())),
    );

    await expect(
      defaultPinnedTransport({
        url: new URL(`http://127.0.0.1:${port}/json`),
        address: "127.0.0.1",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(UnsafeMetadataUrlError);
    await expect(
      defaultPinnedTransport({
        url: new URL(`http://127.0.0.1:${port}/json`),
        address: "127.0.0.1",
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/Metadata fetch failed/);
  });

  it("speaks to an IPv6 loopback with family 6", async () => {
    const v6 = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    try {
      await new Promise<void>((resolve, reject) => {
        v6.once("error", reject);
        v6.listen(0, "::1", () => resolve());
      });
    } catch {
      // IPv6 loopback unavailable on this host — nothing to assert.
      return;
    }
    try {
      const { port } = v6.address() as AddressInfo;
      const res = await defaultPinnedTransport({
        url: new URL(`http://[::1]:${port}/meta.json`),
        address: "::1",
        timeoutMs: 2_000,
      });
      expect(res.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => v6.close(() => resolve()));
    }
  });
});
