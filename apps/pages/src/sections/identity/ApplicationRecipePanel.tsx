import {
  exportRecipe,
  previewRecipe,
} from "@opensesame/app-core/lib/configuration/recipes.js";
import type { LocalApplicationRegistration } from "@opensesame/app-core/lib/local-applications.js";
import { applyImportedRecipe } from "@opensesame/app-core/sections/identity/application-recipe-panel-model.js";
import { useEffect, useState } from "react";
import { FormCommit } from "../../components/FormCommit.js";

export function ApplicationRecipePanel(props: {
  registration: LocalApplicationRegistration | undefined;
  tomb?: string;
  revision?: number;
  /** An import was written; the owner reloads what it shows. */
  onApplied?: () => void;
}) {
  // The directory's revision as this panel last knew it: its own write moves
  // it on before the owner's reload arrives, so a repeat import is not
  // refused as a change made elsewhere.
  const [revision, setRevision] = useState(props.revision);
  useEffect(() => setRevision(props.revision), [props.revision]);
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
        <FormCommit
          label="Apply import"
          onClick={() => {
            if (!recipe) return;
            void applyImportedRecipe({
              imported,
              organization,
              tomb: props.tomb,
              revision,
              fallback: recipe,
            })
              .then((applied) => {
                setResult(applied.message);
                if (applied.revision === undefined) return;
                setRevision(applied.revision);
                props.onApplied?.();
              })
              .catch(() => setResult("Recipe failed to apply."));
          }}
        />
        {result ? <p className="hint">{result}</p> : null}
      </div>
    </section>
  );
}
