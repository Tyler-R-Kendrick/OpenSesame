import { describe, expect, it } from "vitest";
import { buildCatalog } from "./catalog.js";
import { buildConsentReceipt, computeConsentDelta } from "./consent.js";
import { diagnoseRuntimeDocuments } from "./diagnose.js";
import {
  FIXTURE_CATALOG,
  FIXTURE_DISTRIBUTION,
  FIXTURE_INSTALLATION,
  FIXTURE_POLICIES,
  fixtureResolveInput,
} from "./fixtures.js";
import type { ResolveInput } from "./resolve-input.js";
import { resolveComposition } from "./resolve.js";
import type { CapabilityCatalog, CapabilityDescriptor } from "./types.js";

const NOW = "2026-09-22T00:00:00.000Z";
const CORE = ["settings.core", "vault.passwords"];

const familyInput = (overrides: Partial<ResolveInput> = {}): ResolveInput =>
  fixtureResolveInput({
    instancePolicy: FIXTURE_POLICIES.family,
    provenance: "same-origin-deployment",
    installation: FIXTURE_INSTALLATION,
    ...overrides,
  });

/** A catalog with one descriptor rewritten (digest recomputed). */
function rewrite(
  catalog: CapabilityCatalog,
  id: string,
  change: (d: Omit<CapabilityDescriptor, "exposureDigest">) => Omit<CapabilityDescriptor, "exposureDigest">,
): CapabilityCatalog {
  return buildCatalog(
    catalog.capabilities.map(({ exposureDigest: _digest, ...d }) => (d.id === id ? change(d) : d)),
    catalog.catalogVersion + 1,
  );
}

describe("consent", () => {
  it("a receipt built from a plan covers exactly its closure and approves it", () => {
    const first = resolveComposition(familyInput());
    const receipt = buildConsentReceipt(first, FIXTURE_CATALOG, NOW);
    expect(receipt.roots).toEqual(["connectors.external", "identity.federation"]);
    expect(receipt.exposure).toEqual({
      "access.authority": FIXTURE_CATALOG.capabilities.find((d) => d.id === "access.authority")?.exposureDigest,
      "connectors.external": FIXTURE_CATALOG.capabilities.find((d) => d.id === "connectors.external")?.exposureDigest,
      "identity.federation": FIXTURE_CATALOG.capabilities.find((d) => d.id === "identity.federation")?.exposureDigest,
    });
    expect(receipt.receiptDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const plan = resolveComposition(familyInput({ receipt }));
    expect(plan.approvedCapabilities).toEqual(["access.authority", "connectors.external", "identity.federation", ...CORE]);
    expect(computeConsentDelta(plan, FIXTURE_CATALOG, receipt)).toEqual({
      addedRoots: [],
      removedRoots: [],
      changedExposure: [],
      addedDependencies: [],
      requiredNotAccepted: [],
    });
    expect(computeConsentDelta(plan, FIXTURE_CATALOG, null).addedRoots).toEqual(["connectors.external", "identity.federation"]);
  });

  it("a receipt for another installation or instance does not count", () => {
    const first = resolveComposition(familyInput());
    const receipt = buildConsentReceipt(first, FIXTURE_CATALOG, NOW);
    const foreign = resolveComposition(familyInput({ receipt: { ...receipt, installationId: "other-device" } }));
    expect(foreign.approvedCapabilities).toEqual(CORE);
    expect(foreign.capabilities["connectors.external"]?.reasons).toEqual(["CONSENT_REQUIRED"]);
  });

  it("CONSENT-04: a capability the catalog gains later is neither selected nor approved", () => {
    const first = resolveComposition(familyInput());
    const receipt = buildConsentReceipt(first, FIXTURE_CATALOG, NOW);
    const grown = buildCatalog(
      [
        ...FIXTURE_CATALOG.capabilities.map(({ exposureDigest: _digest, ...d }) => d),
        {
          id: "activity.log",
          descriptorVersion: 1,
          tier: "optional",
          title: "Activity",
          summary: "A local activity log.",
          dependencies: [],
          alternatives: [],
          operationIds: ["pages.activity.list"],
          moduleIds: ["activity.log/runtime"],
          environments: ["document"],
          egress: [],
          browserPermissions: [],
          keyAccess: "none",
          requiresService: false,
          offlineLimits: "",
          workerGraphConstraint: null,
          requiresDocumentReload: false,
          itemKinds: [],
        },
      ],
      2,
    );
    const distribution = {
      ...FIXTURE_DISTRIBUTION,
      capabilityIds: [...FIXTURE_DISTRIBUTION.capabilityIds, "activity.log"],
      moduleIds: [...FIXTURE_DISTRIBUTION.moduleIds, "activity.log/runtime"],
    };
    const policy = {
      ...FIXTURE_POLICIES.family,
      capabilities: { ...FIXTURE_POLICIES.family.capabilities, optional: [...FIXTURE_POLICIES.family.capabilities.optional, "activity.log"] },
    };
    const plan = resolveComposition(familyInput({ catalog: grown, distribution, instancePolicy: policy, receipt }));
    expect(plan.capabilities["activity.log"]?.selected).toBe(false);
    expect(plan.capabilities["activity.log"]?.approved).toBe(false);
    expect(plan.capabilities["activity.log"]?.reasons).toEqual(["NOT_SELECTED"]);
    expect(plan.approvedOperations).not.toContain("pages.activity.list");
    expect(plan.approvedCapabilities).toEqual(["access.authority", "connectors.external", "identity.federation", ...CORE]);
    expect(plan.consent.addedRoots).toEqual([]);
  });

  it("CONSENT-05: a changed egress declaration re-opens consent for that capability", () => {
    const first = resolveComposition(familyInput());
    const receipt = buildConsentReceipt(first, FIXTURE_CATALOG, NOW);
    const changed = rewrite(FIXTURE_CATALOG, "connectors.external", (d) => ({
      ...d,
      egress: [...d.egress, { class: "external-service", purpose: "a usage beacon", automatic: true }],
    }));
    const plan = resolveComposition(familyInput({ catalog: changed, receipt }));
    expect(plan.capabilities["connectors.external"]?.approved).toBe(false);
    expect(plan.capabilities["connectors.external"]?.reasons).toEqual(["CONSENT_REQUIRED"]);
    expect(plan.consent.changedExposure).toEqual(["connectors.external"]);
    expect(plan.consent.addedRoots).toEqual([]);
    expect(plan.approvedCapabilities).toEqual(["access.authority", "identity.federation", ...CORE]);
    const renewed = buildConsentReceipt(plan, changed, NOW);
    expect(resolveComposition(familyInput({ catalog: changed, receipt: renewed })).approvedCapabilities).toContain("connectors.external");
  });

  it("CONSENT-05: a new dependency appears as changedExposure on the root and addedDependencies for the dependency", () => {
    const first = resolveComposition(familyInput());
    const receipt = buildConsentReceipt(first, FIXTURE_CATALOG, NOW);
    const changed = rewrite(FIXTURE_CATALOG, "connectors.external", (d) => ({
      ...d,
      dependencies: [...d.dependencies, "vault.passkey-records"],
    }));
    const plan = resolveComposition(familyInput({ catalog: changed, receipt }));
    expect(plan.consent.changedExposure).toEqual(["connectors.external"]);
    expect(plan.consent.addedDependencies).toEqual(["vault.passkey-records"]);
    expect(plan.capabilities["vault.passkey-records"]?.approved).toBe(false);
    expect(plan.capabilities["vault.passkey-records"]?.reasons).toEqual(["CONSENT_REQUIRED"]);
    expect(plan.capabilities["vault.passkey-records"]?.dependencyOf).toEqual(["connectors.external"]);
    expect(plan.approvedCapabilities).not.toContain("connectors.external");
    expect(computeConsentDelta(plan, changed, receipt)).toEqual(plan.consent);
    const renewed = buildConsentReceipt(plan, changed, NOW);
    const approved = resolveComposition(familyInput({ catalog: changed, receipt: renewed }));
    expect(approved.approvedCapabilities).toEqual(["access.authority", "connectors.external", "identity.federation", "settings.core", "vault.passkey-records", "vault.passwords"]);
  });

  it("a root dropped from the selection shows up as removedRoots", () => {
    const first = resolveComposition(familyInput());
    const receipt = buildConsentReceipt(first, FIXTURE_CATALOG, NOW);
    const plan = resolveComposition(familyInput({ installation: { ...FIXTURE_INSTALLATION, selectedOptional: [] }, receipt }));
    expect(plan.consent.removedRoots).toEqual(["connectors.external"]);
    expect(plan.approvedCapabilities).toEqual(["identity.federation", ...CORE]);
  });
});

describe("diagnoseRuntimeDocuments", () => {
  it("names unknown ids, core ids in policy sets, unknown modules and unknown slots", () => {
    const diags = diagnoseRuntimeDocuments(
      familyInput({
        instancePolicy: {
          ...FIXTURE_POLICIES.family,
          capabilities: { ...FIXTURE_POLICIES.family.capabilities, optional: [...FIXTURE_POLICIES.family.capabilities.optional, "never.here", "vault.passwords"] },
        },
        installation: { ...FIXTURE_INSTALLATION, chosenAlternatives: { nowhere: "sharing.drops" } },
        distribution: { ...FIXTURE_DISTRIBUTION, moduleIds: [...FIXTURE_DISTRIBUTION.moduleIds, "ghost.cap/runtime"] },
      }),
    );
    expect(diags.map((d) => d.code)).toEqual(["UNKNOWN_CAPABILITY", "CORE_IN_POLICY", "UNKNOWN_MODULE", "UNKNOWN_SLOT"]);
    expect(diags[0]?.path).toBe("instancePolicy.capabilities.optional[8]");
    expect(diagnoseRuntimeDocuments(familyInput())).toEqual([]);
  });
});
