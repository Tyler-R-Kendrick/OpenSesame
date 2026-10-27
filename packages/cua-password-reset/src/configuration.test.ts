import { describe, expect, it } from "vitest";
import {
  type DecisionConfiguration,
  validateDecisionConfiguration,
} from "./configuration.js";
import type { Decision, DecisionCandidate } from "./types.js";

const kinds: DecisionConfiguration["decisions"] = [
  "act",
  "wait",
  "handoff",
  "finish",
  "refuse",
];

function configuration(): DecisionConfiguration {
  return {
    runtimeId: "agent-browser",
    modelId: "persons-model",
    adapterDigest: `sha256:${"a".repeat(64)}`,
    endpoint: "https://model.example.test/v1",
    decisions: [...kinds],
    maxSteps: 20,
    maxObservationFields: 50,
    screenshotMasking: "required",
  };
}

function answer(
  kind: DecisionConfiguration["decisions"][number],
  candidates: readonly DecisionCandidate[],
): Decision {
  const base = { observationId: "configuration-fixture" } as const;
  if (kind === "act") {
    const candidate = candidates[0];
    if (!candidate) throw new Error("Configuration fixture has no candidates");
    return {
      ...base,
      kind,
      candidateId: candidate.id,
      effectId: candidate.effectId,
    };
  }
  if (kind === "handoff") return { ...base, kind, challenge: "totp" };
  if (kind === "refuse") return { ...base, kind, reason: "unsupported" };
  return { ...base, kind };
}

describe("decision configuration validation", () => {
  it("validates every declared decision against masked fixtures", async () => {
    let calls = 0;
    let sent = "";
    const validated = await validateDecisionConfiguration(
      {
        decide: async (input) => {
          sent += JSON.stringify(input);
          const kind = kinds[calls++];
          if (!kind) throw new Error("Unexpected configuration probe");
          return answer(kind, input.candidates);
        },
      },
      configuration(),
    );
    expect(validated.validatedDecisions).toEqual(kinds);
    expect(calls).toBe(kinds.length);
    expect(sent).not.toContain("person@example.test");
    expect(sent).not.toContain("sensitiveValues");
  });

  it("rejects malformed decisions and unsafe endpoints", async () => {
    await expect(
      validateDecisionConfiguration(
        {
          decide: async () => ({
            kind: "navigate",
            observationId: "configuration-fixture",
          }),
        },
        { ...configuration(), decisions: ["act"] },
      ),
    ).rejects.toThrow();
    await expect(
      validateDecisionConfiguration(
        {
          decide: async (input) => answer("act", input.candidates),
        },
        {
          ...configuration(),
          endpoint: "http://model.example.test",
          decisions: ["act"],
        },
      ),
    ).rejects.toThrow("HTTPS");
  });

  it("binds the proof to runtime, model and adapter configuration", async () => {
    const api = {
      decide: async (input: { candidates: Parameters<typeof answer>[1] }) =>
        answer("act", input.candidates),
    };
    const first = await validateDecisionConfiguration(api, {
      ...configuration(),
      decisions: ["act"],
    });
    const changed = await validateDecisionConfiguration(api, {
      ...configuration(),
      decisions: ["act"],
      modelId: "another-model",
    });
    expect(first.configurationKey).not.toBe(changed.configurationKey);
  });
});
