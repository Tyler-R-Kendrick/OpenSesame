import { afterEach, describe, expect, it, vi } from "vitest";
import {
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

  it("lists MagicDNS and loopback candidates", () => {
    expect(tailscaleCandidates("https://laptop.tail.ts.net")).toEqual([
      "https://laptop.tail.ts.net",
      "https://opensesame",
      "https://opensesame-daemon",
      "http://opensesame:18790",
      "http://opensesame-daemon:18790",
      "http://127.0.0.1:18790",
    ]);
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
});
