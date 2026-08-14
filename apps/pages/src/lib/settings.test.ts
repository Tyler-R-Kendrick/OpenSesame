import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("runtime endpoint defaults", () => {
  it("uses the Host endpoint supplied by the local runtime", async () => {
    vi.stubEnv("VITE_HOST_API", "http://localhost:18787");
    vi.stubEnv("VITE_IDENTITY_API", "http://localhost:8788");
    const { loadSettings, saveSettings } = await import("./settings.js");

    saveSettings({
      hostApi: "http://127.0.0.1:18787",
      identityApi: "http://127.0.0.1:8788",
      daemonApi: "http://127.0.0.1:18790",
      tursoUrl: "",
    });

    expect(loadSettings().hostApi).toBe("http://localhost:18787");
    expect(loadSettings().identityApi).toBe("http://localhost:8788");
    expect(loadSettings().tursoUrl).toBe("");
    expect(loadSettings().daemonApi).toBe("http://127.0.0.1:18790");
  });

  it("auto-connects on loopback and refuses loopback Identity from github.io", async () => {
    const { shouldAutoConnect } = await import("./settings.js");
    expect(
      shouldAutoConnect(
        {
          hostApi: "http://127.0.0.1:8787",
          identityApi: "http://127.0.0.1:8788",
          daemonApi: "http://127.0.0.1:18790",
          tursoUrl: "",
        },
        "127.0.0.1",
      ),
    ).toBe(true);
    expect(
      shouldAutoConnect(
        {
          hostApi: "http://127.0.0.1:8787",
          identityApi: "http://127.0.0.1:8788",
          daemonApi: "http://127.0.0.1:18790",
          tursoUrl: "",
        },
        "tyler-r-kendrick.github.io",
      ),
    ).toBe(false);
    expect(
      shouldAutoConnect(
        {
          hostApi: "https://host.example",
          identityApi: "https://id.example",
          daemonApi: "http://127.0.0.1:18790",
          tursoUrl: "",
        },
        "tyler-r-kendrick.github.io",
      ),
    ).toBe(true);
  });
});
