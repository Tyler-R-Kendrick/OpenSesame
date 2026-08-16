import { afterEach, describe, expect, it, vi } from "vitest";
import { hostRoutedViaDaemon, probeHost } from "./identity.js";
import { saveSettings } from "./settings.js";

describe("host plane probe", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("recognizes Host URLs proxied through a paired daemon", () => {
    expect(
      hostRoutedViaDaemon(
        "https://box.tail123.ts.net/host",
        "https://box.tail123.ts.net",
      ),
    ).toBe(true);
    expect(
      hostRoutedViaDaemon(
        "https://box.tail123.ts.net/host/",
        "https://box.tail123.ts.net/",
      ),
    ).toBe(true);
    expect(
      hostRoutedViaDaemon("https://host.example", "https://box.tail123.ts.net"),
    ).toBe(false);
  });

  it("treats a live paired daemon as Host reachable when gateway health fails", async () => {
    saveSettings({
      hostApi: "https://box.tail123.ts.net/host",
      identityApi: "https://box.tail123.ts.net/identity",
      daemonApi: "https://box.tail123.ts.net",
      tursoUrl: "",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/v1/health") || url.endsWith("/health/live")) {
          return new Response("not found", { status: 404 });
        }
        if (url.endsWith("/health") || url.includes(".ts.net/health")) {
          return Response.json({
            status: "ok",
            service: "opensesame-daemon",
            host_api: "https://box.tail123.ts.net/host",
            identity_api: "https://box.tail123.ts.net/identity",
            tailscale_url: "https://box.tail123.ts.net",
          });
        }
        return new Response("nope", { status: 500 });
      }),
    );
    await expect(probeHost()).resolves.toBe("reachable");
  });

  it("stays unreachable when neither gateway nor daemon answers", async () => {
    saveSettings({
      hostApi: "https://box.tail123.ts.net/host",
      identityApi: "https://box.tail123.ts.net/identity",
      daemonApi: "https://box.tail123.ts.net",
      tursoUrl: "",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(probeHost()).resolves.toBe("unreachable");
  });
});
