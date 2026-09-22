import { describe, expect, it } from "vitest";
import { buildCatalog } from "./catalog.js";
import { buildConsentReceipt } from "./consent.js";
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
function resolveWithConsent(input: ResolveInput): { plan: EffectivePlan; receipt: ConsentReceipt } {
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

describe("resolveComposition", () => {
  it("MODEL-01: no selection and no policy approves only core; every optional is off", () => {
    const plan = resolveComposition(fixtureResolveInput());
    expect(plan.approvedCapabilities).toEqual(CORE);
    expect(plan.approvedModules).toEqual(["settings.core/runtime", "vault.passwords/runtime"]);
    expect(plan.approvedOperations).toEqual(["pages.items.edit", "pages.items.list", "pages.settings.prefs.edit"]);
    expect(plan.approvedItemKinds).toEqual(["login", "note"]);
    expect(plan.requiredWorkerVariant).toBeNull();
    expect(plan.conflicts).toEqual([]);
    expect(plan.consent).toEqual({ addedRoots: [], removedRoots: [], changedExposure: [], addedDependencies: [], requiredNotAccepted: [] });
    expect(Object.keys(plan.capabilities)).toEqual(FIXTURE_CATALOG.capabilities.map((d) => d.id).sort());
    for (const id of optionalIds(plan)) {
      const state = plan.capabilities[id];
      expect(state?.approved).toBe(false);
      expect(state?.selected).toBe(false);
      expect(state?.reasons).toContain("NOT_SELECTED");
    }
    for (const id of CORE) expect(plan.capabilities[id]?.reasons).toEqual(["CORE"]);
    expect(plan.network).toEqual({ externalServices: "allow", allowedServiceOrigins: [] });
    expect(plan.identity.instanceId).toBe("personal-local");
  });

  it("approves a selected root and its dependency chain once consent covers them", () => {
    const { plan, receipt } = resolveWithConsent(familyInput());
    expect(plan.approvedCapabilities).toEqual([
      "access.authority",
      "connectors.external",
      "identity.federation",
      ...CORE,
    ]);
    expect(plan.capabilities["access.authority"]?.dependencyOf).toEqual(["connectors.external"]);
    expect(plan.capabilities["access.authority"]?.selected).toBe(false);
    expect(plan.capabilities["identity.federation"]?.required).toBe(true);
    expect(plan.capabilities["identity.federation"]?.selected).toBe(true);
    expect(receipt.roots).toEqual(["connectors.external", "identity.federation"]);
    expect(Object.keys(receipt.exposure).sort()).toEqual(["access.authority", "connectors.external", "identity.federation"]);
    expect(plan.consent.addedRoots).toEqual([]);
    const explanation = explainCapability(plan, "identity.federation");
    expect(explanation.via).toEqual([]);
    expect(explainCapability(plan, "access.authority").via).toEqual(["connectors.external"]);
    expect(plan.identity.planDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("without a receipt the closure is CONSENT_REQUIRED and listed in the delta", () => {
    const plan = resolveComposition(familyInput());
    expect(plan.approvedCapabilities).toEqual(CORE);
    expect(plan.capabilities["connectors.external"]?.reasons).toEqual(["CONSENT_REQUIRED"]);
    expect(plan.capabilities["access.authority"]?.reasons).toEqual(["CONSENT_REQUIRED"]);
    expect(plan.consent.addedRoots).toEqual(["connectors.external", "identity.federation"]);
    expect(plan.consent.addedDependencies).toEqual(["access.authority"]);
  });

  it("MODEL-04: a selected root whose dependency is prohibited conflicts; neither is approved and no module ships", () => {
    const policy = {
      ...FIXTURE_POLICIES.family,
      capabilities: {
        default: "deny" as const,
        required: ["identity.federation"],
        optional: ["connectors.external", "vault.passkey-records"],
        prohibited: ["access.authority", "telemetry.external"],
      },
    };
    const { plan } = resolveWithConsent(familyInput({ instancePolicy: policy }));
    expect(plan.conflicts).toEqual([
      {
        code: "DEPENDENCY_PROHIBITED",
        capability: "connectors.external",
        subject: "access.authority",
        message: expect.stringContaining("PROHIBITED_BY_INSTANCE"),
      },
    ]);
    expect(plan.capabilities["connectors.external"]?.approved).toBe(false);
    expect(plan.capabilities["connectors.external"]?.reasons).toEqual(["DEPENDENCY_CONFLICT"]);
    expect(plan.capabilities["access.authority"]?.approved).toBe(false);
    expect(plan.capabilities["access.authority"]?.reasons).toEqual(["PROHIBITED_BY_INSTANCE"]);
    expect(plan.capabilities["access.authority"]?.dependencyOf).toEqual(["connectors.external"]);
    expect(plan.approvedModules).not.toContain("connectors.external/runtime");
    expect(plan.approvedModules).not.toContain("access.authority/runtime");
    expect(plan.approvedCapabilities).toEqual(["identity.federation", ...CORE]);
    expect(explainCapability(plan, "access.authority").conflicts).toHaveLength(1);
  });

  it("MODEL-05: when the chosen local alternative is unavailable the remote one is never substituted", () => {
    const distribution = {
      ...FIXTURE_DISTRIBUTION,
      capabilityIds: FIXTURE_DISTRIBUTION.capabilityIds.filter((id) => id !== "sharing.local-transport"),
    };
    const selection = fixtureSelection({
      instanceId: "personal-local",
      acceptedRequired: [],
      selectedOptional: ["sharing.household"],
      chosenAlternatives: { transport: "sharing.local-transport" },
    });
    const { plan } = resolveWithConsent(fixtureResolveInput({ distribution, installation: selection }));
    expect(plan.conflicts).toEqual([
      expect.objectContaining({ code: "ALTERNATIVE_NOT_ALLOWED", capability: "sharing.household", subject: "sharing.local-transport" }),
    ]);
    expect(plan.capabilities["sharing.household"]?.approved).toBe(false);
    expect(plan.capabilities["sharing.drops"]?.approved).toBe(false);
    expect(plan.capabilities["sharing.drops"]?.dependencyOf).toEqual([]);
    expect(plan.capabilities["sharing.drops"]?.reasons).toEqual(["NOT_SELECTED"]);
    expect(plan.approvedCapabilities).toEqual(CORE);
    const unchosen = resolveComposition(fixtureResolveInput({ installation: { ...selection, chosenAlternatives: {} } }));
    expect(unchosen.conflicts).toEqual([
      expect.objectContaining({ code: "ALTERNATIVE_NOT_CHOSEN", capability: "sharing.household", subject: "transport" }),
    ]);
    expect(unchosen.capabilities["sharing.household"]?.reasons).toEqual(["DEPENDENCY_CONFLICT", "ALTERNATIVE_NOT_CHOSEN"]);
    expect(unchosen.capabilities["sharing.drops"]?.approved).toBe(false);
    const wrong = resolveComposition(fixtureResolveInput({ installation: { ...selection, chosenAlternatives: { transport: "telemetry.external" } } }));
    expect(wrong.conflicts[0]?.code).toBe("ALTERNATIVE_NOT_ALLOWED");
  });

  it("MODEL-09: an unsupported environment yields UNSUPPORTED_RUNTIME and no approval", () => {
    const selection = fixtureSelection({ instanceId: "personal-local", acceptedRequired: [], selectedOptional: ["support.local-ai"] });
    const { plan } = resolveWithConsent(fixtureResolveInput({ installation: selection }));
    expect(plan.capabilities["support.local-ai"]?.runtimeSupported).toBe(false);
    expect(plan.capabilities["support.local-ai"]?.reasons).toEqual(["UNSUPPORTED_RUNTIME"]);
    expect(plan.capabilities["support.local-ai"]?.approved).toBe(false);
    const hosted = resolveWithConsent(
      fixtureResolveInput({ installation: selection, facts: { ...FIXTURE_FACTS, environments: [...FIXTURE_FACTS.environments, "shared-worker"] } }),
    ).plan;
    expect(hosted.capabilities["support.local-ai"]?.approved).toBe(true);
  });

  it("MODEL-10: a declined required root refuses the join and widens nothing", () => {
    const selection = fixtureSelection({ acceptedRequired: [], selectedOptional: ["vault.passkey-records", "connectors.external"] });
    const { plan } = resolveWithConsent(familyInput({ installation: selection }));
    expect(plan.consent.requiredNotAccepted).toEqual(["identity.federation"]);
    expect(plan.consent.addedRoots).toEqual([]);
    expect(plan.approvedCapabilities).toEqual(CORE);
    expect(plan.capabilities["identity.federation"]?.reasons).toContain("REQUIRED_NOT_ACCEPTED");
    expect(plan.capabilities["identity.federation"]?.approved).toBe(false);
    expect(plan.capabilities["vault.passkey-records"]?.reasons).toContain("REQUIRED_NOT_ACCEPTED");
    expect(plan.capabilities["vault.passkey-records"]?.approved).toBe(false);
    expect(plan.approvedModules).toEqual(resolveComposition(fixtureResolveInput()).approvedModules);
  });

  it("policyValid:false yields a core-only plan with POLICY_UNVERIFIED on every optional capability", () => {
    const { plan } = resolveWithConsent(familyInput({ policyValid: false, provenance: "invitation-unverified" }));
    expect(plan.approvedCapabilities).toEqual(CORE);
    expect(plan.policyValid).toBe(false);
    for (const id of optionalIds(plan)) {
      expect(plan.capabilities[id]?.reasons).toContain("POLICY_UNVERIFIED");
      expect(plan.capabilities[id]?.permitted).toBe(false);
    }
    expect(plan.network.externalServices).toBe("deny");
    expect(plan.consent.requiredNotAccepted).toEqual([]);
  });

  it("personal-local ceiling is every distributed optional capability with an allow network", () => {
    const selection = fixtureSelection({ instanceId: "personal-local", acceptedRequired: [], selectedOptional: ["telemetry.external", "vault.passkey-records"] });
    const { plan } = resolveWithConsent(fixtureResolveInput({ installation: selection }));
    expect(plan.approvedCapabilities).toEqual([...CORE, "telemetry.external", "vault.passkey-records"]);
    expect(plan.approvedItemKinds).toEqual(["login", "note", "passkey"]);
    for (const id of optionalIds(plan)) expect(plan.capabilities[id]?.permitted).toBe(plan.capabilities[id]?.distributed);
  });

  it("NETWORK_POLICY_DENIES blocks automatic external egress under a deny network", () => {
    const policy = { ...FIXTURE_POLICIES.family, network: { externalServices: "deny" as const, allowedServiceOrigins: [] } };
    const selection = fixtureSelection({ selectedOptional: ["sharing.household", "sharing.drops"], chosenAlternatives: { transport: "sharing.drops" } });
    const { plan } = resolveWithConsent(familyInput({ instancePolicy: policy, installation: selection }));
    expect(plan.capabilities["sharing.drops"]?.reasons).toEqual(["NETWORK_POLICY_DENIES"]);
    expect(plan.capabilities["sharing.household"]?.approved).toBe(false);
    expect(plan.conflicts).toEqual([
      expect.objectContaining({ code: "ALTERNATIVE_NOT_ALLOWED", capability: "sharing.household", subject: "sharing.drops" }),
    ]);
    expect(plan.capabilities["identity.federation"]?.approved).toBe(true);
  });

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
    const { plan } = resolveWithConsent(familyInput({ vault, vaultId: "tomb-1" }));
    expect(plan.capabilities["access.authority"]?.reasons).toEqual(["DISABLED_IN_VAULT"]);
    expect(plan.conflicts[0]?.code).toBe("DEPENDENCY_NOT_PERMITTED");
    expect(plan.approvedCapabilities).toEqual(["identity.federation", ...CORE]);
  });

  it("RESTART_REQUIRED marks a no-longer-approved capability whose module was evaluated", () => {
    const plan = resolveComposition(
      fixtureResolveInput({ facts: { ...FIXTURE_FACTS, cleanRealm: false, evaluatedModuleIds: ["telemetry.external/runtime"] } }),
    );
    expect(plan.capabilities["telemetry.external"]?.restartRequired).toBe(true);
    expect(plan.capabilities["telemetry.external"]?.reasons).toEqual(["NOT_SELECTED", "RESTART_REQUIRED"]);
  });

  it("a selection for another installation or instance is ignored with PROFILE_MISMATCH", () => {
    const plan = resolveComposition(familyInput({ installationId: "someone-else" }));
    expect(plan.approvedCapabilities).toEqual(CORE);
    expect(plan.capabilities["connectors.external"]?.selected).toBe(false);
    expect(plan.capabilities["connectors.external"]?.reasons).toContain("PROFILE_MISMATCH");
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
    const selection = fixtureSelection({ selectedOptional: ["notifications.web-push"] });
    const { plan } = resolveWithConsent(familyInput({ installation: selection }));
    expect(plan.requiredWorkerVariant).toBe("push");
    expect(plan.approvedModules).toContain("notifications.web-push/worker");
    expect(plan.capabilities["notifications.web-push"]?.approved).toBe(true);
  });

  it("WORKER_GRAPH_UNAVAILABLE: without a satisfying variant the capability is not approved", () => {
    const distribution = {
      ...FIXTURE_DISTRIBUTION,
      workerVariants: FIXTURE_DISTRIBUTION.workerVariants.filter((v) => v.id !== "push"),
    };
    const selection = fixtureSelection({ selectedOptional: ["notifications.web-push"] });
    const { plan } = resolveWithConsent(familyInput({ installation: selection, distribution }));
    expect(plan.capabilities["notifications.web-push"]?.approved).toBe(false);
    expect(plan.capabilities["notifications.web-push"]?.reasons).toEqual(["WORKER_GRAPH_UNAVAILABLE"]);
    expect(plan.conflicts).toEqual([
      expect.objectContaining({ code: "WORKER_GRAPH_UNAVAILABLE", capability: "notifications.web-push", subject: "push" }),
    ]);
    expect(plan.requiredWorkerVariant).toBeNull();
    const noWorkers = resolveWithConsent(familyInput({ installation: selection, facts: { ...FIXTURE_FACTS, serviceWorkerAvailable: false } })).plan;
    expect(noWorkers.capabilities["notifications.web-push"]?.approved).toBe(false);
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
    const selection = fixtureSelection({ instanceId: "personal-local", acceptedRequired: [], selectedOptional: ["a.push", "a.sync"] });
    const { plan } = resolveWithConsent(fixtureResolveInput({ catalog, distribution, installation: selection }));
    expect(plan.approvedCapabilities).toEqual(CORE);
    expect(plan.requiredWorkerVariant).toBeNull();
    expect(plan.conflicts.map((c) => c.code)).toEqual(["WORKER_GRAPH_UNAVAILABLE", "WORKER_GRAPH_UNAVAILABLE"]);
    expect(plan.capabilities["a.push"]?.reasons).toEqual(["WORKER_GRAPH_UNAVAILABLE"]);
    const one = resolveWithConsent(fixtureResolveInput({ catalog, distribution, installation: { ...selection, selectedOptional: ["a.sync"] } })).plan;
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
