/** Native Vertex derives its defaults from the same BYO target and field controls. */
import type { AiConnectionDraft } from "@opensesame/app-core/lib/ai-connections/types.js";
import { useId } from "react";
import { FieldShell } from "../../../components/FieldShell.js";
import type { AiConnectionFormProps } from "./AiConnectionForm.js";
type Fields = Pick<AiConnectionFormProps, "draft" | "busy" | "onChange">;
export function VertexEndpointChoice({ draft, busy, onChange }: Fields) {
  const id = useId();
  if (
    draft.providerId !== "byo-ai" ||
    draft.family !== "gemini_generate_content"
  )
    return null;
  return (
    <div className="field">
      <label htmlFor={id}>Endpoint type</label>
      <select
        id={id}
        value={draft.vertex ? "vertex" : "standard"}
        disabled={busy}
        onChange={(event) => {
          if (event.target.value === "vertex")
            onChange("vertex", {
              project: "",
              location: "us-central1",
              credential: "service-account",
            });
          else if (event.target.value === "standard")
            onChange("vertex", undefined);
        }}
      >
        <option value="standard">Standard Gemini API</option>
        <option value="vertex">Google Vertex AI</option>
      </select>
    </div>
  );
}
export function VertexConnectionFields({
  draft,
  busy,
  onChange,
  saved,
}: Fields & Pick<AiConnectionFormProps, "saved">) {
  const auth = useId();
  const secret = useId();
  const target = draft.vertex;
  if (!target) return null;
  return (
    <>
      <FieldShell
        label="Google Cloud project"
        value={target.project}
        disabled={busy}
        mono
        onValueChange={(project) => onChange("vertex", { ...target, project })}
      />
      <FieldShell
        label="Vertex location"
        value={target.location}
        disabled={busy}
        mono
        placeholder="us-central1 or global"
        onValueChange={(location) =>
          onChange("vertex", { ...target, location })
        }
      />
      <div className="field">
        <label htmlFor={auth}>Vertex authentication</label>
        <select
          id={auth}
          value={target.credential}
          disabled={busy}
          onChange={(event) => {
            const credential = event.target.value;
            if (
              credential === "service-account" ||
              credential === "access-token"
            )
              onChange("vertex", { ...target, credential });
          }}
        >
          <option value="service-account">Service account</option>
          <option value="access-token">Google access token</option>
        </select>
      </div>
      {target.credential === "service-account" ? (
        <div className="field">
          <label htmlFor={secret}>Service account JSON</label>
          <textarea
            id={secret}
            autoComplete="off"
            spellCheck={false}
            rows={4}
            value={draft.apiKey}
            disabled={busy}
            placeholder={
              saved
                ? "Saved in the owning vault; enter a replacement"
                : "Paste service-account JSON"
            }
            onChange={(event) => onChange("apiKey", event.target.value)}
          />
        </div>
      ) : (
        <FieldShell
          label="Google access token"
          value={draft.apiKey}
          type="password"
          autoComplete="new-password"
          disabled={busy}
          placeholder={
            saved ? "Saved in the owning vault; enter a replacement" : undefined
          }
          onValueChange={(value) => onChange("apiKey", value)}
        />
      )}
    </>
  );
}
export function VertexConnectionHelp({ draft }: { draft: AiConnectionDraft }) {
  return (
    <details className="conn-client-alt">
      <summary>Connection setup</summary>
      <p>
        The project, location and Gemini model are added under the API prefix.
        Responses appear when the request completes.
      </p>
      <p>
        {draft.vertex?.credential === "service-account"
          ? "The private key stays in this browser and signs a short-lived assertion for Google's token endpoint. Only the issued access token reaches the configured model endpoint."
          : "Supply a Google access token with Vertex permissions. The supplied token is not refreshed by this form."}
      </p>
      <p>
        Testing and saving send a short prompt with up to 16 output tokens. The
        write-only credential is saved in the owning vault. Changing project,
        location, model, endpoint or authentication requires entering it again.
      </p>
    </details>
  );
}
