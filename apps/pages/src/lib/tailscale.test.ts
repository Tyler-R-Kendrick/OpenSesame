import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TAILSCALE_CLIENT_URL,
  assertDaemonReachableFromPage,
  detectTailnet,
  discoverErrorMessage,
  discoverTailscaleDaemon,
  openTailscaleLogin,
  tailscaleCandidates,
  waitForTailnet,
} from "./tailscale.js";
import { normalizeTailnetBase } from "./urls.js";

describe("tailnet pairing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("lists only usable Serve / loopback candidates", () => {
    expect(
      tailscaleCandidates("https://laptop.tail123.ts.net", {
        allowLoopback: false,
      }),
    ).toEqual(["https://laptop.tail123.ts.net"]);

    expect(tailscaleCandidates(undefined, { allowLoopback: true })).toEqual([
      "http://127.0.0.1:18790",
    ]);

    // Bare https MagicDNS names cannot present a valid Tailscale Serve cert.
    expect(
      tailscaleCandidates("https://opensesame", { allowLoopback: false }),
    ).toEqual([]);
  });

  it("allows Tailscale HTTPS and CGNAT, not arbitrary http", () => {
    expect(normalizeTailnetBase("https://laptop.foo.ts.net/host")).toBe(
      "https://laptop.foo.ts.net/host",
    );
    expect(normalizeTailnetBase("http://opensesame:18790")).toBe(
      "http://opensesame:18790",
    );
    expect(normalizeTailnetBase("http://100.64.1.8:18790")).toBe(
      "http://100.64.1.8:18790",
    );
    expect(normalizeTailnetBase("http://10.0.0.5:18790")).toBeNull();
  });

  it("opens the Tailscale client download, not signup/start (admin trap)", () => {
    expect(TAILSCALE_CLIENT_URL).toBe("https://tailscale.com/download");
    expect(TAILSCALE_CLIENT_URL).not.toContain("login.tailscale.com/start");
    const open = vi.fn();
    vi.stubGlobal("open", open);
    openTailscaleLogin();
    expect(open).toHaveBeenCalledWith(
      "https://tailscale.com/download",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("waitForTailnet resolves once the probe succeeds", async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    await expect(
      waitForTailnet({
        probe,
        intervalMs: 1,
        timeoutMs: 50,
      }),
    ).resolves.toBe(true);
    expect(probe.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("waitForTailnet times out when never on the tailnet", async () => {
    const probe = vi.fn().mockResolvedValue(false);
    await expect(
      waitForTailnet({
        probe,
        intervalMs: 1,
        timeoutMs: 10,
      }),
    ).resolves.toBe(false);
  });

  it("explains why localhost cannot pair from github.io", () => {
    const msg = discoverErrorMessage({
      fromGithubPages: true,
      triedLoopback: true,
      detail: "Failed to fetch",
    });
    expect(msg).toMatch(/cannot reach 127\.0\.0\.1/i);
    expect(msg).toMatch(/\.ts\.net/);
    expect(msg).toMatch(/tailscale_url/);
  });

  it("explains missing local daemon without the github.io-only line", () => {
    const msg = discoverErrorMessage({
      fromGithubPages: false,
      triedLoopback: true,
      detail: "http://127.0.0.1:18790: Timed out",
    });
    expect(msg).toMatch(/No daemon answered on loopback/);
    expect(msg).not.toMatch(/github\.io cannot use localhost/);
    expect(msg).toMatch(/Timed out/);
  });
});

describe("tailnet detection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("counts opaque, redirect, and plain OK answers as on-tailnet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({ type: "opaque", ok: false } as unknown as Response),
      ),
    );
    await expect(detectTailnet()).resolves.toBe(true);

    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 200 }))),
    );
    await expect(detectTailnet()).resolves.toBe(true);

    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 404 }))),
    );
    await expect(detectTailnet()).resolves.toBe(false);

    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    await expect(detectTailnet()).resolves.toBe(false);
  });
});

describe("discoverTailscaleDaemon", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns the first candidate that answers as a daemon", async () => {
    vi.stubGlobal("location", {
      hostname: "me.github.io",
      href: "https://me.github.io/OpenSesame/",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("https://box.tail123.ts.net")) {
          return Promise.resolve(
            Response.json({
              service: "opensesame-daemon",
              status: "ok",
              host_api: "https://box.tail123.ts.net/host",
              identity_api: "https://box.tail123.ts.net/identity",
              tailscale_url: "https://box.tail123.ts.net",
            }),
          );
        }
        return Promise.reject(new TypeError("Failed to fetch"));
      }),
    );

    const health = await discoverTailscaleDaemon("https://box.tail123.ts.net");
    expect(health.service).toBe("opensesame-daemon");
    expect(health.hostApi).toBe("https://box.tail123.ts.net/host");
  });

  it("explains the failure with the first probe error when nothing answers", async () => {
    vi.stubGlobal("location", {
      hostname: "me.github.io",
      href: "https://me.github.io/OpenSesame/",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );

    const error = await discoverTailscaleDaemon(
      "https://down.tail123.ts.net",
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Tailscale Serve URL/);
    expect((error as Error).message).toMatch(/down\.tail123\.ts\.net/);
    expect((error as Error).message).toMatch(/Failed to fetch/);
  });
});

describe("assertDaemonReachableFromPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("accepts any daemon address from a loopback page", () => {
    vi.stubGlobal("location", {
      hostname: "localhost",
      href: "http://localhost:5180/",
    });
    expect(() =>
      assertDaemonReachableFromPage("http://127.0.0.1:18790"),
    ).not.toThrow();
  });

  it("fences loopback, non-tailnet, and bare-https names from github.io", () => {
    vi.stubGlobal("location", {
      hostname: "me.github.io",
      href: "https://me.github.io/OpenSesame/",
    });
    expect(() =>
      assertDaemonReachableFromPage("http://127.0.0.1:18790"),
    ).toThrow(/cannot reach 127\.0\.0\.1/);
    expect(() =>
      assertDaemonReachableFromPage("http://10.0.0.5:18790"),
    ).toThrow(/Tailscale Serve/);
    expect(() =>
      assertDaemonReachableFromPage("https://100.64.1.8:18790"),
    ).toThrow(/ending in \.ts\.net/);
    expect(() =>
      assertDaemonReachableFromPage("https://box.tail123.ts.net"),
    ).not.toThrow();
    expect(() =>
      assertDaemonReachableFromPage("http://100.64.1.8:18790"),
    ).not.toThrow();
  });
});
