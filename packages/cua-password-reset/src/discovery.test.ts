import { describe, expect, it, vi } from "vitest";
import type { BrowserDriver } from "./agent-browser.js";
import { discoverResetRecipe } from "./discovery.js";
import { MemoryRecipeStore, recordAndApproveRecipe } from "./recipe-store.js";
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
        decide: async (input) => {
          const kind = sequence.shift();
          return kind
            ? act(kind, input.candidates)
            : { kind: "finish", observationId: "observation-1" };
        },
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

  it("records human handoffs and requires a recorded verify-login before finishing", async () => {
    const driven = browser();
    // The human segment is recorded from the challenge page; the segment's
    // postcondition comes from the first page seen after the person
    // cleared it (no challenge copy left).
    vi.mocked(driven.snapshot)
      .mockResolvedValueOnce({
        ...observation([
          ...fields,
          { ref: "e4", kind: "otp", label: "Authenticator code" },
        ]),
        sensitiveValues: ["person@example.test"],
      })
      .mockResolvedValue({
        ...observation(fields),
        sensitiveValues: ["person@example.test"],
      });
    const handoff = vi.fn(async () => undefined);
    const verify = vi.fn(async () => true);
    let decision = 0;
    const recipe = await discoverResetRecipe({
      decisions: {
        decide: async (input) => {
          decision += 1;
          if (decision === 1)
            return {
              kind: "handoff",
              observationId: "observation-1",
              challenge: "totp",
            };
          if (decision === 2) return act("verify-login", input.candidates);
          return { kind: "finish", observationId: "observation-1" };
        },
      },
      browser: driven,
      executor: {
        execute: vi.fn(async (_action: ResetActionDecision) => undefined),
        handoff,
      },
      authorize: vi.fn(),
      verify,
      entryUrl: `${ORIGIN}/forgot`,
      allowedOrigins: [ORIGIN],
    });
    expect(recipe.steps.map((step) => step.primitive)).toEqual([
      "await-human",
      "verify-login",
    ]);
    expect(recipe.steps[0]?.challenge).toBe("totp");
    expect(recipe.steps[0]?.postcondition?.expectedLabels).toHaveLength(3);
    expect(JSON.stringify(recipe.steps[0]?.postcondition)).not.toContain(
      "person@example.test",
    );
    expect(handoff).toHaveBeenCalledWith("totp");
    expect(verify).toHaveBeenCalledTimes(1);

    await expect(
      discoverResetRecipe({
        decisions: {
          decide: async () => ({
            kind: "finish",
            observationId: "observation-1",
          }),
        },
        browser: browser(),
        executor: {
          execute: vi.fn(async (_action: ResetActionDecision) => undefined),
          handoff: vi.fn(async () => undefined),
        },
        authorize: vi.fn(),
        verify: async () => true,
        entryUrl: `${ORIGIN}/forgot`,
        allowedOrigins: [ORIGIN],
      }),
    ).rejects.toThrow("record a successful verify-login");
  });

  it("stores a recorded ceremony only after owner approval", async () => {
    const options = () => {
      let calls = 0;
      return {
        decisions: {
          decide: async (input: {
            candidates: readonly DecisionCandidate[];
          }) => {
            calls += 1;
            return calls === 1
              ? act("verify-login", input.candidates)
              : { kind: "finish" as const, observationId: "observation-1" };
          },
        },
        browser: browser(),
        executor: {
          execute: vi.fn(async (_action: ResetActionDecision) => undefined),
          handoff: vi.fn(async () => undefined),
        },
        authorize: vi.fn(),
        verify: async () => true,
        entryUrl: `${ORIGIN}/forgot`,
        allowedOrigins: [ORIGIN],
      };
    };
    const declined = new MemoryRecipeStore();
    await expect(
      recordAndApproveRecipe(declined, options(), async () => false),
    ).rejects.toThrow("declined");
    expect(await declined.get("accounts.example.test")).toBeUndefined();

    const approved = new MemoryRecipeStore();
    const recipe = await recordAndApproveRecipe(
      approved,
      options(),
      async (candidate) => candidate.review === "candidate",
    );
    expect(recipe.review).toBe("approved");
    expect((await approved.get(recipe.domain))?.review).toBe("approved");
    // Second run short-circuits: no discovery decisions are consumed.
    const again = await recordAndApproveRecipe(
      approved,
      options(),
      async () => {
        throw new Error("must not be asked");
      },
    );
    expect(again).toEqual(recipe);
  });
});
