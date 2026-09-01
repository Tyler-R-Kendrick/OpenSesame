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
import { beforeAll, describe, expect, it } from "vitest";

import { GUIDE_TARGETS } from "./catalog.js";
import { GUIDE_GOALS, HELP_TOPICS, guideGoalIds } from "./goals.js";
import { GUIDE_PREDICATES, registerGuidePredicates } from "./predicates.js";
import { GUIDE_ROUTES, isKnownGuideRoute } from "./routes.js";
import { guidePredicateIds } from "./state.js";
import {
  describeGuideTargets,
  duplicateGuideTargetMounts,
  guideTargetIds,
  isMountedGuideTarget,
  mountGuideTarget,
  resolveGuideTargetElement,
} from "./targets.js";

const CATALOG_SOURCE = readFileSync(
  join(import.meta.dirname, "catalog.ts"),
  "utf8",
);

const GOALS_SOURCE = readFileSync(
  join(import.meta.dirname, "goals.ts"),
  "utf8",
);

const CAPABILITY_IDS = new Set(CAPABILITIES.map((capability) => capability.id));

beforeAll(() => {
  registerGuidePredicates();
});

describe("the target catalog", () => {
  it("names every control with a semantic id, unique and within budget", () => {
    const seen = new Set<string>();
    for (const descriptor of GUIDE_TARGETS) {
      expect(isGuideSemanticId(descriptor.id)).toBe(true);
      expect(descriptor.id.length).toBeLessThanOrEqual(MAX_SEMANTIC_ID_CHARS);
      expect(seen.has(descriptor.id)).toBe(false);
      seen.add(descriptor.id);
    }
    expect(seen.size).toBe(GUIDE_TARGETS.length);
  });

  it("scopes every target to routes the route registry actually declares", () => {
    for (const descriptor of GUIDE_TARGETS) {
      for (const route of descriptor.routes) {
        expect(isKnownGuideRoute(route)).toBe(true);
      }
    }
  });

  it("cites only capabilities that exist in the ADR-0065 registry", () => {
    for (const descriptor of GUIDE_TARGETS) {
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
    const literals = [
      ...CATALOG_SOURCE.matchAll(/\n\s*description:\s*([\s\S]*?),\n\s*role:/g),
    ];
    expect(literals.length).toBe(GUIDE_TARGETS.length);

    literals.forEach(([, raw], index) => {
      const text = raw.trim();
      expect(text.includes("`")).toBe(false);
      expect(text.includes("${")).toBe(false);
      expect(text.includes("+")).toBe(false);
      expect(text.startsWith('"')).toBe(true);
      expect(text.endsWith('"')).toBe(true);
      // JSON.parse only accepts one complete string literal, so a value built
      // from several pieces cannot survive this.
      expect(JSON.parse(text)).toBe(GUIDE_TARGETS[index]?.description);
    });
  });

  it("carries no authored help answer that could interpolate one either", () => {
    const literals = [
      ...GOALS_SOURCE.matchAll(/\n\s*answer:\s*([\s\S]*?),\n\s*routes:/g),
    ];
    expect(literals.length).toBe(HELP_TOPICS.length);

    literals.forEach(([, raw], index) => {
      const text = raw.trim();
      expect(text.includes("`")).toBe(false);
      expect(text.includes("${")).toBe(false);
      expect(JSON.parse(text)).toBe(HELP_TOPICS[index]?.answer);
    });
  });
});

describe("the page context a model is handed", () => {
  const ALLOWED_KEYS = new Set(["id", "description", "role", "mounted"]);

  it("describes targets without leaking an element, a closure or an extra field", () => {
    for (const route of GUIDE_ROUTES) {
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
      routes: GUIDE_ROUTES.map((route) => route.id),
      predicates: guidePredicateIds(),
    };

    for (const goal of GUIDE_GOALS) {
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
    for (const goal of GUIDE_GOALS) {
      expect(isGuideSemanticId(goal.id)).toBe(true);
      expect(seen.has(goal.id)).toBe(false);
      seen.add(goal.id);
    }
  });

  it("are the only goals help topics point at", () => {
    const goals = new Set(guideGoalIds());
    for (const topic of HELP_TOPICS) {
      if (topic.goal === null) continue;
      expect(goals.has(topic.goal)).toBe(true);
    }
  });

  it("reach the goals the deterministic fallback promises", () => {
    const goals = new Set(guideGoalIds());
    for (const required of [
      "connection.create",
      "vault.item.create",
      "vault.health.review",
      "identity.account.add",
      "settings.security.review",
    ]) {
      expect(goals.has(required)).toBe(true);
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
