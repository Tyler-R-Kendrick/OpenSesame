/**
 * Properties carried forward from #470's resolver suites (order
 * independence over random shuffles, "nothing loads that was not wanted",
 * "changed input ⇒ different digest"), stated against today's resolver.
 *
 * fast-check seed: see `__tests__/scenarios.ts`.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  NOW,
  SEED,
  type Scenario,
  inputOf,
  scenarioArb,
} from "./__tests__/scenarios.js";
import { buildConsentReceipt } from "./consent.js";
import { FIXTURE_CATALOG } from "./fixtures.js";
import type { ResolveInput } from "./resolve-input.js";
import { resolveComposition } from "./resolve.js";
import type { CapabilityId } from "./types.js";

/** A deterministic permutation of `items`, driven by `seed` (Fisher–Yates). */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0 || 1;
  for (let i = out.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

/** Every list the resolver reads, each permuted by its own offset of `seed`. */
function permuted(input: ResolveInput, seed: number): ResolveInput {
  const p = <T>(items: readonly T[], k: number) => shuffled(items, seed + k);
  const policy = input.instancePolicy;
  const installation = input.installation;
  return {
    ...input,
    catalog: {
      ...input.catalog,
      capabilities: p(input.catalog.capabilities, 1),
    },
    distribution: {
      ...input.distribution,
      capabilityIds: p(input.distribution.capabilityIds, 2),
      moduleIds: p(input.distribution.moduleIds, 3),
      workerVariants: p(input.distribution.workerVariants, 4),
    },
    instancePolicy:
      policy === null
        ? null
        : {
            ...policy,
            capabilities: {
              ...policy.capabilities,
              required: p(policy.capabilities.required, 5),
              optional: p(policy.capabilities.optional, 6),
              prohibited: p(policy.capabilities.prohibited, 7),
            },
          },
    workspace:
      input.workspace === null
        ? null
        : {
            ...input.workspace,
            allow:
              input.workspace.allow === null
                ? null
                : p(input.workspace.allow, 8),
            prohibited: p(input.workspace.prohibited, 9),
          },
    vault:
      input.vault === null
        ? null
        : { ...input.vault, disabled: p(input.vault.disabled, 10) },
    installation:
      installation === null
        ? null
        : {
            ...installation,
            acceptedRequired: p(installation.acceptedRequired, 11),
            selectedOptional: p(installation.selectedOptional, 12),
          },
    receipt:
      input.receipt === null
        ? null
        : { ...input.receipt, roots: p(input.receipt.roots, 13) },
  };
}

/** The scenario resolved with consent to everything it offers. */
function consented(scenario: Scenario) {
  const bare = inputOf(scenario);
  const receipt = buildConsentReceipt(
    resolveComposition(bare),
    FIXTURE_CATALOG,
    NOW,
  );
  const input = { ...bare, receipt };
  return { input, plan: resolveComposition(input) };
}

const INDEX = new Map(FIXTURE_CATALOG.capabilities.map((d) => [d.id, d]));

/** What the named roots can reach through dependencies and alternatives. */
function closureOf(roots: Iterable<CapabilityId>): Set<CapabilityId> {
  const seen = new Set<CapabilityId>();
  const stack = [...roots];
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    if (seen.has(id)) continue;
    seen.add(id);
    const d = INDEX.get(id);
    if (d === undefined) continue;
    stack.push(...d.dependencies, ...d.alternatives.flatMap((a) => a.oneOf));
  }
  return seen;
}

describe("order independence over random permutations (MODEL-07, #470)", () => {
  it("permuting every input list yields the identical plan", () => {
    fc.assert(
      fc.property(scenarioArb, fc.integer(), (scenario, seed) => {
        const { input, plan } = consented(scenario);
        expect(resolveComposition(permuted(input, seed))).toEqual(plan);
      }),
      { numRuns: 200, seed: SEED },
    );
  });
});

describe("nothing is approved that no one wanted (#470's load oracle)", () => {
  it("approved optional ⊆ closure(selection) and never prohibited, denied or disabled", () => {
    fc.assert(
      fc.property(scenarioArb, (scenario) => {
        const { input, plan } = consented(scenario);
        const installation = input.installation;
        const wanted = closureOf([
          ...(installation?.acceptedRequired ?? []),
          ...(installation?.selectedOptional ?? []),
        ]);
        const refused = new Set<CapabilityId>([
          ...scenario.policy.capabilities.prohibited,
          ...(scenario.workspace?.prohibited ?? []),
          ...(scenario.vault?.disabled ?? []),
        ]);
        for (const id of plan.approvedCapabilities) {
          if (INDEX.get(id)?.tier !== "optional") continue;
          expect(wanted.has(id), `${id} approved unwanted`).toBe(true);
          expect(refused.has(id), `${id} approved though refused`).toBe(false);
        }
      }),
      { numRuns: 400, seed: SEED },
    );
  });
});

describe("the digest follows what the plan approves (#470)", () => {
  it("plans that approve different modules or report different conflicts have different digests", () => {
    fc.assert(
      fc.property(scenarioArb, scenarioArb, (s1, s2) => {
        const a = consented(s1).plan;
        const b = consented(s2).plan;
        const same =
          JSON.stringify(a.approvedModules) ===
            JSON.stringify(b.approvedModules) &&
          JSON.stringify(a.conflicts) === JSON.stringify(b.conflicts);
        if (!same) {
          expect(a.identity.planDigest).not.toBe(b.identity.planDigest);
        }
      }),
      { numRuns: 300, seed: SEED },
    );
  });
});
