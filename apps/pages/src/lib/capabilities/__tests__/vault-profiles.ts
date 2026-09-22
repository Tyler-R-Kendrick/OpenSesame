/**
 * The real catalog, the real profiles, resolved by the real resolver — for
 * the VAULT acceptance family, which is about this product's own vault under
 * a composed installation, not about a fixture realm.
 *
 * Two passes, because approval needs the receipt the first pass says is owed.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CapabilityId,
  type EffectivePlan,
  type InstallationCapabilitySelection,
  type ResolveInput,
  type RuntimeFacts,
  buildConsentReceipt,
  parseInstallationSelection,
  parseInstancePolicy,
  resolveComposition,
} from "@opensesame/capability-composition";
import { CAPABILITY_CATALOG } from "../catalog.js";
import { distributionFromOwnership } from "../ownership.js";

const profilesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../capability-profiles",
);

export const FACTS: RuntimeFacts = {
  environments: ["document", "dedicated-worker", "service-worker"],
  serviceWorkerAvailable: true,
  activeWorkerVariant: null,
  cleanRealm: true,
  evaluatedModuleIds: [],
  now: "2026-09-22T00:00:00.000Z",
};

const profiles = new Map<string, Record<string, unknown>>(
  readdirSync(profilesDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const parsed = JSON.parse(readFileSync(join(profilesDir, name), "utf8"));
      return [parsed.name as string, parsed as Record<string, unknown>];
    }),
);

/** The resolver's input for a shipped profile, before any receipt. */
export function profileInput(
  name: string,
  overrides: Partial<ResolveInput> = {},
): ResolveInput {
  const profile = profiles.get(name);
  if (!profile) throw new Error(`no profile ${name}`);
  const policyDoc = profile.instancePolicy;
  const policy =
    policyDoc === null
      ? null
      : (() => {
          // SAFETY: a checked-in profile fixture; a parse failure is a test bug.
          const parsed = parseInstancePolicy(policyDoc as never);
          if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
          return parsed.value;
        })();
  // SAFETY: as above — the profile corpus is validated by profiles.test.ts.
  const selection = parseInstallationSelection(
    profile.installationSelection as never,
  );
  if (!selection.ok) throw new Error(JSON.stringify(selection.diagnostics));
  return {
    catalog: CAPABILITY_CATALOG,
    distribution: distributionFromOwnership("selective"),
    instancePolicy: policy,
    provenance: policy === null ? "personal-local" : "same-origin-deployment",
    policyValid: true,
    workspace: null,
    installation: selection.value,
    vault: null,
    receipt: null,
    facts: FACTS,
    installationId: selection.value.installationId,
    vaultId: null,
    ...overrides,
  };
}

/** The installation selection a shipped profile carries. */
export function profileSelection(
  name: string,
): InstallationCapabilitySelection {
  const selection = profileInput(name).installation;
  if (selection === null) throw new Error(`profile ${name} has no selection`);
  return selection;
}

/** A shipped profile resolved to the plan a device would actually run. */
export function profilePlan(
  name: string,
  overrides: Partial<ResolveInput> = {},
): EffectivePlan {
  const input = profileInput(name, overrides);
  const receipt = buildConsentReceipt(
    resolveComposition(input),
    CAPABILITY_CATALOG,
    FACTS.now,
  );
  return resolveComposition({ ...input, receipt });
}

export function approved(plan: EffectivePlan, id: CapabilityId): boolean {
  return plan.capabilities[id]?.approved === true;
}
