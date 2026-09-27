/**
 * View-model logic for `ApplicationRecipePanel` (ADR 0133 §8): the pure part of that
 * screen — no React, no DOM — so any shell can drive the same behaviour.
 */
import {
  applyBoundRecipe,
  type exportRecipe,
  importRecipe,
} from "../../lib/configuration/recipes.js";
import { configureLocalApplication } from "../../lib/local-applications.js";
import { LocalDirectoryError } from "../../lib/local-directory-types.js";

/** The write a recipe makes; tests stand in a store of their own. */
export const recipePanelSeams = {
  configure: configureLocalApplication,
};

export type ApplyImportedRecipeInput = {
  imported: string;
  organization: string;
  tomb?: string;
  revision?: number;
  fallback: ReturnType<typeof exportRecipe>;
};

/** What the panel shows, and the directory's revision after an applied write. */
export type ApplyImportedRecipeResult = Readonly<{
  message: string;
  revision?: number;
}>;

export async function applyImportedRecipe(
  input: ApplyImportedRecipeInput,
): Promise<ApplyImportedRecipeResult> {
  let manifest = input.fallback;
  try {
    // SAFETY: test/fixture or boundary-checked value matches typeof manifest.
    manifest = JSON.parse(input.imported) as typeof manifest;
  } catch {
    return { message: "Imported recipe is not JSON." };
  }
  const bound = importRecipe(manifest, { organization: input.organization });
  if (!bound.ok) return { message: bound.message };
  if (!input.tomb || input.revision === undefined) {
    return { message: "Unlock the vault before applying a recipe." };
  }
  const tomb = input.tomb;
  // The first write is checked against the revision the panel was drawn
  // from, so a change made elsewhere since is refused rather than
  // overwritten; each later write follows on from the one before it.
  let revision = input.revision;
  let applied: Awaited<ReturnType<typeof applyBoundRecipe>>;
  try {
    applied = await applyBoundRecipe(
      bound.bound,
      { organization: input.organization },
      {
        applyLocalApplication: async (resource) => {
          const next = await recipePanelSeams.configure(
            tomb,
            revision,
            resource.logicalId,
            {
              applicationId: resource.logicalId,
              organizationId: resource.organizationId,
              redirectUris: resource.redirectUris,
              scopes: resource.scopes,
            },
          );
          revision = next.revision;
        },
      },
    );
  } catch (err) {
    if (err instanceof LocalDirectoryError) return { message: err.message };
    throw err;
  }
  if (!applied.ok) return { message: applied.message };
  return {
    message: `Applied ${applied.applied.join(", ")} to ${input.organization}. Repeat import keeps the same applicationId.`,
    revision,
  };
}
