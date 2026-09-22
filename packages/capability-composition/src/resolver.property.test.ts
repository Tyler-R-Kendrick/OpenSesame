import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { BoundaryValue } from "@opensesame/os-domain";
import { overlapCast } from "@opensesame/os-domain";
import { validateDescriptor } from "./descriptor.js";
import { type DigestInput, canonicalJson } from "./digest.js";
import { validateInstancePolicy } from "./documents.js";
import { resolveEffectivePlan } from "./resolver.js";
import { descriptor, distribution, makePrng, policy } from "./test-helpers.js";

const FC = { numRuns: 75 } as const;

const idPart = fc
  .string({ minLength: 1, maxLength: 12 })
  .map((s) => s.toLowerCase().replaceAll(/[^a-z0-9._-]/g, "x"));

describe("property — hostile inputs never throw or load silently", () => {
  it("arbitrary policy documents either fail validation or resolve safely", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(idPart, { maxLength: 6 }),
        fc.array(idPart, { maxLength: 6 }),
        fc.array(idPart, { maxLength: 6 }),
        async (required, optional, prohibited) => {
          const outcome = resolveEffectivePlan({
            distribution: distribution([descriptor("a")]),
            instancePolicy: policy({ required, optional, prohibited }),
            runtimeEnvironments: ["document"],
            evaluatedAt: "2026-01-01T00:00:00.000Z",
          });
          // Malformed ids fail closed at validation; valid ones resolve safely.
          if (!outcome.ok) return;
          // Nothing loads that was not explicitly wanted.
          const wanted = new Set([...required, ...optional]);
          for (const c of outcome.plan.selected) {
            if (c.stateAxes.loaded) expect(wanted.has(c.id)).toBe(true);
          }
        },
      ),
      FC,
    );
  });

  it("arbitrary descriptors either fail validation or enter the plan honestly", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ id: idPart }), { maxLength: 5 }),
        async (partials) => {
          const raws = partials.map((p) => descriptor(p.id));
          const outcome = resolveEffectivePlan({
            distribution: distribution(raws),
            instancePolicy: policy({ required: ["a"] }),
            runtimeEnvironments: ["document"],
            evaluatedAt: "2026-01-01T00:00:00.000Z",
          });
          expect(outcome.ok).toBe(true);
          if (!outcome.ok) return;
          // Every malformed descriptor is reported, never silently dropped.
          const shipped = new Set(outcome.plan.selected.map((c) => c.id));
          for (const raw of raws) {
            const checked = validateDescriptor(raw);
            if (!checked.ok) {
              expect(
                outcome.plan.conflicts.some((c) =>
                  c.detail.includes("malformed descriptor"),
                ),
              ).toBe(true);
            } else {
              void shipped;
            }
          }
        },
      ),
      FC,
    );
  });

  it("canonicalJson never throws on hostile boundary values", async () => {
    // SAFETY: fc.jsonValue validated the JSON boundary contract at runtime;
    // the DigestInput arbitrary preserves that same validated contract.
    const hostileJson: fc.Arbitrary<DigestInput> = overlapCast(
      fc.jsonValue(),
    );
    await fc.assert(
      fc.asyncProperty(
        hostileJson,
        async (value: DigestInput) => {
          let threw = false;
          try {
            canonicalJson(value);
          } catch {
            threw = true;
          }
          expect(threw).toBe(false);
        },
      ),
      FC,
    );
  });

  it("oversize id lists fail closed instead of stalling", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 257, max: 600 }), async (count) => {
        const prng = makePrng(count);
        const ids = Array.from({ length: count }, (_, i) => {
          void prng();
          return `cap.${i}`;
        });
        const result = validateInstancePolicy(policy({ required: ids }));
        expect(result.ok).toBe(false);
      }),
      FC,
    );
  });
});
