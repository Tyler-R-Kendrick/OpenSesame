import {
  exportRecipe,
  previewRecipe,
} from "@opensesame/app-core/lib/configuration/recipes.js";
import type { LocalApplicationRegistration } from "@opensesame/app-core/lib/local-applications.js";
import { applyImportedRecipe } from "@opensesame/app-core/sections/identity/application-recipe-panel-model.js";
import { useState } from "react";

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
