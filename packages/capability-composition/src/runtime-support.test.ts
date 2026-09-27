/**
 * missingEnvironments: which declared environments this realm cannot host,
 * on every capability's state and so in its explanation (carried from #470,
 * whose unsupported-runtime detail named them).
 */
import { describe, expect, it } from "vitest";
import {
  FIXTURE_CATALOG,
  FIXTURE_FACTS,
  fixtureDescriptor,
} from "./fixtures.js";
import { fixtureResolveInput } from "./fixtures.js";
import { explainCapability, resolveComposition } from "./resolve.js";
import { missingEnvironments } from "./runtime-support.js";
import type { CapabilityDescriptor, RuntimeFacts } from "./types.js";

const PUSH = "notifications.web-push";

function declared(
  environments: CapabilityDescriptor["environments"],
): CapabilityDescriptor {
  return {
    ...fixtureDescriptor("a.env", { environments }),
    exposureDigest: `sha256:${"0".repeat(64)}`,
  };
}

function facts(over: Partial<RuntimeFacts>): RuntimeFacts {
  return { ...FIXTURE_FACTS, ...over };
}

describe("missingEnvironments", () => {
  it("is empty when every declared environment is hosted", () => {
    expect(
      missingEnvironments(facts({}), declared(["document", "service-worker"])),
    ).toEqual([]);
  });

  it("names each unhosted environment, sorted and once", () => {
    expect(
      missingEnvironments(
        facts({ environments: ["document"] }),
        declared(["service-worker", "dedicated-worker", "service-worker"]),
      ),
    ).toEqual(["dedicated-worker", "service-worker"]);
  });

  it("counts a declared but unusable service worker as missing", () => {
    expect(
      missingEnvironments(
        facts({ serviceWorkerAvailable: false }),
        declared(["document", "service-worker"]),
      ),
    ).toEqual(["service-worker"]);
  });
});

describe("on the plan", () => {
  it("rides on the state and the explanation, and agrees with runtimeSupported", () => {
    const plan = resolveComposition(
      fixtureResolveInput({
        facts: facts({ environments: ["document"] }),
      }),
    );
    const push = explainCapability(plan, PUSH);
    expect(push.state.runtimeSupported).toBe(false);
    expect(push.state.missingEnvironments).toEqual(["service-worker"]);
    for (const state of Object.values(plan.capabilities)) {
      expect(state.missingEnvironments.length === 0, state.id).toBe(
        state.runtimeSupported,
      );
    }
    expect(FIXTURE_CATALOG.capabilities.some((d) => d.id === PUSH)).toBe(true);
  });

  it("an id outside the catalog misses nothing it could name", () => {
    const plan = resolveComposition(fixtureResolveInput({}));
    expect(
      explainCapability(plan, "never.declared").state.missingEnvironments,
    ).toEqual([]);
  });
});
