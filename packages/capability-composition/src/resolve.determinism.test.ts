/**
 * MODEL-07 (input order never reaches the plan) and MODEL-08 (a tightening
 * never grows the approved sets).
 *
 * fast-check seed: 20260922. Recorded so a failure replays exactly; every
 * run here uses the same seed and the same run count.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  NOW,
  SEED,
  idSubset,
  inputOf,
  scenarioArb,
  subset,
  tighten,
} from "./__tests__/scenarios.js";
import { buildConsentReceipt } from "./consent.js";
import {
  FIXTURE_CATALOG,
  FIXTURE_DISTRIBUTION,
  FIXTURE_POLICIES,
  fixtureResolveInput,
  fixtureSelection,
} from "./fixtures.js";
import type { ResolveInput } from "./resolve-input.js";
import { explainCapability, resolveComposition } from "./resolve.js";

function reversed<T>(items: readonly T[]): T[] {
  return [...items].reverse();
}

describe("MODEL-07: determinism", () => {
  it("reordering every input list yields an identical plan digest and explanations", () => {
    const selection = fixtureSelection({
      selectedOptional: [
        "connectors.external",
        "sharing.household",
        "vault.passkey-records",
      ],
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
        allow: [
          "connectors.external",
          "access.authority",
          "identity.federation",
          "sharing.household",
          "sharing.drops",
        ],
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
      catalog: {
        ...FIXTURE_CATALOG,
        capabilities: reversed(FIXTURE_CATALOG.capabilities),
      },
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
          : {
              ...forward.workspace,
              allow: reversed(forward.workspace.allow ?? []),
              prohibited: reversed(forward.workspace.prohibited),
            },
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

describe("MODEL-08: restrictions are monotone", () => {
  it("tightening a policy never grows approvedCapabilities, approvedModules or approvedOperations", () => {
    fc.assert(
      fc.property(scenarioArb, idSubset, idSubset, (scenario, drop, deny) => {
        const before = resolveComposition(inputOf(scenario));
        const receipt = buildConsentReceipt(before, FIXTURE_CATALOG, NOW);
        const consented = resolveComposition({ ...inputOf(scenario), receipt });
        const after = resolveComposition({
          ...inputOf(tighten(scenario, drop, deny)),
          receipt,
        });
        expect(
          subset(after.approvedCapabilities, consented.approvedCapabilities),
        ).toBe(true);
        expect(subset(after.approvedModules, consented.approvedModules)).toBe(
          true,
        );
        expect(
          subset(after.approvedOperations, consented.approvedOperations),
        ).toBe(true);
        expect(
          subset(after.approvedItemKinds, consented.approvedItemKinds),
        ).toBe(true);
        expect(consented.approvedCapabilities).toEqual(
          expect.arrayContaining(["settings.core", "vault.passwords"]),
        );
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
