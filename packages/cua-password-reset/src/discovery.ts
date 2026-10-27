import type { BrowserDriver } from "./agent-browser.js";
import type { DecisionsApi } from "./decisions.js";
import {
  executeDiscoveryAction,
  finishDiscovery,
  nextDiscoveryDecision,
} from "./discovery-decision.js";
import {
  type HumanChallenge,
  type RecipeStep,
  type ResetAction,
  type ResetActionDecision,
  type ResetRecipe,
  recipeSchema,
} from "./types.js";

export { decisionStep } from "./discovery-decision.js";

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

export async function discoverResetRecipe(
  options: DiscoveryOptions,
): Promise<ResetRecipe> {
  const entry = new URL(options.entryUrl);
  if (
    !["https:", "http:"].includes(entry.protocol) ||
    entry.username ||
    entry.password
  )
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
    const decision = await nextDiscoveryDecision(options, observation);
    if (!decision) continue;
    if (decision.kind === "finish")
      return recipeSchema.parse(await finishDiscovery(options, entry, steps));
    await executeDiscoveryAction(
      options,
      decision,
      observation,
      entryPath,
      steps,
    );
  }
  throw new Error("Discovery exceeded its step bound");
}
