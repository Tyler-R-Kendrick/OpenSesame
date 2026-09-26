/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultCapabilityConnectors } from "./capabilities.js";
import {
  authorizeCapabilityConnector,
  bindCapabilityConnector,
  bindingAuthorizedForRootProtection,
  bindingNeedsAuth,
  bumpConsentOperationGeneration,
  capabilityBindDependencies,
  captureConsentOperation,
  connectionAuthorizationState,
  consentCaptureIsCurrent,
  currentConsentOperationGeneration,
} from "./capability-bind.js";
import type { PagesSettings } from "./settings.js";

const BASE: PagesSettings = {
  hostApi: "http://127.0.0.1:18787",
  identityApi: "http://127.0.0.1:18788",
  daemonApi: "http://127.0.0.1:18790",
  capabilityConnectors: {
    ...defaultCapabilityConnectors(),
    encryption: { providerId: "webcrypto" },
    history: { providerId: "github" },
  },
};

let stored: PagesSettings;
let vaultScope: string;
const saveSettings = vi.fn((next: PagesSettings) => {
  stored = next;
});

const original = { ...capabilityBindDependencies };

beforeEach(() => {
  stored = structuredClone(BASE);
  vaultScope = "personal";
  saveSettings.mockClear();
  Object.assign(capabilityBindDependencies, {
    ...original,
    loadSettings: () => stored,
    saveSettings,
    resolveVaultScope: () => vaultScope,
  });
});

afterEach(() => {
  Object.assign(capabilityBindDependencies, original);
  vi.restoreAllMocks();
});

describe("bindCapabilityConnector", () => {
  it("writes the choice through to settings", () => {
    const next = bindCapabilityConnector("encryption", "yubikey");
    expect(next.providerId).toBe("yubikey");
    expect(stored.capabilityConnectors.encryption.providerId).toBe("yubikey");
  });

  it("drops a connection when the provider changes", () => {
    stored.capabilityConnectors.history = {
      providerId: "github",
      connectionId: "conn-github",
      remote: "https://github.com/me/store.git",
    };
    const next = bindCapabilityConnector("history", "gitlab");
    expect(next.connectionId).toBeUndefined();
    expect(next.remote).toBeUndefined();
  });

  it("keeps the connection when the provider is unchanged", () => {
    stored.capabilityConnectors.history = {
      providerId: "github",
      connectionId: "conn-github",
      authorization: "authorized",
      remote: "https://github.com/me/store.git",
    };
    const next = bindCapabilityConnector("history", "github");
    expect(next.connectionId).toBe("conn-github");
    expect(next.authorization).toBe("authorized");
    expect(next.remote).toBe("https://github.com/me/store.git");
  });

  it("leaves every other capability alone", () => {
    bindCapabilityConnector("encryption", "aws-kms");
    expect(stored.capabilityConnectors.history.providerId).toBe("github");
  });

  it("bumps the consent generation when the provider changes", () => {
    const before = currentConsentOperationGeneration();
    bindCapabilityConnector("encryption", "yubikey");
    expect(currentConsentOperationGeneration()).toBeGreaterThan(before);
  });
});

describe("connectionAuthorizationState / bindingNeedsAuth (KP-14)", () => {
  it("is authorized for the built-in vault, which authorizes nothing", () => {
    expect(
      connectionAuthorizationState("encryption", { providerId: "webcrypto" }),
    ).toBe("authorized");
    expect(bindingNeedsAuth("encryption", { providerId: "webcrypto" })).toBe(
      false,
    );
  });

  it("is missing when a connector is bound but not consented", () => {
    expect(
      connectionAuthorizationState("encryption", { providerId: "yubikey" }),
    ).toBe("missing");
    expect(bindingNeedsAuth("encryption", { providerId: "yubikey" })).toBe(
      true,
    );
  });

  it("treats a bare encryption connectionId as pending, not authorized", () => {
    const binding = { providerId: "yubikey", connectionId: "conn-1" };
    expect(connectionAuthorizationState("encryption", binding)).toBe("pending");
    expect(bindingNeedsAuth("encryption", binding)).toBe(true);
    expect(bindingAuthorizedForRootProtection(binding)).toBe(false);
  });

  it("treats explicit pending as not authorized for encryption", () => {
    const binding = {
      providerId: "yubikey",
      connectionId: "conn-1",
      authorization: "pending" as const,
    };
    expect(connectionAuthorizationState("encryption", binding)).toBe("pending");
    expect(bindingNeedsAuth("encryption", binding)).toBe(true);
    expect(bindingAuthorizedForRootProtection(binding)).toBe(false);
  });

  it("is authorized for encryption only after explicit authorized state", () => {
    const binding = {
      providerId: "yubikey",
      connectionId: "conn-1",
      authorization: "authorized" as const,
    };
    expect(connectionAuthorizationState("encryption", binding)).toBe(
      "authorized",
    );
    expect(bindingNeedsAuth("encryption", binding)).toBe(false);
    expect(bindingAuthorizedForRootProtection(binding)).toBe(true);
  });

  it("keeps legacy non-encryption binds: connectionId alone is enough", () => {
    const binding = { providerId: "github", connectionId: "conn-gh" };
    expect(connectionAuthorizationState("history", binding)).toBe("authorized");
    expect(bindingNeedsAuth("history", binding)).toBe(false);
  });

  it("still needs auth for history with no connectionId", () => {
    expect(bindingNeedsAuth("history", { providerId: "github" })).toBe(true);
  });
});

describe("authorizeCapabilityConnector", () => {
  function arrange(over: Partial<typeof capabilityBindDependencies> = {}) {
    Object.assign(capabilityBindDependencies, {
      listConnections: vi.fn().mockResolvedValue([]),
      createConnection: vi
        .fn()
        .mockResolvedValue({ connectionId: "conn-new", status: "pending" }),
      authorizeConnection: vi
        .fn()
        .mockResolvedValue({ authorizationUrl: "https://consent.example" }),
      awaitConsent: vi.fn().mockResolvedValue({
        result: "active",
        connection: { connectionId: "conn-new" },
      }),
      ...over,
    });
  }

  function popup(): Window {
    const child: Window = Object.create(window);
    Object.defineProperty(child, "location", {
      value: { href: "" },
      writable: true,
    });
    child.close = vi.fn();
    return child;
  }

  it("short-circuits a connector that needs no authorization", async () => {
    arrange();
    const shut = vi.fn();
    const consentPopup = popup();
    consentPopup.close = shut;
    const outcome = await authorizeCapabilityConnector(
      "encryption",
      consentPopup,
    );
    expect(outcome.tone).toBe("ok");
    expect(shut).toHaveBeenCalled();
  });

  it("records authorized state when consent comes back active", async () => {
    stored.capabilityConnectors.encryption = { providerId: "yubikey" };
    arrange();
    const outcome = await authorizeCapabilityConnector("encryption", popup());
    expect(outcome.tone).toBe("ok");
    expect(stored.capabilityConnectors.encryption.connectionId).toBe(
      "conn-new",
    );
    expect(stored.capabilityConnectors.encryption.authorization).toBe(
      "authorized",
    );
    expect(
      bindingAuthorizedForRootProtection(
        stored.capabilityConnectors.encryption,
      ),
    ).toBe(true);
  });

  it("remembers an unfinished connection as pending, not authorized", async () => {
    stored.capabilityConnectors.encryption = { providerId: "yubikey" };
    arrange({
      awaitConsent: vi.fn().mockResolvedValue({
        result: "pending",
        connection: { connectionId: "conn-new" },
      }),
    });
    const outcome = await authorizeCapabilityConnector("encryption", popup());
    expect(outcome.tone).toBe("warn");
    expect(stored.capabilityConnectors.encryption.connectionId).toBe(
      "conn-new",
    );
    expect(stored.capabilityConnectors.encryption.authorization).toBe(
      "pending",
    );
    expect(
      bindingNeedsAuth("encryption", stored.capabilityConnectors.encryption),
    ).toBe(true);
    expect(
      bindingAuthorizedForRootProtection(
        stored.capabilityConnectors.encryption,
      ),
    ).toBe(false);
  });

  it("does not record a connection that was refused", async () => {
    stored.capabilityConnectors.encryption = { providerId: "yubikey" };
    arrange({
      awaitConsent: vi.fn().mockResolvedValue({
        result: "failed",
        connection: { connectionId: "conn-new", statusDetail: "denied" },
      }),
    });
    const outcome = await authorizeCapabilityConnector("encryption", popup());
    expect(outcome.tone).toBe("err");
    expect(outcome.text).toBe("denied");
    expect(stored.capabilityConnectors.encryption.connectionId).toBeUndefined();
  });

  it("reuses a live connection rather than creating a second one", async () => {
    stored.capabilityConnectors.encryption = { providerId: "yubikey" };
    const createConnection = vi.fn();
    arrange({
      listConnections: vi.fn().mockResolvedValue([
        {
          connectionId: "conn-existing",
          providerId: "yubikey",
          status: "active",
        },
      ]),
      createConnection,
    });
    await authorizeCapabilityConnector("encryption", popup());
    expect(createConnection).not.toHaveBeenCalled();
  });

  it("replaces a revoked connection instead of reauthorizing a dead one", async () => {
    stored.capabilityConnectors.encryption = { providerId: "yubikey" };
    const createConnection = vi
      .fn()
      .mockResolvedValue({ connectionId: "conn-fresh", status: "pending" });
    arrange({
      listConnections: vi.fn().mockResolvedValue([
        {
          connectionId: "conn-old",
          providerId: "yubikey",
          status: "revoked",
        },
      ]),
      createConnection,
      awaitConsent: vi.fn().mockResolvedValue({
        result: "active",
        connection: { connectionId: "conn-fresh" },
      }),
    });
    await authorizeCapabilityConnector("encryption", popup());
    expect(createConnection).toHaveBeenCalledTimes(1);
  });

  it("closes the popup and reports when the round trip throws", async () => {
    stored.capabilityConnectors.encryption = { providerId: "yubikey" };
    const shut = vi.fn();
    arrange({
      listConnections: vi.fn().mockRejectedValue(new Error("identity is down")),
    });
    const consentPopup = popup();
    consentPopup.close = shut;
    const outcome = await authorizeCapabilityConnector(
      "encryption",
      consentPopup,
    );
    expect(outcome).toEqual({ tone: "err", text: "identity is down" });
    expect(shut).toHaveBeenCalled();
  });

  it("discards a stale callback when the provider changed mid-consent (KP-15)", async () => {
    stored.capabilityConnectors.encryption = { providerId: "yubikey" };
    arrange({
      awaitConsent: vi.fn().mockImplementation(async () => {
        bindCapabilityConnector("encryption", "aws-kms");
        return {
          result: "active",
          connection: { connectionId: "conn-stale" },
        };
      }),
    });
    const outcome = await authorizeCapabilityConnector("encryption", popup());
    expect(outcome.tone).toBe("warn");
    expect(outcome.text).toMatch(/discarded/);
    expect(stored.capabilityConnectors.encryption.providerId).toBe("aws-kms");
    expect(stored.capabilityConnectors.encryption.connectionId).toBeUndefined();
    expect(
      bindingAuthorizedForRootProtection(
        stored.capabilityConnectors.encryption,
      ),
    ).toBe(false);
  });

  it("discards a stale callback when the vault scope changed (KP-15)", async () => {
    stored.capabilityConnectors.encryption = { providerId: "yubikey" };
    arrange({
      awaitConsent: vi.fn().mockImplementation(async () => {
        vaultScope = "project-other";
        return {
          result: "active",
          connection: { connectionId: "conn-stale" },
        };
      }),
    });
    const outcome = await authorizeCapabilityConnector("encryption", popup());
    expect(outcome.tone).toBe("warn");
    expect(outcome.text).toMatch(/discarded/);
    expect(stored.capabilityConnectors.encryption.authorization).not.toBe(
      "authorized",
    );
  });
});

describe("consentCaptureIsCurrent", () => {
  it("rejects when operation generation advances", () => {
    stored.capabilityConnectors.encryption = { providerId: "yubikey" };
    const capture = captureConsentOperation(
      "encryption",
      stored.capabilityConnectors.encryption,
      "conn-1",
    );
    bumpConsentOperationGeneration();
    expect(consentCaptureIsCurrent(capture)).toBe(false);
  });
});
