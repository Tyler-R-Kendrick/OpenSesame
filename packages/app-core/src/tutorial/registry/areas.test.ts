import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountSeams } from "../../lib/account.js";
import { FEATURES } from "../../lib/capabilities/features.js";
import {
  TUTORIAL_AREAS,
  goalOffered,
  tutorialLibrary,
  tutorialStartsFrom,
  tutorialStepCount,
} from "./areas.js";
import {
  FEATURE_TUTORIALS,
  describeGuideGoals,
  guideGoal,
  mergedGuideGoals,
} from "./goals.js";
import { registerTutorialRealm } from "./optional-tutorials.test-support.js";
import { registerGuidePredicates } from "./predicates.js";
import { GUIDE_OVERLAY_ROUTES } from "./routes.js";
import { resetGuidePredicatesForTest } from "./state.js";

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
  const gateOnly = {
    id: "x.gate-only",
    title: "Gate only",
    routes: ["/unlock"],
    guide: "",
  };

  it("never offers a tutorial only a gate could start", () => {
    // The Support sheet is never mounted at a gate (ADR 0090), so a goal that
    // names nothing but gates could not be started by anyone.
    expect(tutorialStartsFrom(gateOnly, "/vault")).toBe(false);
    for (const goal of mergedGuideGoals()) {
      expect(
        goal.routes.length === 0 ||
          goal.routes.some((scope) => !GUIDE_OVERLAY_ROUTES.has(scope)),
        `${goal.id} names only gates`,
      ).toBe(true);
    }
  });

  it("starts a goal from the screens it names and from anywhere it navigates", () => {
    const factors = guideGoal("identity.account-factors");
    expect(factors).not.toBeNull();
    if (factors) expect(tutorialStartsFrom(factors, "/vault")).toBe(true);
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

describe("what a tutorial needs before it is offered", () => {
  const ids = (options: Parameters<typeof tutorialLibrary>[1]) =>
    tutorialLibrary("/settings", options).flatMap((group) =>
      group.tutorials.map((entry) => entry.goal.id),
    );

  it("hides the account menu tours from a device with no account", () => {
    const holds = (predicate: string) => predicate !== "account.signed-in";
    expect(ids({ holds })).not.toContain("identity.sign-out");
    expect(ids({ holds })).not.toContain("identity.switch-account");
    expect(ids({ holds: () => true })).toContain("identity.sign-out");
    expect(ids({ holds: () => true })).toContain("identity.switch-account");
  });

  it("offers the install tour only where Settings draws the install panel", () => {
    const holds = (predicate: string) => predicate !== "install.offered";
    expect(ids({ holds })).not.toContain("app.install");
    expect(ids({ holds: () => true })).toContain("app.install");
  });

  it("offers the email and text code tour only with a sign-in service and an enrolled key", () => {
    for (const missing of ["signin-service.configured", "vault.key-enrolled"]) {
      const holds = (predicate: string) => predicate !== missing;
      expect(ids({ holds })).not.toContain("vault.second-step.code");
    }
    expect(ids({ holds: () => true })).toContain("vault.second-step.code");
  });

  it("points the model and tailnet tours at their sections, so an undrawn one hides them", () => {
    const sectionDrawn = (feature: string) =>
      feature !== "ai" && feature !== "networking";
    const withheld = ids({ sectionDrawn });
    expect(withheld).not.toContain("settings.model-provider");
    expect(withheld).not.toContain("settings.tailnet-sync");
    const drawn = ids({ sectionDrawn: () => true });
    expect(drawn).toContain("settings.model-provider");
    expect(drawn).toContain("settings.tailnet-sync");
  });

  it("applies one gate to the library and to any other list of goals", () => {
    const tour = guideGoal("settings.model-provider");
    expect(tour).not.toBeNull();
    if (!tour) return;
    expect(goalOffered(tour, { sectionDrawn: () => false })).toBe(false);
    expect(goalOffered(tour, { sectionDrawn: () => true })).toBe(true);
    expect(goalOffered(tour)).toBe(true);
  });
});

describe("the goals a model is told about", () => {
  it("leave out one whose requirement does not hold", () => {
    const titles = () =>
      describeGuideGoals("/vault").map((goal) => String(goal.id));
    const real = accountSeams.describeAccount;
    resetGuidePredicatesForTest();
    registerGuidePredicates();
    try {
      accountSeams.describeAccount = () => null;
      expect(titles()).not.toContain("identity.sign-out");
      accountSeams.describeAccount = () => ({
        name: "Ada",
        detail: "Google",
        providerId: "google",
        guest: false,
      });
      expect(titles()).toContain("identity.sign-out");
    } finally {
      accountSeams.describeAccount = real;
      resetGuidePredicatesForTest();
    }
  });
});
