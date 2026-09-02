/** @vitest-environment jsdom */
import { SUPPORT_LIMITS } from "@opensesame/support-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  noteWebMcpFailure,
  noteWebMcpRegistered,
  resetWebMcpRegistrationForTests,
} from "../../webmcp/registration.js";
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

describe("the written help a model is shown", () => {
  it("is retrieved for the question, best match first, with its prose", () => {
    const context = buildSupportPageContext({
      ...BASE,
      route: "/identity",
      question: "how do I add a user?",
    });
    expect(context.help[0]?.id).toBe("help.identity.account.add");
    expect(context.help[0]?.answer).toContain("Register an IdP");
    expect(context.help[0]?.goal).toBe("identity.account.add");
    expect(context.help.length).toBeLessThanOrEqual(
      SUPPORT_LIMITS.maxHelpEntries,
    );
  });

  it("is empty without a question, and says nothing about a blank one", () => {
    expect(buildSupportPageContext({ ...BASE, route: "/vault" }).help).toEqual(
      [],
    );
    expect(
      buildSupportPageContext({ ...BASE, route: "/vault", question: "  " })
        .help,
    ).toEqual([]);
  });
});

describe("the tools a model is told this page implements", () => {
  afterEach(resetWebMcpRegistrationForTests);

  it("come from the registration store, with whether the browser exposes them", () => {
    expect(buildSupportPageContext({ ...BASE, route: "/vault" }).tools).toEqual(
      [],
    );
    noteWebMcpRegistered("document", "boot", [
      {
        name: "opensesame_status",
        description: "Vault status.",
        scope: "boot",
      },
      {
        name: "opensesame_health",
        description: "Plane health.",
        scope: "boot",
      },
    ]);
    noteWebMcpFailure({ name: "opensesame_health", reason: "refused" });
    expect(buildSupportPageContext({ ...BASE, route: "/vault" }).tools).toEqual(
      [
        {
          name: "opensesame_status",
          description: "Vault status.",
          exposed: true,
        },
        {
          name: "opensesame_health",
          description: "Plane health.",
          exposed: false,
        },
      ],
    );
  });

  it("report a browser without a model context as implemented but unexposed", () => {
    noteWebMcpRegistered(null, "boot", [
      {
        name: "opensesame_status",
        description: "Vault status.",
        scope: "boot",
      },
    ]);
    expect(
      buildSupportPageContext({ ...BASE, route: "/vault" }).tools[0]?.exposed,
    ).toBe(false);
  });
});
