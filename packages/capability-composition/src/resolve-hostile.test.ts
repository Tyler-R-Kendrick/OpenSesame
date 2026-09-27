/**
 * The resolver against inputs it was never meant to see — carried forward
 * from #470's adversarial suite: ids named like Object.prototype members, a
 * capability whose module did not ship, a dependency no catalog names, and
 * a dependency cycle. Each fails closed.
 */
import { describe, expect, it } from "vitest";
import { buildCatalog } from "./catalog.js";
import { buildConsentReceipt } from "./consent.js";
import {
  FIXTURE_CATALOG,
  FIXTURE_DISTRIBUTION,
  FIXTURE_INSTALLATION,
  FIXTURE_POLICIES,
  fixtureDescriptor,
  fixtureResolveInput,
  fixtureSelection,
} from "./fixtures.js";
import type { ResolveInput } from "./resolve-input.js";
import {
  capabilityState,
  explainCapability,
  resolveComposition,
} from "./resolve.js";

const CORE = ["settings.core", "vault.passwords"];
const NOW = "2026-09-22T00:00:00.000Z";

/** Resolve once to learn the closure, sign it, resolve again with the receipt. */
function resolveWithConsent(input: ResolveInput) {
  const first = resolveComposition(input);
  const receipt = buildConsentReceipt(first, input.catalog, NOW);
  return { plan: resolveComposition({ ...input, receipt }), receipt };
}

const familyInput = (overrides: Partial<ResolveInput> = {}): ResolveInput =>
  fixtureResolveInput({
    instancePolicy: FIXTURE_POLICIES.family,
    provenance: "same-origin-deployment",
    installation: FIXTURE_INSTALLATION,
    ...overrides,
  });

describe("prototype-named ids (carried from #470's adversarial suite)", () => {
  const plan = resolveComposition(fixtureResolveInput());

  it.each(["constructor", "toString", "hasOwnProperty", "__proto__"])(
    "explainCapability(%s) reads as never distributed, never throws",
    (id) => {
      const explanation = explainCapability(plan, id);
      expect(explanation.state.approved).toBe(false);
      expect(explanation.state.reasons).toEqual(["NOT_DISTRIBUTED"]);
      expect(capabilityState(plan, id)).toBeUndefined();
    },
  );
});

describe("an alternatives slot named like a prototype member", () => {
  it("reads as unchosen, not as the prototype's function", () => {
    const catalog = buildCatalog(
      FIXTURE_CATALOG.capabilities.map(({ exposureDigest: _digest, ...d }) =>
        d.id === "sharing.household"
          ? {
              ...d,
              alternatives: d.alternatives.map((a) => ({
                ...a,
                slot: "constructor",
              })),
            }
          : d,
      ),
      1,
    );
    const plan = resolveComposition(
      fixtureResolveInput({
        catalog,
        installation: {
          ...FIXTURE_INSTALLATION,
          selectedOptional: ["sharing.household"],
          chosenAlternatives: {},
        },
      }),
    );
    expect(plan.conflicts).toEqual([
      expect.objectContaining({
        code: "ALTERNATIVE_NOT_CHOSEN",
        capability: "sharing.household",
        subject: "constructor",
      }),
    ]);
  });
});

describe("module completeness (carried from #470's not-shipped rule)", () => {
  it("a worker unit is not a page module: the build never lists it, and it does not count", () => {
    const distribution = {
      ...FIXTURE_DISTRIBUTION,
      moduleIds: FIXTURE_DISTRIBUTION.moduleIds.filter(
        (m) => m !== "notifications.web-push/worker",
      ),
    };
    const { plan } = resolveWithConsent(
      familyInput({
        distribution,
        installation: fixtureSelection({
          selectedOptional: ["notifications.web-push"],
        }),
      }),
    );
    expect(plan.capabilities["notifications.web-push"]).toMatchObject({
      distributed: true,
      approved: true,
      reasons: [],
    });
  });

  it("a capability whose module did not ship is not distributed, and never approved", () => {
    const baseline = resolveWithConsent(familyInput()).plan;
    const target = baseline.approvedCapabilities.find(
      (id) => baseline.capabilities[id]?.tier === "optional",
    );
    if (target === undefined) throw new Error("fixture approves no optional");
    const dropped = `${target}/runtime`;
    expect(baseline.approvedModules).toContain(dropped);
    const distribution = {
      ...FIXTURE_DISTRIBUTION,
      moduleIds: FIXTURE_DISTRIBUTION.moduleIds.filter((m) => m !== dropped),
    };
    // The same receipt, so only the missing module can change the verdict.
    const { receipt } = resolveWithConsent(familyInput());
    const plan = resolveComposition(familyInput({ distribution, receipt }));
    expect(plan.capabilities[target]).toMatchObject({
      distributed: false,
      approved: false,
    });
    expect(plan.capabilities[target]?.reasons).toContain("NOT_DISTRIBUTED");
    expect(plan.approvedCapabilities).not.toContain(target);
    expect(plan.approvedModules).not.toContain(dropped);
  });
});

describe("catalogs the resolver was never meant to see (carried from #470)", () => {
  function catalogWith(extra: ReturnType<typeof fixtureDescriptor>[]) {
    const catalog = buildCatalog(
      FIXTURE_CATALOG.capabilities
        .filter((d) => d.tier === "core")
        .map(({ exposureDigest: _digest, ...d }) => d)
        .concat(extra),
      1,
    );
    const distribution = {
      ...FIXTURE_DISTRIBUTION,
      capabilityIds: catalog.capabilities.map((d) => d.id),
      moduleIds: catalog.capabilities.flatMap((d) => d.moduleIds),
    };
    return { catalog, distribution };
  }

  it("a dependency no catalog entry names is a conflict, never auto-enabled", () => {
    const { catalog, distribution } = catalogWith([
      fixtureDescriptor("a.root", { dependencies: ["ghost.cap"] }),
    ]);
    const { plan } = resolveWithConsent(
      fixtureResolveInput({
        catalog,
        distribution,
        installation: fixtureSelection({ selectedOptional: ["a.root"] }),
      }),
    );
    expect(plan.conflicts).toEqual([
      expect.objectContaining({
        code: "DEPENDENCY_NOT_DISTRIBUTED",
        capability: "a.root",
        subject: "ghost.cap",
      }),
    ]);
    expect(plan.approvedCapabilities).toEqual(CORE);
  });

  it("a dependency cycle terminates, and approves nothing without consent", () => {
    const { catalog, distribution } = catalogWith([
      fixtureDescriptor("a.one", { dependencies: ["a.two"] }),
      fixtureDescriptor("a.two", { dependencies: ["a.one"] }),
    ]);
    const input = fixtureResolveInput({
      catalog,
      distribution,
      installation: fixtureSelection({ selectedOptional: ["a.one"] }),
    });
    expect(resolveComposition(input).approvedCapabilities).toEqual(CORE);
    const { plan } = resolveWithConsent(input);
    expect(plan.approvedCapabilities).toEqual(["a.one", "a.two", ...CORE]);
  });
});
