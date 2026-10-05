import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mergedGuideTargets } from "./catalog.js";
import { GATE_GOALS } from "./gate-goals.js";
import { HELP_TOPICS, guideGoal } from "./goals.js";
import { registerTutorialRealm } from "./optional-tutorials.test-support.js";
import { GUIDE_OVERLAY_ROUTES, scopeApplies } from "./routes.js";

/**
 * The tutorials of the gates (ADR 0165). The registry cannot see a screen, so
 * it holds each tour to the one thing it can: a tour is offered at a route,
 * and every control it points at is declared for that route.
 */
let revoke = () => {};
beforeAll(() => {
  revoke = registerTutorialRealm();
});
afterAll(() => revoke());

const POINTING = /^(?:focus|hint|annotate|wait target) "([^"]+)"/;

function pointedAt(guide: string): string[] {
  return guide
    .split("\n")
    .flatMap((line) => POINTING.exec(line.trim())?.[1] ?? []);
}

describe("the gate tutorials", () => {
  it("are scoped to gates, and to nothing else", () => {
    for (const goal of GATE_GOALS) {
      expect(goal.routes.length, `${goal.id} has no scope`).toBeGreaterThan(0);
      for (const route of goal.routes) {
        expect(GUIDE_OVERLAY_ROUTES.has(route), `${goal.id}: ${route}`).toBe(
          true,
        );
      }
    }
  });

  it("are live in the registry under the ids they declare", () => {
    for (const goal of GATE_GOALS) {
      expect(guideGoal(goal.id), goal.id).not.toBeNull();
    }
  });

  it("never navigate: a gate has no section to move to", () => {
    for (const goal of GATE_GOALS) {
      expect(goal.guide, goal.id).not.toMatch(/^navigate /m);
    }
  });

  it("point only at controls declared for the screen they are offered on", () => {
    const targets = new Map(
      mergedGuideTargets().map((target) => [target.id, target]),
    );
    for (const goal of GATE_GOALS) {
      const pointed = pointedAt(goal.guide);
      for (const id of pointed) {
        const target = targets.get(id);
        expect(
          target,
          `${goal.id} points at ${id}, which is not declared`,
        ).toBeDefined();
        for (const route of goal.routes) {
          expect(
            target ? scopeApplies(target.routes, route) : false,
            `${goal.id} is offered at ${route}, where ${id} is not declared`,
          ).toBe(true);
        }
      }
    }
  });

  it("say something at every step that points at nothing", () => {
    for (const goal of GATE_GOALS) {
      expect(goal.guide, goal.id).toMatch(/^say "/m);
    }
  });
});

describe("the written help for a gate", () => {
  it("names a tutorial only where one is written for a gate it applies to", () => {
    for (const topic of HELP_TOPICS) {
      if (topic.goal === null) continue;
      const goal = guideGoal(topic.goal);
      if (!goal) continue;
      const names = goal.routes.some((route) =>
        GUIDE_OVERLAY_ROUTES.has(route),
      );
      if (!names) continue;
      expect(
        topic.routes.some((scope) =>
          goal.routes.some(
            (route) => route === scope || route.startsWith(`${scope}/`),
          ),
        ),
        `${topic.id} names ${goal.id}, written for another screen`,
      ).toBe(true);
    }
  });
});
