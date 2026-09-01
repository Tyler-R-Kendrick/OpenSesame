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
    await completeSetup({ ways: ["builtin", "google", "okta"], service: true });

    const record = loadSetup();
    expect(record).not.toBeNull();
    expect(record?.ways).toEqual(["builtin", "google", "okta"]);
    expect(record?.service).toBe(true);
    expect(Number.isNaN(Date.parse(record?.completedAt ?? ""))).toBe(false);
  });

  it("stores no endpoint of its own", async () => {
    await completeSetup({ ways: ["builtin"], service: true });

    // Addresses belong to settings.v1 — the issuer, the client id, every
    // endpoint. A second copy here would be a second source of truth for what
    // this app talks to.
    expect(store.get(SETUP_KEY)).not.toMatch(/http/);
  });

  it("records every way in, not just one", async () => {
    // A deployment is rarely one provider: Google for most people, an org's
    // own IdP for staff. The readout used to say `Identity service — not set`
    // for a deployment signing people in against Okta, because "identity
    // service" meant "an OpenSesame control plane" (ADR 0078).
    await completeSetup({ ways: ["google", "okta", "oidc"], service: false });
    expect(loadSetup()?.ways).toEqual(["google", "okta", "oidc"]);
  });

  it("records a deployment with no accounts as a decision", async () => {
    await completeSetup({ ways: [], service: false });
    const record = loadSetup();
    expect(record?.ways).toEqual([]);
    expect(record?.service).toBe(false);
    expect(record?.joined).toBe(false);
  });

  it("records a join as a decision, not as an unanswered ceremony", async () => {
    await completeSetup({ ways: [], service: false, joined: true });
    const record = loadSetup();
    expect(record?.joined).toBe(true);
    expect(setupRequired({ vaultStatus: "empty", hasSession: false })).toBe(
      false,
    );
  });

  it("reads a corrupt or truncated record as no record", () => {
    for (const raw of ["{", "null", "[]", "{}", '{"completedAt":""}']) {
      store.set(SETUP_KEY, raw);
      expect(loadSetup()).toBeNull();
    }
  });

  it("reads a record that says nothing as a record all the same", () => {
    store.set(
      SETUP_KEY,
      JSON.stringify({ completedAt: "2026-08-31T00:00:00Z" }),
    );
    const record = loadSetup();
    // Somebody has been here; the ceremony must not run again at them.
    expect(record).not.toBeNull();
    expect(record?.ways).toEqual([]);
    expect(record?.service).toBe(false);
  });

  it("reads a record from an earlier ceremony without its dead fields", () => {
    // Records written before ADR 0078 carry `identity`, `provider`, `host` and
    // `machine`. None of those is asked any more; the old record still
    // identifies an operator who has been here, which is all it was ever read
    // for.
    store.set(
      SETUP_KEY,
      JSON.stringify({
        completedAt: "2026-08-31T00:00:00Z",
        identity: "byo",
        provider: "workos",
        host: true,
        machine: true,
      }),
    );
    const record = loadSetup();
    expect(record).not.toBeNull();
    expect(record).not.toHaveProperty("identity");
    expect(record).not.toHaveProperty("host");
  });

  it("drops list entries that are not provider ids", () => {
    store.set(
      SETUP_KEY,
      JSON.stringify({
        completedAt: "2026-08-31T00:00:00Z",
        ways: ["google", "", 7, null, "okta"],
      }),
    );
    expect(loadSetup()?.ways).toEqual(["google", "okta"]);
  });
});

describe("setupRequired", () => {
  const fresh = { vaultStatus: "empty", hasSession: false } as const;

  it("is true for a device nobody has been to", () => {
    expect(setupRequired(fresh)).toBe(true);
  });

  it("is false once the ceremony has been answered", async () => {
    await completeSetup({ ways: [], service: false });
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
