/** @vitest-environment jsdom */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CAPABILITIES } from "@opensesame/capability-registry";
import {
  MAX_SEMANTIC_ID_CHARS,
  compileGuide,
  isGuideSemanticId,
} from "@opensesame/guide-lang";
import { isFunction, isTypeofObject } from "@opensesame/os-domain";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AUTHORED_GUIDE_TARGETS, AUTHORED_HELP_TOPICS } from "./authored.js";
import { mergedGuideTargets } from "./catalog.js";
import * as devModule from "./dev.js";
import {
  CAPABILITY_TUTORIALS,
  guideGoal,
  guideGoalIds,
  mergedGuideGoals,
  mergedHelpTopics,
} from "./goals.js";
import { registerTutorialRealm } from "./optional-tutorials.test-support.js";
import { GUIDE_PREDICATES, registerGuidePredicates } from "./predicates.js";
import { isKnownGuideRoute, mergedGuideRoutes } from "./routes.js";
import { guidePredicateIds } from "./state.js";
import {
  describeGuideTargets,
  duplicateGuideTargetMounts,
  guideTargetIds,
  isMountedGuideTarget,
  mountGuideTarget,
  resolveGuideTargetElement,
  undeclaredGuideTargetMounts,
} from "./targets.js";

const CATALOG_MORE_SOURCE = readFileSync(
  join(import.meta.dirname, "catalog-more.ts"),
  "utf8",
).replace(
  "...SETUP_TARGETS,",
  readFileSync(join(import.meta.dirname, "setup-catalog.ts"), "utf8"),
);

const CATALOG_SOURCE = readFileSync(
  join(import.meta.dirname, "catalog.ts"),
  "utf8",
)
  .replace(
    "...SHELL_TARGETS,",
    readFileSync(join(import.meta.dirname, "shell-catalog.ts"), "utf8"),
  )
  .replace(
    "...VAULT_TARGETS,",
    readFileSync(join(import.meta.dirname, "vault-catalog.ts"), "utf8"),
  )
  .replace("...GUIDE_TARGETS_MORE,", CATALOG_MORE_SOURCE);

/**
 * The whole authored corpus, in `authored.ts`'s order: the core catalog
 * first, then one file per optional partition. The live registries answer
 * only what the plan approved, so the prose-integrity sweeps below read the
 * corpus rather than the view — a description a plan happens to exclude is
 * still checked-in prose that must never interpolate a user value.
 */
const OPTIONAL_TARGET_SOURCES = [
  "connections-catalog.ts",
  "access-catalog.ts",
  "identity-catalog.ts",
  "wallet-catalog.ts",
  "activity-catalog.ts",
];

const TARGET_SOURCES = [
  CATALOG_SOURCE,
  ...OPTIONAL_TARGET_SOURCES.map((file) =>
    readFileSync(join(import.meta.dirname, file), "utf8"),
  ),
];

const GOALS_SOURCES = [
  "goals.ts",
  "connections-goals.ts",
  "access-goals.ts",
  "authority-help.ts",
  "identity-goals.ts",
].map((file) => readFileSync(join(import.meta.dirname, file), "utf8"));

const CAPABILITY_IDS = new Set(CAPABILITIES.map((capability) => capability.id));

// Every optional partition, registered the way its module registers it, so
// the live registries below are the ones a full plan draws.
let revokeRealm = () => {};
beforeAll(() => {
  registerGuidePredicates();
  revokeRealm = registerTutorialRealm();
});
afterAll(() => revokeRealm());

describe("the target catalog", () => {
  it("names every control with a semantic id, unique and within budget", () => {
    const seen = new Set<string>();
    for (const descriptor of mergedGuideTargets()) {
      expect(isGuideSemanticId(descriptor.id)).toBe(true);
      expect(descriptor.id.length).toBeLessThanOrEqual(MAX_SEMANTIC_ID_CHARS);
      expect(seen.has(descriptor.id)).toBe(false);
      seen.add(descriptor.id);
    }
    expect(seen.size).toBe(mergedGuideTargets().length);
  });

  it("scopes every target to routes the route registry actually declares", () => {
    for (const descriptor of mergedGuideTargets()) {
      for (const route of descriptor.routes) {
        expect(isKnownGuideRoute(route)).toBe(true);
      }
    }
  });

  it("cites only capabilities that exist in the ADR-0065 registry", () => {
    for (const descriptor of mergedGuideTargets()) {
      if (descriptor.capabilityId === null) continue;
      expect(CAPABILITY_IDS.has(descriptor.capabilityId)).toBe(true);
    }
  });

  /**
   * The privacy property the whole design rests on: a description is authored
   * prose that was checked in, never a template that could pull a vault item
   * name, a folder name or an account address into model context. Comparing
   * the parsed source literal against the runtime value proves there is no
   * interpolation, no concatenation and no computed value anywhere in it.
   */
  it("carries no description that could interpolate a user-created value", () => {
    const literals = TARGET_SOURCES.flatMap((source) => [
      ...source.matchAll(/\n\s*description:\s*([\s\S]*?),\n\s*role:/g),
    ]);
    expect(literals.length).toBe(AUTHORED_GUIDE_TARGETS.length);

    literals.forEach(([, raw], index) => {
      const text = raw.trim();
      expect(text.includes("`")).toBe(false);
      expect(text.includes("${")).toBe(false);
      expect(text.includes("+")).toBe(false);
      expect(text.startsWith('"')).toBe(true);
      expect(text.endsWith('"')).toBe(true);
      // JSON.parse only accepts one complete string literal, so a value built
      // from several pieces cannot survive this.
      expect(JSON.parse(text)).toBe(AUTHORED_GUIDE_TARGETS[index]?.description);
    });
  });

  it("carries no authored help answer that could interpolate one either", () => {
    const literals = GOALS_SOURCES.flatMap((source) => [
      ...source.matchAll(/\n\s*answer:\s*([\s\S]*?),\n\s*routes:/g),
    ]);
    expect(literals.length).toBe(AUTHORED_HELP_TOPICS.length);

    literals.forEach(([, raw], index) => {
      const text = raw.trim();
      expect(text.includes("`")).toBe(false);
      expect(text.includes("${")).toBe(false);
      expect(JSON.parse(text)).toBe(AUTHORED_HELP_TOPICS[index]?.answer);
    });
  });
});

describe("the page context a model is handed", () => {
  const ALLOWED_KEYS = new Set(["id", "description", "role", "mounted"]);

  it("describes targets without leaking an element, a closure or an extra field", () => {
    for (const route of mergedGuideRoutes()) {
      const described = describeGuideTargets(route.id);
      for (const entry of described) {
        for (const [key, value] of Object.entries(entry)) {
          expect(ALLOWED_KEYS.has(key)).toBe(true);
          expect(isFunction(value)).toBe(false);
          expect(isTypeofObject(value)).toBe(false);
        }
        expect(Object.keys(entry).length).toBe(ALLOWED_KEYS.size);
      }
    }
  });

  it("scopes a route's targets to the ones declared for it", () => {
    const onHealth = describeGuideTargets("/vault/health").map(
      (entry) => entry.id,
    );
    expect(onHealth).toContain("vault.health.summary");
    expect(onHealth).not.toContain("access.grants");
  });
});

describe("the authored guides", () => {
  /**
   * The important one. An authored guide gets no privileged path: it goes
   * through exactly the parser and vocabulary check a model's output does, so
   * a goal naming a control this build does not have fails here rather than
   * at a resolver, at run time, in front of somebody asking for help.
   */
  it("compile against the live registries", () => {
    const vocabulary = {
      goals: guideGoalIds(),
      targets: guideTargetIds(),
      routes: mergedGuideRoutes().map((route) => route.id),
      predicates: guidePredicateIds(),
    };

    for (const goal of mergedGuideGoals()) {
      const compiled = compileGuide(goal.guide, vocabulary);
      if (!compiled.ok) {
        throw new Error(
          `${goal.id} failed at ${compiled.stage}: ${JSON.stringify(compiled.errors)}`,
        );
      }
      expect(compiled.program.goal).toBe(goal.id);
    }
  });

  it("are offered under ids that are themselves semantic and unique", () => {
    const seen = new Set<string>();
    for (const goal of mergedGuideGoals()) {
      expect(isGuideSemanticId(goal.id)).toBe(true);
      expect(seen.has(goal.id)).toBe(false);
      seen.add(goal.id);
    }
  });

  it("are the only goals help topics point at", () => {
    const goals = new Set(guideGoalIds());
    for (const topic of mergedHelpTopics()) {
      expect(topic.goal.length).toBeGreaterThan(0);
      expect(goals.has(topic.goal)).toBe(true);
    }
  });

  it("reach the goals the deterministic fallback promises", () => {
    const goals = new Set(guideGoalIds());
    for (const required of [
      "connection.create",
      "connection.repair",
      "vault.item.create",
      "vault.import",
      "vault.health.review",
      "identity.account.add",
      "settings.security.review",
    ]) {
      expect(goals.has(required)).toBe(true);
    }
  });

  it("maps every PWA-surfaced capability to a compiling walkthrough", () => {
    const pwa = CAPABILITIES.filter(
      (capability) => capability.surfaces.pwa !== null,
    );
    expect(pwa.length).toBeGreaterThan(0);
    for (const capability of pwa) {
      const goalId = Object.entries(CAPABILITY_TUTORIALS).find(
        ([id]) => id === capability.id,
      )?.[1];
      expect(goalId, capability.id).toBeTruthy();
      const named = guideGoal(goalId ?? "");
      expect(named, `${capability.id} -> ${goalId}`).not.toBeNull();
    }
    for (const goalId of new Set(Object.values(CAPABILITY_TUTORIALS))) {
      expect(guideGoalIds()).toContain(goalId);
    }
  });
});

describe("mount bookkeeping", () => {
  it("records no duplicate for an ordinary mount and unmount", () => {
    // Attached, because a React ref only ever hands the registry an element
    // that is already in the document — the effect runs after mount.
    const element = document.createElement("button");
    document.body.append(element);
    const detach = mountGuideTarget("vault.create", element);
    expect(isMountedGuideTarget("vault.create")).toBe(true);
    detach();
    expect(isMountedGuideTarget("vault.create")).toBe(false);
    expect(duplicateGuideTargetMounts()).toEqual([]);
    element.remove();
  });

  it("refuses the same element registered twice", () => {
    const element = document.createElement("button");
    document.body.append(element);
    const detach = mountGuideTarget("vault.create", element);
    expect(() => mountGuideTarget("vault.create", element)).toThrow(
      /guide_target_mounted_twice:vault\.create/,
    );
    detach();
    expect(duplicateGuideTargetMounts()).toContain("vault.create");
    element.remove();
  });

  // The rail and the phone tab bar render the same destination, and exactly one
  // of them is visible at any width. Resolution has to pick the visible copy or
  // every navigation guide fails closed on one form factor.
  it("resolves a target to whichever candidate is visible", () => {
    const rail = document.createElement("a");
    const tab = document.createElement("a");
    document.body.append(rail, tab);
    const detachRail = mountGuideTarget("nav.connections", rail);
    const detachTab = mountGuideTarget("nav.connections", tab);

    expect(resolveGuideTargetElement("nav.connections")).toBe(rail);

    rail.style.display = "none";
    expect(resolveGuideTargetElement("nav.connections")).toBe(tab);
    expect(isMountedGuideTarget("nav.connections")).toBe(true);

    tab.style.display = "none";
    expect(resolveGuideTargetElement("nav.connections")).toBeNull();
    expect(isMountedGuideTarget("nav.connections")).toBe(false);

    detachRail();
    detachTab();
    rail.remove();
    tab.remove();
  });

  // Several controls exist twice — the vault filters are chips on a phone and
  // rail rows on a desktop — and only one copy can hold the target. The other
  // stays in the document, hidden by a media query, so registration alone would
  // advertise an invisible control to a model and let it highlight nothing.
  it("does not call a hidden control mounted", () => {
    const holder = document.createElement("div");
    const element = document.createElement("button");
    holder.append(element);
    document.body.append(holder);
    const detach = mountGuideTarget("vault.create", element);
    expect(isMountedGuideTarget("vault.create")).toBe(true);

    holder.style.display = "none";
    expect(isMountedGuideTarget("vault.create")).toBe(false);
    expect(
      describeGuideTargets("/vault").find((t) => t.id === "vault.create")
        ?.mounted,
    ).toBe(false);

    holder.style.display = "block";
    holder.style.visibility = "hidden";
    expect(isMountedGuideTarget("vault.create")).toBe(false);

    detach();
    holder.remove();
  });

  it("refuses an id the catalog never declared", () => {
    const element = document.createElement("button");
    expect(() => mountGuideTarget("vault.definitely-not", element)).toThrow(
      /guide_target_undeclared/,
    );
  });

  it("binds nothing rather than throwing in a production build", () => {
    // A capability declares its targets when its module activates, so a
    // control from one capability can mount before the capability that
    // declares its id has landed. Approving `backup.git-remote` did exactly
    // that — its settings category names `settings.backup`, declared by
    // `connectors.external` — and the throw ran inside a React ref and took
    // the whole document down. Production fails closed instead: nothing is
    // bound, so a guide still cannot point at it.
    const dev = vi.spyOn(devModule, "inDevelopment").mockReturnValue(false);
    try {
      const element = document.createElement("button");
      const detach = mountGuideTarget("vault.definitely-not", element);
      expect(typeof detach).toBe("function");
      expect(isMountedGuideTarget("vault.definitely-not")).toBe(false);
      expect(resolveGuideTargetElement("vault.definitely-not")).toBeNull();
      expect(undeclaredGuideTargetMounts()).toContain("vault.definitely-not");
      detach();
    } finally {
      dev.mockRestore();
    }
  });
});

describe("the predicate set", () => {
  it("declares every predicate exactly once, and survives a second call", () => {
    const ids = guidePredicateIds();
    expect(new Set(ids).size).toBe(ids.length);
    for (const descriptor of GUIDE_PREDICATES) {
      expect(ids).toContain(descriptor.id);
    }
    registerGuidePredicates();
    expect(guidePredicateIds().length).toBe(ids.length);
  });
});
