/**
 * Capability composition (ADR 0130) against hostile documents — carried
 * forward from #470's `capability_composition` target onto today's resolver.
 *
 * Ids are drawn from real fixture ids and hostile fragments (prototype
 * member names, empty, upper case, oversize), written into raw policy and
 * selection documents, parsed, and resolved. Oracles:
 *   1. no parser, resolve or explain call throws;
 *   2. a policy that does not parse never yields an optional approval;
 *   3. nothing is approved that no one wanted — every approved optional
 *      capability is in the dependency/alternative closure of the ids the
 *      selection names;
 *   4. nothing prohibited by the policy is ever approved.
 */
import {
  type CapabilityCatalog,
  type CapabilityId,
  FIXTURE_CATALOG,
  FIXTURE_INSTALLATION_ID,
  type InstallationCapabilitySelection,
  type InstanceCapabilityPolicy,
  buildConsentReceipt,
  explainCapability,
  fixtureResolveInput,
  parseInstallationSelection,
  parseInstancePolicy,
  resolveComposition,
} from "@opensesame/capability-composition";
import { FuzzedDataProvider } from "./provider.js";

const CATALOG_IDS = FIXTURE_CATALOG.capabilities.map((d) => d.id);
const HOSTILE = [
  "ghost.capability",
  "__proto__",
  "constructor",
  "toString",
  "",
  "UPPER.case",
  "a b",
  `x.${"y".repeat(250)}`,
];
const FRAGMENTS = [...CATALOG_IDS, ...HOSTILE];

function pickFrom(p: FuzzedDataProvider, pool: readonly string[]): string {
  return pool[p.consumeIntegralInRange(0, pool.length - 1)] ?? "";
}

/** A catalog id most of the time; a hostile fragment one draw in eight. */
function pick(p: FuzzedDataProvider, pool: readonly string[]): string {
  return p.consumeIntegralInRange(0, 7) === 0
    ? pickFrom(p, HOSTILE)
    : pickFrom(p, pool);
}

/** Distinct ids, so a parse fails on what was drawn, not on a repeat. */
function pickIds(
  p: FuzzedDataProvider,
  max: number,
  pool: readonly string[],
): string[] {
  const count = p.consumeIntegralInRange(0, max);
  return [...new Set(Array.from({ length: count }, () => pick(p, pool)))];
}

function rawPolicy(p: FuzzedDataProvider) {
  const required = pickIds(p, 2, CATALOG_IDS);
  const optional = pickIds(p, 6, CATALOG_IDS).filter(
    (id) => !required.includes(id),
  );
  // Now and then a contradiction on purpose, so rejection is fuzzed too.
  const rest =
    p.consumeIntegralInRange(0, 15) === 0
      ? CATALOG_IDS
      : CATALOG_IDS.filter(
          (id) => !required.includes(id) && !optional.includes(id),
        );
  return {
    schemaVersion: 1,
    kind: "InstanceCapabilityPolicy",
    instanceId: "fixture-family",
    revision: "fuzz-r1",
    presetProvenance: null,
    capabilities: {
      default: "deny",
      required,
      optional,
      prohibited: rest.length > 0 ? pickIds(p, 2, rest) : [],
    },
    network: {
      externalServices: p.consumeBoolean() ? "allow" : "deny",
      allowedServiceOrigins: [],
    },
    updates: {
      unknownCapabilities: "deny",
      expandedExposure: "require-approval",
    },
  };
}

function rawSelection(
  p: FuzzedDataProvider,
  policy: ReturnType<typeof rawPolicy>,
) {
  const offered = policy.capabilities.optional;
  const required = policy.capabilities.required;
  return {
    schemaVersion: 1,
    kind: "InstallationCapabilitySelection",
    instanceId: "fixture-family",
    installationId: FIXTURE_INSTALLATION_ID,
    basePolicyRevision: "fuzz-r1",
    revision: "fuzz-selection",
    acceptedRequired: p.consumeBoolean()
      ? required
      : pickIds(p, 2, required.length > 0 ? required : CATALOG_IDS),
    selectedOptional: pickIds(p, 4, offered.length > 0 ? offered : CATALOG_IDS),
    chosenAlternatives: p.consumeBoolean()
      ? { transport: pick(p, CATALOG_IDS) }
      : {},
    delivery: { prefetch: "none", offlineCache: "shell-only" },
  };
}

/** Everything the named roots can reach through dependencies and alternatives. */
function closureOf(
  catalog: CapabilityCatalog,
  roots: Iterable<CapabilityId>,
): Set<CapabilityId> {
  const index = new Map(catalog.capabilities.map((d) => [d.id, d]));
  const seen = new Set<CapabilityId>();
  const stack = [...roots];
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    if (seen.has(id)) continue;
    seen.add(id);
    const d = index.get(id);
    if (d === undefined) continue;
    stack.push(...d.dependencies, ...d.alternatives.flatMap((a) => a.oneOf));
  }
  return seen;
}

function wantedBy(selection: InstallationCapabilitySelection | null) {
  if (selection === null) return new Set<CapabilityId>();
  return closureOf(FIXTURE_CATALOG, [
    ...selection.acceptedRequired,
    ...selection.selectedOptional,
  ]);
}

function assertOracles(
  policy: InstanceCapabilityPolicy | null,
  policyParsed: boolean,
  selection: InstallationCapabilitySelection | null,
  approved: readonly CapabilityId[],
): void {
  const optional = approved.filter(
    (id) =>
      FIXTURE_CATALOG.capabilities.find((d) => d.id === id)?.tier ===
      "optional",
  );
  if (!policyParsed && optional.length > 0) {
    throw new Error(`fuzz: unparsed policy approved ${optional.join(",")}`);
  }
  const wanted = wantedBy(selection);
  for (const id of optional) {
    if (!wanted.has(id)) throw new Error(`fuzz: ${id} approved unwanted`);
    if (policy?.capabilities.prohibited.includes(id)) {
      throw new Error(`fuzz: prohibited ${id} approved`);
    }
  }
}

export function fuzz(data: Buffer): void {
  const p = new FuzzedDataProvider(data);
  const draft = rawPolicy(p);
  const policyResult = parseInstancePolicy(draft);
  const selectionResult = parseInstallationSelection(rawSelection(p, draft));
  const policy = policyResult.ok ? policyResult.value : null;
  const selection = selectionResult.ok ? selectionResult.value : null;
  const input = fixtureResolveInput({
    instancePolicy: policy,
    provenance: "same-origin-deployment",
    policyValid: policyResult.ok,
    installation: selection,
  });
  const first = resolveComposition(input);
  // Consent to everything the plan offers, so the oracles see approvals.
  const receipt = buildConsentReceipt(
    first,
    input.catalog,
    "2026-09-22T00:00:00.000Z",
  );
  const plan = resolveComposition({ ...input, receipt });
  assertOracles(policy, policyResult.ok, selection, plan.approvedCapabilities);
  for (const id of FRAGMENTS) explainCapability(plan, id);
}
