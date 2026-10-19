import { validateAiConnection } from "@opensesame/app-core/lib/ai-connections/configuration.js";
import {
  aiConnectionFamilies,
  isAiConnectionFamily,
} from "@opensesame/app-core/lib/ai-connections/presets.js";
import type { AiConnectionDraft } from "@opensesame/app-core/lib/ai-connections/types.js";
import type { FormEvent } from "react";
import { useId } from "react";
import { FieldShell } from "../../../components/FieldShell.js";
import { FormCommit } from "../../../components/FormCommit.js";
import { IconKey } from "../../../components/IconKey.js";
import { IconPlay } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";

import {
  BedrockConnectionFields,
  BedrockConnectionHelp,
} from "./BedrockConnectionFields.js";
import {
  VertexConnectionFields,
  VertexConnectionHelp,
  VertexEndpointChoice,
} from "./VertexConnectionFields.js";

export type AiConnectionFormProps = {
  draft: AiConnectionDraft;
  busy: boolean;
  saved: boolean;
  canRetainCredential?: boolean;
  failure: string;
  result: string;
  onChange: <Key extends keyof AiConnectionDraft>(
    field: Key,
    value: AiConnectionDraft[Key],
  ) => void;
  onSave: () => void;
  onTest: () => void;
};
type Fields = Pick<AiConnectionFormProps, "draft" | "busy" | "onChange">;

function connectionReady(draft: AiConnectionDraft, retained: boolean): boolean {
  try {
    const value = validateAiConnection(draft, false);
    return value.authentication === "none" || Boolean(value.apiKey) || retained;
  } catch {
    return false;
  }
}

/** BYO and optimized partner pages draw one protocol configuration form. */
export function AiConnectionForm(props: AiConnectionFormProps) {
  const { draft, busy, onChange } = props;
  const ready = connectionReady(
    draft,
    props.canRetainCredential ?? props.saved,
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready && !busy) props.onSave();
  };
  return (
    <form
      className="cx-form panel__body"
      aria-label="AI connection configuration"
      onSubmit={submit}
    >
      <FieldShell
        label="Connection name"
        value={draft.name}
        disabled={busy}
        onValueChange={(value) => onChange("name", value)}
      />
      <FamilyFields draft={draft} busy={busy} onChange={onChange} />
      <EndpointFields draft={draft} busy={busy} onChange={onChange} />
      <CredentialFields {...props} />
      <AiConnectionSetup draft={draft} busy={busy} onChange={onChange} />
      <FormCommit
        label="Save AI connection"
        disabled={busy || !ready}
        busy={busy}
      >
        <IconKey
          label="Test AI connection"
          disabled={busy || !ready}
          onClick={props.onTest}
        >
          <IconPlay size={16} />
        </IconKey>
        {props.failure ? <StatusMark tone="err" label={props.failure} /> : null}
        {props.result ? <StatusMark tone="ok" label={props.result} /> : null}
      </FormCommit>
    </form>
  );
}
function FamilyFields({ draft, busy, onChange }: Fields) {
  const familyId = useId();
  const targetId = useId();
  const openai = ["openai_chat", "openai_responses"].includes(draft.family);
  return (
    <>
      <div className="field">
        <label htmlFor={familyId}>API family</label>
        <select
          id={familyId}
          value={draft.family}
          disabled={busy}
          onChange={(event) => {
            const value = event.target.value;
            if (isAiConnectionFamily(value)) onChange("family", value);
          }}
        >
          {aiConnectionFamilies(draft.providerId).map((family) => (
            <option
              key={family.id}
              value={family.id}
              disabled={
                draft.azure?.api === "dated-chat" &&
                family.id === "openai_responses"
              }
            >
              {family.label}
            </option>
          ))}
        </select>
      </div>
      <VertexEndpointChoice draft={draft} busy={busy} onChange={onChange} />
      {draft.providerId === "byo-ai" && openai ? (
        <div className="field">
          <label htmlFor={targetId}>Endpoint type</label>
          <select
            id={targetId}
            value={draft.azure ? "azure" : "standard"}
            disabled={busy}
            onChange={(event) => {
              if (event.target.value === "azure")
                onChange("azure", { api: "v1", credential: "api-key" });
              else if (event.target.value === "standard")
                onChange("azure", undefined);
            }}
          >
            <option value="standard">Standard API</option>
            <option value="azure">Azure OpenAI</option>
          </select>
        </div>
      ) : null}
    </>
  );
}
function EndpointFields({ draft, busy, onChange }: Fields) {
  return (
    <>
      <FieldShell
        label={
          draft.bedrock
            ? "Bedrock runtime endpoint"
            : draft.vertex
              ? "Vertex API base URL"
              : draft.azure
                ? "Azure resource endpoint"
                : "API base URL"
        }
        value={draft.baseUrl}
        type={draft.azure || draft.vertex || draft.bedrock ? "url" : undefined}
        readOnly={["google-vertex", "aws-bedrock"].includes(draft.providerId)}
        placeholder={
          draft.azure
            ? "https://your-resource.openai.azure.com"
            : "https://models.example/v1"
        }
        mono
        disabled={busy}
        onValueChange={(value) => onChange("baseUrl", value)}
      />
      <FieldShell
        label={draft.azure ? "Deployment ID" : "Model ID"}
        value={draft.model}
        mono
        disabled={busy}
        onValueChange={(value) => onChange("model", value)}
      />
    </>
  );
}
function SecretField({
  draft,
  busy,
  saved,
  onChange,
}: Fields & Pick<AiConnectionFormProps, "saved">) {
  if (draft.authentication === "none") return null;
  const label = draft.azure
    ? draft.azure.credential === "api-key"
      ? "Azure API key"
      : "Entra access token"
    : "API key";
  return (
    <FieldShell
      label={label}
      value={draft.apiKey}
      type="password"
      autoComplete="new-password"
      placeholder={
        saved ? "Saved in the owning vault; enter a replacement" : undefined
      }
      disabled={busy}
      onValueChange={(value) => onChange("apiKey", value)}
    />
  );
}
function CredentialFields(
  props: Fields & Pick<AiConnectionFormProps, "saved">,
) {
  const authId = useId();
  if (props.draft.family === "bedrock_converse")
    return <BedrockConnectionFields {...props} />;
  if (props.draft.vertex) return <VertexConnectionFields {...props} />;
  if (props.draft.azure)
    return (
      <>
        <AzureModeFields {...props} />
        <AzureCredentialFields {...props} />
        <SecretField {...props} />
      </>
    );
  return (
    <>
      <div className="field">
        <label htmlFor={authId}>Authentication</label>
        <select
          id={authId}
          value={props.draft.authentication}
          disabled={props.busy}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "api-key" || value === "none")
              props.onChange("authentication", value);
          }}
        >
          <option value="api-key">API key</option>
          <option value="none">No authentication</option>
        </select>
      </div>
      <SecretField {...props} />
    </>
  );
}
function AzureModeFields({ draft, busy, onChange }: Fields) {
  const modeId = useId();
  const target = draft.azure;
  if (!target) return null;
  return (
    <>
      <div className="field">
        <label htmlFor={modeId}>Azure API mode</label>
        <select
          id={modeId}
          value={target.api}
          disabled={busy}
          onChange={(event) => {
            if (event.target.value === "v1")
              onChange("azure", { api: "v1", credential: target.credential });
            else if (event.target.value === "dated-chat")
              onChange("azure", {
                api: "dated-chat",
                credential: target.credential,
                apiVersion: "",
              });
          }}
        >
          <option value="v1">Azure OpenAI v1</option>
          <option value="dated-chat">Dated Chat Completions</option>
        </select>
      </div>
      {target.api === "dated-chat" ? (
        <FieldShell
          label="Azure API version"
          value={target.apiVersion}
          placeholder="YYYY-MM-DD or YYYY-MM-DD-preview"
          mono
          disabled={busy}
          onValueChange={(value) =>
            onChange("azure", { ...target, apiVersion: value })
          }
        />
      ) : null}
    </>
  );
}
function AzureCredentialFields({ draft, busy, onChange }: Fields) {
  const authId = useId();
  const target = draft.azure;
  if (!target) return null;
  return (
    <div className="field">
      <label htmlFor={authId}>Azure authentication</label>
      <select
        id={authId}
        value={target.credential}
        disabled={busy}
        onChange={(event) => {
          const credential = event.target.value;
          if (credential === "api-key" || credential === "entra-token")
            onChange("azure", { ...target, credential });
        }}
      >
        <option value="api-key">API key</option>
        <option value="entra-token">Entra access token</option>
      </select>
    </div>
  );
}
function AiConnectionSetup({ draft, busy, onChange }: Fields) {
  const tokenParameterId = useId();
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
        Your service must permit this browser origin through CORS. The
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
