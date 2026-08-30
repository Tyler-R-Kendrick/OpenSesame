import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultCapabilityConnectors } from "./capabilities.js";

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
        ...defaultCapabilityConnectors(),
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

  it("persists active project id outside the vault", async () => {
    const { loadSettings, saveSettings } = await import("./settings.js");
    saveSettings({
      ...loadSettings(),
      activeProjectId: "prj_personal_001",
    });
    expect(loadSettings().activeProjectId).toBe("prj_personal_001");
  });

  it("defaults capability connectors to WebCrypto encryption and GitHub history", async () => {
    const { loadSettings, saveSettings } = await import("./settings.js");
    saveSettings({
      ...loadSettings(),
      capabilityConnectors: {
        ...defaultCapabilityConnectors(),
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
            ...defaultCapabilityConnectors(),
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
            ...defaultCapabilityConnectors(),
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
            ...defaultCapabilityConnectors(),
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
          ...defaultCapabilityConnectors(),
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
          ...defaultCapabilityConnectors(),
          encryption: { providerId: "webcrypto" },
          history: { providerId: "github" },
        },
      }),
    ).toBe(false);
  });
});

describe("settings subscriptions and guards", () => {
  it("notifies subscribers on save and stops after unsubscribe", async () => {
    const { saveSettings, loadSettings, subscribeSettings } = await import(
      "./settings.js"
    );
    let calls = 0;
    const unsubscribe = subscribeSettings(() => {
      calls += 1;
    });
    saveSettings(loadSettings());
    expect(calls).toBe(1);
    unsubscribe();
    saveSettings(loadSettings());
    expect(calls).toBe(1);
  });

  it("falls back to defaults when persisted JSON is corrupt", async () => {
    const { kvSet } = await import("./kv.js");
    kvSet("settings.v1", "{corrupt");
    const { loadSettings, shippedHostApi } = await import("./settings.js");
    expect(loadSettings().hostApi).toBe(shippedHostApi);
  });

  it("counts a tailnet daemon without a Host as a remote pairing", async () => {
    const { hasRemoteHostPairing } = await import("./settings.js");
    const base = {
      hostApi: "",
      identityApi: "",
      tursoUrl: "",
      mfaAppUrl: "",
      capabilityConnectors: {
        ...defaultCapabilityConnectors(),
        encryption: { providerId: "webcrypto" },
        history: { providerId: "github" },
      },
    };
    expect(
      hasRemoteHostPairing({ ...base, daemonApi: "https://box.tail.ts.net" }),
    ).toBe(true);
    expect(
      hasRemoteHostPairing({ ...base, daemonApi: "http://127.0.0.1:18790" }),
    ).toBe(false);
    expect(hasRemoteHostPairing({ ...base, daemonApi: "" })).toBe(false);
    expect(
      hasRemoteHostPairing({ ...base, daemonApi: "https://evil.example !" }),
    ).toBe(false);
  });

  it("does not auto-connect without an Identity URL", async () => {
    const { shouldAutoConnect } = await import("./settings.js");
    expect(
      shouldAutoConnect(
        {
          hostApi: "",
          identityApi: "",
          daemonApi: "",
          tursoUrl: "",
          mfaAppUrl: "",
          capabilityConnectors: {
            ...defaultCapabilityConnectors(),
            encryption: { providerId: "webcrypto" },
            history: { providerId: "github" },
          },
        },
        "127.0.0.1",
      ),
    ).toBe(false);
  });
});
