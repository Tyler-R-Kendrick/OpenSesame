/** @vitest-environment jsdom */

import { CAPABILITIES } from "@opensesame/capability-registry";
import { compileGuide } from "@opensesame/guide-lang";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { capabilitiesForContext } from "./capability-context.js";
import { DURESS_GOALS, DURESS_HELP } from "./duress-goals.js";
import { CAPABILITY_TUTORIALS, guideGoal, guideGoalIds } from "./goals.js";
import { registerTutorialRealm } from "./optional-tutorials.test-support.js";
import { registerGuidePredicates } from "./predicates.js";
import { mergedGuideRoutes } from "./routes.js";
import { guidePredicateIds } from "./state.js";
import { guideTargetIds } from "./targets.js";

let revokeRealm = () => {};
beforeAll(() => {
  registerGuidePredicates();
  revokeRealm = registerTutorialRealm();
});
afterAll(() => revokeRealm());

const POINTERS = ["vaults.duress_code", "vaults.travel"] as const;

describe("the duress code and travel mode walkthroughs", () => {
  it("map each capability to its own guide, not the vault switcher", () => {
    expect(CAPABILITY_TUTORIALS["vaults.duress_code"]).toBe(
      "vaults.duress-code",
    );
    expect(CAPABILITY_TUTORIALS["vaults.travel"]).toBe("vaults.travel");
    for (const id of POINTERS) {
      expect(CAPABILITY_TUTORIALS[id]).not.toBe("vaults.switch");
      expect(guideGoal(CAPABILITY_TUTORIALS[id])).not.toBeNull();
    }
  });

  it("compile through the same parser and validator model output meets", () => {
    const vocabulary = {
      goals: guideGoalIds(),
      targets: guideTargetIds(),
      routes: mergedGuideRoutes().map((route) => route.id),
      predicates: guidePredicateIds(),
    };
    for (const goal of DURESS_GOALS) {
      const compiled = compileGuide(goal.guide, vocabulary);
      if (!compiled.ok) {
        throw new Error(
          `${goal.id} failed at ${compiled.stage}: ${JSON.stringify(compiled.errors)}`,
        );
      }
      expect(compiled.program.goal).toBe(goal.id);
    }
  });

  it("only point: no step clicks, submits or sets anything", () => {
    for (const goal of DURESS_GOALS) {
      expect(goal.guide).not.toMatch(/^(click|type|submit|fetch|call)\b/m);
      expect(goal.guide).toContain('navigate "/settings/security"');
    }
  });

  it("answer from help topics that open those goals", () => {
    const goals = new Set(guideGoalIds());
    expect(DURESS_HELP.map((topic) => topic.goal).sort()).toEqual([
      "vaults.duress-code",
      "vaults.retired-credentials",
      "vaults.travel",
    ]);
    for (const topic of DURESS_HELP)
      expect(goals.has(topic.goal ?? "")).toBe(true);
  });

  it("scope both capabilities to Settings → Security", () => {
    const ids = (route: string) =>
      capabilitiesForContext(CAPABILITIES, route, []).map((item) => item.id);
    for (const id of POINTERS) {
      expect(ids("/settings/security")).toContain(id);
      expect(ids("/vault")).not.toContain(id);
    }
  });
});
