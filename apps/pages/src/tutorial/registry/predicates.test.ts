/** @vitest-environment jsdom */

import { isBoolean } from "@opensesame/os-domain";
import { beforeEach, describe, expect, it } from "vitest";

import { vaultStore } from "../../lib/vault/store.js";
import {
  GUIDE_PREDICATES,
  noteGuideConnectionsPresent,
  registerGuidePredicates,
} from "./predicates.js";
import {
  guidePredicateIds,
  isKnownGuidePredicate,
  readGuidePredicate,
  resetGuidePredicatesForTest,
} from "./state.js";

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

  it("refuses an id nothing declared", () => {
    expect(() => readGuidePredicate("vault.master-password")).toThrow(
      /guide_predicate_unknown/,
    );
  });
});
