import { describe, expect, it } from "vitest";
import { buildCatalog } from "./catalog.js";
import { buildConsentReceipt, computeConsentDelta } from "./consent.js";
import {
  FIXTURE_CATALOG,
  FIXTURE_DISTRIBUTION,
  FIXTURE_FACTS,
  FIXTURE_INSTALLATION,
  FIXTURE_POLICIES,
  fixtureResolveInput,
  fixtureSelection,
} from "./fixtures.js";
import type { ResolveInput } from "./resolve-input.js";
import { explainCapability, resolveComposition } from "./resolve.js";
import type { CapabilityId, ConsentReceipt, EffectivePlan } from "./types.js";

const CORE = ["settings.core", "vault.passwords"];
const NOW = "2026-09-22T00:00:00.000Z";

function optionalIds(plan: EffectivePlan): CapabilityId[] {
  return Object.values(plan.capabilities)
    .filter((s) => s.tier === "optional")
    .map((s) => s.id);
}

/** Resolve once to learn the closure, sign it, resolve again with the receipt. */
function resolveWithConsent(input: ResolveInput) {
  const first = resolveComposition(input);
  const receipt = buildConsentReceipt(first, input.catalog, NOW);
  return { plan: resolveComposition({ ...input, receipt }), receipt };
}

const familyInput = (overrides: Partial<ResolveInput> = {}): ResolveInput =>
  fixtureResolveInput({
    instancePolicy: FIXTURE_POLICIES.family,
    provenance: "same-origin-deployment",
    installation: FIXTURE_INSTALLATION,
    ...overrides,
  });

describe("runtime facts and scopes", () => {
  it("a vault disable narrows the installation and never widens it", () => {
    const vault = {
      schemaVersion: 1 as const,
      kind: "VaultCapabilitySelection" as const,
      instanceId: "fixture-family",
      installationId: "fixture-installation",
      vaultId: "tomb-1",
      revision: "v1",
      disabled: ["access.authority"],
    };
    const { plan } = resolveWithConsent(
      familyInput({ vault, vaultId: "tomb-1" }),
    );
    expect(plan.capabilities["access.authority"]?.reasons).toEqual([
      "DISABLED_IN_VAULT",
    ]);
    expect(plan.conflicts[0]?.code).toBe("DEPENDENCY_NOT_PERMITTED");
    expect(plan.approvedCapabilities).toEqual(["identity.federation", ...CORE]);
  });

  it("RESTART_REQUIRED marks a no-longer-approved capability whose module was evaluated", () => {
    const plan = resolveComposition(
      fixtureResolveInput({
        facts: {
          ...FIXTURE_FACTS,
          cleanRealm: false,
          evaluatedModuleIds: ["telemetry.external/runtime"],
        },
      }),
    );
    expect(plan.capabilities["telemetry.external"]?.restartRequired).toBe(true);
    expect(plan.capabilities["telemetry.external"]?.reasons).toEqual([
      "NOT_SELECTED",
      "RESTART_REQUIRED",
    ]);
  });

  it("a selection for another installation or instance is ignored with PROFILE_MISMATCH", () => {
    const plan = resolveComposition(
      familyInput({ installationId: "someone-else" }),
    );
    expect(plan.approvedCapabilities).toEqual(CORE);
    expect(plan.capabilities["connectors.external"]?.selected).toBe(false);
    expect(plan.capabilities["connectors.external"]?.reasons).toContain(
      "PROFILE_MISMATCH",
    );
  });

  it("managed-invalid-revision: a selection accepted against a superseded policy revision approves nothing optional", () => {
    // The `managed-invalid-revision` profile: the operator moved the policy
    // on (family-r1 -> family-r2); the device still holds the selection it
    // accepted against family-r1.
    const superseded = {
      ...FIXTURE_POLICIES.family,
      revision: "family-r2",
    };
    const current = resolveWithConsent(familyInput());
    expect(current.plan.approvedCapabilities).toEqual([
      "access.authority",
      "connectors.external",
      "identity.federation",
      ...CORE,
    ]);

    const plan = resolveComposition(
      familyInput({ instancePolicy: superseded, receipt: current.receipt }),
    );
    // Nothing optional is approved, and the approved set only shrank.
    expect(plan.approvedCapabilities).toEqual(CORE);
    expect(plan.approvedModules).toEqual([
      "settings.core/runtime",
      "vault.passwords/runtime",
    ]);
    expect(current.plan.approvedCapabilities).toEqual(
      expect.arrayContaining([...plan.approvedCapabilities]),
    );
    // The choice is still recorded, and PROFILE_MISMATCH says why it is void.
    for (const id of optionalIds(plan)) {
      expect(plan.capabilities[id]?.approved).toBe(false);
      expect(plan.capabilities[id]?.reasons).toContain("PROFILE_MISMATCH");
      expect(plan.capabilities[id]?.permitted).toBe(false);
    }
    expect(plan.capabilities["connectors.external"]?.selected).toBe(true);
    expect(plan.capabilities["identity.federation"]?.selected).toBe(true);
    // Consent is owed again for every root the stale selection named.
    expect(plan.consent.addedRoots).toEqual([
      "connectors.external",
      "identity.federation",
    ]);
    expect(plan.consent.requiredNotAccepted).toEqual(["identity.federation"]);
    expect(computeConsentDelta(plan, FIXTURE_CATALOG, current.receipt)).toEqual(
      plan.consent,
    );
    // Re-accepting the current revision restores it; the revision alone is
    // what went stale, not the exposure.
    const refreshed = resolveWithConsent(
      familyInput({
        instancePolicy: superseded,
        installation: fixtureSelection({ basePolicyRevision: "family-r2" }),
      }),
    ).plan;
    expect(refreshed.approvedCapabilities).toEqual(
      current.plan.approvedCapabilities,
    );
  });

  it("explainCapability fails closed for an unknown id", () => {
    const plan = resolveComposition(fixtureResolveInput());
    const explanation = explainCapability(plan, "never.declared");
    expect(explanation.state.approved).toBe(false);
    expect(explanation.state.reasons).toEqual(["NOT_DISTRIBUTED"]);
  });
});

describe("worker selection", () => {
  it("picks the single variant satisfying every approved constraint", () => {
    const selection = fixtureSelection({
      selectedOptional: ["notifications.web-push"],
    });
    const { plan } = resolveWithConsent(
      familyInput({ installation: selection }),
    );
    expect(plan.requiredWorkerVariant).toBe("push");
    expect(plan.approvedModules).toContain("notifications.web-push/worker");
    expect(plan.capabilities["notifications.web-push"]?.approved).toBe(true);
  });

  it("WORKER_GRAPH_UNAVAILABLE: without a satisfying variant the capability is not approved", () => {
    const distribution = {
      ...FIXTURE_DISTRIBUTION,
      workerVariants: FIXTURE_DISTRIBUTION.workerVariants.filter(
        (v) => v.id !== "push",
      ),
    };
    const selection = fixtureSelection({
      selectedOptional: ["notifications.web-push"],
    });
    const { plan } = resolveWithConsent(
      familyInput({ installation: selection, distribution }),
    );
    expect(plan.capabilities["notifications.web-push"]?.approved).toBe(false);
    expect(plan.capabilities["notifications.web-push"]?.reasons).toEqual([
      "WORKER_GRAPH_UNAVAILABLE",
    ]);
    expect(plan.conflicts).toEqual([
      expect.objectContaining({
        code: "WORKER_GRAPH_UNAVAILABLE",
        capability: "notifications.web-push",
        subject: "push",
      }),
    ]);
    expect(plan.requiredWorkerVariant).toBeNull();
    const noWorkers = resolveWithConsent(
      familyInput({
        installation: selection,
        facts: { ...FIXTURE_FACTS, serviceWorkerAvailable: false },
      }),
    ).plan;
    expect(noWorkers.capabilities["notifications.web-push"]?.approved).toBe(
      false,
    );
  });

  it("WORKER_GRAPH_UNAVAILABLE: constraints no single variant serves together drop both capabilities", () => {
    const catalog = buildCatalog(
      FIXTURE_CATALOG.capabilities
        .filter((d) => d.tier === "core")
        .map(({ exposureDigest: _digest, ...d }) => d)
        .concat([
          { ...blank("a.push"), workerGraphConstraint: "push" },
          { ...blank("a.sync"), workerGraphConstraint: "sync" },
        ]),
      1,
    );
    const distribution = {
      ...FIXTURE_DISTRIBUTION,
      capabilityIds: catalog.capabilities.map((d) => d.id),
      moduleIds: catalog.capabilities.flatMap((d) => d.moduleIds),
      workerVariants: [
        { id: "push", scriptPath: "sw-push.js", satisfies: ["push"] },
        { id: "sync", scriptPath: "sw-sync.js", satisfies: ["sync"] },
      ],
    };
    const selection = fixtureSelection({
      instanceId: "personal-local",
      acceptedRequired: [],
      selectedOptional: ["a.push", "a.sync"],
    });
    const { plan } = resolveWithConsent(
      fixtureResolveInput({ catalog, distribution, installation: selection }),
    );
    expect(plan.approvedCapabilities).toEqual(CORE);
    expect(plan.requiredWorkerVariant).toBeNull();
    expect(plan.conflicts.map((c) => c.code)).toEqual([
      "WORKER_GRAPH_UNAVAILABLE",
      "WORKER_GRAPH_UNAVAILABLE",
    ]);
    expect(plan.capabilities["a.push"]?.reasons).toEqual([
      "WORKER_GRAPH_UNAVAILABLE",
    ]);
    const one = resolveWithConsent(
      fixtureResolveInput({
        catalog,
        distribution,
        installation: { ...selection, selectedOptional: ["a.sync"] },
      }),
    ).plan;
    expect(one.requiredWorkerVariant).toBe("sync");
  });
});

function blank(id: string) {
  return {
    id,
    descriptorVersion: 1,
    tier: "optional" as const,
    title: id,
    summary: "",
    dependencies: [],
    alternatives: [],
    operationIds: [],
    moduleIds: [`${id}/runtime`],
    environments: ["document" as const],
    egress: [],
    browserPermissions: [],
    keyAccess: "none" as const,
    requiresService: false,
    offlineLimits: "",
    workerGraphConstraint: null,
    requiresDocumentReload: false,
    itemKinds: [],
  };
}
