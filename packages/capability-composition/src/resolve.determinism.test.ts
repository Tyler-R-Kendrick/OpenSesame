/**
 * MODEL-07 (input order never reaches the plan) and MODEL-08 (a tightening
 * never grows the approved sets).
 *
 * fast-check seed: 20260922. Recorded so a failure replays exactly; every
 * run here uses the same seed and the same run count.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildConsentReceipt } from "./consent.js";
import {
  FIXTURE_CATALOG,
  FIXTURE_DISTRIBUTION,
  FIXTURE_INSTALLATION,
  FIXTURE_POLICIES,
  fixtureResolveInput,
  fixtureSelection,
} from "./fixtures.js";
import type { ResolveInput } from "./resolve-input.js";
import { explainCapability, resolveComposition } from "./resolve.js";
import type {
  CapabilityId,
  InstanceCapabilityPolicy,
  VaultCapabilitySelection,
  WorkspaceCapabilityRestriction,
} from "./types.js";

const SEED = 20260922;
const NOW = "2026-09-22T00:00:00.000Z";
const OPTIONAL: readonly CapabilityId[] = FIXTURE_CATALOG.capabilities
  .filter((d) => d.tier === "optional")
  .map((d) => d.id);

function reversed<T>(items: readonly T[]): T[] {
  return [...items].reverse();
}

describe("MODEL-07: determinism", () => {
  it("reordering every input list yields an identical plan digest and explanations", () => {
    const selection = fixtureSelection({
      selectedOptional: ["connectors.external", "sharing.household", "vault.passkey-records"],
      chosenAlternatives: { transport: "sharing.drops" },
    });
    const forward = fixtureResolveInput({
      instancePolicy: FIXTURE_POLICIES.family,
      installation: selection,
      workspace: {
        schemaVersion: 1,
        kind: "WorkspaceCapabilityRestriction",
        instanceId: "fixture-family",
        vaultId: "tomb-1",
        revision: "w1",
        allow: ["connectors.external", "access.authority", "identity.federation", "sharing.household", "sharing.drops"],
        prohibited: ["telemetry.external", "vault.passkey-records"],
      },
      vaultId: "tomb-1",
    });
    const first = resolveComposition(forward);
    const receipt = buildConsentReceipt(first, FIXTURE_CATALOG, NOW);
    const policy = FIXTURE_POLICIES.family;
    const backward: ResolveInput = {
      ...forward,
      receipt: { ...receipt, roots: reversed(receipt.roots) },
      catalog: { ...FIXTURE_CATALOG, capabilities: reversed(FIXTURE_CATALOG.capabilities) },
      distribution: {
        ...FIXTURE_DISTRIBUTION,
        capabilityIds: reversed(FIXTURE_DISTRIBUTION.capabilityIds),
        moduleIds: reversed(FIXTURE_DISTRIBUTION.moduleIds),
        workerVariants: reversed(FIXTURE_DISTRIBUTION.workerVariants),
      },
      instancePolicy: {
        ...policy,
        capabilities: {
          default: "deny",
          required: reversed(policy.capabilities.required),
          optional: reversed(policy.capabilities.optional),
          prohibited: reversed(policy.capabilities.prohibited),
        },
      },
      installation: {
        ...selection,
        selectedOptional: reversed(selection.selectedOptional),
        acceptedRequired: reversed(selection.acceptedRequired),
      },
      workspace:
        forward.workspace === null
          ? null
          : { ...forward.workspace, allow: reversed(forward.workspace.allow ?? []), prohibited: reversed(forward.workspace.prohibited) },
    };
    const a = resolveComposition({ ...forward, receipt });
    const b = resolveComposition(backward);
    expect(a.identity.planDigest).toBe(b.identity.planDigest);
    expect(a).toEqual(b);
    expect(a.approvedCapabilities.length).toBeGreaterThan(2);
    for (const id of Object.keys(a.capabilities)) {
      expect(explainCapability(a, id)).toEqual(explainCapability(b, id));
    }
  });
});

type Scenario = Readonly<{
  policy: InstanceCapabilityPolicy;
  workspace: WorkspaceCapabilityRestriction | null;
  vault: VaultCapabilitySelection | null;
  selected: readonly CapabilityId[];
  transport: CapabilityId | null;
}>;

const idSubset = fc.uniqueArray(fc.constantFrom(...OPTIONAL), { maxLength: OPTIONAL.length });

/** Partition the optional ids into required / optional / prohibited / unlisted. */
const policyArb: fc.Arbitrary<InstanceCapabilityPolicy> = fc
  .tuple(fc.array(fc.integer({ min: 0, max: 3 }), { minLength: OPTIONAL.length, maxLength: OPTIONAL.length }), fc.boolean())
  .map(([buckets, allow]) => ({
    ...FIXTURE_POLICIES.family,
    capabilities: {
      default: "deny",
      required: OPTIONAL.filter((_, i) => buckets[i] === 0),
      optional: OPTIONAL.filter((_, i) => buckets[i] === 1),
      prohibited: OPTIONAL.filter((_, i) => buckets[i] === 2),
    },
    network: { externalServices: allow ? "allow" : "deny", allowedServiceOrigins: [] },
  }));

const workspaceArb: fc.Arbitrary<WorkspaceCapabilityRestriction | null> = fc.option(
  fc.tuple(fc.option(idSubset, { nil: null }), idSubset).map(([allow, prohibited]) => ({
    schemaVersion: 1 as const,
    kind: "WorkspaceCapabilityRestriction" as const,
    instanceId: "fixture-family",
    vaultId: "tomb-1",
    revision: "w1",
    allow: allow === null ? null : allow.filter((id) => !prohibited.includes(id)),
    prohibited,
  })),
  { nil: null },
);

const vaultArb: fc.Arbitrary<VaultCapabilitySelection | null> = fc.option(
  idSubset.map((disabled) => ({
    schemaVersion: 1 as const,
    kind: "VaultCapabilitySelection" as const,
    instanceId: "fixture-family",
    installationId: FIXTURE_INSTALLATION.installationId,
    vaultId: "tomb-1",
    revision: "v1",
    disabled,
  })),
  { nil: null },
);

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  policy: policyArb,
  workspace: workspaceArb,
  vault: vaultArb,
  selected: idSubset,
  transport: fc.constantFrom<CapabilityId | null>("sharing.local-transport", "sharing.drops", null),
});

function inputOf(s: Scenario): ResolveInput {
  return fixtureResolveInput({
    instancePolicy: s.policy,
    provenance: "same-origin-deployment",
    workspace: s.workspace,
    vault: s.vault,
    vaultId: "tomb-1",
    installation: fixtureSelection({
      acceptedRequired: s.policy.capabilities.required,
      selectedOptional: s.selected.filter((id) => !s.policy.capabilities.required.includes(id)),
      chosenAlternatives: s.transport === null ? {} : { transport: s.transport },
    }),
  });
}

/** Drop from optional/allow, add to prohibited/disabled — never the reverse. */
function tighten(s: Scenario, drop: readonly CapabilityId[], deny: readonly CapabilityId[]): Scenario {
  const caps = s.policy.capabilities;
  const optional = caps.optional.filter((id) => !drop.includes(id) && !deny.includes(id));
  const prohibited = [...new Set([...caps.prohibited, ...deny.filter((id) => !caps.required.includes(id))])];
  return {
    ...s,
    policy: {
      ...s.policy,
      capabilities: { default: "deny", required: caps.required, optional, prohibited },
      network: drop.length % 2 === 0 ? s.policy.network : { externalServices: "deny", allowedServiceOrigins: [] },
    },
    workspace:
      s.workspace === null
        ? null
        : {
            ...s.workspace,
            allow: s.workspace.allow === null ? null : s.workspace.allow.filter((id) => !drop.includes(id)),
            prohibited: [...new Set([...s.workspace.prohibited, ...deny])],
          },
    vault:
      s.vault === null ? null : { ...s.vault, disabled: [...new Set([...s.vault.disabled, ...drop])] },
  };
}

function subset(smaller: readonly string[], larger: readonly string[]): boolean {
  const big = new Set(larger);
  return smaller.every((x) => big.has(x));
}

describe("MODEL-08: restrictions are monotone", () => {
  it("tightening a policy never grows approvedCapabilities, approvedModules or approvedOperations", () => {
    fc.assert(
      fc.property(scenarioArb, idSubset, idSubset, (scenario, drop, deny) => {
        const before = resolveComposition(inputOf(scenario));
        const receipt = buildConsentReceipt(before, FIXTURE_CATALOG, NOW);
        const consented = resolveComposition({ ...inputOf(scenario), receipt });
        const after = resolveComposition({ ...inputOf(tighten(scenario, drop, deny)), receipt });
        expect(subset(after.approvedCapabilities, consented.approvedCapabilities)).toBe(true);
        expect(subset(after.approvedModules, consented.approvedModules)).toBe(true);
        expect(subset(after.approvedOperations, consented.approvedOperations)).toBe(true);
        expect(subset(after.approvedItemKinds, consented.approvedItemKinds)).toBe(true);
        expect(consented.approvedCapabilities).toEqual(expect.arrayContaining(["settings.core", "vault.passwords"]));
      }),
      { numRuns: 400, seed: SEED },
    );
  });

  it("the plan digest is a pure function of the input", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const input = inputOf(scenario);
        expect(resolveComposition(input)).toEqual(resolveComposition(input));
      }),
      { numRuns: 100, seed: SEED },
    );
  });
});
