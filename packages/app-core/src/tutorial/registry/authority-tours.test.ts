/** @vitest-environment jsdom */

import { AUTHORED_GUIDE_LIMITS, compileGuide } from "@opensesame/guide-lang";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { tutorialLibrary } from "./areas.js";
import { describeGuideGoals, guideGoal, guideGoalIds } from "./goals.js";
import { registerTutorialRealm } from "./optional-tutorials.test-support.js";
import { registerGuidePredicates } from "./predicates.js";
import { mergedGuideRoutes } from "./routes.js";
import { guidePredicateIds } from "./state.js";
import { guideTargetIds } from "./targets.js";

/**
 * The Access, Connections and Identity tours that teach a control by name
 * (ADR 0163 §6): every one points, none acts, and a tour whose controls are
 * drawn only in one state is offered only in that state.
 */
let revokeRealm = () => {};
beforeAll(() => {
  registerGuidePredicates();
  revokeRealm = registerTutorialRealm();
});
afterAll(() => revokeRealm());

const TOURS = {
  "access.review": ["access.grants", "access.resources", "access.policies"],
  "access.requests.hosted": ["access.relay"],
  "connection.review": [
    "connections.reload",
    "connections.provider-picker",
    "connections.catalog",
    "connections.back",
  ],
  "connection.revoke": [
    "connections.connected",
    "connections.revoke",
    "connections.back",
    "connections.attention",
  ],
  "identity.applications.manage": ["identity.service-accounts"],
  "identity.organizations.review": ["identity.organization"],
} as const;

describe("the Access, Connections and Identity tours", () => {
  it("compile under the tour budget and teach the controls they name", () => {
    const vocabulary = {
      goals: guideGoalIds(),
      targets: guideTargetIds(),
      routes: mergedGuideRoutes().map((route) => route.id),
      predicates: guidePredicateIds(),
    };
    for (const [id, controls] of Object.entries(TOURS)) {
      const goal = guideGoal(id);
      expect(goal, id).not.toBeNull();
      const compiled = compileGuide(
        goal?.guide ?? "",
        vocabulary,
        AUTHORED_GUIDE_LIMITS,
      );
      expect(compiled.ok, id).toBe(true);
      for (const control of controls) {
        expect(goal?.guide, `${id} -> ${control}`).toMatch(
          new RegExp(`(?:focus|wait target) "${control}"`),
        );
      }
    }
  });

  it("only point: no step clicks, submits or sets anything", () => {
    for (const id of Object.keys(TOURS)) {
      expect(guideGoal(id)?.guide, id).not.toMatch(
        /^(click|type|submit|fetch|call)\b/m,
      );
    }
  });

  it("opens Identity shares before pointing at its add key", () => {
    const guide = guideGoal("access.grant")?.guide ?? "";
    expect(guide).toContain('navigate "/access/shares"');
    expect(guide.indexOf('wait route "/access/shares"')).toBeLessThan(
      guide.indexOf('focus "access.grant-access"'),
    );
    expect(
      mergedGuideRoutes().some((route) => route.id === "/access/shares"),
    ).toBe(true);
  });

  it("keeps the Access navigation tree visible while teaching its branches", () => {
    const guide = guideGoal("access.review")?.guide ?? "";
    expect(guide).not.toContain('navigate "/access/resources"');
    expect(guide).not.toContain('navigate "/access/policies"');
    expect(guide).toContain('navigate "/access"');
  });

  it("stay out of the model's goal list, which has a budget", () => {
    const offered = describeGuideGoals("/access").map((goal) => goal.id);
    for (const id of Object.keys(TOURS)) {
      expect(guideGoal(id)?.libraryOnly, id).toBe(true);
      expect(offered).not.toContain(id);
    }
  });

  it("offer the revoke tour only while a connection is on the page", () => {
    const ids = (holds: (predicate: string) => boolean) =>
      tutorialLibrary("/connections", { holds }).flatMap((group) =>
        group.tutorials.map((entry) => entry.goal.id),
      );
    expect(ids((p) => p !== "connections.any")).not.toContain(
      "connection.revoke",
    );
    expect(ids(() => true)).toContain("connection.revoke");
  });

  it("offer the hosted requests tour only where an Identity API address is set", () => {
    const ids = (holds: (predicate: string) => boolean) =>
      tutorialLibrary("/access", { holds }).flatMap((group) =>
        group.tutorials.map((entry) => entry.goal.id),
      );
    expect(ids((p) => p !== "signin-service.configured")).not.toContain(
      "access.requests.hosted",
    );
    expect(ids(() => true)).toContain("access.requests.hosted");
  });
});
