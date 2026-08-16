import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverErrorMessage,
  openTailscaleLogin,
  tailscaleCandidates,
  TAILSCALE_CLIENT_URL,
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
});
