import { aiConnectionFamilies } from "@opensesame/app-core/lib/ai-connections/presets.js";
import type { AiConnectionDraft } from "@opensesame/app-core/lib/ai-connections/types.js";
import type { FormEvent } from "react";
import { useId } from "react";
import { FieldShell } from "../../../components/FieldShell.js";
import { FormCommit } from "../../../components/FormCommit.js";
import { IconKey } from "../../../components/IconKey.js";
import { IconPlay } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";

export type AiConnectionFormProps = {
  draft: AiConnectionDraft;
  busy: boolean;
  saved: boolean;
  failure: string;
  result: string;
  onChange: (field: keyof AiConnectionDraft, value: string) => void;
  onSave: () => void;
  onTest: () => void;
};

function connectionReady(draft: AiConnectionDraft, saved: boolean): boolean {
  return Boolean(
    draft.name.trim() &&
      draft.baseUrl.trim() &&
      draft.model.trim() &&
      (draft.authentication === "none" || draft.apiKey || saved),
  );
}

/** BYO and optimized partner pages draw one protocol configuration form. */
export function AiConnectionForm(props: AiConnectionFormProps) {
  const { draft, busy, onChange } = props;
  const familyId = useId();
  const authId = useId();
  const families = aiConnectionFamilies(draft.providerId);
  const ready = connectionReady(draft, props.saved);
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
      <div className="field">
        <label htmlFor={familyId}>API family</label>
        <select
          id={familyId}
          value={draft.family}
          disabled={busy}
          onChange={(event) => onChange("family", event.target.value)}
        >
          {families.map((family) => (
            <option key={family.id} value={family.id}>
              {family.label}
            </option>
          ))}
        </select>
      </div>
      <FieldShell
        label="API base URL"
        value={draft.baseUrl}
        placeholder="https://models.example/v1"
        mono
        disabled={busy}
        onValueChange={(value) => onChange("baseUrl", value)}
      />
      <FieldShell
        label="Model ID"
        value={draft.model}
        mono
        disabled={busy}
        onValueChange={(value) => onChange("model", value)}
      />
      <div className="field">
        <label htmlFor={authId}>Authentication</label>
        <select
          id={authId}
          value={draft.authentication}
          disabled={busy}
          onChange={(event) => onChange("authentication", event.target.value)}
        >
          <option value="api-key">API key</option>
          <option value="none">No authentication</option>
        </select>
      </div>
      {draft.authentication === "api-key" ? (
        <FieldShell
          label="API key"
          value={draft.apiKey}
          type="password"
          autoComplete="new-password"
          placeholder={
            props.saved
              ? "Saved in the owning vault; enter a replacement"
              : undefined
          }
          disabled={busy}
          onValueChange={(value) => onChange("apiKey", value)}
        />
      ) : null}
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

function AiConnectionSetup({
  draft,
  busy,
  onChange,
}: Pick<AiConnectionFormProps, "draft" | "busy" | "onChange">) {
  const tokenParameterId = useId();
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
            onChange={(event) => onChange("tokenParameter", event.target.value)}
          >
            <option value="max_completion_tokens">max_completion_tokens</option>
            <option value="max_tokens">max_tokens</option>
          </select>
        </div>
      ) : null}
      <p>
        The base URL includes the API prefix. Your service must permit this
        browser origin through CORS. The API key is saved as a Token credential
        in the current vault and sent only to the configured endpoint.
      </p>
      <p>
        Testing and saving send a short prompt with up to 16 output tokens.
        Changing the endpoint, API family or model requires an API key again.
      </p>
    </details>
  );
}
