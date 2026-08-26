/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { overlapCast } from "@opensesame/os-domain";
import {
  authorizeCapabilityConnector,
  bindCapabilityConnector,
  bindingNeedsAuth,
  capabilityBindDependencies,
} from "./capability-bind.js";
import type { PagesSettings } from "./settings.js";

// SAFETY: every field these tests read is checked present in this literal; the assertion covers only optional fields no test dereferences.
const BASE: PagesSettings = {
  hostApi: "http://127.0.0.1:18787",
  identityApi: "http://127.0.0.1:18788",
  daemonApi: "http://127.0.0.1:18790",
  tursoUrl: "",
  mfaAppUrl: "",
  capabilityConnectors: {
    encryption: { providerId: "webcrypto" },
    history: { providerId: "github" },
  },
} as PagesSettings;

let stored: PagesSettings;
const saveSettings = vi.fn((next: PagesSettings) => {
  stored = next;
});

const original = { ...capabilityBindDependencies };

beforeEach(() => {
  stored = structuredClone(BASE);
  saveSettings.mockClear();
  Object.assign(capabilityBindDependencies, {
    ...original,
    loadSettings: () => stored,
    saveSettings,
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
    // A connection is an authorization of one specific provider. Carrying
    // GitHub's consent onto a GitLab binding would claim an approval nobody
    // gave — and would then be sent as though GitLab had granted it.
    const next = bindCapabilityConnector("history", "gitlab");
    expect(next.connectionId).toBeUndefined();
    expect(next.remote).toBeUndefined();
  });

  it("keeps the connection when the provider is unchanged", () => {
    stored.capabilityConnectors.history = {
      providerId: "github",
      connectionId: "conn-github",
      remote: "https://github.com/me/store.git",
    };
    const next = bindCapabilityConnector("history", "github");
    expect(next.connectionId).toBe("conn-github");
    expect(next.remote).toBe("https://github.com/me/store.git");
  });

  it("leaves every other capability alone", () => {
    bindCapabilityConnector("encryption", "aws-kms");
    expect(stored.capabilityConnectors.history.providerId).toBe("github");
  });
});

describe("bindingNeedsAuth", () => {
  it("is false for the built-in vault, which authorizes nothing", () => {
    expect(bindingNeedsAuth("encryption", { providerId: "webcrypto" })).toBe(
      false,
    );
  });

  it("is true for a connector bound but not yet consented", () => {
    expect(bindingNeedsAuth("encryption", { providerId: "yubikey" })).toBe(
      true,
    );
  });

  it("is false once a connection id is recorded", () => {
    expect(
      bindingNeedsAuth("encryption", {
        providerId: "yubikey",
        connectionId: "conn-1",
      }),
    ).toBe(false);
  });
});

describe("authorizeCapabilityConnector", () => {
  function arrange(over: Partial<typeof capabilityBindDependencies> = {}) {
    Object.assign(capabilityBindDependencies, {
      ensureHostSession: vi.fn().mockResolvedValue(undefined),
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
    const stub: Window = overlapCast({
      location: { href: "" },
      close: vi.fn(),
    });
    return stub;
  }

  it("short-circuits a connector that needs no authorization", async () => {
    arrange();
    const shut = vi.fn();
    const bare: Window = overlapCast({ close: shut });
    const outcome = await authorizeCapabilityConnector("encryption", bare);
    expect(outcome.tone).toBe("ok");
    // Nothing to consent to, so the popup must not be left hanging open.
    expect(shut).toHaveBeenCalled();
  });

  it("records the connection when consent comes back active", async () => {
    stored.capabilityConnectors.encryption = { providerId: "yubikey" };
    arrange();
    const outcome = await authorizeCapabilityConnector("encryption", popup());
    expect(outcome.tone).toBe("ok");
    expect(stored.capabilityConnectors.encryption.connectionId).toBe(
      "conn-new",
    );
  });

  it("remembers an unfinished connection so the retry resumes it", async () => {
    stored.capabilityConnectors.encryption = { providerId: "yubikey" };
    arrange({
      awaitConsent: vi.fn().mockResolvedValue({
        result: "pending",
        connection: { connectionId: "conn-new" },
      }),
    });
    const outcome = await authorizeCapabilityConnector("encryption", popup());
    expect(outcome.tone).toBe("warn");
    // Not finished is not failed: starting from nothing next time would make
    // the person redo the half of the flow that already worked.
    expect(stored.capabilityConnectors.encryption.connectionId).toBe(
      "conn-new",
    );
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
      ensureHostSession: vi.fn().mockRejectedValue(new Error("host is down")),
    });
    const blank: Window = overlapCast({ location: { href: "" }, close: shut });
    const outcome = await authorizeCapabilityConnector("encryption", blank);
    expect(outcome).toEqual({ tone: "err", text: "host is down" });
    // A popup left open on about:blank is a window the person has to go and
    // find and close themselves.
    expect(shut).toHaveBeenCalled();
  });
});
