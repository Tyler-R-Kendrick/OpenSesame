import { replicateOperationInput } from "@opensesame/app-core/lib/ai-connections/replicate-inference.js";
import type { AiConnectionDraft } from "@opensesame/app-core/lib/ai-connections/types.js";
import { useId } from "react";
import { FieldShell } from "../../../components/FieldShell.js";
import { BedrockConnectionHelp } from "./BedrockConnectionFields.js";
import { VertexConnectionHelp } from "./VertexConnectionFields.js";
type Fields = {
  draft: AiConnectionDraft;
  busy: boolean;
  onChange: <Key extends keyof AiConnectionDraft>(
    field: Key,
    value: AiConnectionDraft[Key],
  ) => void;
};
export function replicateVerificationInput(
  draft: AiConnectionDraft,
  content: string,
) {
  return replicateOperationInput({
    model: draft.model,
    messages: [{ role: "user", content }],
  });
}
export function predictionInputReady(
  draft: AiConnectionDraft,
  content: string,
) {
  try {
    replicateVerificationInput(draft, content);
    return true;
  } catch {
    return false;
  }
}
export function PredictionInput({
  label,
  value,
  busy,
  onChange,
}: {
  label: string;
  value: string;
  busy: boolean;
  onChange?: (value: string) => void;
}) {
  return (
    <FieldShell
      label={label}
      value={value}
      disabled={busy}
      mono
      autoComplete="off"
      onValueChange={onChange}
    />
  );
}
export function AiConnectionSetup({ draft, busy, onChange }: Fields) {
  const tokenParameterId = useId();
  if (draft.family === "elevenlabs_scribe")
    return (
      <details className="conn-client-alt">
        <summary>Connection setup</summary>
        <p>
          Choose a local sample to test or save this transcription connection.
          Both actions send audio only to the configured endpoint and consume
          its transcript; service charges may apply. Audio is transient and
          cleared after saving or locking. The API key is saved as a Token
          credential in the current vault. Use the configured native Tailscale
          HTTP transport, or permit this browser origin and headers for a direct
          browser connection.
        </p>
      </details>
    );
  if (draft.family === "replicate_predictions")
    return (
      <p>
        Enter the model owner/name or an immutable version and its
        model-specific JSON input. Testing and saving create a real prediction,
        which may incur charges, and wait for terminal output. Verification
        input is transient and is not saved. Generated URLs are displayed as
        text. The API token stays in the owning vault.
      </p>
    );
  if (draft.family === "bedrock_converse") return <BedrockConnectionHelp />;
  if (draft.vertex) return <VertexConnectionHelp draft={draft} />;
  return (
    <details className="conn-client-alt">
      <summary>Connection setup</summary>
      {draft.family === "openai_chat" ? (
        <div className="field">
          <label htmlFor={tokenParameterId}>Output token parameter</label>
          <select
            id={tokenParameterId}
            value={draft.tokenParameter}
            disabled={busy}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "max_tokens" || value === "max_completion_tokens")
                onChange("tokenParameter", value);
            }}
          >
            <option value="max_completion_tokens">max_completion_tokens</option>
            <option value="max_tokens">max_tokens</option>
          </select>
        </div>
      ) : null}
      <p>
        {draft.azure
          ? "Enter the Azure resource endpoint, including any custom mount. The operation adds /openai/v1 or the dated deployment path."
          : "The base URL includes the API prefix."}{" "}
        Use the configured native Tailscale HTTP transport, or permit this
        browser origin and request headers for a direct browser connection. The
        credential is saved as a Token credential in the current vault and sent
        only to the configured endpoint.
      </p>
      {draft.azure?.credential === "entra-token" ? (
        <p>
          Supply an Entra access token. This form does not sign in or refresh
          it.
        </p>
      ) : null}
      <p>
        Testing and saving send a short prompt with up to 16 output tokens.
        Changing the target or authentication requires entering the credential
        again.
      </p>
    </details>
  );
}
