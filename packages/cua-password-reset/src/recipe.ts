import type { Observation, RecipeStep, ResetRecipe } from "./types.js";
import { recipeSchema, recipeStepSchema } from "./types.js";

export function recipeMatches(recipe: ResetRecipe, origin: string): boolean {
  const parsed = recipeSchema.parse(recipe);
  const url = new URL(origin);
  const secure = url.protocol === "https:" ||
    ((url.hostname === "localhost" || url.hostname === "127.0.0.1") && url.protocol === "http:");
  return secure && url.hostname === parsed.domain && parsed.allowedOrigins.includes(url.origin);
}

export function stepDrift(step: RecipeStep, observation: Observation): boolean {
  if (!step.ref) return false;
  const field = observation.fields.find((candidate) => candidate.ref === step.ref);
  if (!field) return true;
  if (step.purpose === "new-password" && field.kind !== "password") return true;
  if (step.purpose === "identifier" && !["email", "text"].includes(field.kind)) return true;
  return step.expectedLabel !== undefined && field.label !== step.expectedLabel;
}

export interface RecipeRepair {
  repair(input: { step: RecipeStep; observation: Observation }): Promise<RecipeStep>;
}

export type ReplayStep =
  | { status: "ready"; step: RecipeStep }
  | { status: "review_required"; recipe: ResetRecipe }
  | { status: "reconciliation_required" };

export async function replayStep(
  recipe: ResetRecipe,
  index: number,
  observation: Observation,
  repair?: RecipeRepair,
  phase: "before-submit" | "after-submit" = "before-submit",
): Promise<ReplayStep> {
  const parsed = recipeSchema.parse(recipe);
  if (parsed.review !== "approved") throw new Error("A candidate recipe cannot be replayed");
  const step = parsed.steps[index];
  if (!step) throw new Error("Recipe is complete");
  if (!parsed.allowedOrigins.includes(observation.origin))
    throw new Error("Recipe drifted outside its allowed origins");
  if (!stepDrift(step, observation)) return { status: "ready", step };
  if (phase === "after-submit") return { status: "reconciliation_required" };
  if (!repair) throw new Error("Recipe step drifted");
  const repaired = recipeStepSchema.parse(await repair.repair({ step, observation }));
  if (repaired.id !== step.id || repaired.primitive !== step.primitive)
    throw new Error("Recipe repair changed the step's meaning");
  return { status: "review_required", recipe: updateRecipe(parsed, index, repaired) };
}

export function updateRecipe(
  recipe: ResetRecipe,
  index: number,
  step: RecipeStep,
): ResetRecipe {
  if (!recipe.steps[index] || recipe.steps[index]?.primitive !== step.primitive ||
      recipe.steps[index]?.id !== step.id)
    throw new Error("Recipe update changed the deterministic spine");
  const steps = recipe.steps.map((current, at) => at === index ? step : current);
  return recipeSchema.parse({ ...recipe, review: "candidate", steps });
}

export async function approveRecipe(
  recipe: ResetRecipe,
  approve: () => boolean | Promise<boolean>,
): Promise<ResetRecipe> {
  if (!(await approve())) throw new Error("Recipe review was declined");
  return recipeSchema.parse({ ...recipe, review: "approved" });
}
