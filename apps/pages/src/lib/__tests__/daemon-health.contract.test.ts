import type { JsonValue } from "@opensesame/os-domain";
/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = { loopbackPage: true };

import { browserPairingSeams } from "../browser-pairing.js";
import { defaultCapabilityConnectors } from "../capabilities.js";
import { applyDaemonPairing, probeDaemon } from "../daemon.js";
import { localNetworkFetchSeams } from "../local-network-fetch.js";
import { loadSettings, saveSettings, settingsSeams } from "../settings.js";

// Only the page's own location is faked; persistence stays real, because what
// pairing writes is the half of this contract that broke.
settingsSeams.pageIsLoopback = () => env.loopbackPage;

/**
 * Contract: the daemon's `/health`, as the Rust handler actually emits it.
 *
 * `apps/daemon/src/main.rs::daemon_health` is the producer and this file's
 * `probeDaemon` is the consumer, across a language boundary with no shared
 * schema between them. Nothing checked that they agreed, and they did not:
 * the handler emits only `status` — service metadata and trusted endpoints
 * require authenticated operator access — while the old parser read `host_api` and `identity_api`
 * and, finding neither, substituted `127.0.0.1:8787` and `:8788` as though
 * the daemon had said so.
 *
 * The Rust side pins the same shape in `health_is_opaque`. If someone widens
 * `/health`, that test fails first and points here; if someone widens this
 * parser, these fail. The two halves have to move together.
 */
const RUST_HEALTH_KEYS = ["status"] as const;

/** Exactly what `daemon_health()` returns, Serve enabled. */
function rustHealthPayload() {
  return { status: "ok" };
}

function stubHealth(body: JsonValue) {
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
    ...defaultCapabilityConnectors(),
    encryption: { providerId: "webcrypto" },
    history: { providerId: "github" },
  },
};
const eligible = browserPairingSeams.eligible;
const networkEligible = localNetworkFetchSeams.eligible;

beforeEach(() => {
  browserPairingSeams.eligible = () => true;
  localNetworkFetchSeams.eligible = () => true;
  env.loopbackPage = true;
  saveSettings({ ...LOCAL_SETTINGS });
});

afterEach(() => {
  browserPairingSeams.eligible = eligible;
  localNetworkFetchSeams.eligible = networkEligible;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("daemon /health contract", () => {
  it("carries exactly the one key the Rust handler emits", () => {
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
      hostApi: null,
      identityApi: null,
      tailscaleUrl: null,
    });
  });

  it("ignores a Serve URL injected into public liveness", async () => {
    stubHealth({
      ...rustHealthPayload(),
      tailscale_url: "https://attacker.example",
    });
    const health = await probeDaemon("http://127.0.0.1:18790");
    expect(health.tailscaleUrl).toBeNull();
  });

  it("rejects a listener that does not report healthy liveness", async () => {
    stubHealth({ status: "unhealthy", service: "opensesame-daemon" });
    await expect(probeDaemon("http://127.0.0.1:18790")).rejects.toThrow(
      /did not report healthy liveness/,
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
    stubHealth(rustHealthPayload());
    const local = await probeDaemon("http://127.0.0.1:18790");
    await applyDaemonPairing("https://box.tailnet.ts.net", local);
    const saved = loadSettings();
    expect(saved.hostApi).toBe("http://127.0.0.1:18787");
    expect(saved.daemonApi).toBe("https://box.tailnet.ts.net");
  });

  it("pairing from a remote page routes both planes through the daemon", async () => {
    env.loopbackPage = false;
    stubHealth(rustHealthPayload());
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
