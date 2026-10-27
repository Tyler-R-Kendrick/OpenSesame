import { decide, modelObservation, selectedAction } from "./decisions.js";
import type { DiscoveryOptions } from "./discovery.js";
import type {
  Decision,
  Observation,
  RecipeStep,
  ResetAction,
  ResetActionDecision,
} from "./types.js";

export function decisionStep(
  decision: ResetActionDecision,
  observation: Observation,
  entryPath: string,
  index: number,
): RecipeStep {
  const id = `step-${index}`;
  const safe = modelObservation(observation);
  const target =
    "ref" in decision
      ? {
          ref: decision.ref,
          expectedLabel: safe.fields.find((field) => field.ref === decision.ref)
            ?.label,
        }
      : {};
  switch (decision.kind) {
    case "navigate":
      return { id, primitive: "navigate", path: entryPath };
    case "fill-field":
      return {
        id,
        primitive: "fill-field",
        purpose: decision.purpose,
        ...target,
      };
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

export async function nextDiscoveryDecision(
  options: DiscoveryOptions,
  observation: Observation,
  entryPath: string,
  steps: RecipeStep[],
): Promise<Decision | null> {
  options.authorize("password_reset.model.plan");
  const decision = await decide(
    options.decisions,
    observation,
    options.allowedOrigins,
  );
  if (decision.kind === "refuse")
    throw new Error(`Discovery refused: ${decision.reason}`);
  if (decision.kind === "wait") return null;
  if (decision.kind === "handoff") {
    options.authorize("password_reset.human.takeover");
    const action = {
      kind: "await-human" as const,
      observationId: observation.id,
      challenge: decision.challenge,
    };
    steps.push(decisionStep(action, observation, entryPath, steps.length + 1));
    await options.executor.handoff(decision.challenge);
    return null;
  }
  return decision;
}

export async function finishDiscovery(
  options: DiscoveryOptions,
  entry: URL,
  steps: readonly RecipeStep[],
) {
  options.authorize("password_reset.item.use");
  if (!(await options.verify()))
    throw new Error("Discovery finish was not independently verified");
  if (!steps.some((step) => step.primitive === "verify-login"))
    throw new Error("Discovery must record a successful verify-login step");
  return {
    schemaVersion: 1,
    review: "candidate",
    domain: entry.hostname,
    entryPath: entry.pathname,
    allowedOrigins: options.allowedOrigins,
    steps,
  };
}

export async function executeDiscoveryAction(
  options: DiscoveryOptions,
  decision: Decision,
  observation: Observation,
  entryPath: string,
  steps: RecipeStep[],
): Promise<void> {
  const action = selectedAction(decision, observation);
  options.authorize("password_reset.runtime.execute");
  options.authorize(actionAuthority(action.kind));
  steps.push(decisionStep(action, observation, entryPath, steps.length + 1));
  await options.executor.execute(action);
}

function actionAuthority(kind: string): ResetAction {
  if (kind === "await-email-link") return "password_reset.mailbox.read";
  if (kind === "await-human" || kind === "passkey-prompt")
    return "password_reset.human.takeover";
  return "password_reset.browser.drive";
}
