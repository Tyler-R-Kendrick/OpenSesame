/** @vitest-environment jsdom */
import { CAPABILITIES } from "@opensesame/capability-registry";
import { compileGuide } from "@opensesame/guide-lang";
import { beforeAll, describe, expect, it } from "vitest";
import { capabilitiesForContext } from "./capability-context.js";
import {
  CONTROLLED_SECURITY_GOALS,
  CONTROLLED_SECURITY_HELP,
} from "./controlled-security-goals.js";
import { CAPABILITY_TUTORIALS, guideGoalIds } from "./goals.js";
import { registerGuidePredicates } from "./predicates.js";
import { mergedGuideRoutes } from "./routes.js";
import { guidePredicateIds } from "./state.js";
import { guideTargetIds } from "./targets.js";
beforeAll(() => registerGuidePredicates());
describe("controlled security owner tutorials", () => {
  it("maps both production capability summaries to authored goals", () => {
    expect(CAPABILITY_TUTORIALS["vaults.controlled_canaries"]).toBe(
      "vaults.controlled-canaries",
    );
    expect(CAPABILITY_TUTORIALS["vaults.observation_receiver"]).toBe(
      "vaults.observation-receiver",
    );
    for (const goal of CONTROLLED_SECURITY_GOALS) {
      expect(guideGoalIds()).toContain(goal.id);
      const result = compileGuide(goal.guide, {
        goals: guideGoalIds(),
        targets: guideTargetIds(),
        routes: mergedGuideRoutes().map((r) => r.id),
        predicates: guidePredicateIds(),
      });
      expect(result.ok).toBe(true);
      expect(goal.guide).not.toMatch(/^(click|type|submit|fetch|call)\b/m);
      expect(goal.requires).toContain("vault.unlocked");
    }
    expect(CONTROLLED_SECURITY_HELP.map((t) => t.goal)).toEqual(
      CONTROLLED_SECURITY_GOALS.map((g) => g.id),
    );
  });
  it("offers capability context only on Security", () => {
    const ids = (route: string) =>
      capabilitiesForContext(CAPABILITIES, route, []).map((c) => c.id);
    for (const id of [
      "vaults.controlled_canaries",
      "vaults.observation_receiver",
    ]) {
      expect(ids("/settings/security")).toContain(id);
      expect(ids("/vault")).not.toContain(id);
    }
  });
});
