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
import { GUIDE_OVERLAY_ROUTES, guideRouteWithin } from "./routes.js";
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

/** The gates that draw a help key: each must have a tutorial to offer (ADR 0166). */
const KEYED_GATES = [
  "/unlock/door",
  "/unlock/form",
  "/unlock/passkey",
  "/unlock/signin",
  "/setup/choose",
  "/setup/capabilities",
  "/setup/identity",
  "/setup/connectors",
  "/broker/authorize",
  "/federation",
] as const;

describe("where a tutorial can start", () => {
  const gateOnly = {
    id: "x.gate-only",
    title: "Gate only",
    routes: ["/unlock/door"],
    guide: "",
  };

  it("offers a tutorial written for a gate at that gate, and from no other screen", () => {
    // A gate has no section to navigate to, so a tour for one cannot be walked
    // from the shell or from another gate (ADR 0166, amending ADR 0163 §4).
    expect(tutorialStartsFrom(gateOnly, "/unlock/door")).toBe(true);
    expect(tutorialStartsFrom(gateOnly, "/vault")).toBe(false);
    expect(tutorialStartsFrom(gateOnly, "/settings")).toBe(false);
    expect(tutorialStartsFrom(gateOnly, "/unlock/form")).toBe(false);
    expect(tutorialStartsFrom(gateOnly, "/setup/choose")).toBe(false);
  });

  it("offers a gate none of the shell's tutorials, which point at controls it does not draw", () => {
    const lock = guideGoal("vault.lock");
    const security = guideGoal("settings.security.review");
    expect(lock).not.toBeNull();
    expect(security).not.toBeNull();
    for (const gate of GUIDE_OVERLAY_ROUTES) {
      if (lock) expect(tutorialStartsFrom(lock, gate), gate).toBe(false);
      if (security)
        expect(tutorialStartsFrom(security, gate), gate).toBe(false);
    }
  });

  it("starts a tutorial that names only gates from every gate it names", () => {
    for (const goal of mergedGuideGoals()) {
      if (goal.routes.length === 0) continue;
      if (!goal.routes.every((scope) => GUIDE_OVERLAY_ROUTES.has(scope))) {
        continue;
      }
      for (const scope of goal.routes) {
        expect(tutorialStartsFrom(goal, scope), `${goal.id} at ${scope}`).toBe(
          true,
        );
      }
      expect(tutorialStartsFrom(goal, "/vault"), `${goal.id}`).toBe(false);
    }
  });

  it("gives every gate that draws a help key a tutorial to offer", () => {
    for (const gate of KEYED_GATES) {
      expect(GUIDE_OVERLAY_ROUTES.has(gate), `${gate} is a gate`).toBe(true);
      const offered = tutorialLibrary(gate, {
        sectionDrawn: () => true,
        holds: () => true,
      }).flatMap((group) => group.tutorials);
      expect(offered.length, `${gate} offers nothing`).toBeGreaterThan(0);
      for (const { goal } of offered) {
        expect(
          goal.routes.some((scope) => guideRouteWithin(gate, scope)),
          `${goal.id} is offered at ${gate} but names no scope around it`,
        ).toBe(true);
      }
    }
  });

  it("lists nothing under a gate that the shell would list", () => {
    const here = tutorialLibrary("/unlock/door", {
      sectionDrawn: () => true,
      holds: () => true,
    })
      .flatMap((group) => group.tutorials)
      .map((entry) => entry.goal.id);
    expect(here).toEqual(["gate.front-door", "gate.join"]);
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

  it("offers the rail and statusline tours only on a wide shell, the phone's only on a narrow one", () => {
    const wide = (predicate: string) => predicate !== "shell.narrow";
    const narrow = (predicate: string) => predicate !== "shell.wide";
    const rail = [
      "shell.sections",
      "shell.statusline",
      "shell.sections.access",
    ];
    const phone = ["shell.sections.phone", "shell.more"];
    for (const id of rail) {
      expect(ids({ holds: wide })).toContain(id);
      expect(ids({ holds: narrow })).not.toContain(id);
    }
    for (const id of phone) {
      expect(ids({ holds: narrow })).toContain(id);
      expect(ids({ holds: wide })).not.toContain(id);
    }
  });

  it("offers the Keybindings, recovery and plugin tours only where their row is drawn", () => {
    const without = (missing: string) => (predicate: string) =>
      predicate !== missing;
    const needs = {
      "settings.keybindings.review": "shell.keys",
      "vault.recovery.view": "vault.recovery-made",
      "settings.browser-autofill": "plugin.browser-autofill.panel",
      "settings.surrogate-credentials": "plugin.surrogate-proxy.panel",
    } as const;
    for (const [id, predicate] of Object.entries(needs)) {
      expect(ids({ holds: without(predicate) })).not.toContain(id);
      expect(ids({ holds: () => true })).toContain(id);
    }
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

  it("offers the model tour only while the on-device model draws the picks", () => {
    const holds = (predicate: string) => predicate !== "support.model-picks";
    const sectionDrawn = () => true;
    expect(ids({ holds, sectionDrawn })).not.toContain(
      "settings.model-provider",
    );
    expect(ids({ holds: () => true, sectionDrawn })).toContain(
      "settings.model-provider",
    );
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

  it("hides a tour until one capability it names is installed", () => {
    const health = guideGoal("vault.health.review");
    const install = guideGoal("vault.item-types.install");
    expect(health).not.toBeNull();
    expect(install).not.toBeNull();
    if (!health || !install) return;
    expect(health.capabilities).toEqual(["vault.security-checks"]);
    expect(install.capabilities).toEqual([
      "vault.derived-records",
      "vault.passkey-records",
      "vault.certificate-records",
    ]);
    const absent = () => false;
    expect(goalOffered(health, { installed: absent })).toBe(false);
    expect(
      goalOffered(health, {
        installed: (id) => id === "vault.security-checks",
      }),
    ).toBe(true);
    expect(goalOffered(install, { installed: absent })).toBe(false);
    expect(
      goalOffered(install, {
        installed: (id) => id === "vault.passkey-records",
      }),
    ).toBe(true);
    expect(goalOffered(health)).toBe(true);
    expect(goalOffered(install)).toBe(true);
  });

  it("applies one gate to the library and to any other list of goals", () => {
    const tour = guideGoal("settings.model-provider");
    expect(tour).not.toBeNull();
    if (!tour) return;
    expect(goalOffered(tour, { sectionDrawn: () => false })).toBe(false);
    expect(goalOffered(tour, { sectionDrawn: () => true })).toBe(true);
    expect(goalOffered(tour)).toBe(true);
    expect(tour.capabilities).toEqual(["support.local-ai"]);
    expect(goalOffered(tour, { installed: () => false })).toBe(false);
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
