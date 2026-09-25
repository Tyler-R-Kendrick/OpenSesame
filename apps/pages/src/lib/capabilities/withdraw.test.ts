import { CAPABILITY_CATALOG } from "@opensesame/app-core/lib/capabilities/catalog.js";
import { withoutPresetResidue } from "@opensesame/app-core/lib/capabilities/preset-residue.js";
import {
  type EffectivePlan,
  type InstanceCapabilityPolicy,
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

function planUnder(
  prohibited: string[],
  policy: InstanceCapabilityPolicy = orgPolicy(prohibited),
): EffectivePlan {
  return resolveComposition({
    catalog: CAPABILITY_CATALOG,
    distribution: distributionFromOwnership("selective"),
    instancePolicy: policy,
    provenance: "same-origin-deployment",
    policyValid: true,
    workspace: null,
    installation: null,
    vault: null,
    receipt: null,
    facts: {
      environments: ["document", "dedicated-worker", "service-worker"],
      serviceWorkerAvailable: true,
      activeWorkerVariant: null,
      cleanRealm: true,
      evaluatedModuleIds: [],
      now: "2026-09-24T00:00:00.000Z",
    },
    installationId: "device-org-1",
    vaultId: null,
  });
}

describe("an operator withdraws a browser-local capability (ADR 0142)", () => {
  it("runs all four by default", () => {
    const plan = planUnder([]);
    for (const id of [
      "identity.local-iam",
      "identity.siop",
      "identity.site-broker",
      "backup.git-remote",
    ]) {
      expect(plan.capabilities[id]?.approved, id).toBe(true);
    }
  });

  it("withdrawing browser-local IAM takes SIOP with it, and leaves the rest", () => {
    const plan = planUnder(["identity.local-iam"]);
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

  it("read as the store reads it, all four run", () => {
    const plan = planUnder([], withoutPresetResidue(legacy));
    expect(plan.capabilities["backup.git-remote"]?.approved).toBe(true);
    expect(plan.capabilities["identity.local-iam"]?.approved).toBe(true);
  });

  it("a hand-written policy still withdraws them", () => {
    const written = orgPolicy(["backup.git-remote"], null);
    const plan = planUnder([], withoutPresetResidue(written));
    expect(plan.capabilities["backup.git-remote"]?.approved).toBe(false);
  });
});
