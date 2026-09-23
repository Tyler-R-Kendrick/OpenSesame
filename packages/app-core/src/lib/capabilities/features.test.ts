import type {
  CapabilityState,
  EffectivePlan,
} from "@opensesame/capability-composition";
import { describe, expect, it } from "vitest";
import { FEATURE_BINDING_CATEGORIES } from "../../sections/connections/shared.js";
import {
  CAPABILITY_CATALOG,
  coreCapabilityIds,
  optionalCapabilityIds,
} from "./catalog.js";
import {
  FEATURES,
  PROVIDER_GROUPS,
  featureById,
  featureOf,
  featureState,
  switchFeature,
} from "./features.js";

/** A plan in which the named capabilities run and every optional one may. */
function planWith(approved: readonly string[]): EffectivePlan {
  const capabilities: Record<string, CapabilityState> = {};
  for (const entry of CAPABILITY_CATALOG.capabilities) {
    capabilities[entry.id] = {
      id: entry.id,
      tier: entry.tier,
      distributed: true,
      permitted: true,
      required: false,
      selected: approved.includes(entry.id),
      dependencyOf: [],
      runtimeSupported: true,
      approved: entry.tier === "core" || approved.includes(entry.id),
      restartRequired: false,
      reasons: [],
    };
  }
  // SAFETY: the tests read `capabilities` only.
  return { capabilities } as unknown as EffectivePlan;
}

describe("FEATURES", () => {
  it("rolls every optional capability into exactly one feature, and nothing always-on", () => {
    const owners = new Map<string, string>();
    for (const feature of FEATURES) {
      for (const id of feature.capabilities) {
        expect(owners.has(id), `${id} in two features`).toBe(false);
        owners.set(id, feature.id);
      }
    }
    expect([...owners.keys()].sort()).toEqual(optionalCapabilityIds().sort());
    for (const id of coreCapabilityIds()) expect(featureOf(id)).toBeNull();
  });

  it("gives every connector family one home: a feature or an always-on group", () => {
    const homes = [
      ...FEATURES.flatMap((feature) => feature.providerCategories),
      ...PROVIDER_GROUPS.map((group) => group.category),
    ];
    expect(new Set(homes).size).toBe(homes.length);
    expect([...homes].sort()).toEqual([...FEATURE_BINDING_CATEGORIES].sort());
  });

  it("puts the git providers under Backups and the models under AI", () => {
    expect(featureById("backups").providerCategories).toEqual([
      "backup_recovery",
    ]);
    expect(featureById("ai").models).toBe(true);
  });
});

describe("featureState", () => {
  it("is on when any capability behind it runs, complete when all do", () => {
    const ai = featureById("ai");
    const partial = featureState(ai, planWith(["agents.webmcp"]));
    expect(partial.on).toBe(true);
    expect(partial.complete).toBe(false);
    expect(featureState(ai, planWith([])).on).toBe(false);
    expect(featureState(ai, planWith(ai.capabilities)).complete).toBe(true);
  });

  it("offers nothing a plan does not distribute or permit", () => {
    const plan = planWith([]);
    const state = plan.capabilities["wallet.spending"];
    if (!state) throw new Error("missing wallet");
    // SAFETY: test-only mutation of a fixture plan.
    (plan.capabilities as Record<string, CapabilityState>)["wallet.spending"] =
      { ...state, permitted: false };
    expect(featureState(featureById("payments"), plan).available).toEqual([]);
  });
});

describe("switchFeature", () => {
  it("adds every capability behind a feature and keeps the other roots", () => {
    const next = switchFeature(
      { roots: ["backup.git-remote"], alternatives: {} },
      featureById("sharing"),
      true,
      planWith(["backup.git-remote"]),
      CAPABILITY_CATALOG,
    );
    expect(next.roots).toEqual([
      "backup.git-remote",
      "sharing.drops",
      "sharing.household",
    ]);
  });

  it("chooses an alternative the switch itself adds, so the review is not blocked", () => {
    const next = switchFeature(
      { roots: [], alternatives: {} },
      featureById("sharing"),
      true,
      planWith([]),
      CAPABILITY_CATALOG,
    );
    expect(next.alternatives).toEqual({ transport: "sharing.drops" });
  });

  it("keeps a choice already made", () => {
    const next = switchFeature(
      { roots: [], alternatives: { transport: "sharing.drops" } },
      featureById("sharing"),
      true,
      planWith([]),
      CAPABILITY_CATALOG,
    );
    expect(next.alternatives).toEqual({ transport: "sharing.drops" });
  });

  it("removes every capability behind a feature when switched off", () => {
    const next = switchFeature(
      {
        roots: ["agents.webmcp", "support.local-ai", "wallet.spending"],
        alternatives: {},
      },
      featureById("ai"),
      false,
      planWith(["agents.webmcp", "support.local-ai", "wallet.spending"]),
      CAPABILITY_CATALOG,
    );
    expect(next.roots).toEqual(["wallet.spending"]);
  });

  it("drops a root that has since become always-on", () => {
    const next = switchFeature(
      { roots: ["vault.passkey-records", "wallet.spending"], alternatives: {} },
      featureById("backups"),
      false,
      planWith([]),
      CAPABILITY_CATALOG,
    );
    expect(next.roots).toEqual(["wallet.spending"]);
  });
});
