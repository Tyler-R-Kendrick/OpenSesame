/**
 * Every PWA-surfaced capability has an authored walkthrough the support
 * agent can emit. The fake agent here stands in for a model: asked about the
 * capability, it returns that guide, and the same compile path the live
 * session uses must accept it.
 */

import { CAPABILITIES } from "@opensesame/capability-registry";
import { compileGuide } from "@opensesame/guide-lang";
import {
  createSupportSession,
  fakeAgentAnswering,
} from "@opensesame/support-agent";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CAPABILITY_TUTORIALS,
  guideGoal,
  guideGoalIds,
} from "../registry/goals.js";
import { registerGuidePredicates } from "../registry/predicates.js";
import { GUIDE_ROUTES } from "../registry/routes.js";
import { guidePredicateIds } from "../registry/state.js";
import { guideTargetIds } from "../registry/targets.js";

beforeAll(() => {
  registerGuidePredicates();
});

function vocabulary() {
  return {
    goals: guideGoalIds(),
    targets: guideTargetIds(),
    routes: GUIDE_ROUTES.map((route) => route.id),
    predicates: guidePredicateIds(),
  };
}

describe("tutorial generation for every PWA capability", () => {
  const pwa = CAPABILITIES.filter(
    (capability) => capability.surfaces.pwa !== null,
  );

  it("covers the PWA surface", () => {
    expect(pwa.map((capability) => capability.id).sort()).toEqual(
      Object.keys(CAPABILITY_TUTORIALS).sort(),
    );
  });

  for (const capability of pwa) {
    it(`generates a compiling tutorial for ${capability.id}`, async () => {
      const goalId = CAPABILITY_TUTORIALS[capability.id];
      const goal = guideGoal(goalId ?? "");
      expect(goal, capability.id).not.toBeNull();
      if (!goal) return;

      const compiled = compileGuide(goal.guide, vocabulary());
      expect(compiled.ok, capability.id).toBe(true);

      const session = createSupportSession({
        port: fakeAgentAnswering(
          `Here is how to ${capability.title}.`,
          goal.guide,
        ),
        vocabulary: vocabulary(),
        readContext: () => ({
          version: 1,
          pageId: "pages",
          route: "/vault",
          targets: [],
          routes: [],
          state: [],
          capabilities: [
            {
              id: capability.id,
              title: capability.title,
              available: true,
            },
          ],
          goals: [{ id: goal.id, title: goal.title }],
        }),
      });

      await session.ask(`How do I ${capability.title}?`);
      const snapshot = session.snapshot();
      expect(snapshot.status, capability.id).toBe("idle");
      expect(snapshot.program, capability.id).not.toBeNull();
      expect(snapshot.program?.goal, capability.id).toBe(goal.id);
      expect(snapshot.guideError, capability.id).toBeNull();
    });
  }
});
