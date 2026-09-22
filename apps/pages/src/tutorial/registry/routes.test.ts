import { isGuideRouteId } from "@opensesame/guide-lang";
import { describe, expect, it } from "vitest";
import { GUIDE_ROUTES, guideRouteForPath, isKnownGuideRoute } from "./routes.js";

describe("guide route registry", () => {
  it("declares only ids the guide grammar accepts (checked here, not at load)", () => {
    for (const route of GUIDE_ROUTES) {
      expect(isGuideRouteId(route.id), route.id).toBe(true);
    }
  });

  it("declares each route once", () => {
    const ids = GUIDE_ROUTES.map((route) => route.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(isKnownGuideRoute(id)).toBe(true);
  });

  it("maps a deep path to its longest declared prefix", () => {
    expect(guideRouteForPath("/vault/abc/edit")).toBe("/vault");
    expect(guideRouteForPath("/identity/authorize")).toBe("/identity/authorize");
    expect(isKnownGuideRoute("/nowhere")).toBe(false);
  });
});
