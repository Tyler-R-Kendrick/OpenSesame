/**
 * The whole plan for one multi-branch family scenario, rendered and pinned
 * as an approved file — carried forward from #470's `plan.approval.test`
 * (its "Verify equivalent").
 *
 * The plan digest covers the approved sets and the conflicts, not every
 * capability's axes and reasons; this rendering covers all of it, so a
 * change to how any capability is explained shows up in review as a diff of
 * `__snapshots__/plan.approved.md`. Update it only on purpose
 * (`vitest -u`), and read the diff.
 */
import { describe, expect, it } from "vitest";
import { buildConsentReceipt } from "./consent.js";
import {
  FIXTURE_CATALOG,
  FIXTURE_FACTS,
  FIXTURE_INSTALLATION,
  FIXTURE_POLICIES,
  fixtureResolveInput,
  fixtureSelection,
} from "./fixtures.js";
import type { ResolveInput } from "./resolve-input.js";
import { resolveComposition } from "./resolve.js";
import type { CapabilityState, EffectivePlan } from "./types.js";

const NOW = "2026-09-22T00:00:00.000Z";

/**
 * Family policy; a selection that reaches for a prohibited capability, one
 * the workspace denies, one whose dependency the workspace denies, one this
 * realm cannot run, one needing a transport choice, and one consented to
 * only after the receipt was signed.
 */
function scenario(): ResolveInput {
  const signedFor = fixtureSelection({
    selectedOptional: [
      "connectors.external",
      "notifications.web-push",
      "telemetry.external",
      "vault.passkey-records",
    ],
  });
  const base = fixtureResolveInput({
    instancePolicy: FIXTURE_POLICIES.family,
    provenance: "same-origin-deployment",
    installation: signedFor,
    facts: { ...FIXTURE_FACTS, environments: ["document"] },
    workspace: {
      schemaVersion: 1,
      kind: "WorkspaceCapabilityRestriction",
      instanceId: "fixture-family",
      vaultId: "tomb-1",
      revision: "w1",
      allow: null,
      prohibited: ["access.authority", "vault.passkey-records"],
    },
    vaultId: "tomb-1",
  });
  const receipt = buildConsentReceipt(
    resolveComposition(base),
    FIXTURE_CATALOG,
    NOW,
  );
  return {
    ...base,
    receipt,
    installation: {
      ...FIXTURE_INSTALLATION,
      ...signedFor,
      selectedOptional: [...signedFor.selectedOptional, "sharing.household"],
      chosenAlternatives: { transport: "sharing.drops" },
    },
  };
}

function axes(state: CapabilityState): string {
  const on = (
    [
      "distributed",
      "permitted",
      "required",
      "selected",
      "runtimeSupported",
      "approved",
      "restartRequired",
    ] as const
  ).filter((key) => state[key]);
  return on.join(",");
}

function render(plan: EffectivePlan): string {
  const { identity, consent } = plan;
  const states = Object.values(plan.capabilities).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const list = (xs: readonly string[]) => `[${xs.join(", ")}]`;
  return [
    "# capability-composition plan — approved behaviour",
    "",
    `planDigest: ${identity.planDigest}`,
    `instance: ${identity.instanceId} @ ${identity.policyRevision}`,
    `selection: ${identity.selectionRevision}`,
    `provenance: ${plan.provenance} (policyValid=${plan.policyValid})`,
    `workerVariant: ${plan.requiredWorkerVariant ?? "none"}`,
    `network: ${plan.network.externalServices} ${list(plan.network.allowedServiceOrigins)}`,
    "",
    "## Approved",
    "",
    `capabilities: ${list(plan.approvedCapabilities)}`,
    `modules: ${list(plan.approvedModules)}`,
    `operations: ${list(plan.approvedOperations)}`,
    `itemKinds: ${list(plan.approvedItemKinds)}`,
    "",
    "## Capabilities",
    "",
    ...states.map(
      (s) =>
        `- ${s.id} (${s.tier}) axes={${axes(s)}} via=${list(s.dependencyOf)} reasons=${list(s.reasons)}`,
    ),
    "",
    "## Conflicts",
    "",
    ...plan.conflicts.map((c) => `! ${c.capability} ${c.code} ${c.subject}`),
    "",
    "## Consent owed",
    "",
    `addedRoots: ${list(consent.addedRoots)}`,
    `removedRoots: ${list(consent.removedRoots)}`,
    `changedExposure: ${list(consent.changedExposure)}`,
    `addedDependencies: ${list(consent.addedDependencies)}`,
    `requiredNotAccepted: ${list(consent.requiredNotAccepted)}`,
    "",
  ].join("\n");
}

describe("plan approval (#470's Verify equivalent)", () => {
  it("matches the approved plan rendering", async () => {
    await expect(render(resolveComposition(scenario()))).toMatchFileSnapshot(
      "./__snapshots__/plan.approved.md",
    );
  });
});
