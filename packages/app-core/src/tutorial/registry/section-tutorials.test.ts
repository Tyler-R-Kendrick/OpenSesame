import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FEATURES } from "../../lib/capabilities/features.js";
import { INTEGRATIONS } from "../../lib/capabilities/integrations.js";
import { goalSections, tutorialLibrary } from "./areas.js";
import {
  FEATURE_TUTORIALS,
  INTEGRATION_TUTORIALS,
  guideGoal,
  mergedGuideGoals,
} from "./goals.js";
import { registerTutorialRealm } from "./optional-tutorials.test-support.js";
import { isKnownGuideRoute } from "./routes.js";

let revoke = () => {};
beforeAll(() => {
  revoke = registerTutorialRealm();
});
afterAll(() => revoke());

/**
 * Settings › Features holds the switches and Settings › Integrations the third
 * parties a feature connects to (ADR 0189). Each section has a tutorial, a
 * tour walks the one page its section is on, and a section is offered only
 * where its own page draws it.
 */
describe("the tutorials of Settings › Features and Settings › Integrations", () => {
  it("opens a tutorial for every section of Settings › Features", () => {
    for (const feature of FEATURES) {
      const goal = FEATURE_TUTORIALS[feature.id];
      expect(goal, `${feature.id} has no tutorial`).toBeDefined();
      expect(guideGoal(goal ?? ""), `${feature.id}: ${goal}`).not.toBeNull();
    }
    expect(Object.keys(FEATURE_TUTORIALS).sort()).toEqual(
      FEATURES.map((feature) => feature.id).sort(),
    );
  });

  it("walks every feature tutorial through the one page its sections are on", () => {
    for (const [id, goal] of Object.entries(FEATURE_TUTORIALS)) {
      const guide = guideGoal(goal)?.guide;
      expect(guide, goal).toBeDefined();
      if (goal.startsWith("feature.")) {
        // A tour of its own: this feature's page, and this feature's section.
        expect(guide, goal).toContain('navigate "/settings/features"');
        expect(guide, goal).toContain(`focus "feature.${id}"`);
      } else {
        // A task-shaped tour: it still names this feature's section.
        expect(goalSections(guide ?? ""), goal).toContain(`feature.${id}`);
      }
      expect(guide, goal).not.toContain("/settings/capabilities");
    }
  });

  it("opens a tutorial for every section of Settings › Integrations", () => {
    for (const integration of INTEGRATIONS) {
      const goal = INTEGRATION_TUTORIALS[integration.id];
      expect(goal, `${integration.id} has no tutorial`).toBeDefined();
      expect(
        guideGoal(goal ?? ""),
        `${integration.id}: ${goal}`,
      ).not.toBeNull();
    }
    expect(Object.keys(INTEGRATION_TUTORIALS).sort()).toEqual(
      INTEGRATIONS.map((integration) => integration.id).sort(),
    );
  });

  it("walks every integration tutorial through the one page its sections are on", () => {
    for (const [id, goal] of Object.entries(INTEGRATION_TUTORIALS)) {
      const guide = guideGoal(goal)?.guide;
      expect(guide, goal).toBeDefined();
      expect(guide, goal).toContain('navigate "/settings/integrations"');
      // A tour of its own, or the task-shaped one (Backups, AI) that still
      // names this integration's section.
      expect(goalSections(guide ?? ""), goal).toContain(`integration.${id}`);
      if (goal.startsWith("integration.")) {
        expect(goal).toBe(`integration.${id}`);
      }
      expect(guide, goal).not.toContain("/settings/capabilities");
    }
  });

  it("keeps a switch's tour on Features and a provider's on Integrations", () => {
    for (const goal of mergedGuideGoals()) {
      if (goal.id.startsWith("feature.")) {
        expect(goal.guide, goal.id).not.toContain('"/settings/integrations"');
        expect(goalSections(goal.guide), goal.id).toEqual([goal.id]);
      }
      if (goal.id.startsWith("integration.")) {
        expect(goal.guide, goal.id).not.toContain('"/settings/features"');
        expect(goalSections(goal.guide), goal.id).toEqual([goal.id]);
      }
    }
  });

  it("names a section by its full target id, feature or integration", () => {
    expect(
      goalSections(
        [
          'focus "feature.ai" "One." side=bottom',
          'focus "integration.ai" "Two." side=bottom',
          'focus "settings.model-provider" "Not a section." side=bottom',
        ].join("\n"),
      ),
    ).toEqual(["feature.ai", "integration.ai"]);
  });
});

describe("what a section tour needs before it is offered", () => {
  const ids = (options: Parameters<typeof tutorialLibrary>[1]) =>
    tutorialLibrary("/settings", options).flatMap((group) =>
      group.tutorials.map((entry) => entry.goal.id),
    );

  it("keeps model choices with the AI feature tour independently of its integration section", () => {
    const noIntegration = ids({
      sectionDrawn: (id) => id !== "integration.ai",
    });
    expect(noIntegration).toContain("settings.model-provider");
    expect(noIntegration).toContain("feature.ai");
    const noFeature = ids({ sectionDrawn: (id) => id !== "feature.ai" });
    expect(noFeature).not.toContain("feature.ai");
    expect(noFeature).not.toContain("settings.model-provider");
  });

  it("asks for the section of the page a tour is on, not of the other page", () => {
    // Features and Integrations draw independently: a feature section that is
    // not drawn must not hide the tour of its integration, and the reverse.
    const only = (kept: string) => (id: string) => !id.startsWith(kept);
    const noFeatures = ids({ sectionDrawn: only("feature.") });
    const noIntegrations = ids({ sectionDrawn: only("integration.") });
    expect(noFeatures).toContain("integration.identity");
    expect(noFeatures).not.toContain("feature.identity");
    expect(noIntegrations).toContain("feature.identity");
    expect(noIntegrations).not.toContain("integration.identity");
  });
});

describe("tutorial panel destinations", () => {
  it.each([
    ["vaults.manage", "/settings/vaults", "vaults.list"],
    ["vault.item-types.install", "/settings/item-types", "settings.item-types"],
    [
      "settings.model-provider",
      "/settings/features/ai",
      "settings.model-provider",
    ],
    [
      "settings.local-notifications",
      "/settings/features/local-notifications",
      "settings.local-notifications",
    ],
  ])("navigates %s to the page that owns its target", (goal, route, target) => {
    expect(isKnownGuideRoute(route)).toBe(true);
    const guide = guideGoal(goal)?.guide;
    expect(guide).toBeDefined();
    const lines = guide?.split("\n") ?? [];
    const focus = lines.findIndex((line) =>
      line.startsWith(`focus "${target}"`),
    );
    expect(focus).toBeGreaterThan(0);
    const navigations = lines
      .slice(0, focus)
      .filter((line) => line.startsWith("navigate "));
    expect(navigations.at(-1)).toBe(`navigate "${route}"`);
    expect(lines.slice(0, focus)).toContain(
      `wait route "${route}" timeout=15000`,
    );
  });
});
