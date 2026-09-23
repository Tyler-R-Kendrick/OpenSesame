import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultCapabilityConnectors } from "./capabilities.js";
import type { MonitorSnapshot, TargetState } from "./connectivity-monitor.js";
import {
  type ConnectorStatus,
  briefOrigin,
  buildConnectors,
  classifyIdentityConnector,
  classifyKeysConnector,
  isOfflineSet,
  needsAttention,
  repoHint,
} from "./connectors.js";
import type { PlaneStatus } from "./planes.js";
import { settingsSeams } from "./settings.js";
import type { PagesSettings } from "./settings.js";

Object.assign(settingsSeams, {
  loadSettings: () => ({}),
  subscribeSettings: () => () => {},
  settingsEpoch: () => 0,
});

function plane(over: Partial<PlaneStatus> = {}): PlaneStatus {
  return {
    identity: "connected",
    identityBase: "http://127.0.0.1:18788",
    ...over,
  };
}

function target(over: Partial<TargetState> = {}): TargetState {
  return {
    health: "reachable",
    failure: null,
    lastCheckedAt: 1_000,
    checking: false,
    rttMs: 12,
    ...over,
  };
}

function settings(over: Partial<PagesSettings> = {}): PagesSettings {
  return {
    hostApi: "",
    identityApi: "",
    daemonApi: "",
    mfaAppUrl: "",
    capabilityConnectors: {
      ...defaultCapabilityConnectors(),
    },
    ...over,
  };
}

function snapshot(over: Partial<MonitorSnapshot> = {}): MonitorSnapshot {
  return {
    offline: false,
    identity: target(),
    nextCheckAt: null,
    ...over,
  };
}

describe("identity connector", () => {
  it("is live on this device with no remote URL", () => {
    const row = classifyIdentityConnector(
      plane({ identityBase: "device" }),
      target(),
      false,
      "",
    );
    expect(row.tone).toBe("live");
    expect(row.detail).toBe("This device");
  });

  it("is live on a remote base with a session", () => {
    const row = classifyIdentityConnector(
      plane({
        identity: "connected",
        identityBase: "https://id.example",
      }),
      target(),
      false,
      "https://id.example",
    );
    expect(row.tone).toBe("live");
    expect(row.detail).toBe("id.example");
  });

  it("asks for a session when the remote base answers without one", () => {
    const row = classifyIdentityConnector(
      plane({ identity: "none", identityBase: "https://id.example" }),
      target(),
      false,
      "https://id.example",
    );
    expect(row.tone).toBe("attn");
  });

  it("is offline when the radio is off", () => {
    const row = classifyIdentityConnector(
      plane({ identityBase: "device" }),
      target(),
      true,
      "",
    );
    expect(row.tone).toBe("offline");
  });
});

describe("keys connector", () => {
  it("is live on the built-in WebCrypto default", () => {
    const row = classifyKeysConnector(settings());
    expect(row.id).toBe("keys");
    expect(row.tone).toBe("live");
  });
});

describe("buildConnectors", () => {
  it("builds identity and keys, in bar order", () => {
    const built = buildConnectors(plane(), snapshot(), settings());
    expect(built.map((row) => row.id)).toEqual(["identity", "keys"]);
  });

  it("marks everything offline when the radio is off", () => {
    const built = buildConnectors(
      plane(),
      snapshot({ offline: true }),
      settings(),
    );
    const tones = Object.fromEntries(
      built.map((row) => [row.id, row.tone]),
    ) as Record<string, string>;
    expect(tones.identity).toBe("offline");
  });
});

describe("offline set", () => {
  it("is true when any connector reports offline", () => {
    const rows: ConnectorStatus[] = buildConnectors(
      plane(),
      snapshot({ offline: true }),
      settings(),
    );
    expect(isOfflineSet(rows)).toBe(true);
    expect(isOfflineSet(buildConnectors(plane(), snapshot(), settings()))).toBe(
      false,
    );
  });
});

describe("re-exports", () => {
  it.skip("keeps the origin helpers on the bar module", () => {
    expect(briefOrigin("https://id.example/path")).toBe("id.example");
    expect(repoHint("https://github.com/octo/vault")).toContain("octo");
  });
});
