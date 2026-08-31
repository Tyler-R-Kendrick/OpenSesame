import { beforeEach, describe, expect, it, vi } from "vitest";

import { kvSeams } from "./kv.js";
import { settingsSeams } from "./settings.js";

const store = new Map<string, string>();
Object.assign(kvSeams, {
  kvGet: (key: string) => store.get(key) ?? null,
  kvSetDurable: async (key: string, value: string) => {
    store.set(key, value);
  },
});

import {
  SETUP_KEY,
  SETUP_STEPS,
  completeSetup,
  initialStep,
  loadSetup,
  setupRequired,
  setupSeams,
  unlockViable,
} from "./setup.js";

const originalSetupSeams = { ...setupSeams };
const originalSettingsSeams = { ...settingsSeams };

type Endpoints = { identityApi: string; hostApi: string };

function withEndpoints({ identityApi, hostApi }: Endpoints): void {
  setupSeams.loadSettings = () =>
    // Only the two fields `initialStep` reads matter; the rest of PagesSettings
    // is filled by the real loader in production.
    ({
      ...originalSettingsSeams.loadSettings(),
      identityApi,
      hostApi,
    });
}

beforeEach(() => {
  store.clear();
  Object.assign(setupSeams, originalSetupSeams);
  Object.assign(settingsSeams, originalSettingsSeams);
});

describe("the setup record", () => {
  it("round-trips what the operator answered", async () => {
    await completeSetup({
      identity: "connected",
      provider: "workos",
      host: true,
      machine: false,
    });

    const record = loadSetup();
    expect(record).not.toBeNull();
    expect(record?.identity).toBe("connected");
    expect(record?.provider).toBe("workos");
    expect(record?.host).toBe(true);
    expect(record?.machine).toBe(false);
    expect(Number.isNaN(Date.parse(record?.completedAt ?? ""))).toBe(false);
  });

  it("stores no endpoint of its own", async () => {
    await completeSetup({
      identity: "connected",
      provider: "",
      host: true,
      machine: true,
    });

    // Addresses belong to settings.v1. A second copy here would be a second
    // source of truth for what this app talks to.
    expect(store.get(SETUP_KEY)).not.toMatch(/http/);
  });

  it("reads a corrupt or truncated record as no record", () => {
    for (const raw of ["{", "null", "[]", "{}", '{"completedAt":""}']) {
      store.set(SETUP_KEY, raw);
      expect(loadSetup()).toBeNull();
    }
  });

  it("defaults a record written by an older shape to connected", () => {
    store.set(
      SETUP_KEY,
      JSON.stringify({ completedAt: "2026-08-31T00:00:00Z" }),
    );
    const record = loadSetup();
    expect(record?.identity).toBe("connected");
    expect(record?.provider).toBe("");
    expect(record?.host).toBe(false);
  });
});

describe("setupRequired", () => {
  const fresh = { vaultStatus: "empty", hasSession: false } as const;

  it("is true for a device nobody has been to", () => {
    expect(setupRequired(fresh)).toBe(true);
  });

  it("is false once the ceremony has been answered", async () => {
    await completeSetup({
      identity: "local-only",
      provider: "",
      host: false,
      machine: false,
    });
    expect(setupRequired(fresh)).toBe(false);
  });

  it("is false where a vault already exists, record or not", () => {
    // Every build before the ceremony let people seal a vault without one.
    // Sending them to first-run setup would tell a returning user their vault
    // is a fresh install.
    expect(setupRequired({ vaultStatus: "locked", hasSession: false })).toBe(
      false,
    );
    expect(setupRequired({ vaultStatus: "unlocked", hasSession: false })).toBe(
      false,
    );
  });

  it("is false where an Identity session is live", () => {
    // A session is only reachable through a working Identity API, so somebody
    // has already pointed this app at one.
    expect(setupRequired({ vaultStatus: "empty", hasSession: true })).toBe(
      false,
    );
  });

  it("survives a KV read that throws", () => {
    kvSeams.kvGet = vi.fn(() => {
      throw new Error("OPFS unavailable");
    });
    expect(setupRequired(fresh)).toBe(true);
    kvSeams.kvGet = (key: string) => store.get(key) ?? null;
  });
});

describe("unlockViable", () => {
  it("is false with nothing sealed on the device", () => {
    expect(unlockViable("empty")).toBe(false);
  });

  it("is true wherever there is a vault to open", () => {
    expect(unlockViable("locked")).toBe(true);
    expect(unlockViable("unlocked")).toBe(true);
  });
});

describe("initialStep", () => {
  it("starts at the beginning when nothing is configured", () => {
    withEndpoints({ identityApi: "", hostApi: "" });
    expect(initialStep()).toBe("identity");
  });

  it("skips to the Host question when identity is already known", () => {
    withEndpoints({ identityApi: "https://id.acme.com", hostApi: "" });
    expect(initialStep()).toBe("host");
  });

  it("opens on Review when the deployment already carries both", () => {
    // Loopback dev, or a static deploy whose os-runtime-config.json names the
    // endpoints: four screens of pre-filled fields would teach the operator
    // that the ceremony is theatre.
    withEndpoints({
      identityApi: "http://127.0.0.1:18788",
      hostApi: "http://127.0.0.1:18787",
    });
    expect(initialStep()).toBe("review");
  });

  it("treats whitespace as unset", () => {
    withEndpoints({ identityApi: "   ", hostApi: "   " });
    expect(initialStep()).toBe("identity");
  });

  it("only ever names a real step", () => {
    withEndpoints({ identityApi: "https://id.acme.com", hostApi: "" });
    expect(SETUP_STEPS).toContain(initialStep());
  });
});
