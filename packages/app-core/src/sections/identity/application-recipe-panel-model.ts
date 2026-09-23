/**
 * View-model logic for `ApplicationRecipePanel` (ADR 0133 §8): the pure part of that
 * screen — no React, no DOM — so any shell can drive the same behaviour.
 */
import {
  applyBoundRecipe,
  type exportRecipe,
  importRecipe,
} from "../../lib/configuration/recipes.js";
import {
  configureLocalApplication,
  readLocalApplications,
} from "../../lib/local-applications.js";

export type ApplyImportedRecipeInput = {
  imported: string;
  organization: string;
  tomb?: string;
  revision?: number;
  fallback: ReturnType<typeof exportRecipe>;
};

export async function applyImportedRecipe(
  input: ApplyImportedRecipeInput,
): Promise<string> {
  let manifest = input.fallback;
  try {
    // SAFETY: test/fixture or boundary-checked value matches typeof manifest.
    manifest = JSON.parse(input.imported) as typeof manifest;
  } catch {
    return "Imported recipe is not JSON.";
  }
  const bound = importRecipe(manifest, { organization: input.organization });
  if (!bound.ok) return bound.message;
  if (!input.tomb || input.revision === undefined) {
    return "Unlock the vault before applying a recipe.";
  }
  const tomb = input.tomb;
  const revision = input.revision;
  const applied = await applyBoundRecipe(
    bound.bound,
    { organization: input.organization },
    {
      applyLocalApplication: async (resource) => {
        const current = await readLocalApplications(tomb);
        await configureLocalApplication(
          tomb,
          current.revision,
          resource.logicalId,
          {
            applicationId: resource.logicalId,
            organizationId: resource.organizationId,
            redirectUris: resource.redirectUris,
            scopes: resource.scopes,
          },
        );
      },
    },
  );
  return applied.ok
    ? `Applied ${applied.applied.join(", ")} to ${input.organization}. Repeat import keeps the same applicationId.`
    : applied.message;
}
