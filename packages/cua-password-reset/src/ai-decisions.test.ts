import type { LanguageModel } from "ai";
import { describe, expect, it, vi } from "vitest";
import { createAiDecisions, type AiDecisionRuntime } from "./ai-decisions.js";
import { decide, selectedAction } from "./decisions.js";
import { decisionSchema, type DecisionCandidate, type Observation } from "./types.js";
import { ORIGIN } from "./test-support.js";

type GenerateOptions = Parameters<AiDecisionRuntime["generate"]>[0];

function fakeRuntime() {
  const calls: GenerateOptions[] = [];
  const models: { baseURL: string; apiKey: string; model: string }[] = [];
  const runtime: AiDecisionRuntime = {
    createModel(config, model) {
      models.push({ baseURL: config.baseURL, apiKey: config.apiKey, model });
      return { specificationVersion: "v3" } as LanguageModel;
    },
    async generate(options) {
      calls.push(options);
      const input = JSON.parse(options.prompt) as {
        observation: Observation;
        candidates: DecisionCandidate[];
      };
      const click = input.candidates.find((candidate) => candidate.action.kind === "click");
      return {
        object: click
          ? {
              kind: "act",
              observationId: input.observation.id,
              candidateId: click.id,
              effectId: click.effectId,
            }
          : { kind: "finish", observationId: input.observation.id },
      };
    },
  };
  return { runtime, calls, models };
}

function config(apiKey: () => string | Promise<string> = async () => "model-key-canary") {
  return { model: "decision-model", baseURL: "https://model.example.test/v1", apiKey };
}

describe("AI SDK decisions", () => {
  it("probes the real strict schema at configuration and resolves the key only per call", async () => {
    const { runtime, calls, models } = fakeRuntime();
    const apiKey = vi.fn(async () => "model-key-canary");
    const api = await createAiDecisions(config(apiKey), runtime);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.schema).toBe(decisionSchema);
    expect(calls[0]?.schemaName).toBe("password_reset_decision");
    expect(apiKey).toHaveBeenCalledTimes(1);

    const observation: Observation = {
      id: "observation-ai",
      origin: ORIGIN,
      fields: [{ ref: "e1", kind: "button", label: "Continue" }],
    };
    const decision = await decide(api, observation, [ORIGIN]);
    expect(selectedAction(decision, observation)).toMatchObject({ kind: "click" });
    expect(apiKey).toHaveBeenCalledTimes(2);
    expect(models).toEqual([
      { baseURL: config().baseURL, apiKey: "model-key-canary", model: "decision-model" },
      { baseURL: config().baseURL, apiKey: "model-key-canary", model: "decision-model" },
    ]);
  });

  it("sends neither input canaries nor raw screenshots to the model or request errors", async () => {
    const { runtime, calls } = fakeRuntime();
    const api = await createAiDecisions(config(), runtime);
    const observation: Observation = {
      id: "observation-secret",
      origin: ORIGIN,
      fields: [
        { ref: "e1", kind: "button", label: "Continue SECRET_CANARY" },
        { ref: "e2", kind: "password", label: "Password RAW_FIELD_CANARY" },
      ],
      screenshot: "RAW_SCREENSHOT_CANARY",
      maskedScreenshot: "data:image/png;base64,TUFTS0VE",
      sensitiveValues: ["SECRET_CANARY", "RAW_FIELD_CANARY"],
    };
    await decide(api, observation, [ORIGIN]);
    const outbound = calls.map((call) => call.prompt).join("\n");
    expect(outbound).not.toContain("SECRET_CANARY");
    expect(outbound).not.toContain("RAW_FIELD_CANARY");
    expect(outbound).not.toContain("RAW_SCREENSHOT_CANARY");
    expect(outbound).not.toContain("model-key-canary");
    expect(outbound).toContain("TUFTS0VE");

    const failing = fakeRuntime();
    failing.runtime.generate = async () => {
      throw new Error("provider echoed model-key-canary and SECRET_CANARY");
    };
    await expect(createAiDecisions(config(), failing.runtime)).rejects.toThrow(
      /^Model failed its strict decision probe$/,
    );
  });

  it("refuses invalid configuration and a malformed probe without external calls in tests", async () => {
    const { runtime, calls } = fakeRuntime();
    await expect(createAiDecisions(config(async () => ""), runtime))
      .rejects.toThrow("strict decision probe");
    expect(calls).toHaveLength(0);
    await expect(createAiDecisions({ ...config(), model: "" }, runtime)).rejects.toThrow();
    await expect(createAiDecisions({ ...config(), baseURL: "https://key@model.test" }, runtime))
      .rejects.toThrow("credential-free");

    runtime.generate = async () => ({
      object: { kind: "finish", observationId: "configuration-probe", extra: "code" },
    });
    await expect(createAiDecisions(config(), runtime)).rejects.toThrow("strict decision probe");
  });
});
