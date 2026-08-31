import { beforeEach, describe, expect, it, vi } from "vitest";

import { TRUSTED_UPSTREAMS } from "./federation.js";
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
  brokeredSignInReady,
  completeSetup,
  loadSetup,
  setupRequired,
  setupSeams,
  unlockViable,
} from "./setup.js";

const originalSetupSeams = { ...setupSeams };
const originalSettingsSeams = { ...settingsSeams };

beforeEach(() => {
  store.clear();
  Object.assign(setupSeams, originalSetupSeams);
  Object.assign(settingsSeams, originalSettingsSeams);
});

describe("the setup record", () => {
  it("round-trips what the operator answered", async () => {
    await completeSetup({
      identity: "byo",
      provider: "workos",
      host: true,
      machine: false,
    });

    const record = loadSetup();
    expect(record).not.toBeNull();
    expect(record?.identity).toBe("byo");
    expect(record?.provider).toBe("workos");
    expect(record?.host).toBe(true);
    expect(record?.machine).toBe(false);
    expect(Number.isNaN(Date.parse(record?.completedAt ?? ""))).toBe(false);
  });

  it("stores no endpoint of its own", async () => {
    await completeSetup({
      identity: "brokered",
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

  it("reads an unknown or absent choice as the zero-config road", () => {
    store.set(
      SETUP_KEY,
      JSON.stringify({ completedAt: "2026-08-31T00:00:00Z" }),
    );
    const record = loadSetup();
    // "brokered" is the answer that needs nothing configured, so it is the
    // safe reading of a record that does not say.
    expect(record?.identity).toBe("brokered");
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
      identity: "none",
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

describe("brokeredSignInReady", () => {
  it("every compiled upstream carries an issuer", () => {
    // The invariant the whole provider-first ceremony rests on: a build always
    // ships an upstream a browser can run the code flow against, so a
    // deployment nobody has configured can still sign somebody in. If this ever
    // becomes false, leading with the zero-config road is a lie.
    expect(TRUSTED_UPSTREAMS.length).toBeGreaterThan(0);
    for (const upstream of TRUSTED_UPSTREAMS) {
      expect(upstream.issuer.trim().length).toBeGreaterThan(0);
    }
  });

  it("is true when the default upstream has an issuer", () => {
    setupSeams.defaultUpstreamIssuer = () => "https://shoo.dev";
    expect(brokeredSignInReady()).toBe(true);
  });

  it("is false only if a build shipped without one", () => {
    setupSeams.defaultUpstreamIssuer = () => "";
    expect(brokeredSignInReady()).toBe(false);
  });
});

describe("SETUP_STEPS", () => {
  it("asks sign-in first and nothing else that is required", () => {
    // It was four steps, three of which asked for self-hosted addresses most
    // deployments do not have. Sign-in is the only question with a wrong
    // answer, so it leads and everything else folds behind it.
    expect(SETUP_STEPS).toEqual(["signin", "more"]);
  });
});
