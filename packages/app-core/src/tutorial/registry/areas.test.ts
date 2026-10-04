import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FEATURES } from "../../lib/capabilities/features.js";
import {
  TUTORIAL_AREAS,
  tutorialLibrary,
  tutorialStartsFrom,
  tutorialStepCount,
} from "./areas.js";
import { FEATURE_TUTORIALS, guideGoal, mergedGuideGoals } from "./goals.js";
import { registerTutorialRealm } from "./optional-tutorials.test-support.js";

let revoke = () => {};
beforeAll(() => {
  revoke = registerTutorialRealm();
});
afterAll(() => revoke());

describe("the tutorial library", () => {
  it("gives every live tutorial exactly one home", () => {
    const homes = new Map<string, string[]>();
    for (const area of TUTORIAL_AREAS) {
      for (const goal of area.goals) {
        homes.set(goal, [...(homes.get(goal) ?? []), area.id]);
      }
    }
    for (const goal of mergedGuideGoals()) {
      expect(homes.get(goal.id), `${goal.id} has no area`).toHaveLength(1);
    }
  });

  it("names only tutorials that exist", () => {
    for (const area of TUTORIAL_AREAS) {
      for (const goal of area.goals) {
        expect(guideGoal(goal), `${area.id} lists ${goal}`).not.toBeNull();
      }
    }
  });

  it("lists nothing under More", () => {
    expect(tutorialLibrary("/vault").some((group) => group.id === "more")).toBe(
      false,
    );
  });

  it("opens a tutorial for every section of Settings › Capabilities", () => {
    for (const feature of FEATURES) {
      const goal = FEATURE_TUTORIALS[feature.id];
      expect(goal, `${feature.id} has no tutorial`).toBeDefined();
      expect(guideGoal(goal ?? ""), `${feature.id}: ${goal}`).not.toBeNull();
    }
  });

  it("walks every feature tutorial through the one page its sections are on", () => {
    for (const goal of Object.values(FEATURE_TUTORIALS)) {
      const descriptor = guideGoal(goal);
      if (!goal.startsWith("feature.")) continue;
      expect(descriptor?.guide).toContain('navigate "/settings/capabilities"');
      expect(descriptor?.guide).toContain(`focus "${goal}"`);
    }
  });
});

describe("where a tutorial can start", () => {
  it("offers a gate's tutorial only on that gate", () => {
    const unlock = guideGoal("unlock.open");
    expect(unlock).not.toBeNull();
    if (!unlock) return;
    expect(tutorialStartsFrom(unlock, "/unlock")).toBe(true);
    expect(tutorialStartsFrom(unlock, "/vault")).toBe(false);
    const ids = (route: string) =>
      tutorialLibrary(route).flatMap((group) =>
        group.tutorials.map((entry) => entry.goal.id),
      );
    expect(ids("/vault")).not.toContain("unlock.open");
    expect(ids("/unlock")).toContain("unlock.open");
  });

  it("offers a gate nothing but the tutorials written for it", () => {
    const ids = (route: string) =>
      tutorialLibrary(route).flatMap((group) =>
        group.tutorials.map((entry) => entry.goal.id),
      );
    // The unlock screen has no shell to navigate in: no shell tutorial starts there.
    expect(ids("/unlock")).not.toContain("vault.lock");
    expect(ids("/unlock")).toContain("unlock.open");
    expect(ids("/setup")).toContain("setup.operator");
    expect(ids("/setup")).not.toContain("unlock.open");
  });

  it("offers a tutorial that navigates from anywhere", () => {
    const health = guideGoal("vault.health.review");
    expect(health).not.toBeNull();
    if (health) expect(tutorialStartsFrom(health, "/settings")).toBe(true);
    const install = guideGoal("app.install");
    if (install) expect(tutorialStartsFrom(install, "/vault")).toBe(true);
  });
});

describe("the step count on a library row", () => {
  it("counts the steps a person walks, not the closing card", () => {
    expect(
      tutorialStepCount(
        [
          "guide/1",
          'goal "x.y"',
          'say "One."',
          'navigate "/vault"',
          'wait route "/vault" timeout=15000',
          'focus "vault.create" "Two." side=bottom',
          'wait target "vault.create" event=activate timeout=30000',
          'success "Done."',
          "end",
        ].join("\n"),
      ),
    ).toBe(2);
    expect(tutorialStepCount('guide/1\ngoal "x.y"\nsay "Only."\nend')).toBe(1);
  });
});
