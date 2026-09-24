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
  featureById,
  featureOf,
  featureState,
  isSwitchable,
  neededBy,
  switchCapability,
  switchFeature,
  withdrawnAlwaysOn,
} from "./features.js";

/**
 * A plan in which the named capabilities run and every optional one may;
 * `overrides` changes single capabilities' states on top of that.
 */
function planWith(
  approved: readonly string[],
  overrides: ReadonlyMap<string, Partial<CapabilityState>> = new Map(),
): EffectivePlan {
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
      ...overrides.get(entry.id),
    };
  }
  return {
    identity: {
      instanceId: "personal-local",
      installationId: "features-test",
      vaultId: null,
      distributionId: "features-test",
      policyRevision: "personal-local",
      selectionRevision: "1",
      planDigest: "sha256:features-test",
    },
    provenance: "personal-local",
    policyValid: true,
    capabilities,
    approvedCapabilities: Object.values(capabilities)
      .filter((state) => state.approved)
      .map((state) => state.id),
    approvedModules: [],
    approvedOperations: [],
    approvedItemKinds: [],
    requiredWorkerVariant: null,
    conflicts: [],
    consent: {
      addedRoots: [],
      removedRoots: [],
      changedExposure: [],
      addedDependencies: [],
      requiredNotAccepted: [],
    },
    network: { externalServices: "allow", allowedServiceOrigins: [] },
  };
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

  it("gives every connector family exactly one section", () => {
    const homes = FEATURES.flatMap((feature) => feature.providerCategories);
    expect(new Set(homes).size).toBe(homes.length);
    expect([...homes].sort()).toEqual([...FEATURE_BINDING_CATEGORIES].sort());
  });

  it("names every section once", () => {
    const titles = FEATURES.map((feature) => feature.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("puts the git providers under Backups and the models under AI", () => {
    expect(featureById("backups").providerCategories).toEqual([
      "backup_recovery",
    ]);
    expect(featureById("ai").models).toBe(true);
  });

  it("draws no switch where the function is always on (ADR 0142)", () => {
    for (const id of [
      "identity",
      "encryption",
      "backups",
      "password-managers",
      "cloud-secret-storage",
      "local-storage",
    ] as const) {
      expect(isSwitchable(featureById(id)), id).toBe(false);
    }
    for (const id of [
      "backup.git-remote",
      "identity.local-iam",
      "identity.siop",
      "identity.site-broker",
    ]) {
      expect(coreCapabilityIds(), id).toContain(id);
    }
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
    const plan = planWith(
      [],
      new Map([["wallet.spending", { permitted: false }]]),
    );
    expect(featureState(featureById("payments"), plan).available).toEqual([]);
  });
});

describe("switchFeature", () => {
  it("adds every capability behind a feature and keeps the other roots", () => {
    const next = switchFeature(
      { roots: ["wallet.spending"], alternatives: {} },
      featureById("sharing"),
      true,
      planWith(["wallet.spending"]),
      CAPABILITY_CATALOG,
    );
    expect(next.roots).toEqual([
      "wallet.spending",
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

  it("forgets the alternative choices a feature made when it is switched off", () => {
    const next = switchFeature(
      {
        roots: ["sharing.drops", "sharing.household"],
        alternatives: { transport: "sharing.drops", other: "wallet.spending" },
      },
      featureById("sharing"),
      false,
      planWith(["sharing.drops", "sharing.household"]),
      CAPABILITY_CATALOG,
    );
    expect(next.alternatives).toEqual({ other: "wallet.spending" });
  });

  it("keeps a choice a root outside the feature still answers to", () => {
    const catalog = {
      ...CAPABILITY_CATALOG,
      capabilities: CAPABILITY_CATALOG.capabilities.map((entry) =>
        entry.id === "wallet.spending"
          ? {
              ...entry,
              alternatives: [{ slot: "transport", oneOf: ["sharing.drops"] }],
            }
          : entry,
      ),
    };
    const next = switchFeature(
      {
        roots: ["sharing.drops", "sharing.household", "wallet.spending"],
        alternatives: { transport: "sharing.drops" },
      },
      featureById("sharing"),
      false,
      planWith(["sharing.drops", "sharing.household", "wallet.spending"]),
      catalog,
    );
    expect(next.roots).toEqual(["wallet.spending"]);
    expect(next.alternatives).toEqual({ transport: "sharing.drops" });
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

describe("switchCapability", () => {
  it("adds one capability of a section and answers the slot it needs", () => {
    const next = switchCapability(
      { roots: [], alternatives: {} },
      featureById("sharing"),
      "sharing.household",
      true,
      planWith([]),
      CAPABILITY_CATALOG,
    );
    expect(next.roots).toEqual(["sharing.household"]);
    expect(next.alternatives).toEqual({ transport: "sharing.drops" });
  });

  it("removes only that capability and keeps its section's others", () => {
    const next = switchCapability(
      { roots: ["support.local-ai", "support.remote-ai"], alternatives: {} },
      featureById("ai"),
      "support.remote-ai",
      false,
      planWith(["support.local-ai", "support.remote-ai"]),
      CAPABILITY_CATALOG,
    );
    expect(next.roots).toEqual(["support.local-ai"]);
  });
});

describe("neededBy", () => {
  it("names the kept root whose slot the capability answers", () => {
    expect(
      neededBy(
        {
          roots: ["sharing.drops", "sharing.household"],
          alternatives: { transport: "sharing.drops" },
        },
        "sharing.drops",
        CAPABILITY_CATALOG,
      ),
    ).toEqual(["sharing.household"]);
  });

  it("names nobody once that root is gone, or for a capability no slot chose", () => {
    expect(
      neededBy(
        {
          roots: ["sharing.drops"],
          alternatives: { transport: "sharing.drops" },
        },
        "sharing.drops",
        CAPABILITY_CATALOG,
      ),
    ).toEqual([]);
    expect(
      neededBy(
        { roots: ["sharing.household"], alternatives: {} },
        "support.local-ai",
        CAPABILITY_CATALOG,
      ),
    ).toEqual([]);
  });
});

describe("withdrawnAlwaysOn", () => {
  it("names the always-on capabilities the plan does not run, and nothing optional", () => {
    const withdrawn = {
      approved: false,
      reasons: ["PROHIBITED_BY_INSTANCE" as const],
    };
    const plan = planWith(
      [],
      new Map([
        ["identity.site-broker", withdrawn],
        ["backup.git-remote", withdrawn],
      ]),
    );
    expect(withdrawnAlwaysOn(plan)).toEqual([
      "backup.git-remote",
      "identity.site-broker",
    ]);
    expect(withdrawnAlwaysOn(null)).toEqual([]);
  });
});
