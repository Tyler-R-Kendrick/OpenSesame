import {
  PROTON_PASS_PUBLIC_APP_VERSION,
  secretBackendModeLabel,
} from "@opensesame/app-core/lib/secret-backends/presets.js";
import type { SecretBackendMode } from "@opensesame/app-core/lib/secret-backends/types.js";
import { type FormEvent, type ReactNode, useId } from "react";
import { FieldShell } from "../../../components/FieldShell.js";
import { FormCommit } from "../../../components/FormCommit.js";
import { IconKey } from "../../../components/IconKey.js";
import { IconCheck, IconRefresh } from "../../../components/Icons.js";
import { StatusMark } from "../../../components/StatusMark.js";
import {
  type SecretBackendFieldProps,
  SecretBackendFields,
} from "./secret-backend-fields.js";

export type SecretBackendFormProps = SecretBackendFieldProps & {
  modes: readonly SecretBackendMode[];
  online: boolean;
  saved: boolean;
  failure: string;
  docsUrl?: string;
  setup?: string;
  children?: ReactNode;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onProbe: () => void;
  onReload: () => void;
};

function ModeField({ draft, modes, busy, onChange }: SecretBackendFormProps) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>Connection method</label>
      <select
        id={id}
        value={draft.mode}
        disabled={busy}
        onChange={(event) => {
          const mode = event.target.value;
          if (mode === "proton-pass" && !draft.appVersion)
            onChange("appVersion", PROTON_PASS_PUBLIC_APP_VERSION);
          onChange("mode", mode);
        }}
      >
        {modes.map((mode) => (
          <option key={mode} value={mode}>
            {secretBackendModeLabel(mode)}
          </option>
        ))}
      </select>
    </div>
  );
}

/** BYO and partner connections use the same fields and configuration actions. */
export function SecretBackendForm(props: SecretBackendFormProps) {
  const { draft, busy, onChange } = props;
  return (
    <form className="cx-form panel__body" onSubmit={props.onSubmit}>
      <FieldShell
        label="Connection name"
        value={draft.name}
        disabled={busy}
        onValueChange={(value) => onChange("name", value)}
      />
      <ModeField {...props} />
      <SecretBackendFields {...props} />
      {props.children}
      {props.setup || props.docsUrl ? (
        <details className="conn-client-alt">
          <summary>Setup guide</summary>
          {props.setup ? <p>{props.setup}</p> : null}
          {props.docsUrl ? (
            <a href={props.docsUrl} target="_blank" rel="noreferrer noopener">
              Provider documentation
            </a>
          ) : null}
        </details>
      ) : null}
      <FormCommit label="Save secret backend" disabled={busy} busy={busy}>
        <IconKey
          label="Test secret backend"
          disabled={busy}
          onClick={props.onProbe}
        >
          <IconCheck size={17} />
        </IconKey>
        {props.saved ? (
          <IconKey
            label="Reload secret backend configuration"
            disabled={busy}
            onClick={props.onReload}
          >
            <IconRefresh size={17} />
          </IconKey>
        ) : null}
        {props.failure ? <StatusMark tone="err" label={props.failure} /> : null}
      </FormCommit>
    </form>
  );
}
