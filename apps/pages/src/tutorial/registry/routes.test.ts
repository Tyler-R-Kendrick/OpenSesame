import { isGuideRouteId } from "@opensesame/guide-lang";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerTutorialRealm } from "./optional-tutorials.test-support.js";
import {
  CORE_GUIDE_ROUTES,
  guideRouteForPath,
  isKnownGuideRoute,
  mergedGuideRoutes,
} from "./routes.js";

// A route belongs to the capability that owns the screen. The realm is the
// whole authored set; the core-only default is asserted on its own below.
let revokeRealm = () => {};
beforeAll(() => {
  revokeRealm = registerTutorialRealm();
});
afterAll(() => revokeRealm());

describe("guide route registry", () => {
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
    expect(guideRouteForPath("/identity/authorize")).toBe("/identity/authorize");
    expect(isKnownGuideRoute("/nowhere")).toBe(false);
  });
});

describe("a core-only plan", () => {
  it("declares the shell's own routes and nothing a capability owns", () => {
    const revoke = registerTutorialRealm();
    revoke();
    expect(mergedGuideRoutes()).toEqual(CORE_GUIDE_ROUTES);
    expect(isKnownGuideRoute("/connections")).toBe(false);
    expect(isKnownGuideRoute("/identity/authorize")).toBe(false);
    expect(isKnownGuideRoute("/vault")).toBe(true);
    expect(isKnownGuideRoute("/settings/security")).toBe(true);
  });
});
