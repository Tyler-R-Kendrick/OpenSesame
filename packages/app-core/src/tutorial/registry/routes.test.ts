import {
  GUIDE_LANG_HEADER,
  compileGuide,
  isGuideRouteId,
} from "@opensesame/guide-lang";
import { SUPPORT_LIMITS } from "@opensesame/support-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerTutorialRealm } from "./optional-tutorials.test-support.js";
import {
  CORE_GUIDE_ROUTES,
  GUIDE_OVERLAY_ROUTES,
  guideRouteForLocation,
  guideRouteForPath,
  guideRouteWithin,
  isKnownGuideRoute,
  mergedGuideRoutes,
  navigationGuideRoutes,
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
    for (const route of navigationGuideRoutes()) {
      expect(isGuideRouteId(route.id), route.id).toBe(true);
    }
  });

  it("declares each route once", () => {
    const ids = navigationGuideRoutes().map((route) => route.id);
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

  it("distinguishes the Tailnet record from the Devices summary", () => {
    expect(
      guideRouteForLocation("/identity", "?view=devices", "#tailnet-devices"),
    ).toBe("/identity/devices/tailnet");
    expect(
      guideRouteForLocation("/identity", "?view=devices", "#another-record"),
    ).toBe("/identity");
  });
});

describe("a core-only plan", () => {
  it("declares the shell's own routes and nothing a capability owns", () => {
    expect(mergedGuideRoutes()).toEqual(CORE_GUIDE_ROUTES);
    expect(isKnownGuideRoute("/connections")).toBe(false);
    expect(isKnownGuideRoute("/identity/authorize")).toBe(false);
    expect(isKnownGuideRoute("/identity/devices/tailnet")).toBe(false);
    expect(
      guideRouteForLocation("/identity", "?view=devices", "#tailnet-devices"),
    ).toBe("/vault");
    expect(isKnownGuideRoute("/vault")).toBe(true);
    expect(isKnownGuideRoute("/settings/security")).toBe(true);
  });

  it("derives real feature pages without adding them to the model's route list", () => {
    for (const route of [
      "/settings/features/ai/support.local-ai",
      "/settings/features/autofill",
      "/settings/features/surrogates",
    ]) {
      expect(isKnownGuideRoute(route), route).toBe(true);
      expect(guideRouteForPath(route)).toBe(route);
      expect(guideRouteForLocation(route)).toBe(route);
      expect(navigationGuideRoutes().some((entry) => entry.id === route)).toBe(
        true,
      );
      expect(mergedGuideRoutes().some((entry) => entry.id === route)).toBe(
        route === "/settings/features/ai/support.local-ai",
      );
    }
    for (const unknown of [
      "/settings/features/not-a-feature",
      "/settings/features/ai/not-a-capability",
      "/settings/features/ai/support.local-ai/details",
      "/settings/features/ai/support.local-ai-other",
    ]) {
      expect(isKnownGuideRoute(unknown), unknown).toBe(false);
    }
  });

  it("compiles navigation and a wait against the core AI settings descriptor", () => {
    const route = "/settings/features/ai/support.local-ai";
    const result = compileGuide(
      [
        GUIDE_LANG_HEADER,
        'goal "settings.ai"',
        `navigate "${route}"`,
        `wait route "${route}" timeout=1000`,
      ].join("\n"),
      {
        goals: ["settings.ai"],
        targets: [],
        routes: mergedGuideRoutes().map((entry) => entry.id),
        predicates: [],
      },
    );
    expect(result).toEqual({
      ok: true,
      program: {
        version: 1,
        goal: "settings.ai",
        instructions: [
          { kind: "navigate", route },
          { kind: "wait", subject: "route", route, timeoutMs: 1000 },
        ],
      },
    });
  });
});

describe("where the person stands, to the precision a tour needs", () => {
  it("tells the list, an item's pane and the trash apart", () => {
    expect(guideRouteForLocation("/vault")).toBe("/vault");
    expect(guideRouteForLocation("/vault", "?f=favorites")).toBe("/vault");
    expect(guideRouteForLocation("/vault", "?f=trash")).toBe("/vault/trash");
    expect(guideRouteForLocation("/vault/itm_1")).toBe("/vault/item");
    expect(guideRouteForLocation("/vault/itm_1/")).toBe("/vault/item");
    expect(guideRouteForLocation("/vault/itm_1", "?f=trash")).toBe(
      "/vault/item",
    );
  });

  it("keeps the screens that are not an item's pane where they were", () => {
    expect(guideRouteForLocation("/vault/health")).toBe("/vault/health");
    expect(guideRouteForLocation("/vault/new/login")).toBe("/vault");
    expect(guideRouteForLocation("/vault/new")).toBe("/vault");
    expect(guideRouteForLocation("/vault/itm_1/edit")).toBe("/vault");
    expect(guideRouteForLocation("/settings/security")).toBe(
      "/settings/security",
    );
  });

  it("names both places as routes a tour may go to, inside the vault", () => {
    for (const route of ["/vault/item", "/vault/trash"]) {
      expect(isKnownGuideRoute(route)).toBe(true);
      expect(guideRouteWithin(route, "/vault")).toBe(true);
    }
  });
});

describe("the gates are routes (ADR 0166)", () => {
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
    expect(mergedGuideRoutes().length).toBeLessThanOrEqual(
      SUPPORT_LIMITS.maxRoutes - 4,
    );
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
