import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("runtime endpoint defaults", () => {
  it("uses the Host endpoint supplied by the local runtime", async () => {
    vi.stubEnv("VITE_HOST_API", "http://localhost:18787");
    vi.stubEnv("VITE_IDENTITY_API", "http://localhost:18788");
    const { loadSettings, saveSettings } = await import("./settings.js");

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

    expect(loadSettings().hostApi).toBe("http://localhost:18787");
    expect(loadSettings().identityApi).toBe("http://localhost:18788");
    expect(loadSettings().tursoUrl).toBe("");
    expect(loadSettings().daemonApi).toBe("http://127.0.0.1:18790");
  });

  it("persists a Mobile MFA handoff URL", async () => {
    const { loadSettings, saveSettings } = await import("./settings.js");
    saveSettings({
      ...loadSettings(),
      mfaAppUrl: "http://127.0.0.1:5177",
    });
    expect(loadSettings().mfaAppUrl).toBe("http://127.0.0.1:5177");
  });

  it("defaults capability connectors to WebCrypto encryption and GitHub history", async () => {
    const { loadSettings, saveSettings } = await import("./settings.js");
    saveSettings({
      ...loadSettings(),
      capabilityConnectors: {
        encryption: { providerId: "webcrypto" },
        history: {
          providerId: "github",
          remote: "https://github.com/acme/store.git",
        },
      },
    });
    expect(loadSettings().capabilityConnectors.encryption.providerId).toBe(
      "webcrypto",
    );
    expect(loadSettings().capabilityConnectors.history).toMatchObject({
      providerId: "github",
      remote: "https://github.com/acme/store.git",
    });
  });

  it("auto-connects on loopback and refuses loopback Identity from github.io", async () => {
    const { shouldAutoConnect, hasRemoteHostPairing } = await import(
      "./settings.js"
    );
    expect(
      shouldAutoConnect(
        {
          hostApi: "http://127.0.0.1:8787",
          identityApi: "http://127.0.0.1:18788",
          daemonApi: "http://127.0.0.1:18790",
          tursoUrl: "",
          mfaAppUrl: "",
          capabilityConnectors: {
            encryption: { providerId: "webcrypto" },
            history: { providerId: "github" },
          },
        },
        "127.0.0.1",
      ),
    ).toBe(true);
    expect(
      shouldAutoConnect(
        {
          hostApi: "http://127.0.0.1:8787",
          identityApi: "http://127.0.0.1:18788",
          daemonApi: "http://127.0.0.1:18790",
          tursoUrl: "",
          mfaAppUrl: "",
          capabilityConnectors: {
            encryption: { providerId: "webcrypto" },
            history: { providerId: "github" },
          },
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
          mfaAppUrl: "",
          capabilityConnectors: {
            encryption: { providerId: "webcrypto" },
            history: { providerId: "github" },
          },
        },
        "tyler-r-kendrick.github.io",
      ),
    ).toBe(true);
    expect(
      hasRemoteHostPairing({
        hostApi: "https://box.tail123.ts.net/host",
        identityApi: "https://box.tail123.ts.net/identity",
        daemonApi: "https://box.tail123.ts.net",
        tursoUrl: "",
        mfaAppUrl: "",
        capabilityConnectors: {
          encryption: { providerId: "webcrypto" },
          history: { providerId: "github" },
        },
      }),
    ).toBe(true);
    expect(
      hasRemoteHostPairing({
        hostApi: "http://127.0.0.1:8787",
        identityApi: "http://127.0.0.1:18788",
        daemonApi: "http://127.0.0.1:18790",
        tursoUrl: "",
        mfaAppUrl: "",
        capabilityConnectors: {
          encryption: { providerId: "webcrypto" },
          history: { providerId: "github" },
        },
      }),
    ).toBe(false);
  });
});
