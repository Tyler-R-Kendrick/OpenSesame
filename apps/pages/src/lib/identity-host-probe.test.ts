import { afterEach, describe, expect, it, vi } from "vitest";
import { hostRoutedViaDaemon, probeHost, probeIdentity } from "./identity.js";
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
      mfaAppUrl: "",
      capabilityConnectors: {
        encryption: { providerId: "webcrypto" },
        history: { providerId: "github" },
      },
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
      mfaAppUrl: "",
      capabilityConnectors: {
        encryption: { providerId: "webcrypto" },
        history: { providerId: "github" },
      },
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

describe("identity plane probe", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("requires OpenSesame health JSON, not a foreign 401 on the same port", async () => {
    saveSettings({
      hostApi: "http://127.0.0.1:18787",
      identityApi: "http://127.0.0.1:8788",
      daemonApi: "http://127.0.0.1:18790",
      tursoUrl: "",
      mfaAppUrl: "",
      capabilityConnectors: {
        encryption: { providerId: "webcrypto" },
        history: { providerId: "github" },
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: "invalid session control token" },
          { status: 401 },
        ),
      ),
    );
    await expect(probeIdentity()).resolves.toBe("unreachable");
  });

  it("marks control-plane live health as reachable", async () => {
    saveSettings({
      hostApi: "http://127.0.0.1:18787",
      identityApi: "http://127.0.0.1:18788",
      daemonApi: "http://127.0.0.1:18790",
      tursoUrl: "",
      mfaAppUrl: "",
      capabilityConnectors: {
        encryption: { providerId: "webcrypto" },
        history: { providerId: "github" },
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ status: "ok" })),
    );
    await expect(probeIdentity()).resolves.toBe("reachable");
  });
});
