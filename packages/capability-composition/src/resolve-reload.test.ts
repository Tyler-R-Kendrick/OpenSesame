/**
 * RELOAD_REQUIRED — carried forward from #470's restart-required rule for a
 * capability that must start in a fresh document. Approved in a realm that
 * has already run other modules, and not yet evaluated itself, it stays
 * approved and waits for a reload; the loader refuses to start it until then.
 * What the document approved while it was still clean (`approvedAtLoad`) is
 * exempt: a later resolve must not strand what boot was already starting.
 */
import { describe, expect, it } from "vitest";
import { buildConsentReceipt } from "./consent.js";
import {
  FIXTURE_FACTS,
  FIXTURE_INSTALLATION,
  FIXTURE_POLICIES,
  fixtureResolveInput,
  fixtureSelection,
} from "./fixtures.js";
import type { ResolveInput } from "./resolve-input.js";
import { resolveComposition } from "./resolve.js";
import type { RuntimeFacts } from "./types.js";

const PUSH = "notifications.web-push";

function planWith(facts: Partial<RuntimeFacts>) {
  const input: ResolveInput = fixtureResolveInput({
    instancePolicy: FIXTURE_POLICIES.family,
    provenance: "same-origin-deployment",
    installation: fixtureSelection({
      ...FIXTURE_INSTALLATION,
      selectedOptional: [PUSH],
    }),
    facts: { ...FIXTURE_FACTS, ...facts },
  });
  const receipt = buildConsentReceipt(
    resolveComposition(input),
    input.catalog,
    FIXTURE_FACTS.now,
  );
  return resolveComposition({ ...input, receipt });
}

describe("RELOAD_REQUIRED", () => {
  it("a fresh document starts it as usual", () => {
    const state = planWith({ cleanRealm: true }).capabilities[PUSH];
    expect(state?.approved).toBe(true);
    expect(state?.reasons).toEqual([]);
  });

  it("a document that already ran other modules keeps it approved, waiting for a reload", () => {
    const plan = planWith({
      cleanRealm: false,
      evaluatedModuleIds: ["vault.passkey-records/runtime"],
    });
    expect(plan.capabilities[PUSH]?.approved).toBe(true);
    expect(plan.capabilities[PUSH]?.reasons).toEqual(["RELOAD_REQUIRED"]);
    expect(plan.approvedCapabilities).toContain(PUSH);
  });

  it("once its own module has run in this document, no reload is owed", () => {
    const state = planWith({
      cleanRealm: false,
      evaluatedModuleIds: [`${PUSH}/runtime`],
    }).capabilities[PUSH];
    expect(state?.reasons).toEqual([]);
  });

  it("what the document approved at load still starts after other modules ran", () => {
    const state = planWith({
      cleanRealm: false,
      evaluatedModuleIds: ["vault.passkey-records/runtime"],
      approvedAtLoad: [PUSH],
    }).capabilities[PUSH];
    expect(state?.approved).toBe(true);
    expect(state?.reasons).toEqual([]);
  });

  it("a capability that needs no fresh document never waits", () => {
    const plan = planWith({ cleanRealm: false });
    for (const state of Object.values(plan.capabilities)) {
      if (state.id === PUSH) continue;
      expect(state.reasons, state.id).not.toContain("RELOAD_REQUIRED");
    }
  });
});
