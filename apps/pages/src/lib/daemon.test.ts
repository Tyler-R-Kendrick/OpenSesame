import { afterEach, describe, expect, it, vi } from "vitest";
import { applyDaemonPairing, probeDaemon } from "./daemon.js";
import {
  hasRemoteHostPairing,
  loadSettings,
  saveSettings,
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
});
