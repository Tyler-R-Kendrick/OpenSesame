import type { Provider } from "@opensesame/app-core/lib/connections.js";
import { type FormEvent, useId } from "react";
import { FormCommit } from "../../components/FormCommit.js";
import { StatusMark } from "../../components/StatusMark.js";

/** An `api_key` connector: the key, pasted once, and an optional name. */
export function ApiKeyForm({
  provider,
  name,
  apiKey,
  busy,
  online,
  failure,
  onName,
  onApiKey,
  onSubmit,
}: {
  provider: Provider;
  name: string;
  apiKey: string;
  busy: boolean;
  online: boolean;
  /** The sentence for the last try that failed, drawn beside the key. */
  failure: string;
  onName: (value: string) => void;
  onApiKey: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const nameId = useId();
  const keyId = useId();
  return (
    <form className="conn-tile__body" onSubmit={onSubmit}>
      <div className="field">
        <label className="label" htmlFor={keyId}>
          API key
        </label>
        <input
          id={keyId}
          type="password"
          autoComplete="off"
          placeholder="Paste API key once"
          title="Paste once. It is not shown again."
          value={apiKey}
          onChange={(event) => onApiKey(event.target.value)}
        />
      </div>
      <details className="conn-client-alt">
        <summary>Optional settings</summary>
        <div className="field">
          <label className="label" htmlFor={nameId}>
            Name it (optional)
          </label>
          <input
            id={nameId}
            value={name}
            onChange={(event) => onName(event.target.value)}
          />
          <p className="hint">
            Only changes the label in OpenSesame; the provider never sees it.
          </p>
        </div>
      </details>
      <FormCommit
        label={busy ? "Saving" : `Connect ${provider.displayName}`}
        busy={busy}
        disabled={busy || !online || apiKey.trim() === ""}
      >
        {failure ? <StatusMark tone="err" label={failure} /> : null}
      </FormCommit>
    </form>
  );
}
