import { isGuideRouteId } from "@opensesame/guide-lang";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerTutorialRealm } from "./optional-tutorials.test-support.js";
import {
  CORE_GUIDE_ROUTES,
  GUIDE_OVERLAY_ROUTES,
  guideRouteForPath,
  isKnownGuideRoute,
  mergedGuideRoutes,
  scopeApplies,
} from "./routes.js";

// A route belongs to the capability that owns the screen. The realm is the
// whole authored set; the core-only default is asserted on its own below.
describe("guide route registry", () => {
  let revokeRealm = () => {};
  beforeEach(() => {
    revokeRealm = registerTutorialRealm();
  });
  afterEach(() => revokeRealm());

  it("declares only ids the guide grammar accepts (checked here, not at load)", () => {
    for (const route of mergedGuideRoutes()) {
      expect(isGuideRouteId(route.id), route.id).toBe(true);
    }
  });

  it("declares each route once", () => {
    const ids = mergedGuideRoutes().map((route) => route.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(isKnownGuideRoute(id)).toBe(true);
  });

  it("maps a deep path to its longest declared prefix", () => {
    expect(guideRouteForPath("/vault/abc/edit")).toBe("/vault");
    expect(guideRouteForPath("/identity/authorize")).toBe(
      "/identity/authorize",
    );
    expect(isKnownGuideRoute("/nowhere")).toBe(false);
  });
});

describe("a core-only plan", () => {
  it("declares the shell's own routes and nothing a capability owns", () => {
    expect(mergedGuideRoutes()).toEqual(CORE_GUIDE_ROUTES);
    expect(isKnownGuideRoute("/connections")).toBe(false);
    expect(isKnownGuideRoute("/identity/authorize")).toBe(false);
    expect(isKnownGuideRoute("/vault")).toBe(true);
    expect(isKnownGuideRoute("/settings/security")).toBe(true);
  });
});

describe("the gates are routes (ADR 0165)", () => {
  it("declares every gate it names, so page context never falls back to the vault", () => {
    for (const gate of [
      "/unlock/door",
      "/unlock/form",
      "/unlock/passkey",
      "/unlock/signin",
      "/setup/choose",
      "/setup/capabilities",
      "/setup/identity",
      "/setup/connectors",
    ]) {
      expect(isKnownGuideRoute(gate), gate).toBe(true);
      expect(GUIDE_OVERLAY_ROUTES.has(gate), gate).toBe(true);
    }
  });

  it("keeps the authored routes inside the budget a model is told, with room to spare", () => {
    expect(mergedGuideRoutes().length).toBeLessThanOrEqual(30);
  });
});

describe("what applies where", () => {
  it("applies a named scope to its own screen and to every screen within it", () => {
    expect(scopeApplies(["/unlock"], "/unlock/door")).toBe(true);
    expect(scopeApplies(["/unlock/door"], "/unlock/door")).toBe(true);
    expect(scopeApplies(["/unlock/door"], "/unlock/form")).toBe(false);
    expect(scopeApplies(["/setup/identity"], "/setup")).toBe(false);
  });

  it("applies no scope to the shell, and to no gate", () => {
    expect(scopeApplies([], "/vault")).toBe(true);
    expect(scopeApplies([], "/settings/security")).toBe(true);
    for (const gate of GUIDE_OVERLAY_ROUTES) {
      expect(scopeApplies([], gate), gate).toBe(false);
    }
  });
});
