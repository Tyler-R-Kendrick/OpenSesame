import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  connectorLabel,
  defaultCapabilityConnectors,
  normalizeCapabilityConnectors,
} from "./capabilities.js";

describe("capability connectors", () => {
  it("defaults encryption to WebCrypto and history to GitHub", () => {
    const defaults = defaultCapabilityConnectors();
    expect(defaults.encryption.providerId).toBe("webcrypto");
    expect(defaults.history.providerId).toBe("github");
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
      encryption: { providerId: "stripe" },
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
  });

  it("labels the device encryption key vault clearly", () => {
    expect(connectorLabel("webcrypto")).toMatch(/WebCrypto/i);
  });
});
