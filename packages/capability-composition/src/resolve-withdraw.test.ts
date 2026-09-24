import { describe, expect, it } from "vitest";
import { buildCatalog } from "./catalog.js";
import { buildConsentReceipt } from "./consent.js";
import { diagnoseRuntimeDocuments } from "./diagnose.js";
import { FIXTURE_DISTRIBUTION, fixtureResolveInput } from "./fixtures.js";
import type { ResolveInput } from "./resolve-input.js";
import { resolveComposition } from "./resolve.js";
import type {
  CapabilityDescriptor,
  CapabilityId,
  InstanceCapabilityPolicy,
} from "./types.js";

type Declared = Omit<CapabilityDescriptor, "exposureDigest">;

function capability(
  id: CapabilityId,
  overrides: Partial<Declared> = {},
): Declared {
  return {
    id,
    descriptorVersion: 1,
    tier: "core",
    title: id,
    summary: `${id}.`,
    dependencies: [],
    alternatives: [],
    operationIds: [],
    moduleIds: [`${id}/runtime`],
    environments: ["document"],
    egress: [],
    browserPermissions: [],
    keyAccess: "none",
    requiresService: false,
    offlineLimits: "",
    workerGraphConstraint: null,
    requiresDocumentReload: false,
    itemKinds: [],
    ...overrides,
  };
}

/**
 * Statically linked core (no module), an always-on host, an always-on
 * capability that needs it, and an optional one that needs it too — the
 * shape of `identity.local-iam`, `identity.siop` and a directory feature.
 */
const CATALOG = buildCatalog(
  [
    capability("shell.core", { moduleIds: [] }),
    capability("host.local"),
    capability("host.siop", { dependencies: ["host.local"] }),
    capability("feature.directory", {
      tier: "optional",
      dependencies: ["host.local"],
    }),
  ],
  1,
);

const DISTRIBUTION = {
  ...FIXTURE_DISTRIBUTION,
  capabilityIds: CATALOG.capabilities.map((d) => d.id),
  moduleIds: CATALOG.capabilities.flatMap((d) => d.moduleIds),
};

function policy(prohibited: CapabilityId[]): InstanceCapabilityPolicy {
  return {
    schemaVersion: 1,
    kind: "InstanceCapabilityPolicy",
    instanceId: "org",
    revision: "r1",
    presetProvenance: { id: "organization", version: 1 },
    capabilities: {
      default: "deny",
      required: [],
      optional: ["feature.directory"],
      prohibited,
    },
    network: { externalServices: "allow", allowedServiceOrigins: [] },
    updates: {
      unknownCapabilities: "deny",
      expandedExposure: "require-approval",
    },
  };
}

function input(overrides: Partial<ResolveInput>): ResolveInput {
  return fixtureResolveInput({
    catalog: CATALOG,
    distribution: DISTRIBUTION,
    provenance: "same-origin-deployment",
    installation: {
      schemaVersion: 1,
      kind: "InstallationCapabilitySelection",
      instanceId: "org",
      installationId: "fixture-installation",
      basePolicyRevision: "r1",
      revision: "1",
      acceptedRequired: [],
      selectedOptional: ["feature.directory"],
      chosenAlternatives: {},
      delivery: { prefetch: "none", offlineCache: "shell-only" },
    },
    ...overrides,
  });
}

/** Resolve once to learn the closure, sign it, resolve again with it. */
function resolved(overrides: Partial<ResolveInput>) {
  const first = resolveComposition(input(overrides));
  const receipt = buildConsentReceipt(first, CATALOG, "2026-09-24T00:00:00Z");
  return resolveComposition(input({ ...overrides, receipt }));
}

describe("an operator may withdraw an always-on capability (ADR 0140)", () => {
  it("runs every always-on capability while nothing is prohibited", () => {
    const plan = resolved({ instancePolicy: policy([]) });
    expect(plan.approvedCapabilities).toEqual([
      "feature.directory",
      "host.local",
      "host.siop",
      "shell.core",
    ]);
  });

  it("withdraws a prohibited always-on capability, what needs it, and the optional that needs it", () => {
    const plan = resolved({ instancePolicy: policy(["host.local"]) });
    expect(plan.approvedCapabilities).toEqual(["shell.core"]);
    expect(plan.approvedModules).not.toContain("host.local/runtime");
    expect(plan.capabilities["host.local"]?.reasons).toEqual([
      "PROHIBITED_BY_INSTANCE",
    ]);
    expect(plan.capabilities["host.local"]?.permitted).toBe(false);
    expect(plan.capabilities["host.siop"]?.approved).toBe(false);
    expect(plan.capabilities["feature.directory"]?.approved).toBe(false);
    expect(plan.capabilities["feature.directory"]?.reasons).toContain(
      "DEPENDENCY_CONFLICT",
    );
    expect(
      plan.conflicts.some(
        (conflict) => conflict.code === "DEPENDENCY_PROHIBITED",
      ),
    ).toBe(true);
  });

  it("never withdraws statically linked core, which has no module to leave out", () => {
    const plan = resolved({ instancePolicy: policy(["shell.core"]) });
    expect(plan.capabilities["shell.core"]?.approved).toBe(true);
    expect(plan.capabilities["shell.core"]?.reasons).toEqual(["CORE"]);
  });

  it("an unverified policy withdraws nothing", () => {
    const plan = resolved({
      instancePolicy: policy(["host.local"]),
      policyValid: false,
    });
    expect(plan.capabilities["host.local"]?.approved).toBe(true);
  });

  it("a withdrawal is a policy's to make, and statically linked core in it is still diagnosed", () => {
    const codes = (prohibited: CapabilityId[]) =>
      diagnoseRuntimeDocuments(
        input({ instancePolicy: policy(prohibited) }),
      ).map((d) => d.code);
    expect(codes(["host.local"])).not.toContain("CORE_IN_POLICY");
    expect(codes(["shell.core"])).toContain("CORE_IN_POLICY");
  });
});
