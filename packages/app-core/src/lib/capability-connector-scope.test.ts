import { afterEach, describe, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { defaultCapabilityConnectors } from "./capabilities.js";
import { LAST_VAULT_KEY } from "./last-vault.js";
import { PROJECTS_KEY } from "./projects-state.js";

afterEach(() => {
  configureHost(createTestHost());
  vi.resetModules();
});

function boot(activeId: string): string {
  return JSON.stringify({ v: 1, activeId });
}

describe("capability bindings per vault", () => {
  it("keeps a legacy map on personal and defaults everywhere else", async () => {
    const { kvGet, kvSet, kvDelete } = await import("./kv.js");
    const { loadSettings, saveSettings } = await import("./settings.js");
    kvSet(
      "settings.v1",
      JSON.stringify({
        hostApi: "",
        identityApi: "",
        daemonApi: "",
        capabilityConnectors: {
          encryption: { providerId: "aws-kms" },
          history: { providerId: "github" },
        },
      }),
    );

    expect(loadSettings().capabilityConnectors.encryption.providerId).toBe(
      "aws-kms",
    );

    kvSet(PROJECTS_KEY, boot("prj_other"));
    expect(loadSettings().capabilityConnectors.encryption.providerId).toBe(
      "webcrypto",
    );
    expect(loadSettings().capabilityConnectors.history.remote).toBeUndefined();

    saveSettings({
      ...loadSettings(),
      capabilityConnectors: {
        ...defaultCapabilityConnectors(),
        history: {
          providerId: "github",
          remote: "https://github.com/other/store.git",
        },
      },
    });

    kvSet(PROJECTS_KEY, boot("personal"));
    expect(loadSettings().capabilityConnectors.encryption.providerId).toBe(
      "aws-kms",
    );
    expect(loadSettings().capabilityConnectors.history.remote).toBeUndefined();

    kvSet(PROJECTS_KEY, boot("prj_other"));
    expect(loadSettings().capabilityConnectors.encryption.providerId).toBe(
      "webcrypto",
    );
    expect(loadSettings().capabilityConnectors.history.remote).toBe(
      "https://github.com/other/store.git",
    );

    kvSet(LAST_VAULT_KEY, "guest");
    expect(loadSettings().capabilityConnectors.encryption.providerId).toBe(
      "webcrypto",
    );
    expect(loadSettings().capabilityConnectors.history.remote).toBeUndefined();

    saveSettings({
      ...loadSettings(),
      capabilityConnectors: {
        ...defaultCapabilityConnectors(),
        encryption: { providerId: "gcp-kms" },
      },
    });

    kvDelete(LAST_VAULT_KEY);
    kvSet(PROJECTS_KEY, boot("personal"));
    expect(loadSettings().capabilityConnectors.encryption.providerId).toBe(
      "aws-kms",
    );

    kvSet(LAST_VAULT_KEY, "guest");
    expect(loadSettings().capabilityConnectors.encryption.providerId).toBe(
      "gcp-kms",
    );

    kvDelete(LAST_VAULT_KEY);
    kvSet(PROJECTS_KEY, boot("prj_other"));
    expect(loadSettings().capabilityConnectors.history.remote).toBe(
      "https://github.com/other/store.git",
    );

    // SAFETY: the settings json this test wrote keeps the vault connector map.
    const stored = JSON.parse(kvGet("settings.v1") ?? "{}") as {
      capabilityConnectorsByVault: Record<
        string,
        { encryption: { providerId: string } }
      >;
    };
    expect(
      stored.capabilityConnectorsByVault.personal?.encryption.providerId,
    ).toBe("aws-kms");
    expect(
      stored.capabilityConnectorsByVault.guest?.encryption.providerId,
    ).toBe("gcp-kms");
    expect(
      stored.capabilityConnectorsByVault.prj_other?.encryption.providerId,
    ).toBe("webcrypto");
  });

  it("does not treat a legacy map as another tomb when per-vault storage exists", async () => {
    const { kvSet } = await import("./kv.js");
    const { loadSettings } = await import("./settings.js");
    kvSet(
      "settings.v1",
      JSON.stringify({
        hostApi: "",
        identityApi: "",
        daemonApi: "",
        capabilityConnectors: {
          encryption: { providerId: "aws-kms" },
        },
        capabilityConnectorsByVault: {},
      }),
    );
    expect(loadSettings().capabilityConnectors.encryption.providerId).toBe(
      "webcrypto",
    );
  });
});
