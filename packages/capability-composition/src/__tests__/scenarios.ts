/**
 * fast-check scenarios over the fixture catalog, shared by the determinism
 * (MODEL-07/08) and property suites. A scenario is a policy, an optional
 * workspace and vault restriction, a selection and a transport choice.
 */
import fc from "fast-check";
import {
  FIXTURE_CATALOG,
  FIXTURE_INSTALLATION,
  FIXTURE_POLICIES,
  fixtureResolveInput,
  fixtureSelection,
} from "../fixtures.js";
import type { ResolveInput } from "../resolve-input.js";
import type {
  CapabilityId,
  InstanceCapabilityPolicy,
  VaultCapabilitySelection,
  WorkspaceCapabilityRestriction,
} from "../types.js";

/** Recorded so a failure replays exactly; every run uses it. */
export const SEED = 20260922;
export const NOW = "2026-09-22T00:00:00.000Z";
const OPTIONAL: readonly CapabilityId[] = FIXTURE_CATALOG.capabilities
  .filter((d) => d.tier === "optional")
  .map((d) => d.id);

export type Scenario = Readonly<{
  policy: InstanceCapabilityPolicy;
  workspace: WorkspaceCapabilityRestriction | null;
  vault: VaultCapabilitySelection | null;
  selected: readonly CapabilityId[];
  transport: CapabilityId | null;
}>;

export const idSubset = fc.uniqueArray(fc.constantFrom(...OPTIONAL), {
  maxLength: OPTIONAL.length,
});

/** Partition the optional ids into required / optional / prohibited / unlisted. */
const policyArb: fc.Arbitrary<InstanceCapabilityPolicy> = fc
  .tuple(
    fc.array(fc.integer({ min: 0, max: 3 }), {
      minLength: OPTIONAL.length,
      maxLength: OPTIONAL.length,
    }),
    fc.boolean(),
  )
  .map(([buckets, allow]) => ({
    ...FIXTURE_POLICIES.family,
    capabilities: {
      default: "deny",
      required: OPTIONAL.filter((_, i) => buckets[i] === 0),
      optional: OPTIONAL.filter((_, i) => buckets[i] === 1),
      prohibited: OPTIONAL.filter((_, i) => buckets[i] === 2),
    },
    network: {
      externalServices: allow ? "allow" : "deny",
      allowedServiceOrigins: [],
    },
  }));

const workspaceArb: fc.Arbitrary<WorkspaceCapabilityRestriction | null> =
  fc.option(
    fc
      .tuple(fc.option(idSubset, { nil: null }), idSubset)
      .map(([allow, prohibited]) => ({
        schemaVersion: 1 as const,
        kind: "WorkspaceCapabilityRestriction" as const,
        instanceId: "fixture-family",
        vaultId: "tomb-1",
        revision: "w1",
        allow:
          allow === null
            ? null
            : allow.filter((id) => !prohibited.includes(id)),
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

export const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  policy: policyArb,
  workspace: workspaceArb,
  vault: vaultArb,
  selected: idSubset,
  transport: fc.constantFrom<CapabilityId | null>(
    "sharing.local-transport",
    "sharing.drops",
    null,
  ),
});

export function inputOf(s: Scenario): ResolveInput {
  return fixtureResolveInput({
    instancePolicy: s.policy,
    provenance: "same-origin-deployment",
    workspace: s.workspace,
    vault: s.vault,
    vaultId: "tomb-1",
    installation: fixtureSelection({
      acceptedRequired: s.policy.capabilities.required,
      selectedOptional: s.selected.filter(
        (id) => !s.policy.capabilities.required.includes(id),
      ),
      chosenAlternatives:
        s.transport === null ? {} : { transport: s.transport },
    }),
  });
}

/** Drop from optional/allow, add to prohibited/disabled — never the reverse. */
export function tighten(
  s: Scenario,
  drop: readonly CapabilityId[],
  deny: readonly CapabilityId[],
): Scenario {
  const caps = s.policy.capabilities;
  const optional = caps.optional.filter(
    (id) => !drop.includes(id) && !deny.includes(id),
  );
  const prohibited = [
    ...new Set([
      ...caps.prohibited,
      ...deny.filter((id) => !caps.required.includes(id)),
    ]),
  ];
  return {
    ...s,
    policy: {
      ...s.policy,
      capabilities: {
        default: "deny",
        required: caps.required,
        optional,
        prohibited,
      },
      network:
        drop.length % 2 === 0
          ? s.policy.network
          : { externalServices: "deny", allowedServiceOrigins: [] },
    },
    workspace:
      s.workspace === null
        ? null
        : {
            ...s.workspace,
            allow:
              s.workspace.allow === null
                ? null
                : s.workspace.allow.filter((id) => !drop.includes(id)),
            prohibited: [...new Set([...s.workspace.prohibited, ...deny])],
          },
    vault:
      s.vault === null
        ? null
        : {
            ...s.vault,
            disabled: [...new Set([...s.vault.disabled, ...drop])],
          },
  };
}

export function subset(
  smaller: readonly string[],
  larger: readonly string[],
): boolean {
  const big = new Set(larger);
  return smaller.every((x) => big.has(x));
}
