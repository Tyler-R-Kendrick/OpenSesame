import { afterEach, describe, expect, it, vi } from "vitest";
import { applyDaemonPairing, probeDaemon } from "./daemon.js";
import {
  hasRemoteHostPairing,
  loadSettings,
  saveSettings,
  shippedHostApi,
  shippedIdentityApi,
} from "./settings.js";

describe("daemon pairing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("refuses a daemon URL this page may not call", async () => {
    await expect(probeDaemon("http://10.0.0.5:18790")).rejects.toThrow(
      /not one this page may call/,
    );
    await expect(probeDaemon("not-a-url")).rejects.toThrow(
      /not one this page may call/,
    );
  });

  it("pins Host/Identity to the Serve base instead of loopback ads", async () => {
    vi.stubGlobal("location", {
      hostname: "tyler-r-kendrick.github.io",
      href: "https://tyler-r-kendrick.github.io/OpenSesame/",
    });
    saveSettings({
      hostApi: "",
      identityApi: "",
      daemonApi: "",
      tursoUrl: "",
      mfaAppUrl: "",
      capabilityConnectors: {
        encryption: { providerId: "webcrypto" },
        history: { providerId: "github" },
      },
    });
    await applyDaemonPairing("https://box.tail123.ts.net", {
      status: "ok",
      service: "opensesame-daemon",
      hostApi: "http://127.0.0.1:8787",
      identityApi: "http://127.0.0.1:8788",
      tailscaleUrl: "https://box.tail123.ts.net",
    });
    const settings = loadSettings();
    expect(settings.daemonApi).toBe("https://box.tail123.ts.net");
    expect(settings.hostApi).toBe("https://box.tail123.ts.net/host");
    expect(settings.identityApi).toBe("https://box.tail123.ts.net/identity");
    expect(hasRemoteHostPairing(settings)).toBe(true);
  });

  it("keeps loopback Host/Identity when Pages itself is on localhost", async () => {
    vi.stubGlobal("location", {
      hostname: "localhost",
      href: "http://localhost:5180/OpenSesame/settings",
    });
    saveSettings({
      hostApi: shippedHostApi,
      identityApi: shippedIdentityApi,
      daemonApi: "http://127.0.0.1:18790",
      tursoUrl: "",
      mfaAppUrl: "",
      capabilityConnectors: {
        encryption: { providerId: "webcrypto" },
        history: { providerId: "github" },
      },
    });
    await applyDaemonPairing("http://127.0.0.1:18790", {
      status: "ok",
      service: "opensesame-daemon",
      hostApi: shippedHostApi,
      identityApi: shippedIdentityApi,
      tailscaleUrl: "https://box.tail123.ts.net",
    });
    const settings = loadSettings();
    expect(settings.daemonApi).toBe("https://box.tail123.ts.net");
    expect(settings.hostApi).toBe(shippedHostApi);
    expect(settings.identityApi).toBe(shippedIdentityApi);
  });
});

describe("daemon probing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not invent upstreams the daemon did not state", async () => {
    // `/health` is deliberately opaque: status, service, tailscale_url. It has
    // never carried host_api or identity_api — those are on the
    // operator-token-gated /v1/toolbar/status. Filling them in with
    // 127.0.0.1:8787/:8788 made pairing look authoritative about ports the
    // daemon never mentioned, and on a loopback page that overwrote a working
    // :18787 Host with the legacy :8787.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(Response.json({ service: "opensesame-daemon" })),
      ),
    );
    await expect(probeDaemon("http://127.0.0.1:18790")).resolves.toEqual({
      status: "ok",
      service: "opensesame-daemon",
      hostApi: null,
      identityApi: null,
      tailscaleUrl: null,
    });
  });

  it("still takes upstreams from a daemon that does state them", async () => {
    // The shape is optional, not forbidden — a future /health may carry it.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            service: "opensesame-daemon",
            host_api: "https://box.tailnet.ts.net/host",
            identity_api: "https://box.tailnet.ts.net/identity",
          }),
        ),
      ),
    );
    const health = await probeDaemon("http://127.0.0.1:18790");
    expect(health.hostApi).toBe("https://box.tailnet.ts.net/host");
    expect(health.identityApi).toBe("https://box.tailnet.ts.net/identity");
  });

  it("rejects a non-OK answer and a foreign service on the daemon port", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("no", { status: 502 }))),
    );
    await expect(probeDaemon("http://127.0.0.1:18790")).rejects.toThrow(
      /Daemon 502/,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(Response.json({ service: "something-else" })),
      ),
    );
    await expect(probeDaemon("http://127.0.0.1:18790")).rejects.toThrow(
      /not an OpenSesame daemon/,
    );
  });
});

describe("daemon pairing fallbacks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps the loopback daemon address when no Serve URL is advertised", async () => {
    vi.stubGlobal("location", {
      hostname: "localhost",
      href: "http://localhost:5180/OpenSesame/",
    });
    saveSettings({
      hostApi: "http://127.0.0.1:23456",
      identityApi: "http://127.0.0.1:29999",
      daemonApi: "",
      tursoUrl: "",
      mfaAppUrl: "",
      capabilityConnectors: {
        encryption: { providerId: "webcrypto" },
        history: { providerId: "github" },
      },
    });
    await applyDaemonPairing("http://127.0.0.1:18790", {
      status: "ok",
      service: "opensesame-daemon",
      hostApi: "https://unreachable.example",
      identityApi: "https://unreachable.example",
      tailscaleUrl: null,
    });
    const settings = loadSettings();
    expect(settings.daemonApi).toBe("http://127.0.0.1:18790");
    // Advertised non-loopback planes are useless here — keep the working ones.
    expect(settings.hostApi).toBe("http://127.0.0.1:23456");
    expect(settings.identityApi).toBe("http://127.0.0.1:29999");
  });

  it("falls back to the shipped loopback planes when nothing usable is known", async () => {
    vi.stubGlobal("location", {
      hostname: "127.0.0.1",
      href: "http://127.0.0.1:5180/OpenSesame/",
    });
    saveSettings({
      hostApi: "https://remote-only.example",
      identityApi: "https://remote-only.example",
      daemonApi: "",
      tursoUrl: "",
      mfaAppUrl: "",
      capabilityConnectors: {
        encryption: { providerId: "webcrypto" },
        history: { providerId: "github" },
      },
    });
    await applyDaemonPairing("http://127.0.0.1:18790", {
      status: "ok",
      service: "opensesame-daemon",
      hostApi: "",
      identityApi: "",
      tailscaleUrl: null,
    });
    const settings = loadSettings();
    expect(settings.hostApi).toBe(shippedHostApi);
    expect(settings.identityApi).toBe(shippedIdentityApi);
  });

  it("never persists loopback Host endpoints on a remote page", async () => {
    vi.stubGlobal("location", {
      hostname: "me.github.io",
      href: "https://me.github.io/OpenSesame/",
    });
    saveSettings({
      hostApi: "https://kept.example/host",
      identityApi: "https://kept.example/identity",
      daemonApi: "",
      tursoUrl: "",
      mfaAppUrl: "",
      capabilityConnectors: {
        encryption: { providerId: "webcrypto" },
        history: { providerId: "github" },
      },
    });
    await applyDaemonPairing("http://127.0.0.1:18790", {
      status: "ok",
      service: "opensesame-daemon",
      hostApi: "http://127.0.0.1:8787",
      identityApi: "http://127.0.0.1:8788",
      tailscaleUrl: null,
    });
    const settings = loadSettings();
    expect(settings.hostApi).toBe("https://kept.example/host");
    expect(settings.identityApi).toBe("https://kept.example/identity");
    expect(settings.daemonApi).toBe("http://127.0.0.1:18790");
    expect(hasRemoteHostPairing(settings)).toBe(true);
  });
});
