import { describe, expect, it, vi } from "vitest";
import type { BrowserDriver } from "./agent-browser.js";
import { discoverResetRecipe } from "./discovery.js";
import { ORIGIN, observation } from "./test-support.js";
import type {
  DecisionCandidate,
  Observation,
  ResetActionDecision,
} from "./types.js";

const fields: Observation["fields"] = [
  { ref: "e1", kind: "email", label: "person@example.test" },
  { ref: "e2", kind: "password", label: "New password" },
  { ref: "e3", kind: "button", label: "Reset password" },
];

function browser(): BrowserDriver {
  return {
    open: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => ({
      ...observation(fields),
      sensitiveValues: ["person@example.test"],
    })),
    click: vi.fn(async () => undefined),
    fill: vi.fn(async () => undefined),
    fillSecret: vi.fn(async () => undefined),
  };
}

function act(
  kind: ResetActionDecision["kind"],
  candidates: readonly DecisionCandidate[],
) {
  const candidate = candidates.find((entry) => entry.action.kind === kind);
  return (
    candidate && {
      kind: "act" as const,
      observationId: "observation-1",
      candidateId: candidate.id,
      effectId: candidate.effectId,
    }
  );
}

describe("first-run bounded discovery", () => {
  it("builds a candidate recipe from legal decisions without account data", async () => {
    const sequence: ResetActionDecision["kind"][] = [
      "navigate",
      "fill-field",
      "fill-field",
      "submit",
      "verify-login",
    ];
    const execute = vi.fn(async (_action: ResetActionDecision) => undefined);
    const recipe = await discoverResetRecipe({
      decisions: {
        decide: async (input) =>
          sequence.length > 0
            ? act(sequence.shift()!, input.candidates)
            : { kind: "finish", observationId: "observation-1" },
      },
      browser: browser(),
      executor: { execute, handoff: vi.fn(async () => undefined) },
      authorize: vi.fn(),
      verify: async () => true,
      entryUrl: `${ORIGIN}/forgot`,
      allowedOrigins: [ORIGIN],
      maxSteps: 10,
    });
    expect(recipe.review).toBe("candidate");
    expect(recipe.steps.map((step) => step.primitive)).toEqual([
      "navigate",
      "fill-field",
      "fill-field",
      "submit",
      "verify-login",
    ]);
    expect(JSON.stringify(recipe)).not.toContain("person@example.test");
    expect(execute).toHaveBeenCalledTimes(5);
  });

  it("enforces the configured step bound and independent completion", async () => {
    const base = {
      browser: browser(),
      executor: {
        execute: vi.fn(async (_action: ResetActionDecision) => undefined),
        handoff: vi.fn(async () => undefined),
      },
      entryUrl: `${ORIGIN}/forgot`,
      allowedOrigins: [ORIGIN],
      authorize: vi.fn(),
      maxSteps: 1,
    };
    await expect(
      discoverResetRecipe({
        ...base,
        decisions: {
          decide: async (input) => act("navigate", input.candidates),
        },
        authorize: vi.fn(),
        verify: async () => true,
      }),
    ).rejects.toThrow("step bound");
    await expect(
      discoverResetRecipe({
        ...base,
        decisions: {
          decide: async () => ({
            kind: "finish",
            observationId: "observation-1",
          }),
        },
        authorize: vi.fn(),
        verify: async () => false,
      }),
    ).rejects.toThrow("independently verified");
  });
});
