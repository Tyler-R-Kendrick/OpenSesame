import { overlapCast } from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  capabilityDef,
  connectorLabel,
  defaultCapabilityConnectors,
  isSettingsEncryptionKey,
  normalizeCapabilityConnectors,
} from "./capabilities.js";

describe("capability connectors", () => {
  it("defaults encryption to WebCrypto and history to GitHub", () => {
    const defaults = defaultCapabilityConnectors();
    expect(defaults.encryption.providerId).toBe("webcrypto");
    expect(defaults.history.providerId).toBe("github");
    expect(defaults.mfa_authenticator.providerId).toBe("vault-self");
    expect(defaults.mfa_email.providerId).toBe("resend");
    expect(defaults.mfa_sms.providerId).toBe("twilio");
  });

  it("keeps GitHub as the history default and accepts a remote", () => {
    const next = normalizeCapabilityConnectors({
      history: {
        providerId: "github",
        connectionId: "conn_1",
        remote: "https://github.com/acme/secrets.git",
      },
    });
    expect(next.history).toEqual({
      providerId: "github",
      connectionId: "conn_1",
      remote: "https://github.com/acme/secrets.git",
    });
    expect(next.encryption.providerId).toBe("webcrypto");
  });

  it("rejects unknown connectors for a capability", () => {
    const next = normalizeCapabilityConnectors({
      encryption: { providerId: "unknown-processor" },
    });
    expect(next.encryption.providerId).toBe("webcrypto");
  });

  it("marks GitHub history as requiring auth with repo scope", () => {
    const history = CAPABILITIES.find((c) => c.id === "history");
    expect(history?.requiresAuth("github")).toBe(true);
    expect(history?.authScopes?.("github")).toEqual([
      "read:user",
      "repo",
      "workflow",
    ]);
    expect(history?.requiresAuth("password-store")).toBe(false);
    expect(history?.connectorIds).toEqual([
      "github",
      "password-store",
      "gitlab",
    ]);
  });

  it("preserves multi-select history selections", () => {
    const next = normalizeCapabilityConnectors({
      history: {
        providerId: "gitlab",
        selections: [
          { providerId: "github", group: "git" },
          {
            providerId: "gitlab",
            group: "git",
            remote: "https://gitlab.com/org/store.git",
          },
        ],
      },
    });
    expect(next.history.selections).toEqual([
      { providerId: "github", group: "git" },
      {
        providerId: "gitlab",
        group: "git",
        remote: "https://gitlab.com/org/store.git",
      },
    ]);
  });

  it("labels the device encryption key vault clearly", () => {
    expect(connectorLabel("webcrypto")).toMatch(/WebCrypto/i);
  });

  it("covers the capability families including MFA delivery", () => {
    expect(CAPABILITIES.map((c) => c.id).sort()).toEqual([
      "certificates",
      "cloud_secrets",
      "encryption",
      "history",
      "identity",
      "mfa_authenticator",
      "mfa_email",
      "mfa_sms",
      "password_managers",
    ]);
    const defaults = defaultCapabilityConnectors();
    for (const def of CAPABILITIES) {
      expect(def.connectorIds).toContain(defaults[def.id].providerId);
      expect(defaults[def.id].providerId).toBe(def.connectorIds[0]);
    }
  });

  it("lists the three certificate issuers with ACME issuers auth-free", () => {
    const certs = capabilityDef("certificates");
    expect(certs.connectorIds).toEqual([
      "letsencrypt",
      "zerossl",
      "cloudflare-origin-ca",
    ]);
    expect(certs.requiresAuth("letsencrypt")).toBe(false);
    expect(certs.requiresAuth("cloudflare-origin-ca")).toBe(true);
  });
});

describe("capability definitions", () => {
  it("resolves known capabilities and rejects unknown ids", () => {
    expect(capabilityDef("encryption").connectorIds).toContain("webcrypto");
    expect(capabilityDef("history").connectorIds).toContain("github");
    expect(() => capabilityDef(overlapCast("nope"))).toThrow(
      /unknown capability/,
    );
  });

  it("requires auth for cloud key vaults but not device-local ones", () => {
    const encryption = capabilityDef("encryption");
    expect(encryption.requiresAuth("webcrypto")).toBe(false);
    expect(encryption.requiresAuth("sealed-local")).toBe(false);
    expect(encryption.requiresAuth("age")).toBe(false);
    expect(isSettingsEncryptionKey("age")).toBe(true);
    expect(isSettingsEncryptionKey("aws-kms")).toBe(false);
    expect(encryption.requiresAuth("aws-kms")).toBe(true);
    expect(encryption.authScopes?.("aws-kms")).toBeUndefined();
  });

  it("scopes GitLab history auth and leaves other connectors scopeless", () => {
    const history = capabilityDef("history");
    expect(history.requiresAuth("gitlab")).toBe(true);
    expect(history.authScopes?.("gitlab")).toEqual(["read_user", "api"]);
    expect(history.authScopes?.("password-store")).toBeUndefined();
  });

  it("labels every built-in connector and falls back to the raw id", () => {
    const labels: Array<[string, string]> = [
      ["webcrypto", "WebCrypto (this device)"],
      ["sealed-local", "Sealed local (Host)"],
      ["password-store", "Local git password-store"],
      ["aws-kms", "AWS KMS"],
      ["azure-key-vault-keys", "Azure Key Vault"],
      ["gcp-kms", "Google Cloud KMS"],
      ["github", "GitHub"],
      ["gitlab", "GitLab"],
    ];
    for (const [id, label] of labels) {
      expect(connectorLabel(id)).toBe(label);
    }
    expect(connectorLabel("acme-vault")).toBe("acme-vault");
  });

  it("drops blank connection ids and remotes during normalization", () => {
    const next = normalizeCapabilityConnectors({
      encryption: { providerId: "age", connectionId: "   ", remote: "" },
      history: {},
    });
    expect(next.encryption).toEqual({ providerId: "age" });
    expect(next.history.providerId).toBe("github");
    expect(normalizeCapabilityConnectors(undefined)).toEqual(
      defaultCapabilityConnectors(),
    );
    expect(normalizeCapabilityConnectors(null).encryption.providerId).toBe(
      "webcrypto",
    );
  });

  it("keeps a trimmed connection id when one is present", () => {
    const next = normalizeCapabilityConnectors({
      encryption: { providerId: "age", connectionId: "  conn_9  " },
    });
    expect(next.encryption.connectionId).toBe("conn_9");
  });
});
