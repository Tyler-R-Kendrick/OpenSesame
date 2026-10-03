import { CAPABILITY_CATALOG } from "@opensesame/app-core/lib/capabilities/catalog.js";
import { withoutPresetResidue } from "@opensesame/app-core/lib/capabilities/preset-residue.js";
import {
  type CapabilityId,
  type EffectivePlan,
  type InstallationCapabilitySelection,
  type InstanceCapabilityPolicy,
  buildConsentReceipt,
  resolveComposition,
} from "@opensesame/capability-composition";
import { describe, expect, it } from "vitest";
import { distributionFromOwnership } from "./ownership.js";

function orgPolicy(
  prohibited: string[],
  presetProvenance: InstanceCapabilityPolicy["presetProvenance"] = {
    id: "organization",
    version: 2,
  },
): InstanceCapabilityPolicy {
  return {
    schemaVersion: 1,
    kind: "InstanceCapabilityPolicy",
    instanceId: "inst-org",
    revision: "1",
    presetProvenance,
    capabilities: { default: "deny", required: [], optional: [], prohibited },
    network: { externalServices: "allow", allowedServiceOrigins: [] },
    updates: {
      unknownCapabilities: "deny",
      expandedExposure: "require-approval",
    },
  };
}

function selection(
  selectedOptional: readonly CapabilityId[],
): InstallationCapabilitySelection {
  return {
    schemaVersion: 1,
    kind: "InstallationCapabilitySelection",
    instanceId: "inst-org",
    installationId: "device-org-1",
    basePolicyRevision: "1",
    revision: "1",
    acceptedRequired: [],
    selectedOptional,
    chosenAlternatives: {},
    delivery: { prefetch: "none", offlineCache: "shell-only" },
  };
}

function planUnder(
  prohibited: string[],
  policy: InstanceCapabilityPolicy = orgPolicy(prohibited),
  selectedOptional: readonly CapabilityId[] = [],
): EffectivePlan {
  const input = {
    catalog: CAPABILITY_CATALOG,
    distribution: distributionFromOwnership("selective"),
    instancePolicy: policy,
    provenance: "same-origin-deployment" as const,
    policyValid: true,
    workspace: null,
    installation:
      selectedOptional.length === 0 ? null : selection(selectedOptional),
    vault: null,
    receipt: null,
    facts: {
      environments: ["document", "dedicated-worker", "service-worker"] as const,
      serviceWorkerAvailable: true,
      activeWorkerVariant: null,
      cleanRealm: true,
      evaluatedModuleIds: [],
      approvedAtLoad: [],
      now: "2026-09-24T00:00:00.000Z",
    },
    installationId: "device-org-1",
    vaultId: null,
  };
  if (input.installation === null) return resolveComposition(input);
  const first = resolveComposition(input);
  return resolveComposition({
    ...input,
    receipt: buildConsentReceipt(first, CAPABILITY_CATALOG, input.facts.now),
  });
}

describe("an operator withdraws a browser-local capability (ADR 0142)", () => {
  it("runs the always-on pair by default and leaves Identity off", () => {
    const plan = planUnder([]);
    for (const id of ["identity.site-broker", "backup.git-remote"]) {
      expect(plan.capabilities[id]?.approved, id).toBe(true);
    }
    // Identity is an optional extension (ADR 0153), off until chosen.
    for (const id of ["identity.local-iam", "identity.siop"]) {
      expect(plan.capabilities[id]?.approved, id).toBe(false);
    }
  });

  it("withdrawing browser-local IAM takes SIOP with it, and leaves the rest", () => {
    const permitted = orgPolicy([]);
    const allowed: InstanceCapabilityPolicy = {
      ...permitted,
      capabilities: {
        ...permitted.capabilities,
        optional: ["identity.local-iam", "identity.siop"],
      },
    };
    const chosen = ["identity.local-iam", "identity.siop"] as const;
    const on = planUnder([], allowed, chosen);
    expect(on.capabilities["identity.local-iam"]?.approved).toBe(true);
    expect(on.capabilities["identity.siop"]?.approved).toBe(true);
    const plan = planUnder(
      [],
      {
        ...allowed,
        capabilities: {
          ...allowed.capabilities,
          prohibited: ["identity.local-iam"],
        },
      },
      chosen,
    );
    expect(plan.capabilities["identity.local-iam"]?.approved).toBe(false);
    expect(plan.capabilities["identity.siop"]?.approved).toBe(false);
    expect(plan.capabilities["identity.site-broker"]?.approved).toBe(true);
    expect(plan.approvedModules).not.toContain("identity.local-iam/runtime");
    expect(plan.approvedModules).not.toContain("identity.siop/runtime");
  });

  it("withdraws git backup, and never statically linked core", () => {
    const plan = planUnder(["backup.git-remote", "vault.passwords"]);
    expect(plan.capabilities["backup.git-remote"]?.approved).toBe(false);
    expect(plan.capabilities["vault.passwords"]?.approved).toBe(true);
  });
});

describe("a version-1 preset's refusals are not a withdrawal", () => {
  // Main-era Personal projected every optional id it did not offer into
  // `prohibited`, git backup and browser-local IAM among them.
  const legacy = orgPolicy(["backup.git-remote", "identity.local-iam"], {
    id: "personal",
    version: 1,
  });

  it("read as written, it would take git backup away", () => {
    expect(
      planUnder([], legacy).capabilities["backup.git-remote"]?.approved,
    ).toBe(false);
  });

  it("read as the store reads it, git backup runs and the IAM refusal stands", () => {
    const plan = planUnder([], withoutPresetResidue(legacy));
    expect(plan.capabilities["backup.git-remote"]?.approved).toBe(true);
    // IAM is optional again, so a version-1 prohibition of it is kept.
    expect(plan.capabilities["identity.local-iam"]?.approved).toBe(false);
  });

  it("a hand-written policy still withdraws them", () => {
    const written = orgPolicy(["backup.git-remote"], null);
    const plan = planUnder([], withoutPresetResidue(written));
    expect(plan.capabilities["backup.git-remote"]?.approved).toBe(false);
  });
});
