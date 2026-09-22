import { describe, expect, it } from "vitest";
import { buildConsentReceipt } from "./consent.js";
import {
  FIXTURE_CATALOG,
  FIXTURE_DISTRIBUTION,
  FIXTURE_FACTS,
  FIXTURE_INSTALLATION,
  FIXTURE_POLICIES,
  fixtureResolveInput,
} from "./fixtures.js";
import type { ResolveInput } from "./resolve-input.js";
import { resolveComposition } from "./resolve.js";
import { reviewCompositionChange } from "./review.js";
import type { EffectivePlan } from "./types.js";

const NOW = "2026-09-22T00:00:00.000Z";

function consented(input: ResolveInput): EffectivePlan {
  const receipt = buildConsentReceipt(resolveComposition(input), input.catalog, NOW);
  return resolveComposition({ ...input, receipt });
}

const familyInput = (selected: readonly string[], overrides: Partial<ResolveInput> = {}): ResolveInput =>
  fixtureResolveInput({
    instancePolicy: FIXTURE_POLICIES.family,
    provenance: "same-origin-deployment",
    installation: { ...FIXTURE_INSTALLATION, selectedOptional: selected, revision: `sel-${selected.length}` },
    ...overrides,
  });

describe("reviewCompositionChange", () => {
  it("reports what a widening enables: capabilities, modules, operations, egress, permissions, worker", () => {
    const before = consented(familyInput([]));
    const after = consented(familyInput(["connectors.external", "vault.passkey-records", "notifications.web-push"]));
    const review = reviewCompositionChange(before, after, FIXTURE_CATALOG);
    expect(review.enabled).toEqual(["access.authority", "connectors.external", "notifications.web-push", "vault.passkey-records"]);
    expect(review.disabled).toEqual([]);
    expect(review.addedModules).toEqual([
      "access.authority/runtime",
      "connectors.external/runtime",
      "notifications.web-push/runtime",
      "notifications.web-push/worker",
      "vault.passkey-records/runtime",
    ]);
    expect(review.addedOperations).toEqual(["pages.access.grants.list", "pages.connectors.list", "pages.items.passkey.create"]);
    expect(review.addedEgress).toEqual([{ automatic: false, class: "external-service", purpose: "the connector directory" }]);
    expect(review.addedPermissions).toEqual(["notifications", "webauthn"]);
    expect(review.workerTransition).toEqual({ from: null, to: "push" });
    expect(review.requiresDocumentReload).toEqual(["notifications.web-push"]);
    expect(review.requiresNewArtifact).toBe(false);
    expect(review.widened).toBe(true);
    expect(review.before).toEqual(before.identity);
    expect(review.after).toEqual(after.identity);
  });

  it("widened: a tightening that adds nothing is not widened; one that sneaks an approval in is", () => {
    const wide = consented(familyInput(["connectors.external", "vault.passkey-records"]));
    const narrow = consented(familyInput(["connectors.external"]));
    const tightened = reviewCompositionChange(wide, narrow, FIXTURE_CATALOG);
    expect(tightened.widened).toBe(false);
    expect(tightened.disabled).toEqual(["vault.passkey-records"]);
    expect(tightened.removedModules).toEqual(["vault.passkey-records/runtime"]);
    expect(tightened.removedOperations).toEqual(["pages.items.passkey.create"]);
    expect(tightened.addedEgress).toEqual([]);
    expect(tightened.workerTransition).toBeNull();
    const sideways = consented(familyInput(["notifications.web-push"]));
    const swapped = reviewCompositionChange(wide, sideways, FIXTURE_CATALOG);
    expect(swapped.widened).toBe(true);
    expect(swapped.enabled).toEqual(["notifications.web-push"]);
    expect(swapped.disabled).toEqual(["access.authority", "connectors.external", "vault.passkey-records"]);
    expect(reviewCompositionChange(wide, wide, FIXTURE_CATALOG).widened).toBe(false);
  });

  it("carries the after-plan's conflicts, consent, restart set and artifact need", () => {
    const before = consented(familyInput(["connectors.external"]));
    const facts = { ...FIXTURE_FACTS, cleanRealm: false, evaluatedModuleIds: ["connectors.external/runtime", "access.authority/runtime"] };
    const afterInput = familyInput(["notifications.web-push"], {
      facts,
      distribution: { ...FIXTURE_DISTRIBUTION, workerVariants: [{ id: "core-only", scriptPath: "sw.js", satisfies: [] }] },
    });
    const after = resolveComposition({ ...afterInput, receipt: buildConsentReceipt(before, FIXTURE_CATALOG, NOW) });
    const review = reviewCompositionChange(before, after, FIXTURE_CATALOG);
    expect(review.restartRequiredFor).toEqual(["access.authority/runtime", "connectors.external/runtime"]);
    expect(review.requiresNewArtifact).toBe(true);
    expect(review.conflicts).toEqual(after.conflicts);
    expect(review.consent).toEqual(after.consent);
    expect(review.conflicts.map((c) => c.code)).toEqual(["WORKER_GRAPH_UNAVAILABLE"]);
    expect(review.consent.addedRoots).toEqual([]);
    expect(review.widened).toBe(false);
  });
});
