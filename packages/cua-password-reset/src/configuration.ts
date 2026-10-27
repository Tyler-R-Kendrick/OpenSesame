import { z } from "zod";
import {
  type DecisionsApi,
  guardDecision,
  legalCandidates,
  modelObservation,
} from "./decisions.js";
import type { Decision, Observation } from "./types.js";

const SUPPORTED = ["act", "wait", "handoff", "finish", "refuse"] as const;

export const decisionConfigurationSchema = z
  .object({
    runtimeId: z.string().min(1).max(128),
    modelId: z.string().min(1).max(256),
    adapterDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    endpoint: z.url(),
    decisions: z.array(z.enum(SUPPORTED)).min(1).max(SUPPORTED.length),
    maxSteps: z.number().int().min(1).max(80),
    maxObservationFields: z.number().int().min(1).max(100),
    screenshotMasking: z.literal("required"),
  })
  .strict();
export type DecisionConfiguration = z.infer<typeof decisionConfigurationSchema>;

export type ValidatedDecisionConfiguration = {
  configuration: DecisionConfiguration;
  configurationKey: string;
  validatedDecisions: readonly Decision["kind"][];
};

export async function validateDecisionConfiguration(
  api: DecisionsApi,
  input: DecisionConfiguration,
): Promise<ValidatedDecisionConfiguration> {
  const configuration = decisionConfigurationSchema.parse(input);
  const url = new URL(configuration.endpoint);
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "::1"].includes(url.hostname)
  )
    throw new Error("A model endpoint must be HTTPS or loopback");
  const decisions = [...new Set(configuration.decisions)];
  for (const kind of decisions) {
    const observation = modelObservation(fixture());
    const candidates = legalCandidates(observation);
    const raw = await api.decide({ observation, candidates });
    const decision = guardDecision(raw, observation, [observation.origin]);
    if (decision.kind !== kind)
      throw new Error(`Runtime did not validate ${kind}`);
  }
  return {
    configuration: { ...configuration, decisions },
    configurationKey: JSON.stringify({ ...configuration, decisions }),
    validatedDecisions: decisions,
  };
}

function fixture(): Observation {
  return {
    id: "configuration-fixture",
    origin: "https://accounts.example.test",
    fields: [
      { ref: "e1", kind: "email", label: "person@example.test" },
      { ref: "e2", kind: "password", label: "New password" },
      { ref: "e3", kind: "otp", label: "Authenticator code" },
      { ref: "e4", kind: "button", label: "Reset password" },
    ],
    maskedScreenshot: "data:image/png;base64,bWFza2Vk",
    sensitiveValues: ["person@example.test"],
  };
}
