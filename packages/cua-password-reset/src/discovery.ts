import { decide, modelObservation, selectedAction, type DecisionsApi } from "./decisions.js";
import type { BrowserDriver } from "./agent-browser.js";
import {
  recipeSchema,
  type HumanChallenge,
  type Observation,
  type RecipeStep,
  type ResetAction,
  type ResetActionDecision,
  type ResetRecipe,
} from "./types.js";

export interface DiscoveryExecutor {
  execute(decision: ResetActionDecision): Promise<void>;
  handoff(challenge: HumanChallenge): Promise<void>;
}

export interface DiscoveryOptions {
  decisions: DecisionsApi;
  browser: BrowserDriver;
  executor: DiscoveryExecutor;
  authorize(action: ResetAction): void;
  verify(): Promise<boolean>;
  entryUrl: string;
  allowedOrigins: readonly string[];
  maxSteps?: number;
}

export function decisionStep(
  decision: ResetActionDecision,
  observation: Observation,
  entryPath: string,
  index: number,
): RecipeStep {
  const id = `step-${index}`;
  const safe = modelObservation(observation);
  const target = "ref" in decision
    ? {
        ref: decision.ref,
        expectedLabel: safe.fields.find((field) => field.ref === decision.ref)?.label,
      }
    : {};
  switch (decision.kind) {
    case "navigate":
      return { id, primitive: "navigate", path: entryPath };
    case "fill-field":
      return { id, primitive: "fill-field", purpose: decision.purpose, ...target };
    case "click":
      return { id, primitive: "click", ...target };
    case "submit":
      return { id, primitive: "submit", ...target };
    case "passkey-prompt":
      return { id, primitive: "passkey-prompt", ...target };
    case "await-email-link":
    case "await-human":
    case "verify-login":
      return { id, primitive: decision.kind };
  }
}

export async function discoverResetRecipe(options: DiscoveryOptions): Promise<ResetRecipe> {
  const entry = new URL(options.entryUrl);
  if (!["https:", "http:"].includes(entry.protocol) || entry.username || entry.password)
    throw new Error("Discovery entry must be a credential-free HTTP(S) URL");
  if (!options.allowedOrigins.includes(entry.origin))
    throw new Error("Discovery entry is outside the allowed origins");
  const maxSteps = options.maxSteps ?? 40;
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 80)
    throw new Error("Discovery step bound must be between 1 and 80");
  const entryPath = entry.pathname;
  const steps: RecipeStep[] = [];
  options.authorize("password_reset.browser.drive");
  await options.browser.open(entry.href);
  for (let index = 1; index <= maxSteps; index += 1) {
    options.authorize("password_reset.browser.drive");
    const observation = await options.browser.snapshot();
    options.authorize("password_reset.model.plan");
    const decision = await decide(options.decisions, observation, options.allowedOrigins);
    if (decision.kind === "refuse")
      throw new Error(`Discovery refused: ${decision.reason}`);
    if (decision.kind === "wait") continue;
    if (decision.kind === "handoff") {
      options.authorize("password_reset.human.takeover");
      await options.executor.handoff(decision.challenge);
      continue;
    }
    if (decision.kind === "finish") {
      options.authorize("password_reset.item.use");
      if (!(await options.verify()))
        throw new Error("Discovery finish was not independently verified");
      return recipeSchema.parse({
        schemaVersion: 1,
        review: "candidate",
        domain: entry.hostname,
        entryPath,
        allowedOrigins: options.allowedOrigins,
        steps,
      });
    }
    const action = selectedAction(decision, observation);
    options.authorize("password_reset.runtime.execute");
    options.authorize(action.kind === "await-email-link"
      ? "password_reset.mailbox.read"
      : action.kind === "await-human" || action.kind === "passkey-prompt"
        ? "password_reset.human.takeover"
        : "password_reset.browser.drive");
    steps.push(decisionStep(action, observation, entryPath, steps.length + 1));
    await options.executor.execute(action);
  }
  throw new Error("Discovery exceeded its step bound");
}
