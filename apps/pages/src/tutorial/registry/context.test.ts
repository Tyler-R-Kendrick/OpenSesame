/** @vitest-environment jsdom */
import { SUPPORT_LIMITS } from "@opensesame/support-agent";
import { afterEach, describe, expect, it } from "vitest";
import { buildSupportPageContext } from "./context.js";
import { GUIDE_PREDICATES } from "./predicates.js";
import { GUIDE_ROUTES, guideRouteWithin } from "./routes.js";
import { declareGuidePredicate, resetGuidePredicatesForTest } from "./state.js";

const BASE = {
  pageId: "pages",
  hostReachable: true,
  identityReachable: true,
} as const;

describe("the route a model is told it is on", () => {
  it("passes a registered route through unchanged", () => {
    for (const route of GUIDE_ROUTES) {
      const context = buildSupportPageContext({ ...BASE, route: route.id });
      expect(context.route).toBe(route.id);
    }
  });

  /**
   * The adversarial sweep found this reachable only by convention: the route
   * was caller-supplied and length-bounded, but never checked for membership.
   * A route the registry does not know must not reach a model as though the
   * app were standing on it — the model would scope its whole answer to a
   * place that does not exist.
   */
  it("refuses a route the registry does not declare", () => {
    const hostile = [
      "/admin/secrets",
      "/vault/../admin",
      "/not-a-route",
      "",
      "vault",
    ];
    for (const route of hostile) {
      const context = buildSupportPageContext({ ...BASE, route });
      expect(context.route, `${route} survived`).toBe("/vault");
    }
  });

  it("scopes targets and goals to the corrected route, not the supplied one", () => {
    const corrected = buildSupportPageContext({
      ...BASE,
      route: "/admin/secrets",
    });
    const vault = buildSupportPageContext({ ...BASE, route: "/vault" });
    expect(corrected.targets.map((target) => target.id)).toEqual(
      vault.targets.map((target) => target.id),
    );
    expect(corrected.goals.map((goal) => goal.id)).toEqual(
      vault.goals.map((goal) => goal.id),
    );
  });
});

describe("a route scope", () => {
  /**
   * `/vault/health` really is inside `/vault`, and a target scoped to the
   * section belongs on both. That is what the prefix is for.
   */
  it("contains a nested route", () => {
    expect(guideRouteWithin("/vault/health", "/vault")).toBe(true);
    expect(guideRouteWithin("/vault", "/vault")).toBe(true);
  });

  /**
   * A bare `startsWith` would make `/access` a prefix of `/access-review` and
   * scope every `/access` target, goal and help topic onto an unrelated
   * screen — telling a model that controls are on the page that are not.
   * Nothing collides among today's declared routes, so only this test would
   * notice the day a hyphenated sibling is added.
   */
  it("stops at a segment boundary", () => {
    expect(guideRouteWithin("/access-review", "/access")).toBe(false);
    expect(guideRouteWithin("/vaults", "/vault")).toBe(false);
    expect(guideRouteWithin("/settings-advanced", "/settings")).toBe(false);
  });
});

describe("an authored list that outgrows its model budget", () => {
  afterEach(() => {
    resetGuidePredicatesForTest();
    for (const predicate of GUIDE_PREDICATES) declareGuidePredicate(predicate);
  });

  /**
   * Every list in the page context is authored in this repository, so
   * outgrowing a budget is our mistake — and a silent `slice` hides it
   * perfectly: the model simply stops being told about whatever fell off the
   * end, with nothing red and nothing logged. The ADR 0065 capability list is
   * the one already close to its ceiling, and it grows on somebody else's
   * merge rather than on ours, so the failure has to be the loud kind.
   *
   * State facts are the list a test can actually grow, and they share the one
   * guard, so this pins the behaviour for all five.
   */
  it("stops a developer rather than quietly shrinking the context", () => {
    resetGuidePredicatesForTest();
    for (let index = 0; index <= SUPPORT_LIMITS.maxStateFacts; index += 1) {
      declareGuidePredicate({
        id: `test.fact-${index}`,
        description: "A fact declared to overrun the budget.",
        read: () => true,
      });
    }
    expect(() =>
      buildSupportPageContext({ ...BASE, route: "/vault" }),
    ).toThrowError(/support_context_budget_exceeded:state/);
  });

  it("stays within budget with the registry as authored", () => {
    expect(() =>
      buildSupportPageContext({ ...BASE, route: "/vault" }),
    ).not.toThrow();
  });
});
