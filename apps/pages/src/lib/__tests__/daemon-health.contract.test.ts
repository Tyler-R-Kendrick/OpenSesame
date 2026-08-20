/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ loopbackPage: true }));

vi.mock("../settings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../settings.js")>();
  // Only the page's own location is faked; persistence stays real, because
  // what pairing *writes* is the half of this contract that broke.
  return { ...actual, pageIsLoopback: () => env.loopbackPage };
});

import { applyDaemonPairing, probeDaemon } from "../daemon.js";
import { loadSettings, saveSettings } from "../settings.js";

/**
 * Contract: the daemon's `/health`, as the Rust handler actually emits it.
 *
 * `apps/daemon/src/main.rs::daemon_health` is the producer and this file's
 * `probeDaemon` is the consumer, across a language boundary with no shared
 * schema between them. Nothing checked that they agreed, and they did not:
 * the handler emits `status`, `service` and `tailscale_url` — node IPs, DNS
 * and admin URLs are deliberately held back for the operator-token-gated
 * `/v1/toolbar/status` — while the parser read `host_api` and `identity_api`
 * and, finding neither, substituted `127.0.0.1:8787` and `:8788` as though
 * the daemon had said so.
 *
 * The Rust side pins the same shape in `health_is_opaque`. If someone widens
 * `/health`, that test fails first and points here; if someone widens this
 * parser, these fail. The two halves have to move together.
 */
const RUST_HEALTH_KEYS = ["status", "service", "tailscale_url"] as const;

/** Exactly what `daemon_health()` returns, Serve enabled. */
function rustHealthPayload(tailscaleUrl: string | null = null) {
  return {
    status: "ok",
    service: "opensesame-daemon",
    tailscale_url: tailscaleUrl,
  };
}

function stubHealth(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(Response.json(body))),
  );
}

const LOCAL_SETTINGS = {
  hostApi: "http://127.0.0.1:18787",
  identityApi: "http://127.0.0.1:18788",
  daemonApi: "http://127.0.0.1:18790",
  tursoUrl: "",
  mfaAppUrl: "",
  capabilityConnectors: {
    encryption: { providerId: "webcrypto" },
    history: { providerId: "github" },
  },
};

beforeEach(() => {
  env.loopbackPage = true;
  saveSettings({ ...LOCAL_SETTINGS });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("daemon /health contract", () => {
  it("carries exactly the three keys the Rust handler emits", () => {
    // A canary on the fixture itself: if the producer grows a field, update
    // this list and the parser together, deliberately.
    expect(Object.keys(rustHealthPayload()).sort()).toEqual(
      [...RUST_HEALTH_KEYS].sort(),
    );
    expect(RUST_HEALTH_KEYS).not.toContain("host_api");
    expect(RUST_HEALTH_KEYS).not.toContain("identity_api");
  });

  it("parses the real payload without inventing what it does not carry", async () => {
    stubHealth(rustHealthPayload());
    const health = await probeDaemon("http://127.0.0.1:18790");
    expect(health).toEqual({
      status: "ok",
      service: "opensesame-daemon",
      hostApi: null,
      identityApi: null,
      tailscaleUrl: null,
    });
  });

  it("reads the Serve URL when the daemon has one", async () => {
    stubHealth(rustHealthPayload("https://box.tailnet.ts.net"));
    const health = await probeDaemon("http://127.0.0.1:18790");
    expect(health.tailscaleUrl).toBe("https://box.tailnet.ts.net");
  });

  it("rejects a listener that is not the daemon", async () => {
    // The `not-opensesame` failure class depends on this staying a throw.
    stubHealth({ status: "ok", service: "some-other-service" });
    await expect(probeDaemon("http://127.0.0.1:18790")).rejects.toThrow(
      /not an OpenSesame daemon/,
    );
  });

  it("pairing from a loopback page keeps the Host already configured", async () => {
    // The bug this contract existed to catch: with host_api absent, the
    // parser used to hand pairing "http://127.0.0.1:8787", which is loopback
    // and non-empty, so the guard that would have preserved the real Host
    // never fired and a working :18787 was overwritten with the legacy port.
    await applyDaemonPairing(
      "http://127.0.0.1:18790",
      await (async () => {
        stubHealth(rustHealthPayload());
        return probeDaemon("http://127.0.0.1:18790");
      })(),
    );
    const saved = loadSettings();
    expect(saved.hostApi).toBe("http://127.0.0.1:18787");
    expect(saved.identityApi).toBe("http://127.0.0.1:18788");
    expect(saved.daemonApi).toBe("http://127.0.0.1:18790");
  });

  it("pairing from a loopback page keeps loopback planes even over Serve", async () => {
    // A local page can reach 127.0.0.1 directly, so forcing it through the
    // Serve proxy would add CORS and TLS failure modes for nothing. The Serve
    // URL is still remembered, for QR hand-off and for other devices.
    stubHealth(rustHealthPayload("https://box.tailnet.ts.net"));
    const local = await probeDaemon("http://127.0.0.1:18790");
    await applyDaemonPairing("http://127.0.0.1:18790", local);
    const saved = loadSettings();
    expect(saved.hostApi).toBe("http://127.0.0.1:18787");
    expect(saved.daemonApi).toBe("https://box.tailnet.ts.net");
  });

  it("pairing from a remote page routes both planes through the daemon", async () => {
    env.loopbackPage = false;
    stubHealth(rustHealthPayload("https://box.tailnet.ts.net"));
    const health = await probeDaemon("http://127.0.0.1:18790");
    await applyDaemonPairing("https://box.tailnet.ts.net", health);
    const saved = loadSettings();
    // A remote page cannot call loopback, so the Serve proxy paths are the
    // only usable planes — and those come from the Serve URL, not /health.
    expect(saved.daemonApi).toBe("https://box.tailnet.ts.net");
    expect(saved.hostApi).toBe("https://box.tailnet.ts.net/host");
    expect(saved.identityApi).toBe("https://box.tailnet.ts.net/identity");
  });
});
