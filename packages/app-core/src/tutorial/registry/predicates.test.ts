/** @vitest-environment jsdom */

import { isBoolean } from "@opensesame/os-domain";
import { createItem } from "@opensesame/vault-core";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { accountSeams } from "../../lib/account.js";
import { deviceIdentitySeams } from "../../lib/device-identity.js";
import { vaultStore } from "../../lib/vault/store.js";
import { unlockMethodsSeams } from "../../lib/vault/unlock-methods.js";
import { registerTutorialRealm } from "./optional-tutorials.test-support.js";
import {
  GUIDE_PREDICATES,
  noteGuideConnectionsPresent,
  provideGuideDeviceForm,
  provideGuideInstallOffer,
  provideGuidePluginPanel,
  provideGuideSupportModelPicks,
  registerGuidePredicates,
} from "./predicates.js";
import {
  guidePredicateIds,
  isKnownGuidePredicate,
  readGuidePredicate,
  resetGuidePredicatesForTest,
} from "./state.js";

// Connections, Identity and their routes are contributions; these facts
// only exist on a deployment whose plan approved those capabilities.
let revokeRealm = () => {};
beforeAll(() => {
  revokeRealm = registerTutorialRealm();
});
afterAll(() => revokeRealm());

function goTo(path: string): void {
  window.history.pushState({}, "", path);
}

beforeEach(() => {
  resetGuidePredicatesForTest();
  registerGuidePredicates();
  noteGuideConnectionsPresent(false);
  goTo("/vault");
});

describe("registering the predicate set", () => {
  it("declares each id once and only once", () => {
    const ids = guidePredicateIds();
    expect(ids.length).toBe(GUIDE_PREDICATES.length);
    expect(new Set(ids).size).toBe(ids.length);
    for (const descriptor of GUIDE_PREDICATES) {
      expect(isKnownGuidePredicate(descriptor.id)).toBe(true);
    }
  });

  it("is safe to call again, so a reload does not take the page down", () => {
    registerGuidePredicates();
    expect(guidePredicateIds().length).toBe(GUIDE_PREDICATES.length);
  });

  it("covers the arrival and availability facts a guide is allowed to wait on", () => {
    const ids = new Set(guidePredicateIds());
    for (const required of [
      "vault.unlocked",
      "vault.empty",
      "route.vault",
      "route.connections",
      "route.access",
      "route.identity",
      "route.settings",
      "host.connected",
      "identity.connected",
      "connections.any",
    ]) {
      expect(ids.has(required)).toBe(true);
    }
  });
});

describe("reading a predicate", () => {
  /**
   * A wait loop calls these with no idea what the app is doing. A locked vault
   * is the state most likely to be under one, so every predicate has to answer
   * a plain boolean there rather than throw the guide away with it.
   */
  it("answers a boolean for every predicate while the vault is locked", () => {
    vaultStore.lock();
    for (const descriptor of GUIDE_PREDICATES) {
      const value = readGuidePredicate(descriptor.id);
      expect(isBoolean(value)).toBe(true);
    }
    expect(readGuidePredicate("vault.unlocked")).toBe(false);
    expect(readGuidePredicate("vault.empty")).toBe(true);
  });

  it("reports where the person is, from the route registry rather than the raw path", () => {
    goTo("/connections/github/con_123");
    expect(readGuidePredicate("route.connections")).toBe(true);
    expect(readGuidePredicate("route.vault")).toBe(false);

    goTo("/vault/health");
    expect(readGuidePredicate("route.vault")).toBe(true);
    expect(readGuidePredicate("route.vault.health")).toBe(true);

    goTo("/settings/security");
    expect(readGuidePredicate("route.settings")).toBe(true);
    expect(readGuidePredicate("route.settings.security")).toBe(true);
    expect(readGuidePredicate("route.identity")).toBe(false);
  });

  it("reports only a count for connections, never anything named", () => {
    expect(readGuidePredicate("connections.any")).toBe(false);
    noteGuideConnectionsPresent(true);
    expect(readGuidePredicate("connections.any")).toBe(true);
    noteGuideConnectionsPresent(false);
    expect(readGuidePredicate("connections.any")).toBe(false);
  });

  it("says whether an account is signed in, and nothing about who", () => {
    const real = accountSeams.describeAccount;
    try {
      accountSeams.describeAccount = () => null;
      expect(readGuidePredicate("account.signed-in")).toBe(false);
      accountSeams.describeAccount = () => ({
        name: "Ada",
        detail: "Google",
        providerId: "google",
        guest: false,
      });
      expect(readGuidePredicate("account.signed-in")).toBe(true);
    } finally {
      accountSeams.describeAccount = real;
    }
  });

  it("says whether a sign-in service is set", () => {
    const real = deviceIdentitySeams.remoteIdentityApi;
    try {
      deviceIdentitySeams.remoteIdentityApi = () => "";
      expect(readGuidePredicate("signin-service.configured")).toBe(false);
      deviceIdentitySeams.remoteIdentityApi = () => "https://id.example.test";
      expect(readGuidePredicate("signin-service.configured")).toBe(true);
    } finally {
      deviceIdentitySeams.remoteIdentityApi = real;
    }
  });

  it("says whether the vault has a key enrolled", () => {
    const real = unlockMethodsSeams.listAvailableUnlockMethods;
    try {
      unlockMethodsSeams.listAvailableUnlockMethods = () => [];
      expect(readGuidePredicate("vault.key-enrolled")).toBe(false);
      unlockMethodsSeams.listAvailableUnlockMethods = () => ["password"];
      expect(readGuidePredicate("vault.key-enrolled")).toBe(true);
    } finally {
      unlockMethodsSeams.listAvailableUnlockMethods = real;
    }
  });

  it("reads the install offer from the reader the shell provides", () => {
    expect(readGuidePredicate("install.offered")).toBe(false);
    provideGuideInstallOffer(() => true);
    try {
      expect(readGuidePredicate("install.offered")).toBe(true);
    } finally {
      provideGuideInstallOffer(() => false);
    }
  });

  it("reads how the shell is drawn from the reader the shell provides", () => {
    const read = (id: string) => readGuidePredicate(id);
    try {
      provideGuideDeviceForm(() => ({ narrow: false, keys: true }));
      expect([read("shell.wide"), read("shell.narrow")]).toEqual([true, false]);
      expect(read("shell.keys")).toBe(true);
      provideGuideDeviceForm(() => ({ narrow: true, keys: false }));
      expect([read("shell.wide"), read("shell.narrow")]).toEqual([false, true]);
      expect(read("shell.keys")).toBe(false);
    } finally {
      provideGuideDeviceForm(() => ({ narrow: false, keys: true }));
    }
  });

  it("says the model picks are drawn only while the shell says the on-device model is approved", () => {
    expect(readGuidePredicate("support.model-picks")).toBe(false);
    provideGuideSupportModelPicks(() => true);
    try {
      expect(readGuidePredicate("support.model-picks")).toBe(true);
    } finally {
      provideGuideSupportModelPicks(() => false);
    }
  });

  it("says a plugin panel is drawn only while its capability answers so", () => {
    const id = "plugin.browser-autofill.panel";
    expect(readGuidePredicate(id)).toBe(false);
    const forget = provideGuidePluginPanel("browser-autofill", () => true);
    expect(readGuidePredicate(id)).toBe(true);
    expect(readGuidePredicate("plugin.surrogate-proxy.panel")).toBe(false);
    forget();
    expect(readGuidePredicate(id)).toBe(false);
  });

  it("says whether this vault has made recovery codes", () => {
    expect(readGuidePredicate("vault.recovery-made")).toBe(false);
  });

  it("says whether the vault holds items and trash, and nothing about which", () => {
    vaultStore.lock();
    expect(readGuidePredicate("vault.has-items")).toBe(false);
    expect(readGuidePredicate("vault.has-trash")).toBe(false);
    const snapshot = vaultStore.getSnapshot();
    const held = (deletedAt: string | null) =>
      vi.spyOn(vaultStore, "getSnapshot").mockReturnValue({
        ...snapshot,
        items: [{ ...createItem("secret", "one"), deletedAt }],
      });
    const spy = held(null);
    expect(readGuidePredicate("vault.has-items")).toBe(true);
    expect(readGuidePredicate("vault.has-trash")).toBe(false);
    spy.mockRestore();
    const trashed = held("2026-10-05T00:00:00.000Z");
    expect(readGuidePredicate("vault.has-items")).toBe(false);
    expect(readGuidePredicate("vault.has-trash")).toBe(true);
    trashed.mockRestore();
  });

  it("refuses an id nothing declared", () => {
    expect(() => readGuidePredicate("vault.master-password")).toThrow(
      /guide_predicate_unknown/,
    );
  });
});
