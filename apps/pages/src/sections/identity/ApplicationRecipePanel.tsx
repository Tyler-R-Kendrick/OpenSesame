import { useState } from "react";
import {
  applyBoundRecipe,
  exportRecipe,
  importRecipe,
  previewRecipe,
} from "../../lib/configuration/recipes.js";
import {
  type LocalApplicationRegistration,
  configureLocalApplication,
  readLocalApplications,
} from "../../lib/local-applications.js";

type ApplyImportedRecipeInput = {
  imported: string;
  organization: string;
  tomb?: string;
  revision?: number;
  fallback: ReturnType<typeof exportRecipe>;
};

async function applyImportedRecipe(
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

export function ApplicationRecipePanel(props: {
  registration: LocalApplicationRegistration | undefined;
  tomb?: string;
  revision?: number;
}) {
  const [imported, setImported] = useState("");
  const [organization, setOrganization] = useState("");
  const [result, setResult] = useState("");
  const recipe = props.registration
    ? exportRecipe({
        name: props.registration.applicationId,
        resources: [
          {
            kind: "local_application",
            logicalId: props.registration.applicationId,
            body: {
              redirectUris: props.registration.redirectUris,
              scopes: props.registration.scopes,
              clientSecret: "must-not-export",
            },
          },
        ],
        requiredInputs: ["organization"],
      })
    : null;
  const preview = recipe ? previewRecipe(recipe) : null;

  return (
    <section className="panel">
      <div className="panel__head">
        <div>
          <h3>Portable recipe</h3>
        </div>
      </div>
      <div className="panel__body">
        {preview ? (
          <p className="hint">
            {preview.resources} resource(s). {preview.omissions[0]}
          </p>
        ) : (
          <p className="hint">Register the application before exporting.</p>
        )}
        {recipe ? (
          <textarea
            readOnly
            rows={8}
            spellCheck={false}
            aria-label="Exported recipe"
            value={JSON.stringify(recipe, null, 2)}
          />
        ) : null}
        <label htmlFor="recipe-org">Organization binding</label>
        <input
          id="recipe-org"
          value={organization}
          onChange={(event) => setOrganization(event.target.value)}
        />
        <label htmlFor="recipe-import">Import recipe JSON</label>
        <textarea
          id="recipe-import"
          rows={4}
          spellCheck={false}
          value={imported}
          onChange={(event) => setImported(event.target.value)}
        />
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => {
            if (!recipe) return;
            void applyImportedRecipe({
              imported,
              organization,
              tomb: props.tomb,
              revision: props.revision,
              fallback: recipe,
            }).then(setResult);
          }}
        >
          Apply import
        </button>
        {result ? <p className="hint">{result}</p> : null}
      </div>
    </section>
  );
}
